import { ErrorRequestHandler, RequestHandler } from 'express';
import { failure } from '../utils/response';
export const notFound: RequestHandler = (req, res) => { failure(res, `Route not found: ${req.method} ${req.path}`, 404); };
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (['23505','23503'].includes(err?.code)) { failure(res, err.code === '23505' ? 'Record already exists' : 'Referenced record is missing or still in use', 409); return; }
  if (err?.status >= 400 && err?.status < 500) { failure(res, err.message, err.status); return; }
  console.error('HTTP request failed:', err);
  failure(res, 'Internal server error', 500);
};
