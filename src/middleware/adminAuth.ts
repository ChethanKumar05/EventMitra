import { Request, RequestHandler } from 'express';
import { findSessionAdmin, hasSecurityReadPermission } from '../services/adminAuthService';
import { AdminIdentity, SecurityActor, SecurityResource } from '../security/types';
import { httpError } from '../utils/httpError';

export const cookieName = process.env.NODE_ENV === 'production' ? '__Host-eventmitra' : 'eventmitra_session';
export const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/' };
export function sessionToken(req: Request): string {
  const match = (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`));
  const value = match?.slice(cookieName.length + 1) ?? '';
  return /^[a-f0-9]{64}$/.test(value) ? value : '';
}
export function securityActor(req: Request, admin: AdminIdentity): SecurityActor {
  return { adminId: admin.admin_id, sessionToken: sessionToken(req) };
}
export const securityHeaders: RequestHandler = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (req.get('sec-fetch-site') === 'cross-site') return next(Object.assign(new Error('Cross-site request rejected'), { status: 403 }));
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) return next(Object.assign(new Error('Origin rejected'), { status: 403 }));
  }
  next();
};
export const authenticateAdmin: RequestHandler = (req, res, next) => {
  void (async () => {
    const token = sessionToken(req);
    if (!token) httpError(401, 'Authentication required');
    const admin = await findSessionAdmin(token);
    if (!admin) httpError(401, 'Authentication required');
    res.locals.admin = admin;
    next();
  })().catch(next);
};
export const requireSuperAdmin: RequestHandler = (_req, res, next) => {
  if (!res.locals.admin?.is_super_admin) { next(Object.assign(new Error('Super admin required'), { status: 403 })); return; }
  next();
};
export function requireSecurityRead(resource: SecurityResource): RequestHandler {
  return (_req, res, next) => {
    const admin = res.locals.admin as AdminIdentity;
    if (admin.is_super_admin) { next(); return; }
    void hasSecurityReadPermission(admin, resource).then(allowed => {
      if (!allowed) httpError(403, 'Permission denied');
      next();
    }).catch(next);
  };
}
