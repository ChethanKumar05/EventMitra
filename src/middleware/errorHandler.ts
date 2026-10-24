import { ErrorRequestHandler, RequestHandler } from 'express';
import { failure } from '../utils/response';

export const notFound: RequestHandler = (req, res) => {
  failure(res, `Route not found: ${req.method} ${req.path}`, 404);
};

export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  console.error('HTTP request failed:', err);
  failure(res, 'Internal server error', 500);
};
