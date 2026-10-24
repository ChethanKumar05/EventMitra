import { success } from '../utils/response';
import { cookieName,cookieOptions,sessionToken } from '../middleware/adminAuth';
import * as service from '../services/adminAuthService';
import { email,username,handler,requestBody } from './securityValidation';
import { httpError } from '../utils/httpError';
export const login=handler(async(req,res)=>{
  const body=requestBody(req.body,'admin_code');
  const fields=['email','username','identifier'].filter(key=>body[key]!==undefined);
  if(fields.length!==1)httpError(400,'Provide exactly one of email, username or identifier');
  const field=fields[0]!,value=body[field];
  const identifier=field==='email'?email(value):field==='username'?username(value):typeof value==='string'&&value.includes('@')?email(value):username(value);
  const password=body.password;
  if(typeof password!=='string'||!password||Buffer.byteLength(password)>256)httpError(400,'Password is required and must be at most 256 bytes');
  const login=await service.loginAdmin(identifier,password,req.ip??'');
  res.cookie(cookieName,login.session,{...cookieOptions,maxAge:8*60*60*1000});
  success(res,'Logged in',login.admin);
});
export const me=handler(async(_req,res)=>{success(res,'Current admin',await service.currentAdmin(res.locals.admin));});
export const logout=handler(async(req,res)=>{await service.logoutAdmin(sessionToken(req));res.clearCookie(cookieName,cookieOptions);success(res,'Logged out',null);});
