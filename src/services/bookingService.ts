import { PoolClient } from 'pg';
import { pool } from '../config/database';
import { BookingActor, BookingInput } from '../types/booking';
import { digest } from '../security/password';
import { generateId } from '../utils/id';
import { httpError } from '../utils/httpError';
import { paise, rupees, bookingTaxBps, paymentWindowMinutes } from '../utils/bookingMoney';
import { assertBookingActor, bookingTransaction } from './bookingAuthorizationService';
import { enqueueBookingNotifications } from './notificationService';
import { securityTransaction } from './securityService';
import { effectivePricePredicate } from './venuePricingService';

export async function bookingRequestLimit(actor: BookingActor, purpose: string, max: number): Promise<void> {
  const result = await pool.query(`INSERT INTO public.booking_request_limits(attempt_key,attempts) VALUES($1,1) ON CONFLICT(attempt_key) DO UPDATE SET
    attempts=CASE WHEN booking_request_limits.window_start<now()-interval '15 minutes' THEN 1 ELSE booking_request_limits.attempts+1 END,
    window_start=CASE WHEN booking_request_limits.window_start<now()-interval '15 minutes' THEN now() ELSE booking_request_limits.window_start END RETURNING attempts`, [digest(`${purpose}:${actor.type}:${actor.id}`)]);
  if (result.rows[0].attempts>max) httpError(429,'Too many booking requests. Try again in 15 minutes.');
}

export async function expireUnpaidBookings(client: PoolClient, venueId?: string): Promise<void> {
  const expired = await client.query(`UPDATE public.booking SET booking_status='Cancelled',payment_state='expired',reason='Advance payment window expired',updated_at=now()
    WHERE booking_status='Accepted' AND payment_state='awaiting_payment' AND payment_expires_at<=now()${venueId ? ' AND venue_id=$1' : ''} RETURNING *`, venueId ? [venueId] : []);
  for (const booking of expired.rows) await enqueueBookingNotifications(client,booking,'payment_expired','The advance payment window expired. The reservation has been released.');
}

