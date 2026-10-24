import { PoolClient } from 'pg';
import { pool,withClient } from '../config/database';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import { digest,hashPassword } from '../security/password';
import { generateId } from '../utils/id';
import { httpError } from '../utils/httpError';
import { OtpTarget,OtpPurpose,OwnerSignupInput } from '../types/owner';
const mutationLock=71003602;
const otpCode='1111';
function developmentOtp():void { if(process.env.NODE_ENV==='production')httpError(503,'OTP delivery is not configured for production'); }
async function transaction<T>(callback:(client:PoolClient)=>Promise<T>):Promise<T>{
  return withClient(async client=>{await client.query('BEGIN');try{await client.query('SELECT pg_advisory_xact_lock($1)',[mutationLock]);const result=await callback(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}});
}
async function limit(key:string,max:number):Promise<void>{
  const result=await pool.query(`INSERT INTO public.owner_otp_limits(attempt_key,attempts) VALUES($1,1) ON CONFLICT(attempt_key) DO UPDATE SET
    attempts=CASE WHEN owner_otp_limits.window_start<now()-interval '15 minutes' THEN 1 ELSE owner_otp_limits.attempts+1 END,
    window_start=CASE WHEN owner_otp_limits.window_start<now()-interval '15 minutes' THEN now() ELSE owner_otp_limits.window_start END RETURNING attempts`,[digest(key)]);
  if(result.rows[0].attempts>max)httpError(429,'Too many requests. Try again in 15 minutes.');
}
function targetKey(target:OtpTarget):string {return target.type==='email'?`email:${target.email}`:`phone:${target.country_code}:${target.phone_number}`;}
function targetWhere(target:OtpTarget,offset=1):{sql:string;values:string[]}{
  return target.type==='email'?{sql:`lower(email)=$${offset}`,values:[target.email]}:{sql:`country_code=$${offset} AND owner_phone_number=$${offset+1}`,values:[target.country_code,target.phone_number]};
}
export async function signupOwner(input:OwnerSignupInput,ip:string){
  await limit(`signup-ip:${ip}`,20);
  const password=await hashPassword(input.password);
  return transaction(async client=>{
    if((await client.query("SELECT 1 FROM public.owner WHERE lower(regexp_replace(btrim(owner_name),'[[:space:]]+',' ','g'))=lower($1)",[input.owner_name])).rowCount)httpError(409,'Owner name already exists');
    if((await client.query('SELECT 1 FROM public.owner WHERE lower(email)=$1',[input.email])).rowCount)httpError(409,'Email already exists');
    if((await client.query('SELECT 1 FROM public.owner WHERE country_code=$1 AND owner_phone_number=$2',[input.country_code,input.owner_phone_number])).rowCount)httpError(409,'Owner phone number already exists');
    const values={...input,password};const keys=Object.keys(values);const params=Object.values(values);
    // All keys come from the controller's explicit input mapping; IDs/codes/status are server-owned.
    const result=await client.query(`INSERT INTO public.owner(owner_id,${keys.map(key=>`"${key}"`).join(',')}) VALUES($1,${keys.map((_,i)=>`$${i+2}`).join(',')})
      RETURNING owner_id,owner_code,owner_name,email,status,kyc_verification,is_phone_number_verified,is_email_verified`,[generateId(),...params]);
    return result.rows[0];
  });
}
export async function issueOwnerOtp(target:OtpTarget,purpose:OtpPurpose,ip:string){
  developmentOtp();await limit(`otp-ip:${ip}`,20);await limit(`otp-target:${targetKey(target)}`,5);
  const raw=randomBytes(32).toString('hex');const where=targetWhere(target);
  return transaction(async client=>{
    const owner=(await client.query(`SELECT password,status FROM public.owner WHERE ${where.sql} FOR UPDATE`,where.values)).rows[0];
    const fingerprint=purpose==='password_reset'&&owner&&['pending','verified'].includes(owner.status)?digest(owner.password):null;
    await client.query(`UPDATE public.owner_phone_verification SET consumed_at=now() WHERE type=$1 AND email IS NOT DISTINCT FROM $2 AND country_code IS NOT DISTINCT FROM $3 AND phone_number IS NOT DISTINCT FROM $4 AND purpose=$5 AND consumed_at IS NULL`,[target.type,target.type==='email'?target.email:null,target.type==='phone'?target.country_code:null,target.type==='phone'?target.phone_number:null,purpose]);
    await client.query(`INSERT INTO public.owner_phone_verification(otp_id,otp,otp_token,type,email,country_code,phone_number,purpose,password_fingerprint,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '5 minutes')`,[generateId(),digest(`${raw}:${otpCode}`),digest(raw),target.type,target.type==='email'?target.email:null,target.type==='phone'?target.country_code:null,target.type==='phone'?target.phone_number:null,purpose,fingerprint]);
    return {otp_token:raw,type:target.type,purpose,expires_in:300,delivery:'development-fixed-otp'};
  });
}
export async function verifyOwnerOtp(token:string,otp:string){
  developmentOtp();
  const result=await transaction(async client=>{
    const row=(await client.query(`SELECT *,expires_at>now() AS unexpired FROM public.owner_phone_verification WHERE otp_token=$1 FOR UPDATE`,[digest(token)])).rows[0];
    if(!row||!row.unexpired||row.consumed_at||row.is_verified)return {error:401 as const};
    if(row.attempts>=5)return {error:429 as const};
    await client.query('UPDATE public.owner_phone_verification SET attempts=attempts+1 WHERE otp_id=$1',[row.otp_id]);
    if(!timingSafeEqual(Buffer.from(digest(`${token}:${otp}`),'hex'),Buffer.from(row.otp,'hex')))return {error:row.attempts+1>=5?429 as const:401 as const};
    await client.query(`UPDATE public.owner_phone_verification SET is_verified=true,verified_at=now(),consumed_at=CASE WHEN purpose='verification' THEN now() ELSE NULL END WHERE otp_id=$1`,[row.otp_id]);
    if(row.purpose==='verification'){
      const target:OtpTarget=row.type==='email'?{type:'email',email:row.email}:{type:'phone',country_code:row.country_code,phone_number:row.phone_number};const where=targetWhere(target);
      await client.query(`UPDATE public.owner SET ${row.type==='email'?'is_email_verified':'is_phone_number_verified'}=true,updated_at=now() WHERE ${where.sql}`,where.values);
    }
    return {data:{is_verified:true,type:row.type,purpose:row.purpose}};
  });
  if(result.error)httpError(result.error,result.error===429?'Too many OTP attempts':'Invalid, expired or already used OTP');
  return result.data;
}
export async function resetOwnerPassword(token:string,password:string,ip:string){
  developmentOtp();await limit(`reset-ip:${ip}`,20);
  const eligible=await pool.query(`SELECT 1 FROM public.owner_phone_verification WHERE otp_token=$1 AND purpose='password_reset' AND is_verified AND consumed_at IS NULL AND expires_at>now()`,[digest(token)]);
  if(!eligible.rowCount)httpError(401,'Invalid or expired password reset token');
  const hash=await hashPassword(password);
  return transaction(async client=>{
    const row=(await client.query(`SELECT *,expires_at>now() AS unexpired FROM public.owner_phone_verification WHERE otp_token=$1 FOR UPDATE`,[digest(token)])).rows[0];
    if(!row||!row.unexpired||row.purpose!=='password_reset'||!row.is_verified||row.consumed_at)httpError(401,'Invalid or expired password reset token');
    const target:OtpTarget=row.type==='email'?{type:'email',email:row.email}:{type:'phone',country_code:row.country_code,phone_number:row.phone_number};const where=targetWhere(target);
    const owner=(await client.query(`SELECT owner_id,password,status FROM public.owner WHERE ${where.sql} FOR UPDATE`,where.values)).rows[0];
    if(!owner||!['pending','verified'].includes(owner.status)||!row.password_fingerprint||digest(owner.password)!==row.password_fingerprint)httpError(401,'Invalid or expired password reset token');
    await client.query('UPDATE public.owner SET password=$1,updated_at=now() WHERE owner_id=$2',[hash,owner.owner_id]);
    await client.query('UPDATE public.owner_phone_verification SET consumed_at=now() WHERE otp_id=$1',[row.otp_id]);
    return null;
  });
}
