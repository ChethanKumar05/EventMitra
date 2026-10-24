import { Request, RequestHandler } from 'express';
import { findSessionUser } from '../services/userAuthService';
import { httpError } from '../utils/httpError';

export const userCookieName = process.env.NODE_ENV === 'production' ? '__Host-eventmitra-user' : 'eventmitra_user_session';
export const userCookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/' };

export function userSessionToken(req: Request): string {
  const cookie = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${userCookieName}=`));
  const token = cookie?.slice(userCookieName.length + 1) ?? '';
  return /^[a-f0-9]{64}$/.test(token) ? token : '';
}

export const authenticateUser: RequestHandler = (req, res, next) => {
  void (async () => {
    const token = userSessionToken(req);
    if (!token) httpError(401, 'User authentication required');
    const user = await findSessionUser(token);
    if (!user) httpError(401, 'User authentication required');
    res.locals.user = user;
    next();
  })().catch(next);
};

export const userAuthHeaders: RequestHandler = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (req.get('sec-fetch-site') === 'cross-site' || (origin && origin !== `${req.protocol}://${req.get('host')}`)) {
      next(Object.assign(new Error('Cross-site user request rejected'), { status: 403 }));
      return;
    }
  }
  next();
};
