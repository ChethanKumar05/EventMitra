import { normalizeEmail,validatePhone } from '../utils/adminValidation';
import { checkPassword } from '../security/password';
import { httpError } from '../utils/httpError';
import { text } from './securityValidation';
import { OwnerSignupInput,OtpTarget } from '../types/owner';
export function ownerBody(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))httpError(400,'JSON object required');
  return value as Record<string,unknown>;
}
export function ownerName(value:unknown):string {
  if(typeof value==='string'&&/[\u0000-\u001f\u007f]/.test(value))httpError(400,'Invalid owner_name');
  const name=text(value,'owner_name',150).replace(/\s+/g,' ');
  if(/[\u0000-\u001f\u007f]/.test(name))httpError(400,'Invalid owner_name');
  return name;
}
function country(value:unknown):string { if(typeof value!=='string'||!/^\+[1-9][0-9]{0,2}$/.test(value))httpError(400,'country_code must be a calling code such as +91');return value; }
function nationalPhone(value:unknown,countryCode:string):string {
  if(typeof value!=='string'||!/^[1-9][0-9]{6,14}$/.test(value)||value.length+countryCode.length-1>15)httpError(400,'phone_number must contain 7-15 digits without a country prefix; combined international number must not exceed 15 digits');
  return value;
}
export function otpTarget(value:unknown):OtpTarget {
  const body=ownerBody(value);
  if(body.type==='email'){
    if(body.phone_number!==undefined||body.country_code!==undefined)httpError(400,'Email OTP requests must contain email only');
    return {type:'email',email:normalizeEmail(body.email)};
  }
  if(body.type==='phone'){
    if(body.email!==undefined)httpError(400,'Phone OTP requests must not contain email');
    const country_code=country(body.country_code);
    return {type:'phone',country_code,phone_number:nationalPhone(body.phone_number,country_code)};
  }
  return httpError(400,'type must be email or phone');
}
export function otpToken(value:unknown):string {
  if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))httpError(400,'Invalid otp_token');return value;
}
export function signupInput(value:unknown):OwnerSignupInput {
  const body=ownerBody(value),country_code=country(body.country_code);checkPassword(body.password);
  if(body.gender!=='m'&&body.gender!=='f')httpError(400,'gender must be m or f');
  const coordinate=(key:'lat'|'long',max:number)=>{
    const number=body[key];if(typeof number!=='number'||!Number.isFinite(number)||Math.abs(number)>max)httpError(400,`${key} must be a number between ${-max} and ${max}`);return number;
  };
  const pin_code=text(body.pin_code,'pin_code',12);if(!/^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/.test(pin_code))httpError(400,'Invalid pin_code');
  const input:OwnerSignupInput={owner_name:ownerName(body.owner_name),owner_phone_number:nationalPhone(body.owner_phone_number,country_code),country_code,
    email:normalizeEmail(body.email),password:body.password,gender:body.gender,doc_type:text(body.doc_type,'doc_type',50),doc_number:text(body.doc_number,'doc_number',100),doc_image:text(body.doc_image,'doc_image',2048),pin_code,
    state:text(body.state,'state',100),city:text(body.city,'city',100),area:text(body.area,'area',150),lat:coordinate('lat',90),long:coordinate('long',180),address:text(body.address,'address',2000)};
  for(const field of ['alternative_number','whatsapp_number'] as const)if(body[field]!==undefined)input[field]=body[field]===null||body[field]===''?null:validatePhone(body[field]);
  if(body.alternative_email!==undefined)input.alternative_email=body.alternative_email===null||body.alternative_email===''?null:normalizeEmail(body.alternative_email);
  if(body.profile_image!==undefined)input.profile_image=body.profile_image===null||body.profile_image===''?null:text(body.profile_image,'profile_image',2048);
  for(const field of ['owner_id','owner_code','status','kyc_verification','is_phone_number_verified','is_email_verified'] as const)if(body[field]!==undefined)httpError(400,`${field} cannot be set during signup`);
  return input;
}
