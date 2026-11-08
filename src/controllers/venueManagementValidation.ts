import { Request } from 'express';
import { normalizeEmail, validatePhone } from '../utils/adminValidation';
import { httpError } from '../utils/httpError';
import { ManagedVenueQuery, managedVenueColumns, VenueInput, VenuePart, venuePartIdFields, venueStatuses } from '../types/venueManagement';
import { managementListQuery } from './managementValidation';
import { recordId, text } from './securityValidation';

const integers = ['venue_hall_capacity', 'venue_dining_capacity', 'venue_available_rooms_count', 'venue_parking_capacity', 'venue_year_established'];
const venueArrays = ['venue_images', 'venue_documents', 'refund_policy', 'cancellation_policy'];
const venueText = ['venue_name', 'pin_code', 'state', 'city', 'area', 'venue_number', 'venue_alternative_number', 'venue_website_url', 'email', 'description'];
const amenities = ['is_chairs_available', 'is_ac_available', 'is_fan_available', 'is_guest_room_available', 'is_parking_available', 'is_washroom_available'];
const partFields: Record<VenuePart, string[]> = {
  'type-slots': ['slot_name', 'from_time', 'to_time', 'description', 'is_active'],
  amenities,
  prices: ['venue_type_slot_id', 'venue_from_date', 'venue_to_date', 'venue_from_time', 'venue_to_time', 'venue_price', 'venue_advance_price',
    'venue_decoration_id', 'venue_decoration_from_date', 'venue_decoration_to_date', 'venue_decoration_from_time', 'venue_decoration_to_time',
    'venue_meals_id', 'venue_meals_from_date', 'venue_meals_to_date', 'venue_meals_from_time', 'venue_meals_to_time'],
  decorations: ['venue_decoration_name', 'venue_decoration_images', 'venue_decoration_price', 'venue_decoration_advance_price', 'advance_return_within_date', 'is_cancellation_availble', 'cancelation_policy', 'return_policy'],
  meals: ['meal_deatails', 'is_veg', 'is_non_veg', 'per_plate_price', 'meals_advance_price', 'advance_return_within_date', 'is_cancellation_availble', 'cancelation_policy', 'return_policy'],
};

function bodyObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) httpError(400, 'JSON object required');
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!allowed.includes(key)) httpError(400, `Unexpected field: ${key}`);
  return body;
}
function boolean(value: unknown, key: string): boolean {
  if (typeof value !== 'boolean') httpError(400, `${key} must be boolean`); return value;
}
function strings(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.length > 100) httpError(400, `${key} must be an array with at most 100 strings`);
  return value.map(item => text(item, key, key.includes('policy') ? 2000 : 2048));
}
function decimal(value: unknown, key: string, integralDigits = 10): string {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'number' && !Number.isFinite(value))) httpError(400, `Invalid ${key}`);
  const str = String(value);
  if (!new RegExp(`^(0|[1-9][0-9]{0,${integralDigits - 1}})(\\.[0-9]{1,2})?$`).test(str)) httpError(400, `${key} must be nonnegative with at most two decimal places`);
  return str;
}
function date(value: unknown, key: string): string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) httpError(400, `Invalid ${key}`);
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) httpError(400, `Invalid ${key}`);
  return value;
}
function time(value: unknown, key: string): string {
  if (typeof value !== 'string' || !/^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/.test(value)) httpError(400, `Invalid ${key}; use HH:mm or HH:mm:ss`);
  return value.length === 5 ? value + ':00' : value;
}

