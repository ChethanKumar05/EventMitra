import { Response } from 'express';

export function success<T>(res: Response, message: string, data: T, statusCode = 200) {
  return res.status(statusCode).json({ status: true, message, code: statusCode, data });
}

export function failure(res: Response, message: string, statusCode = 400) {
  return res.status(statusCode).json({ status: false, message, code: statusCode, data: null });
}
