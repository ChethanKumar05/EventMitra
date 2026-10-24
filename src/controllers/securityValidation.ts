import { Request, RequestHandler, Response } from 'express';
import { checkPassword } from '../security/password';
import { httpError } from '../utils/httpError';
export const handler = (callback: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { void callback(req, res).catch(next); };
export function text(value: unknown, name: string, max = 150): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) httpError(400, `Invalid ${name}`);
  return value.trim();
}
export { normalizeEmail as email,validateUsername as username,validatePhone as phone } from '../utils/adminValidation';
export function recordId(value: unknown): string { return text(value, 'ID', 26); }
export function requestBody(value: unknown, generatedCode: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) httpError(400, 'JSON object required');
  const body = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(body, generatedCode)) httpError(400, `${generatedCode} is generated automatically and cannot be supplied`);
  return body;
}
export function password(value: unknown): string { checkPassword(value); return value; }
export function permissionIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000) httpError(400, 'Invalid permission_ids');
  return [...new Set(value.map(recordId))];
}

export function uniqueName(value:unknown,name:string,max=150):string { return text(value,name,max).replace(/\s+/g,' '); }