async function quoteInTransaction(client: PoolClient, input: BookingInput) {
  const candidate = (await client.query(`SELECT p.venue_id,v.owner_id FROM public.venue_price_details p JOIN public.venue_details v USING(venue_id) WHERE venue_price_id=$1`, [input.venue_price_id])).rows[0];
  if (!candidate) httpError(404,'Venue price not found');
  const owner = (await client.query('SELECT status FROM public.owner WHERE owner_id=$1 FOR SHARE', [candidate.owner_id])).rows[0];
  const venue = (await client.query('SELECT * FROM public.venue_details WHERE venue_id=$1 FOR UPDATE', [candidate.venue_id])).rows[0];
  if (!venue || venue.owner_id!==candidate.owner_id || !venue.is_active || venue.status!=='Active' || !owner || !['pending','verified'].includes(owner.status)) httpError(409,'Venue is not available for booking');
  await expireUnpaidBookings(client,venue.venue_id);
  const config = (await client.query(`SELECT to_jsonb(p) AS price,to_jsonb(s) AS slot,to_jsonb(d) AS decoration,to_jsonb(m) AS meals
    FROM public.venue_price_details p JOIN public.venue_type_slots s ON s.venue_type_slot_id=p.venue_type_slot_id AND s.venue_id=p.venue_id
    LEFT JOIN public.venue_decoration_details d ON d.venue_decoration_id=p.venue_decoration_id AND d.venue_id=p.venue_id
    LEFT JOIN public.venue_meals_details m ON m.venue_meals_id=p.venue_meals_id AND m.venue_id=p.venue_id
    WHERE p.venue_id=$2 AND (p.venue_price_id=$1 OR (p.is_default AND p.venue_type_slot_id=(
      SELECT venue_type_slot_id FROM public.venue_price_details WHERE venue_price_id=$1 AND venue_id=$2)))
      AND ${effectivePricePredicate('p','$3')}`, [input.venue_price_id,venue.venue_id,input.booking_date])).rows[0];
  if (!config) httpError(409,'Selected price is unavailable for this date. Select a date-specific price or configure a default for this slot.');
  if (!config.slot.is_active) httpError(409,'An active venue slot is required');
  const { price,slot } = config;
  if (venue.venue_hall_capacity!=null && input.guest_count>venue.venue_hall_capacity) httpError(400,'guest_count exceeds venue hall capacity');
  for (const [include,key,prefix] of [[input.include_decoration,'decoration','venue_decoration'],[input.include_meals,'meals','venue_meals']] as const) {
    if (!include) continue;
    if (!config[key]) httpError(409,`Selected price has no ${key} package`);
    if ((price[`${prefix}_from_date`] && input.booking_date<price[`${prefix}_from_date`]) || (price[`${prefix}_to_date`] && input.booking_date>price[`${prefix}_to_date`])) httpError(409,`${key} package is not available on this date`);
  }
  const timezone = process.env.BOOKING_TIME_ZONE ?? 'Asia/Kolkata';
  try { new Intl.DateTimeFormat('en',{timeZone:timezone}); } catch { httpError(503,'Invalid BOOKING_TIME_ZONE configuration'); }
  const window = (await client.query(`SELECT ($1::date+$2::time) AT TIME ZONE $4 AS booking_from,
    (($1::date+CASE WHEN $3::time<=$2::time THEN 1 ELSE 0 END)+$3::time) AT TIME ZONE $4 AS booking_to`, [input.booking_date,price.venue_from_time,price.venue_to_time,timezone])).rows[0];
  if (window.booking_from.getTime()<=Date.now()) httpError(400,'Booking must start in the future');
  if ((await client.query(`SELECT 1 FROM public.booking WHERE venue_id=$1 AND booking_status='Accepted' AND tstzrange(booking_from,booking_to,'[)')&&tstzrange($2,$3,'[)') LIMIT 1`, [venue.venue_id,window.booking_from,window.booking_to])).rowCount) httpError(409,'Venue is already reserved for this time period');
  const venueAmount = paise(price.venue_price), decorationAmount = input.include_decoration ? paise(config.decoration.venue_decoration_price) : 0n,
    mealsAmount = input.include_meals ? paise(config.meals.per_plate_price)*BigInt(input.guest_count) : 0n;
  const mealAdvance = input.include_meals ? paise(config.meals.meals_advance_price) : 0n;
  const advanceBase = paise(price.venue_advance_price)+(input.include_decoration?paise(config.decoration.venue_decoration_advance_price):0n)+(mealAdvance>mealsAmount?mealsAmount:mealAdvance);
  const taxBps = bookingTaxBps(), subtotal = venueAmount+decorationAmount+mealsAmount, tax = (subtotal*BigInt(taxBps)+5000n)/10000n,
    advanceTax = (advanceBase*BigInt(taxBps)+5000n)/10000n,total=subtotal+tax,advance=advanceBase+advanceTax;
  if (advance>total) httpError(409,'Configured advances exceed the booking total');
  if (advance>0n && advance<100n) httpError(409,'Configured advance must be zero or at least INR 1.00');
  const amounts = { venue_amount:rupees(venueAmount),decoration_amount:rupees(decorationAmount),meals_amount:rupees(mealsAmount),tax_amount:rupees(tax),discount_amount:'0.00',total_amount:rupees(total),advance_amount:rupees(advance),balance_amount:rupees(total-advance),tax_rate_bps:taxBps };
  const priceSource=price.is_default?'default':'date_specific';
  return { venue_id:venue.venue_id,owner_id:venue.owner_id,venue_price_id:price.venue_price_id,requested_venue_price_id:input.venue_price_id,venue_type_slot_id:slot.venue_type_slot_id,is_default:price.is_default,price_source:priceSource,
    booking_date:input.booking_date,booking_from:window.booking_from.toISOString(),booking_to:window.booking_to.toISOString(),guest_count:input.guest_count,currency:'INR',...amounts,
    price_snapshot:{ venue_name:venue.venue_name,price,slot,price_source:priceSource,requested_venue_price_id:input.venue_price_id,decoration:input.include_decoration?config.decoration:null,meals:input.include_meals?config.meals:null,guest_count:input.guest_count,time_zone:timezone,...amounts } };
}

export async function quoteBooking(actor: BookingActor, input: BookingInput) {
  if (actor.type!=='user') httpError(403,'User authentication required');
  return bookingTransaction(async client=>{ await assertBookingActor(actor,client,'read',true);return quoteInTransaction(client,input); });
}