export function managedVenueInput(value: unknown, admin: boolean, create = false): VenueInput {
  const body = bodyObject(value, [...integers, ...venueArrays, ...venueText, 'lat', 'long', 'venue_length', 'venue_width', 'venue_height', 'is_active', 'is_cancellation_availble', ...(admin ? ['status', 'reason', ...(create ? ['owner_id'] : [])] : [])]);
  const input: VenueInput = {};
  if (create) input.venue_name = text(body.venue_name, 'venue_name', 200);
  if (create && admin) input.owner_id = recordId(body.owner_id);
  for (const [key, val] of Object.entries(body)) {
    if (key === 'owner_id') continue;
    if (venueArrays.includes(key)) input[key] = strings(val, key);
    else if (integers.includes(key)) {
      if (val === null) { input[key] = null; continue; }
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 0 || val > 2147483647 || (key === 'venue_year_established' && (val < 1800 || val > 2200))) httpError(400, `Invalid ${key}`);
      input[key] = val;
    } else if (key === 'lat' || key === 'long') {
      if (val === null) { input[key] = null; continue; }
      if (typeof val !== 'number' || !Number.isFinite(val) || Math.abs(val) > (key === 'lat' ? 90 : 180)) httpError(400, `Invalid ${key}`);
      input[key] = val;
    } else if (['venue_length', 'venue_width', 'venue_height'].includes(key)) input[key] = val === null ? null : decimal(val, key, 8);
    else if (key === 'is_active' || key === 'is_cancellation_availble') input[key] = boolean(val, key);
    else if (key === 'status') {
      if (typeof val !== 'string' || !(venueStatuses as readonly string[]).includes(val)) httpError(400, 'Invalid status'); input.status = val;
    } else if (key === 'venue_name') input[key] = text(val, key, 200);
    else if (val === null || val === '') input[key] = null;
    else if (key === 'email') input[key] = normalizeEmail(val);
    else if (key === 'venue_number' || key === 'venue_alternative_number') input[key] = validatePhone(val);
    else if (key === 'venue_website_url') {
      const website = text(val, key, 2048);
      try { const url = new URL(website); if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) httpError(400, 'Invalid venue_website_url'); }
      catch { httpError(400, 'Invalid venue_website_url'); }
      input[key] = website;
    } else {
      const max = key === 'description' ? 10000 : key === 'reason' ? 2000 : key === 'area' ? 150 : key === 'pin_code' ? 12 : 100;
      input[key] = text(val, key, max);
      if (key === 'pin_code' && !/^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/.test(input[key] as string)) httpError(400, 'Invalid pin_code');
    }
  }
  if (!Object.keys(input).length) httpError(400, 'At least one venue field is required');
  return input;
}

export function venuePartInput(part: VenuePart, value: unknown, create = false): VenueInput {
  const body = bodyObject(value, partFields[part]), input: VenueInput = {};
  if (create) {
    const required = part === 'type-slots' ? ['slot_name', 'from_time', 'to_time'] : part === 'prices' ? ['venue_type_slot_id', 'venue_from_date', 'venue_to_date', 'venue_from_time', 'venue_to_time', 'venue_price'] : part === 'decorations' ? ['venue_decoration_name'] : [];
    for (const key of required) if (body[key] === undefined || body[key] === null) httpError(400, `${key} is required`);
  }
  for (const [key, val] of Object.entries(body)) {
    if (key.startsWith('is_')) input[key] = boolean(val, key);
    else if (key.endsWith('_id')) input[key] = val === null && key !== 'venue_type_slot_id' ? null : recordId(val);
    else if (key.endsWith('_date')) input[key] = val === null && !['venue_from_date', 'venue_to_date'].includes(key) ? null : date(val, key);
    else if (key.endsWith('_time')) input[key] = val === null && !['from_time', 'to_time', 'venue_from_time', 'venue_to_time'].includes(key) ? null : time(val, key);
    else if (key.endsWith('_price')) input[key] = decimal(val, key);
    else if (['venue_decoration_images', 'meal_deatails', 'cancelation_policy', 'return_policy'].includes(key)) input[key] = strings(val, key);
    else if (key === 'description') input[key] = val === null || val === '' ? null : text(val, key, 10000);
    else input[key] = text(val, key, key === 'slot_name' ? 100 : 150);
  }
  if (!Object.keys(input).length) httpError(400, 'At least one field is required');
  return input;
}

export function venuePartSaveInput(part: VenuePart, value: unknown): { input: VenueInput; partId?: string } {
  const idField = venuePartIdFields[part];
  const body = bodyObject(value, [...partFields[part], ...(part === 'amenities' ? [] : [idField])]);
  const partId = body[idField] == null ? undefined : recordId(body[idField]);
  const fields = Object.fromEntries(Object.entries(body).filter(([key]) => key !== idField));
  return { input: venuePartInput(part, fields, partId === undefined), partId };
}

export function managedVenueListQuery(query: Request['query'], admin: boolean): ManagedVenueQuery {
  const { min_capacity, max_capacity, ...rest } = query;
  const result: ManagedVenueQuery = managementListQuery(rest, managedVenueColumns.filter(column => admin || column !== 'owner_id'), venueStatuses);
  for (const [key, value] of Object.entries({ min_capacity, max_capacity })) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > 2147483647) httpError(400, `Invalid ${key}`);
    result[key as 'min_capacity' | 'max_capacity'] = Number(value);
  }
  if (result.min_capacity !== undefined && result.max_capacity !== undefined && result.min_capacity > result.max_capacity) httpError(400, 'min_capacity must not exceed max_capacity');
  return result;
}
