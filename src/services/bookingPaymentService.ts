import { pool } from '../config/database';
import { BookingActor } from '../types/booking';
import { httpError } from '../utils/httpError';
import { paise,rupees } from '../utils/bookingMoney';
import { digest } from '../security/password';
import { assertBookingActor, bookingTransaction } from './bookingAuthorizationService';
import { bookingRecord, bookingRequestLimit, expireUnpaidBookings, queueRefundReview } from './bookingService';
import { enqueueBookingNotifications } from './notificationService';
import * as gateway from './razorpayService';

function validateOrder(order: gateway.RazorpayOrder,payment: Record<string,any>): void {
  if (!/^order_[A-Za-z0-9]+$/.test(order.id) || order.currency!=='INR' || order.amount!==Number(paise(payment.payment_amount)) || order.receipt!==payment.booking_payment_id || order.notes?.booking_id!==payment.booking_id || order.notes?.payment_attempt_id!==payment.booking_payment_id) httpError(409,'Razorpay order does not match the stored payment');
}

export async function createBookingPaymentOrder(actor: BookingActor,id: string) {
  if(actor.type!=='user')httpError(403,'User authentication required');
  gateway.razorpayKeyId();await bookingRequestLimit(actor,'order',30);
  const intent=await bookingTransaction(async client=>{
    await assertBookingActor(actor,client,'read',true);
    const booking=(await client.query('SELECT * FROM public.booking WHERE booking_id=$1 AND user_id=$2 FOR UPDATE',[id,actor.id])).rows[0];if(!booking)httpError(404,'Booking not found');
    await expireUnpaidBookings(client,booking.venue_id);
    if(booking.booking_status!=='Accepted'||booking.payment_state!=='awaiting_payment'||!booking.payment_expires_at||booking.payment_expires_at.getTime()<=Date.now())httpError(409,'Owner acceptance and an unexpired advance payment window are required');
    const payment=(await client.query('SELECT * FROM public.booking_payment_details WHERE booking_payment_id=$1 AND booking_id=$2 FOR UPDATE',[booking.booking_payment_id,id])).rows[0];
    if(!payment||paise(payment.payment_amount)<=0n)httpError(409,'No advance payment is required');
    if(payment.razorpay_order_id)return {payment,create:false};
    if(payment.order_state!=='not_created')return {payment,create:false};
    await client.query("UPDATE public.booking_payment_details SET order_state='creating',order_intent_at=now(),updated_at=now() WHERE booking_payment_id=$1",[payment.booking_payment_id]);
    return {payment,create:true};
  });
  let payment=intent.payment;
  if(intent.create){
    try{
      const order=await gateway.createRazorpayOrder(payment.booking_payment_id,id,Number(paise(payment.payment_amount)));
      validateOrder(order,payment);
      payment=(await pool.query(`UPDATE public.booking_payment_details SET razorpay_order_id=$2,order_state='created',updated_at=now()
        WHERE booking_payment_id=$1 AND (razorpay_order_id IS NULL OR razorpay_order_id=$2) RETURNING *`,[payment.booking_payment_id,order.id])).rows[0];
    }catch(error){await pool.query("UPDATE public.booking_payment_details SET order_state='unknown',updated_at=now() WHERE booking_payment_id=$1 AND razorpay_order_id IS NULL",[payment.booking_payment_id]);throw error;}
  }
  if(!payment.razorpay_order_id)return { pending:true,booking_payment_id:payment.booking_payment_id,message:'Order creation is pending reconciliation. Retry this endpoint later; a second order will not be created.' };
  return {pending:false,booking_id:id,booking_payment_id:payment.booking_payment_id,key_id:gateway.razorpayKeyId(),order_id:payment.razorpay_order_id,amount:Number(paise(payment.payment_amount)),currency:'INR'};
}

