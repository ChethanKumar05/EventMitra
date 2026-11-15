import { httpError } from './httpError';
export function paise(value: unknown): bigint {
  const raw = String(value ?? 0);
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(raw)) httpError(409, 'Invalid configured price');
  const [whole = '0', fraction = ''] = raw.split('.'); return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
export function rupees(value: bigint): string {
  if (value < 0n || value > 999999999999n) httpError(409, 'Booking amount exceeds the supported range');
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}
export function bookingTaxBps(): number {
  const value = Number(process.env.BOOKING_TAX_BPS ?? 0);
  if (!Number.isInteger(value) || value < 0 || value > 10000) httpError(503, 'Invalid BOOKING_TAX_BPS configuration'); return value;
}
export function paymentWindowMinutes(): number {
  const value = Number(process.env.BOOKING_PAYMENT_WINDOW_MINUTES ?? 30);
  if (!Number.isInteger(value) || value < 5 || value > 1440) httpError(503, 'Invalid booking payment window configuration'); return value;
}
