import { Request } from 'express';
import { DiscoveryQuery, BookingInput } from '../types/booking';
import { httpError } from '../utils/httpError';
import { normalizeEmail } from '../utils/adminValidation';
import { userBody } from './userValidation';
import { recordId } from './securityValidation';

export function bookingDate(value:unknown):string{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.startsWith('0000'))httpError(400,'booking_date must be YYYY-MM-DD');
  const parsed=new Date(value+'T00:00:00Z');
  if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)httpError(400,'Invalid booking_date');
  return value;
}

export function venueDetailDate(query:Request['query']):string|undefined{
  for(const key of Object.keys(query))if(key!=='booking_date')httpError(400,`Unsupported query parameter: ${key}`);
  return query.booking_date===undefined?undefined:bookingDate(query.booking_date);
}

export function discoveryQuery(query: Request['query']): DiscoveryQuery {
  const allowed = ['page', 'limit', 'search', 'city', 'state', 'area', 'pin_code', 'lat', 'long', 'distance_km', 'min_rating', 'sort_by','booking_date'];
  for (const key of Object.keys(query)) if (!allowed.includes(key)) httpError(400, `Unsupported query parameter: ${key}`);
  const string = (key: string, max = 200): string | undefined => {
    const value = query[key]; if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > max) httpError(400, `Invalid ${key}`); return value.trim();
  };
  const number = (key: string, min: number, max: number): number | undefined => {
    const value = string(key, 30); if (value === undefined) return undefined;
    if (!/^-?[0-9]+(?:\.[0-9]+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) httpError(400, `Invalid ${key}`); return Number(value);
  };
  const page = number('page', 1, 1000000) ?? 1, limit = number('limit', 1, 100) ?? 20;
  if (!Number.isInteger(page) || !Number.isInteger(limit)) httpError(400, 'page and limit must be integers');
  const lat = number('lat', -90, 90), long = number('long', -180, 180), radius = number('distance_km', 0.001, 20040);
  if ((lat === undefined) !== (long === undefined)) httpError(400, 'Provide both lat and long');
  const sort = string('sort_by', 10) ?? (lat !== undefined ? 'distance' : 'rating');
  if (sort !== 'distance' && sort !== 'rating') httpError(400, 'sort_by must be distance or rating');
  if ((sort === 'distance' || radius !== undefined) && lat === undefined) httpError(400, 'Distance sorting/filtering requires lat and long');
  return { page, limit, search: string('search'), city: string('city', 100), state: string('state', 100), area: string('area', 150), pin_code: string('pin_code', 12), lat, long, distance_km: radius, min_rating: number('min_rating', 0, 5), sort_by: sort,booking_date:query.booking_date===undefined?undefined:bookingDate(query.booking_date) };
}

export function bookingInput(value: unknown): BookingInput {
  const body = userBody(value, ['venue_price_id', 'booking_date', 'guest_count', 'include_decoration', 'include_meals', 'contact_email']);
  const date = bookingDate(body.booking_date);
  if (typeof body.guest_count !== 'number' || !Number.isInteger(body.guest_count) || body.guest_count < 1 || body.guest_count > 100000) httpError(400, 'guest_count must be an integer between 1 and 100000');
  for (const key of ['include_decoration', 'include_meals']) if (body[key] !== undefined && typeof body[key] !== 'boolean') httpError(400, `${key} must be boolean`);
  return { venue_price_id: recordId(body.venue_price_id), booking_date: date, guest_count: body.guest_count, include_decoration: body.include_decoration === true, include_meals: body.include_meals === true, ...(body.contact_email !== undefined ? { contact_email: normalizeEmail(body.contact_email) } : {}) };
}

export function bookingIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(value)) httpError(400, 'Idempotency-Key header is required (16-100 letters, digits, underscores or hyphens)'); return value;
}