async function verifiedCapture(payment: gateway.RazorpayPayment,order: gateway.RazorpayOrder) {
  if(!['captured','refunded'].includes(payment.status)||!payment.captured||order.status!=='paid'||order.amount_paid<order.amount)return {pending:true};
  return bookingTransaction(async client=>{
    let stored=(await client.query('SELECT * FROM public.booking_payment_details WHERE razorpay_order_id=$1 FOR UPDATE',[order.id])).rows[0];
    if(!stored&&order.receipt){
      stored=(await client.query('SELECT * FROM public.booking_payment_details WHERE booking_payment_id=$1 AND razorpay_order_id IS NULL FOR UPDATE',[order.receipt])).rows[0];
      if(stored){validateOrder(order,stored);await client.query("UPDATE public.booking_payment_details SET razorpay_order_id=$2,order_state='created' WHERE booking_payment_id=$1",[stored.booking_payment_id,order.id]);}
    }
    if(!stored)httpError(404,'Stored Razorpay order not found');validateOrder(order,stored);
    if(payment.order_id!==order.id||payment.currency!=='INR'||payment.amount!==Number(paise(stored.payment_amount)))httpError(409,'Captured amount/currency/order does not match');
    if(stored.razorpay_payment_id&&stored.razorpay_payment_id!==payment.id)httpError(409,'Order already has a different captured payment; admin reconciliation is required');
    const booking=(await client.query('SELECT * FROM public.booking WHERE booking_id=$1 FOR UPDATE',[stored.booking_id])).rows[0];
    if(stored.captured_at)return {pending:false,booking_id:booking.booking_id};
    await client.query(`UPDATE public.booking_payment_details SET razorpay_payment_id=$2,booking_payment_status='Completed',captured_at=now(),updated_at=now(),order_state='created',booking_razorpay_details=$3 WHERE booking_payment_id=$1`,
      [stored.booking_payment_id,payment.id,{order_id:order.id,payment_id:payment.id,amount:payment.amount,currency:payment.currency,status:payment.status}]);
    if(payment.amount_refunded>=payment.amount){
      await client.query("UPDATE public.booking SET booking_status=CASE WHEN booking_status='Accepted' THEN 'Cancelled' ELSE booking_status END,payment_state='refunded',is_advance_paid=false,updated_at=now() WHERE booking_id=$1",[booking.booking_id]);
      await client.query("UPDATE public.booking_payment_details SET booking_payment_status='Other',booking_other_payment_status='Refunded' WHERE booking_payment_id=$1",[stored.booking_payment_id]);
    }else if(booking.booking_status!=='Accepted'||booking.payment_state!=='awaiting_payment'||!booking.payment_expires_at||booking.payment_expires_at.getTime()<=Date.now()||payment.amount_refunded>0){
      if(booking.booking_status==='Accepted')await client.query("UPDATE public.booking SET booking_status='Cancelled',payment_state='expired',reason='Payment arrived after the reservation window',updated_at=now() WHERE booking_id=$1",[booking.booking_id]);
      await queueRefundReview(client,booking,{...stored,payment_amount:rupees(BigInt(payment.amount-payment.amount_refunded))},'Captured payment for an expired, rejected or partially refunded booking');
    }else{
      await client.query("UPDATE public.booking SET is_advance_paid=true,payment_state='paid',updated_at=now() WHERE booking_id=$1",[booking.booking_id]);
      await enqueueBookingNotifications(client,booking,'advance_paid',`Advance payment of INR ${stored.payment_amount} was verified. Your booking is confirmed.`);
    }
    return {pending:false,booking_id:booking.booking_id};
  });
}

export async function confirmBookingPayment(actor: BookingActor,id: string,input:{razorpay_order_id:string;razorpay_payment_id:string;razorpay_signature:string}) {
  if(actor.type!=='user')httpError(403,'User authentication required');await assertBookingActor(actor);await bookingRequestLimit(actor,'verify',100);
  const stored=(await pool.query(`SELECT p.* FROM public.booking_payment_details p JOIN public.booking b USING(booking_id) WHERE b.booking_id=$1 AND b.user_id=$2 AND p.razorpay_order_id=$3`,[id,actor.id,input.razorpay_order_id])).rows[0];
  if(!stored)httpError(404,'Booking payment order not found');
  if(!gateway.verifyCheckoutSignature(stored.razorpay_order_id,input.razorpay_payment_id,input.razorpay_signature))httpError(401,'Invalid payment signature');
  const [payment,order]=await Promise.all([gateway.fetchRazorpayPayment(input.razorpay_payment_id),gateway.fetchRazorpayOrder(stored.razorpay_order_id)]);
  if(payment.order_id!==stored.razorpay_order_id||payment.amount!==Number(paise(stored.payment_amount))||payment.currency!=='INR')httpError(409,'Payment does not match the booking');
  const result=await verifiedCapture(payment,order);
  return {pending:result.pending,booking:await bookingRecord(pool,actor,id)};
}

