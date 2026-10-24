import { Request,RequestHandler } from 'express';
import { findSessionOwner } from '../services/ownerAuthService';
import { httpError } from '../utils/httpError';
export const ownerCookieName=process.env.NODE_ENV==='production'?'__Host-eventmitra-owner':'eventmitra_owner_session';
export const ownerCookieOptions={httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict' as const,path:'/'};
export function ownerSessionToken(req:Request):string {
  const cookie=(req.headers.cookie??'').split(';').map(value=>value.trim()).find(value=>value.startsWith(`${ownerCookieName}=`));
  const token=cookie?.slice(ownerCookieName.length+1)??'';
  return /^[a-f0-9]{64}$/.test(token)?token:'';
}
export const authenticateOwner:RequestHandler=(req,res,next)=>{
  void(async()=>{
    const token=ownerSessionToken(req);
    if(!token)httpError(401,'Owner authentication required');
    const owner=await findSessionOwner(token);
    if(!owner)httpError(401,'Owner authentication required');
    res.locals.owner=owner;
    next();
  })().catch(next);
};
export const ownerAuthHeaders:RequestHandler=(req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(!['GET','HEAD','OPTIONS'].includes(req.method)){
    const origin=req.get('origin');
    if(req.get('sec-fetch-site')==='cross-site'||(origin&&origin!==`${req.protocol}://${req.get('host')}`)){
      next(Object.assign(new Error('Cross-site owner request rejected'),{status:403}));return;
    }
  }
  next();
};
