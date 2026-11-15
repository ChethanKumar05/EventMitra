import { createHmac, timingSafeEqual } from 'node:crypto';
import { httpError } from '../utils/httpError';

export interface RazorpayOrder { id: string; amount: number; amount_paid: number; currency: string; status: string; receipt: string; notes?: Record<string,string>; }
export interface RazorpayPayment { id: string; order_id: string; amount: number; currency: string; status: string; captured: boolean; amount_refunded: number; }
export interface RazorpayRefund { id: string; payment_id: string; amount: number; currency: string; status: string; receipt?: string; }

export function razorpayConfigured(): boolean { return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET); }
export function razorpayKeyId(): string {
  if (!razorpayConfigured()) httpError(503,'Razorpay credentials are not configured'); return process.env.RAZORPAY_KEY_ID!;
}
async function request<T>(path: string, method = 'GET', body?: unknown, extraHeaders: Record<string,string> = {}): Promise<T> {
  const keyId = razorpayKeyId();
  try {
    const response = await fetch('https://api.razorpay.com/v1'+path, { method, headers: { Authorization: 'Basic '+Buffer.from(`${keyId}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64'),'Content-Type':'application/json',...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(15000) });
    if (!response.ok) httpError(503,'Razorpay request failed; payment state will be reconciled');
    return await response.json() as T;
  } catch { return httpError(503,'Razorpay is unavailable; payment state will be reconciled'); }
}
export function verifyRazorpaySignature(message: string | Buffer, signature: string, secret: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(createHmac('sha256',secret).update(message).digest(),Buffer.from(signature,'hex'));
}
export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
  razorpayKeyId();return verifyRazorpaySignature(`${orderId}|${paymentId}`,signature,process.env.RAZORPAY_KEY_SECRET!);
}
export const createRazorpayOrder = (paymentId: string,bookingId: string,amount: number) => request<RazorpayOrder>('/orders','POST',{ amount,currency:'INR',receipt:paymentId,partial_payment:false,notes:{booking_id:bookingId,payment_attempt_id:paymentId} });
export const fetchRazorpayOrder = (id: string) => request<RazorpayOrder>('/orders/'+encodeURIComponent(id));
export const fetchRazorpayPayment = (id: string) => request<RazorpayPayment>('/payments/'+encodeURIComponent(id));
export const fetchRazorpayOrderPayments = (id: string) => request<{items:RazorpayPayment[]}>('/orders/'+encodeURIComponent(id)+'/payments');
export const findRazorpayOrders = (receipt: string) => request<{items:RazorpayOrder[]}>('/orders?receipt='+encodeURIComponent(receipt)+'&count=100');
export const createRazorpayRefund = (paymentId: string,reviewId: string,amount: number) => request<RazorpayRefund>('/payments/'+encodeURIComponent(paymentId)+'/refund','POST',{amount,speed:'normal',receipt:reviewId},{'X-Refund-Idempotency':reviewId});
export const fetchRazorpayRefund = (id: string) => request<RazorpayRefund>('/refunds/'+encodeURIComponent(id));