async function applyProcessedRefund(refund: gateway.RazorpayRefund) {
  if(refund.status!=='processed')return;
  const remotePayment=await gateway.fetchRazorpayPayment(refund.payment_id);
  await bookingTransaction(async client=>{
    const stored=(await client.query('SELECT * FROM public.booking_payment_details WHERE razorpay_payment_id=$1 FOR UPDATE',[refund.payment_id])).rows[0];
    if(!stored)return;
    const expected=Number(paise(stored.payment_amount));
    if(remotePayment.id!==refund.payment_id||remotePayment.currency!=='INR'||remotePayment.amount!==expected||refund.currency!=='INR'||!Number.isSafeInteger(remotePayment.amount_refunded)||remotePayment.amount_refunded<refund.amount||remotePayment.amount_refunded>expected)httpError(409,'Refund does not match the captured payment');
    const review=(await client.query(`SELECT r.*,p.razorpay_payment_id FROM public.booking_refund_reviews r JOIN public.booking_payment_details p USING(booking_payment_id)
      WHERE r.razorpay_refund_id=$1 OR (r.refund_review_id=$2 AND r.status IN ('Approved','Processing')) FOR UPDATE OF r`,[refund.id,refund.receipt??''])).rows[0];
    if(review&&(refund.payment_id!==review.razorpay_payment_id||refund.amount!==Number(paise(review.amount))))httpError(409,'Refund does not match its approved review');
    if(review)await client.query("UPDATE public.booking_refund_reviews SET status='Processed',razorpay_refund_id=$2,updated_at=now() WHERE refund_review_id=$1",[review.refund_review_id,refund.id]);
    const fullyRefunded=remotePayment.amount_refunded===expected;
    await client.query("UPDATE public.booking_payment_details SET booking_payment_status='Other',booking_other_payment_status=$2,booking_other_payment_details=$3,updated_at=now() WHERE booking_payment_id=$1",[stored.booking_payment_id,fullyRefunded?'Refunded':'Partially refunded',{refunded_amount_paise:remotePayment.amount_refunded,last_refund_id:refund.id}]);
    const booking=(await client.query(`UPDATE public.booking SET booking_status=CASE WHEN booking_status='Accepted' THEN 'Cancelled' ELSE booking_status END,payment_state=$2,is_advance_paid=false,updated_at=now() WHERE booking_id=$1 RETURNING *`,[stored.booking_id,fullyRefunded?'refunded':'refund_review'])).rows[0];
    if(fullyRefunded){
      await client.query("UPDATE public.booking_refund_reviews SET status='Processed',updated_at=now() WHERE booking_payment_id=$1 AND status IN ('Pending','Approved','Processing','Failed')",[stored.booking_payment_id]);
      await enqueueBookingNotifications(client,booking,'refund_processed','Razorpay reported a completed refund of the captured advance.');
    }else{
      const remaining=rupees(BigInt(expected-remotePayment.amount_refunded));
      await queueRefundReview(client,booking,{...stored,payment_amount:remaining},'Razorpay reported a partial refund; the remaining advance requires admin review');
      await client.query("UPDATE public.booking_refund_reviews SET amount=$2 WHERE booking_payment_id=$1 AND status='Pending'",[stored.booking_payment_id,remaining]);
    }
  });
}

export async function handleRazorpayWebhook(raw: Buffer,signature: string,eventId: string) {
  const secret=process.env.RAZORPAY_WEBHOOK_SECRET;if(!secret)httpError(503,'Razorpay webhook secret is not configured');
  if(!gateway.verifyRazorpaySignature(raw,signature,secret))httpError(401,'Invalid webhook signature');
  let payload:any;try{payload=JSON.parse(raw.toString('utf8'));}catch{httpError(400,'Invalid webhook JSON');}
  if(!payload||typeof payload.event!=='string')httpError(400,'Invalid webhook event');
  const hash=digest(raw.toString('utf8')),prior=(await pool.query('SELECT payload_hash FROM public.razorpay_webhook_events WHERE event_id=$1',[eventId])).rows[0];
  if(prior){if(prior.payload_hash!==hash)httpError(409,'Webhook event ID has a conflicting payload');return {duplicate:true};}
  if(['payment.captured','order.paid','payment.authorized'].includes(payload.event)){
    const entity=payload.payload?.payment?.entity;
    if(!entity||typeof entity.id!=='string'||!/^pay_[A-Za-z0-9]+$/.test(entity.id))httpError(400,'Missing webhook payment');
    const payment=await gateway.fetchRazorpayPayment(entity.id),order=await gateway.fetchRazorpayOrder(payment.order_id);
    await verifiedCapture(payment,order);
  }else if(payload.event==='refund.processed'){
    const id=payload.payload?.refund?.entity?.id;
    if(typeof id!=='string'||!/^rfnd_[A-Za-z0-9]+$/.test(id))httpError(400,'Missing webhook refund');await applyProcessedRefund(await gateway.fetchRazorpayRefund(id));
  }
  // Unknown/failed/authorised events never overwrite a captured payment or confirm a booking.
  await pool.query('INSERT INTO public.razorpay_webhook_events(event_id,event_type,payload_hash) VALUES($1,$2,$3) ON CONFLICT(event_id) DO NOTHING',[eventId,payload.event,hash]);
  return {duplicate:false};
}