export async function createBooking(actor: BookingActor,input: BookingInput,idempotencyKey: string) {
  if (actor.type!=='user') httpError(403,'User authentication required');
  await bookingRequestLimit(actor,'create',20);
  return bookingTransaction(async client=>{
    const user=await assertBookingActor(actor,client,'read',true),requestHash=digest(JSON.stringify(input));
    const existing=(await client.query('SELECT booking_id,request_hash FROM public.booking WHERE user_id=$1 AND idempotency_key=$2',[actor.id,idempotencyKey])).rows[0];
    if(existing){if(existing.request_hash!==requestHash)httpError(409,'Idempotency-Key was already used for a different booking');return {created:false,booking:await bookingRecord(client,actor,existing.booking_id)};}
    const quote=await quoteInTransaction(client,input),contactEmail=input.contact_email??user.email;
    if(!contactEmail)httpError(400,'contact_email is required when the user profile has no email');
    const bookingId=generateId(),paymentId=generateId();
    const booking=(await client.query(`INSERT INTO public.booking(booking_id,user_id,venue_id,owner_id,venue_price_id,venue_type_slot_id,booking_date,booking_from,booking_to,guest_count,contact_email,price_snapshot,advance_amount,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,[bookingId,actor.id,quote.venue_id,quote.owner_id,quote.venue_price_id,quote.venue_type_slot_id,input.booking_date,quote.booking_from,quote.booking_to,input.guest_count,contactEmail,quote.price_snapshot,quote.advance_amount,idempotencyKey,requestHash])).rows[0];
    await client.query(`INSERT INTO public.booking_price_details(booking_price_id,booking_id,venue_amount,decoration_amount,meals_amount,tax_amount,discount_amount,total_amount,advance_amount,balance_amount,tax_rate_bps)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[generateId(),bookingId,quote.venue_amount,quote.decoration_amount,quote.meals_amount,quote.tax_amount,quote.discount_amount,quote.total_amount,quote.advance_amount,quote.balance_amount,quote.tax_rate_bps]);
    await client.query(`INSERT INTO public.booking_payment_details(booking_payment_id,booking_id,booking_total_amount,booking_totoal_tax,payment_amount)
      VALUES($1,$2,$3,$4,$5)`,[paymentId,bookingId,quote.total_amount,quote.tax_amount,quote.advance_amount]);
    await client.query('UPDATE public.booking SET booking_payment_id=$1 WHERE booking_id=$2',[paymentId,bookingId]);
    await enqueueBookingNotifications(client,booking,'requested','Your booking request was created and is waiting for the venue owner. Payment is available after acceptance.');
    return {created:true,booking:await bookingRecord(client,actor,bookingId)};
  });
}

export async function bookingRecord(db: Pick<PoolClient,'query'>,actor: BookingActor,id: string) {
  const scope=actor.type==='user'?' AND b.user_id=$2':actor.type==='owner'?' AND b.owner_id=$2':'';
  const row=(await db.query(`SELECT (to_jsonb(b)-'request_hash'-'idempotency_key')||jsonb_build_object(
    'venue_name',v.venue_name,'is_confirmed',(b.booking_status='Accepted' AND b.payment_state IN ('paid','not_required')),
    'booking_price_details',(SELECT to_jsonb(p) FROM public.booking_price_details p WHERE p.booking_id=b.booking_id),
    'booking_payment_details',coalesce((SELECT jsonb_agg(jsonb_build_object('booking_payment_id',p.booking_payment_id,'payment_amount',p.payment_amount,'booking_payment_status',p.booking_payment_status,'currency',p.currency,'razorpay_order_id',p.razorpay_order_id,'razorpay_payment_id',p.razorpay_payment_id,'order_state',p.order_state,'captured_at',p.captured_at) ORDER BY p.created_at,p.booking_payment_id) FROM public.booking_payment_details p WHERE p.booking_id=b.booking_id),'[]'::jsonb),
    'refund_reviews',coalesce((SELECT jsonb_agg(jsonb_build_object('refund_review_id',r.refund_review_id,'status',r.status,'amount',r.amount,'reason',r.reason,'admin_reason',r.admin_reason,'razorpay_refund_id',r.razorpay_refund_id)) FROM public.booking_refund_reviews r WHERE r.booking_id=b.booking_id),'[]'::jsonb)) AS record
    FROM public.booking b JOIN public.venue_details v USING(venue_id) WHERE b.booking_id=$1${scope}`,actor.type==='admin'?[id]:[id,actor.id])).rows[0];
  if(!row)httpError(404,'Booking not found');return row.record;
}

export async function getBooking(actor: BookingActor,id: string) {await assertBookingActor(actor);return bookingRecord(pool,actor,id);}

export interface BookingListQuery {page:number;limit:number;search?:string;booking_status?:string;payment_state?:string;venue_id?:string;owner_id?:string;user_id?:string;}
export async function listBookings(actor: BookingActor,query:BookingListQuery) {
  await assertBookingActor(actor);
  const values:unknown[]=[],clauses:string[]=[];
  const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
  if(actor.type!=='admin')clauses.push(`b.${actor.type}_id=${bind(actor.id)}`);
  for(const key of ['booking_status','payment_state','venue_id','owner_id','user_id'] as const)if(query[key]!==undefined)clauses.push(`b.${key}=${bind(query[key])}`);
  if(query.search){const search=bind(query.search);clauses.push(`(strpos(lower(b.booking_code),lower(${search}))>0 OR strpos(lower(v.venue_name),lower(${search}))>0)`);}
  values.push(query.limit,(query.page-1)*query.limit);
  const result=(await pool.query(`WITH matching AS (SELECT b.booking_id,b.booking_code,b.user_id,b.owner_id,b.venue_id,v.venue_name,b.booking_date,b.booking_from,b.booking_to,b.guest_count,b.booking_status,b.payment_state,b.is_advance_paid,b.advance_amount,b.payment_expires_at,b.created_at,p.total_amount
    FROM public.booking b JOIN public.venue_details v USING(venue_id) LEFT JOIN public.booking_price_details p USING(booking_id) ${clauses.length?'WHERE '+clauses.join(' AND '):''}),
    page_items AS (SELECT * FROM matching ORDER BY created_at DESC,booking_id DESC LIMIT $${values.length-1} OFFSET $${values.length})
    SELECT (SELECT count(*)::int FROM matching) AS total,coalesce((SELECT json_agg(page_items ORDER BY created_at DESC,booking_id DESC) FROM page_items),'[]'::json) AS items`,values)).rows[0];
  const totalPages=Math.ceil(result.total/query.limit);return {...result,page:query.page,limit:query.limit,totalPages,hasNextPage:query.page<totalPages,hasPreviousPage:query.page>1};
}

export async function listRefundReviews(actor:BookingActor,page:number,limit:number,status?:string) {
  if(actor.type!=='admin')httpError(403,'Admin required');await assertBookingActor(actor);
  const result=(await pool.query(`WITH matching AS (SELECT r.*,b.booking_code,b.venue_id FROM public.booking_refund_reviews r JOIN public.booking b USING(booking_id) WHERE ($1::text IS NULL OR r.status=$1)),
    page_items AS (SELECT * FROM matching ORDER BY created_at DESC,refund_review_id DESC LIMIT $2 OFFSET $3)
    SELECT (SELECT count(*)::int FROM matching) AS total,coalesce((SELECT json_agg(page_items ORDER BY created_at DESC,refund_review_id DESC) FROM page_items),'[]'::json) AS items`,[status??null,limit,(page-1)*limit])).rows[0];
  const totalPages=Math.ceil(result.total/limit);return {...result,page,limit,totalPages,hasNextPage:page<totalPages,hasPreviousPage:page>1};
}

export async function reviewBookingRefund(actor:BookingActor,bookingId:string,reviewId:string,decision:'approve'|'reject',reason:string) {
  if(actor.type!=='admin')httpError(403,'Admin required');
  return securityTransaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock($1)',[71003604]);await assertBookingActor(actor,client,'edit');
    const review=(await client.query('SELECT * FROM public.booking_refund_reviews WHERE refund_review_id=$1 AND booking_id=$2 FOR UPDATE',[reviewId,bookingId])).rows[0];
    if(!review)httpError(404,'Refund review not found');
    if(!['Pending','Failed'].includes(review.status))httpError(409,'Refund review has already been decided');
    await client.query(`UPDATE public.booking_refund_reviews SET status=$2,admin_reason=$3,reviewed_by=$4,attempts=0,next_attempt_at=now(),updated_at=now() WHERE refund_review_id=$1`,[reviewId,decision==='approve'?'Approved':'Rejected',reason,actor.id]);
    const booking=(await client.query('SELECT * FROM public.booking WHERE booking_id=$1',[bookingId])).rows[0];
    if(decision==='reject')await client.query("UPDATE public.booking SET payment_state='paid',updated_at=now() WHERE booking_id=$1 AND payment_state='refund_review'",[bookingId]);
    await enqueueBookingNotifications(client,booking,decision==='approve'?'refund_approved':'refund_denied',decision==='approve'?'An admin approved the refund. It is queued for Razorpay processing.':`An admin declined the refund: ${reason}`);
    return bookingRecord(client,actor,bookingId);
  });
}

