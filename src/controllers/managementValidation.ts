import { Request } from 'express';
import { accountFields, AccountInput, ManagementListQuery, PersonKind, ProfileInput } from '../types/management';
import { httpError } from '../utils/httpError';
import { normalizeEmail, validatePhone } from '../utils/adminValidation';
import { checkPassword } from '../security/password';
import { text } from './securityValidation';
import { userBody, userSignupInput } from './userValidation';
import { ownerName, signupInput } from './ownerValidation';

const userFields = ['country_code', 'user_phone_number', 'user_name', 'gender', 'email', 'profile_image', 'whatsapp_number', 'alternative_number'];
const ownerFields = ['country_code', 'owner_phone_number', 'owner_name', 'gender', 'email', 'profile_image', 'whatsapp_number', 'alternative_number', 'alternative_email', 'password', 'doc_type', 'doc_number', 'doc_image', 'pin_code', 'state', 'city', 'area', 'lat', 'long', 'address'];
const statuses = ['pending', 'verified', 'rejected', 'blocked', 'hold', 'deleted'];

export function managementProfileInput(kind: PersonKind, value: unknown, create = false): ProfileInput {
  const fields = kind === 'user' ? userFields : ownerFields;
  const body = userBody(value, [...fields, 'status', 'reason', kind === 'user' ? 'is_active' : 'kyc_verification']);
  const input: ProfileInput = {};
  if (create) {
    const signupBody = Object.fromEntries(Object.entries(body).filter(([key]) => fields.includes(key)));
    Object.assign(input, kind === 'user' ? userSignupInput(signupBody) : signupInput(signupBody));
  } else {
    const optional = (value: unknown, fn: (value: unknown) => string) => value === null || value === '' ? null : fn(value);
    for (const field of fields) {
      const value = body[field];
      if (value === undefined) continue;
      if (field === 'password') { checkPassword(value); input.password = value; }
      else if (field === 'country_code') {
        if (typeof value !== 'string' || !/^\+[1-9][0-9]{0,2}$/.test(value)) httpError(400, 'Invalid country_code');
        input[field] = value;
      } else if (field === `${kind}_phone_number`) {
        if (typeof value !== 'string' || !/^[1-9][0-9]{6,14}$/.test(value)) httpError(400, `Invalid ${field}`);
        input[field] = value;
      } else if (field === 'owner_name') input[field] = ownerName(value);
      else if (field === 'user_name') {
        input[field] = text(value, field, 150).replace(/\s+/g, ' ');
        if (typeof value === 'string' && /[\u0000-\u001f\u007f]/.test(value)) httpError(400, 'Invalid user_name');
      } else if (field === 'email' || field === 'alternative_email') {
        input[field] = kind === 'owner' && field === 'email' ? normalizeEmail(value) : optional(value, normalizeEmail);
      } else if (field === 'gender') {
        if (value !== 'm' && value !== 'f') httpError(400, 'gender must be m or f'); input.gender = value;
      } else if (field === 'alternative_number' || field === 'whatsapp_number') input[field] = optional(value, validatePhone);
      else if (field === 'lat' || field === 'long') {
        const max = field === 'lat' ? 90 : 180;
        if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > max) httpError(400, `Invalid ${field}`);
        input[field] = value;
      } else if (field === 'pin_code') {
        const pin = text(value, field, 12); if (!/^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/.test(pin)) httpError(400, 'Invalid pin_code'); input[field] = pin;
      } else {
        const max = ['profile_image', 'doc_image'].includes(field) ? 2048 : field === 'address' ? 2000 : field === 'doc_type' ? 50 : field === 'area' ? 150 : 100;
        input[field] = field === 'profile_image' ? optional(value, v => text(v, field, max)) : text(value, field, max);
      }
    }
  }
  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !statuses.includes(body.status)) httpError(400, 'Invalid status');
    input.status = body.status;
  }
  if (body.reason !== undefined) input.reason = body.reason === null || body.reason === '' ? null : text(body.reason, 'reason', 2000);
  for (const field of ['is_active', 'kyc_verification']) if (body[field] !== undefined) {
    if (typeof body[field] !== 'boolean') httpError(400, `${field} must be boolean`); input[field] = body[field];
  }
  if (!Object.keys(input).length) httpError(400, 'At least one field is required');
  return input;
}