export async function reconcilePaymentOrders(): Promise<void> {
  if(!gateway.razorpayConfigured())return;
  const pending=await pool.query(`SELECT * FROM public.booking_payment_details WHERE (order_state='unknown' OR (order_state='creating' AND order_intent_at<now()-interval '1 minute')) ORDER BY order_intent_at LIMIT 10`);
  for(const payment of pending.rows){
    try{
      const orders=(await gateway.findRazorpayOrders(payment.booking_payment_id)).items.filter(order=>order.receipt===payment.booking_payment_id);
      if(orders.length!==1)continue;validateOrder(orders[0]!,payment);
      await pool.query("UPDATE public.booking_payment_details SET razorpay_order_id=$2,order_state='created',updated_at=now() WHERE booking_payment_id=$1 AND razorpay_order_id IS NULL",[payment.booking_payment_id,orders[0]!.id]);
    }catch{/* Keep the intent for retry; never create another order on an ambiguous result. */}
  }
  const awaiting=await pool.query(`SELECT * FROM public.booking_payment_details WHERE order_state='created' AND captured_at IS NULL
    AND (last_reconciled_at IS NULL OR last_reconciled_at<now()-interval '2 minutes') ORDER BY last_reconciled_at NULLS FIRST LIMIT 10`);
  for(const stored of awaiting.rows){
    await pool.query('UPDATE public.booking_payment_details SET last_reconciled_at=now() WHERE booking_payment_id=$1',[stored.booking_payment_id]);
    try{
      const order=await gateway.fetchRazorpayOrder(stored.razorpay_order_id);
      if(order.status!=='paid')continue;
      const payment=(await gateway.fetchRazorpayOrderPayments(order.id)).items.find(item=>item.captured&&['captured','refunded'].includes(item.status));
      if(payment)await verifiedCapture(await gateway.fetchRazorpayPayment(payment.id),order);
    }catch{/* Callback/webhook delivery can recover independently; retain for the next poll. */}
  }
}

export async function processApprovedRefunds(): Promise<void> {
  if(!gateway.razorpayConfigured())return;
  const reviews=await bookingTransaction(async client=>(await client.query(`UPDATE public.booking_refund_reviews SET status='Processing',attempts=attempts+1,next_attempt_at=now()+interval '2 minutes',updated_at=now()
    WHERE refund_review_id IN(SELECT refund_review_id FROM public.booking_refund_reviews WHERE status IN ('Approved','Processing') AND next_attempt_at<=now() ORDER BY created_at LIMIT 5 FOR UPDATE SKIP LOCKED) RETURNING *`)).rows);
  for(const review of reviews){
    try{
      const stored=(await pool.query('SELECT * FROM public.booking_payment_details WHERE booking_payment_id=$1',[review.booking_payment_id])).rows[0];
      if(!stored?.razorpay_payment_id)throw new Error('Missing captured payment');
      const refund=await gateway.createRazorpayRefund(stored.razorpay_payment_id,review.refund_review_id,Number(paise(review.amount)));
      if(refund.payment_id!==stored.razorpay_payment_id||refund.currency!=='INR'||refund.amount!==Number(paise(review.amount)))throw new Error('Refund mismatch');
      await pool.query('UPDATE public.booking_refund_reviews SET razorpay_refund_id=$2,updated_at=now() WHERE refund_review_id=$1',[review.refund_review_id,refund.id]);
      await applyProcessedRefund(refund);
    }catch{await pool.query("UPDATE public.booking_refund_reviews SET status=CASE WHEN attempts>=8 THEN 'Failed' ELSE 'Processing' END,updated_at=now() WHERE refund_review_id=$1 AND status<>'Processed'",[review.refund_review_id]);}
  }
}
