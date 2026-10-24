import { normalizeEmail, validatePhone } from '../utils/adminValidation';
import { httpError } from '../utils/httpError';
import { UserPhone, UserSignupInput } from '../types/user';
import { text } from './securityValidation';

export function userBody(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) httpError(400, 'JSON object required');
  const body = value as Record<string, unknown>;
  for (const field of Object.keys(body)) {
    if (!allowed.includes(field)) httpError(400, `Unexpected field: ${field}`);
  }
  return body;
}

function phoneFields(body: Record<string, unknown>): UserPhone {
  const country = body.country_code, phone = body.user_phone_number;
  if (typeof country !== 'string' || !/^\+[1-9][0-9]{0,2}$/.test(country)) {
    httpError(400, 'country_code must be a calling code such as +91');
  }
  if (typeof phone !== 'string' || !/^[1-9][0-9]{6,14}$/.test(phone) || country.length - 1 + phone.length > 15) {
    httpError(400, 'user_phone_number must be a string of 7-15 digits without a country prefix; combined international number must not exceed 15 digits');
  }
  return { country_code: country, user_phone_number: phone };
}

export function userPhoneInput(value: unknown): UserPhone {
  return phoneFields(userBody(value, ['country_code', 'user_phone_number']));
}

export function userSignupInput(value: unknown): UserSignupInput {
  const body = userBody(value, ['country_code', 'user_phone_number', 'email', 'gender', 'user_name', 'profile_image', 'whatsapp_number', 'alternative_number']);
  const phone = phoneFields(body);
  if (body.gender !== 'm' && body.gender !== 'f') httpError(400, 'gender must be m or f');
  const name = text(body.user_name, 'user_name', 150).replace(/\s+/g, ' ');
  if (typeof body.user_name === 'string' && /[\u0000-\u001f\u007f]/.test(body.user_name)) httpError(400, 'Invalid user_name');
  const optional = <T>(value: unknown, validate: (value: unknown) => T): T | null =>
    value === undefined || value === null || value === '' ? null : validate(value);
  return {
    ...phone, user_name: name, gender: body.gender,
    email: optional(body.email, normalizeEmail),
    profile_image: optional(body.profile_image, value => text(value, 'profile_image', 2048)),
    whatsapp_number: optional(body.whatsapp_number, validatePhone),
    alternative_number: optional(body.alternative_number, validatePhone),
  };
}

export function userOtpInput(value: unknown): { otp: string; otp_token: string } {
  const body = userBody(value, ['otp', 'otp_token']);
  if (typeof body.otp !== 'string' || !/^\d{4}$/.test(body.otp)) httpError(400, 'otp must be a four-digit string');
  if (typeof body.otp_token !== 'string' || !/^[a-f0-9]{64}$/.test(body.otp_token)) httpError(400, 'Invalid otp_token');
  return { otp: body.otp, otp_token: body.otp_token };
}
