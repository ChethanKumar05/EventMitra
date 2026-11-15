import { Request, Response } from 'express';
import { BookingActor, NotificationRecipient } from '../types/booking';
import { userSessionToken } from '../middleware/userAuth';
import { ownerSessionToken } from '../middleware/ownerAuth';
import { sessionToken } from '../middleware/adminAuth';
import { handler,recordId,text } from './securityValidation';
import { userBody } from './userValidation';
import { bookingIdempotencyKey,bookingInput } from './bookingValidation';
import * as service from '../services/bookingService';
import * as payments from '../services/bookingPaymentService';
import { success } from '../utils/response';
import { httpError } from '../utils/httpError';

export function bookingActor(req:Request,res:Response,type:NotificationRecipient):BookingActor {
  return {type,id:res.locals[type][`${type}_id`],token:type==='user'?userSessionToken(req):type==='owner'?ownerSessionToken(req):sessionToken(req)};
}
export function requestPagination(query:Request['query']):{page:number;limit:number} {
  const integer=(key:string,fallback:number,max:number)=>{
    const value=query[key];if(value===undefined)return fallback;
    if(typeof value!=='string'||!/^[1-9][0-9]*$/.test(value)||Number(value)>max)httpError(400,`Invalid ${key}`);return Number(value);
  };return {page:integer('page',1,1000000),limit:integer('limit',20,100)};
}
function bookingListQuery(query:Request['query'],admin:boolean):service.BookingListQuery {
  const allowed=['page','limit','search','booking_status','payment_state','venue_id',...(admin?['owner_id','user_id']:[])];
  for(const key of Object.keys(query))if(!allowed.includes(key))httpError(400,`Unsupported query parameter: ${key}`);
  const result:service.BookingListQuery=requestPagination(query);
  for(const key of ['search','booking_status','payment_state','venue_id','owner_id','user_id'] as const){
    if(query[key]===undefined)continue;result[key]=text(query[key],key,key.endsWith('_id')?26:200);
  }
  if(result.booking_status&&!['Requested','Accepted','Rejected','Cancelled','Pending','Hold'].includes(result.booking_status))httpError(400,'Invalid booking_status');
  if(result.payment_state&&!['legacy','awaiting_acceptance','awaiting_payment','paid','not_required','expired','refund_review','refunded'].includes(result.payment_state))httpError(400,'Invalid payment_state');
  return result;
}
export function bookingController(type:NotificationRecipient) {
  return {
    list:handler(async(req,res)=>success(res,'Bookings',await service.listBookings(bookingActor(req,res,type),bookingListQuery(req.query,type==='admin')))),
    get:handler(async(req,res)=>success(res,'Booking',await service.getBooking(bookingActor(req,res,type),recordId(req.params.bookingId)))),
    quote:handler(async(req,res)=>success(res,'Server-calculated booking quote',await service.quoteBooking(bookingActor(req,res,type),bookingInput(req.body)))),
    create:handler(async(req,res)=>{
      const input=bookingInput(req.body),key=bookingIdempotencyKey(req.get('Idempotency-Key'));
      const result=await service.createBooking(bookingActor(req,res,type),input,key);success(res,result.created?'Booking requested; awaiting owner acceptance':'Existing booking request',result.booking,result.created?201:200);
    }),
    decision:handler(async(req,res)=>{
      const id=recordId(req.params.bookingId),body=userBody(req.body,['decision','reason']);
      if(body.decision!=='accept'&&body.decision!=='reject')httpError(400,'decision must be accept or reject');
      const reason=body.decision==='reject'?text(body.reason,'reason',2000):body.reason===undefined?undefined:text(body.reason,'reason',2000);
      success(res,'Booking decision saved',await service.decideBooking(bookingActor(req,res,type),id,body.decision,reason));
    }),
    paymentOrder:handler(async(req,res)=>{
      const result=await payments.createBookingPaymentOrder(bookingActor(req,res,type),recordId(req.params.bookingId));success(res,result.pending?'Payment order is being reconciled':'Razorpay checkout order',result,result.pending?202:200);
    }),
    verifyPayment:handler(async(req,res)=>{
      const id=recordId(req.params.bookingId),body=userBody(req.body,['razorpay_order_id','razorpay_payment_id','razorpay_signature']);
      for(const [key,prefix]of [['razorpay_order_id','order'],['razorpay_payment_id','pay']] as const)if(typeof body[key]!=='string'||!new RegExp(`^${prefix}_[A-Za-z0-9]{1,80}$`).test(body[key] as string))httpError(400,`Invalid ${key}`);
      if(typeof body.razorpay_signature!=='string'||!/^[a-f0-9]{64}$/.test(body.razorpay_signature))httpError(400,'Invalid razorpay_signature');
      const result=await payments.confirmBookingPayment(bookingActor(req,res,type),id,body as {razorpay_order_id:string;razorpay_payment_id:string;razorpay_signature:string});
      success(res,result.pending?'Awaiting Razorpay capture':'Payment verified',result.booking,result.pending?202:200);
    }),
    refundReviews:handler(async(req,res)=>{
      for(const key of Object.keys(req.query))if(!['page','limit','status'].includes(key))httpError(400,'Unsupported refund query');
      const {page,limit}=requestPagination(req.query),status=req.query.status===undefined?undefined:text(req.query.status,'status',20);
      if(status&&!['Pending','Approved','Rejected','Processing','Processed','Failed'].includes(status))httpError(400,'Invalid refund status');
      success(res,'Refund reviews',await service.listRefundReviews(bookingActor(req,res,type),page,limit,status));
    }),
    refundDecision:handler(async(req,res)=>{
      const bookingId=recordId(req.params.bookingId),reviewId=recordId(req.params.reviewId),body=userBody(req.body,['decision','reason']);
      if(body.decision!=='approve'&&body.decision!=='reject')httpError(400,'decision must be approve or reject');
      success(res,'Refund decision saved',await service.reviewBookingRefund(bookingActor(req,res,type),bookingId,reviewId,body.decision,text(body.reason,'reason',2000)));
    }),
  };
}
export const razorpayWebhook=handler(async(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!Buffer.isBuffer(req.body))httpError(400,'Raw JSON webhook body required');
  const signature=req.get('x-razorpay-signature'),eventId=req.get('x-razorpay-event-id');
  if(!signature||!eventId||!/^[A-Za-z0-9_-]{1,150}$/.test(eventId))httpError(400,'Webhook signature and event ID are required');
  success(res,'Webhook processed',await payments.handleRazorpayWebhook(req.body,signature,eventId));
});
