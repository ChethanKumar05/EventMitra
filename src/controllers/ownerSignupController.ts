import * as service from '../services/ownerSignupService';
import { ownerBody,otpTarget,otpToken,signupInput } from './ownerValidation';
import { handler,password } from './securityValidation';
import { httpError } from '../utils/httpError';
import { success } from '../utils/response';
export const signup=handler(async(req,res)=>{success(res,'Owner registered',await service.signupOwner(signupInput(req.body),req.ip??''),201);});
export const sendOtp=handler(async(req,res)=>{success(res,'Test OTP challenge created',await service.issueOwnerOtp(otpTarget(req.body),'verification',req.ip??''));});
export const forgotPassword=handler(async(req,res)=>{success(res,'If the account is eligible, a password-reset challenge is available',await service.issueOwnerOtp(otpTarget(req.body),'password_reset',req.ip??''));});
export const verifyOtp=handler(async(req,res)=>{
  const body=ownerBody(req.body),token=otpToken(body.otp_token);
  if(typeof body.otp!=='string'||!/^\d{4}$/.test(body.otp))httpError(400,'otp must be a four-digit string');
  success(res,'OTP verified',await service.verifyOwnerOtp(token,body.otp));
});
export const resetPassword=handler(async(req,res)=>{
  const body=ownerBody(req.body),token=otpToken(body.otp_token),next=password(body.new_password);
  if(body.confirm_password!==undefined&&body.confirm_password!==next)httpError(400,'Passwords do not match');
  success(res,'Password reset. Log in again.',await service.resetOwnerPassword(token,next,req.ip??''));
});