export function bankAccountInput(value: unknown, create = false): AccountInput {
  const body = userBody(value, accountFields), input: AccountInput = {};
  for (const field of ['account_number', 'branch_address', 'ifsc_code', 'branch_name', 'account_holder_name'] as const) {
    if (!create && body[field] === undefined) continue;
    const val = text(body[field], field, field === 'branch_address' ? 2000 : field === 'account_number' ? 34 : field === 'ifsc_code' ? 11 : 150);
    if (field === 'account_number' && !/^[0-9]{6,34}$/.test(val)) httpError(400, 'account_number must contain 6-34 digits as a string');
    if (field === 'ifsc_code' && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(val.toUpperCase())) httpError(400, 'Invalid ifsc_code');
    input[field] = field === 'ifsc_code' ? val.toUpperCase() : val;
  }
  if (body.passbook_image !== undefined) input.passbook_image = body.passbook_image === null || body.passbook_image === '' ? null : text(body.passbook_image, 'passbook_image', 2048);
  if (body.is_default !== undefined) {
    if (typeof body.is_default !== 'boolean') httpError(400, 'is_default must be boolean'); input.is_default = body.is_default;
  }
  if (!Object.keys(input).length) httpError(400, 'At least one account field is required');
  return input;
}

export function defaultAccountInput(value: unknown): AccountInput {
  const body = userBody(value, ['is_default']);
  if (typeof body.is_default !== 'boolean') httpError(400, 'is_default must be boolean');
  return { is_default: body.is_default };
}

export function managementListQuery(query: Request['query'], columns: readonly string[]): ManagementListQuery {
  const allowed = ['page', 'limit', 'search', 'search_column', 'sort_by', 'sort_order', ...columns];
  for (const key of Object.keys(query)) if (!allowed.includes(key)) httpError(400, `Unsupported query parameter: ${key}`);
  const scalar = (key: string, max = 200): string | undefined => {
    const value = query[key]; if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > max || !value.trim()) httpError(400, `Invalid ${key}`);
    return value.trim();
  };
  const integer = (key: string, fallback: number, max: number) => {
    const value = scalar(key, 10); if (value === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(value) || Number(value) > max) httpError(400, `Invalid ${key}`); return Number(value);
  };
  const search_column = scalar('search_column', 50), sort_by = scalar('sort_by', 50), sort_order = scalar('sort_order', 4);
  if (search_column && search_column !== 'all' && !columns.includes(search_column)) httpError(400, 'Invalid search_column');
  if (sort_by && !columns.includes(sort_by)) httpError(400, 'Invalid sort_by');
  if (sort_order && sort_order !== 'asc' && sort_order !== 'desc') httpError(400, 'Invalid sort_order');
  const filters: Record<string, string> = {};
  for (const column of columns) {
    const value = scalar(column, column === 'branch_address' ? 2000 : 200);
    if (value === undefined) continue;
    if ((column.startsWith('is_') || column === 'kyc_verification') && value !== 'true' && value !== 'false') httpError(400, `Invalid ${column}`);
    if (column === 'status' && !statuses.includes(value)) httpError(400, 'Invalid status');
    if (column === 'gender' && !['m', 'f'].includes(value)) httpError(400, 'Invalid gender');
    filters[column] = value;
  }
  return { page: integer('page', 1, 1000000), limit: integer('limit', 20, 100), search: scalar('search'), search_column, sort_by, sort_order: sort_order as 'asc' | 'desc' | undefined, filters };
}