export async function queueRefundReview(client: PoolClient,booking: Record<string,any>,payment: Record<string,any>,reason: string) {
  await client.query(`INSERT INTO public.booking_refund_reviews(refund_review_id,booking_id,booking_payment_id,amount,reason)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(booking_payment_id) DO NOTHING`,[generateId(),booking.booking_id,payment.booking_payment_id,payment.payment_amount,reason]);
  await client.query("UPDATE public.booking SET payment_state='refund_review',updated_at=now() WHERE booking_id=$1",[booking.booking_id]);
  await enqueueBookingNotifications(client,booking,'refund_review','The payment needs admin refund review. No automatic refund has been initiated.');
}

export async function decideBooking(actor: BookingActor,id: string,decision:'accept'|'reject',reason?:string) {
  if(actor.type!=='owner')httpError(403,'Owner authentication required');
  return bookingTransaction(async client=>{
    await assertBookingActor(actor,client,'read',true);
    const candidate=(await client.query('SELECT venue_id FROM public.booking WHERE booking_id=$1 AND owner_id=$2',[id,actor.id])).rows[0];if(!candidate)httpError(404,'Booking not found');
    const venue=(await client.query('SELECT * FROM public.venue_details WHERE venue_id=$1 FOR UPDATE',[candidate.venue_id])).rows[0];
    await expireUnpaidBookings(client,candidate.venue_id);
    const booking=(await client.query('SELECT * FROM public.booking WHERE booking_id=$1 AND owner_id=$2 FOR UPDATE',[id,actor.id])).rows[0];
    if(decision==='accept'){
      if(booking.booking_status==='Accepted')return bookingRecord(client,actor,id);
      if(booking.booking_status!=='Requested'||booking.payment_state!=='awaiting_acceptance')httpError(409,'Only a requested booking can be accepted');
      if(!venue.is_active||venue.status!=='Active'||venue.owner_id!==actor.id)httpError(409,'Venue is not available');
      if(booking.booking_from.getTime()<=Date.now())httpError(409,'Booking start time has passed');
      const required=paise(booking.advance_amount)>0n;
      await client.query(`UPDATE public.booking SET booking_status='Accepted',payment_state=$2,payment_expires_at=CASE WHEN $3 THEN least(booking_from,now()+($4::int*interval '1 minute')) ELSE NULL END,updated_at=now() WHERE booking_id=$1`,[id,required?'awaiting_payment':'not_required',required,paymentWindowMinutes()]);
      if(!required)await client.query("UPDATE public.booking_payment_details SET booking_payment_status='Other',booking_other_payment_status='No advance required',updated_at=now() WHERE booking_payment_id=$1",[booking.booking_payment_id]);
      await enqueueBookingNotifications(client,booking,'accepted',required?`The owner accepted your booking. Pay the INR ${booking.advance_amount} advance within ${paymentWindowMinutes()} minutes.`:'The owner accepted your booking. No advance payment is required.');
    }else{
      if(booking.booking_status==='Rejected')return bookingRecord(client,actor,id);
      if(!['Requested','Accepted'].includes(booking.booking_status))httpError(409,'This booking cannot be rejected');
      await client.query("UPDATE public.booking SET booking_status='Rejected',reason=$2,payment_expires_at=NULL,updated_at=now() WHERE booking_id=$1",[id,reason]);
      const paid=(await client.query("SELECT * FROM public.booking_payment_details WHERE booking_id=$1 AND booking_payment_status='Completed'",[id])).rows;
      for(const payment of paid)await queueRefundReview(client,booking,payment,reason??'Owner rejected the paid booking');
      await enqueueBookingNotifications(client,booking,'rejected',`The owner rejected your booking. ${reason??''}`);
    }
    return bookingRecord(client,actor,id);
  });
}
