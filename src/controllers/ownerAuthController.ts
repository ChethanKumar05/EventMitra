import { ownerUsername } from './ownerValidation';
import * as service from '../services/ownerAuthService';
import { ownerCookieName,ownerCookieOptions,ownerSessionToken } from '../middleware/ownerAuth';
import { handler } from './securityValidation';
import { normalizeEmail } from '../utils/adminValidation';
import { httpError } from '../utils/httpError';
import { success } from '../utils/response';
export const login=handler(async(req,res)=>{
  const body=req.body;
  if(!body||typeof body!=='object'||Array.isArray(body))httpError(400,'JSON object required');
  for(const key of Object.keys(body))if(!['user_name','email','password'].includes(key))httpError(400,`Unexpected login field: ${key}; use user_name or email`);
  const fields=['user_name','email'].filter(key=>body[key]!==undefined);
  if(fields.length!==1)httpError(400,'Provide exactly one of user_name or email');
  const field=fields[0] as 'user_name'|'email';
  const identifier=field==='email'?normalizeEmail(body.email):ownerUsername(body.user_name);
  const password=body.password;
  if(typeof password!=='string'||!password||Buffer.byteLength(password)>256)httpError(400,'Password is required and must be at most 256 bytes');
  const result=await service.loginOwner({field,identifier,password},req.ip??'');
  res.cookie(ownerCookieName,result.session,{...ownerCookieOptions,maxAge:8*60*60*1000});
  success(res,'Owner logged in',{...result.owner,access_token:result.session,token_type:'Bearer',expires_in:28800});
});
export const me=handler(async(_req,res)=>{success(res,'Current owner',res.locals.owner);});
export const logout=handler(async(req,res)=>{
  // Idempotent: revoke the presented token and clear even expired/invalid cookies.
  const token=ownerSessionToken(req);
  if(token)await service.logoutOwner(token);
  res.clearCookie(ownerCookieName,ownerCookieOptions);
  success(res,'Owner logged out',null);
});
