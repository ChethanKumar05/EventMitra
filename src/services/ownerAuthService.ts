import { randomBytes } from 'node:crypto';
import { pool,withClient } from '../config/database';
import { digest,verifyPassword } from '../security/password';
import { OwnerIdentity,OwnerLoginInput } from '../types/owner';
import { httpError } from '../utils/httpError';
const allowedStatuses=['pending','verified'];
const publicColumns='owner_id,owner_code,owner_name,email,status,kyc_verification,is_phone_number_verified';
function invalidCredentials():never { return httpError(401,'Invalid owner name/email or password. Use email if your name is shared.'); }
interface OwnerCredential extends OwnerIdentity { password:string; }
async function loginAttempt(key:string,limit:number):Promise<void> {
  const result=await pool.query(`INSERT INTO public.owner_login_attempts(attempt_key,attempts) VALUES ($1,1)
    ON CONFLICT(attempt_key) DO UPDATE SET
    attempts=CASE WHEN owner_login_attempts.window_start<now()-interval '15 minutes' THEN 1 ELSE owner_login_attempts.attempts+1 END,
    window_start=CASE WHEN owner_login_attempts.window_start<now()-interval '15 minutes' THEN now() ELSE owner_login_attempts.window_start END RETURNING attempts`,[key]);
  if(result.rows[0].attempts>limit)httpError(429,'Too many owner login attempts. Try again in 15 minutes.');
}
export async function loginOwner(input:OwnerLoginInput,ip:string) {
  await loginAttempt(digest(`owner-ip:${ip}`),100);
  // Field selection comes from the controller's union, never client SQL text.
  const predicate=input.field==='email'?'lower(email)=$1':'lower(btrim(owner_name))=$1';
  const result=await pool.query<OwnerCredential>(`SELECT ${publicColumns},password FROM public.owner WHERE ${predicate} ORDER BY owner_id LIMIT 2`,[input.identifier]);
  const owner=result.rows.length===1?result.rows[0]:undefined;
  await loginAttempt(digest(`owner-account:${ip}|${owner?.owner_id??`${input.field}:${input.identifier}`}`),10);
  const eligible=owner&&allowedStatuses.includes(owner.status);
  // Missing/ambiguous/disallowed accounts still perform a dummy scrypt verification.
  if(!await verifyPassword(input.password,eligible?owner.password:null))invalidCredentials();
  if(!owner)invalidCredentials();
  const session=randomBytes(32).toString('hex');
  const identity=await withClient(async client=>{
    await client.query('BEGIN');
    try{
      const current=(await client.query<OwnerCredential>(`SELECT ${publicColumns},password FROM public.owner WHERE owner_id=$1 FOR UPDATE`,[owner.owner_id])).rows[0];
      if(!current||!allowedStatuses.includes(current.status)||current.password!==owner.password||(input.field==='email'&&current.email?.toLowerCase()!==input.identifier))invalidCredentials();
      // Recheck name ambiguity while creating the session as well.
      if(input.field==='owner_name'){
        const matches=await client.query('SELECT owner_id FROM public.owner WHERE lower(btrim(owner_name))=$1 LIMIT 2',[input.identifier]);
        if(matches.rows.length!==1||matches.rows[0].owner_id!==current.owner_id)invalidCredentials();
      }
      await client.query('DELETE FROM public.owner_sessions WHERE expires_at<=now()');
      await client.query("DELETE FROM public.owner_login_attempts WHERE window_start<now()-interval '1 day'");
      await client.query(`INSERT INTO public.owner_sessions(token_hash,owner_id,password_fingerprint,expires_at)
        VALUES ($1,$2,$3,now()+interval '8 hours')`,[digest(session),current.owner_id,digest(current.password)]);
      await client.query('COMMIT');
      const {password:_password,...publicOwner}=current;
      return publicOwner;
    }catch(error){await client.query('ROLLBACK');throw error;}
  });
  return {session,owner:identity};
}
export async function findSessionOwner(session:string):Promise<OwnerIdentity|null> {
  const result=await pool.query<OwnerCredential&{password_fingerprint:string}>(`SELECT o.owner_id,o.owner_code,o.owner_name,o.email,o.status,o.kyc_verification,o.is_phone_number_verified,o.password,s.password_fingerprint
    FROM public.owner_sessions s JOIN public.owner o USING(owner_id)
    WHERE s.token_hash=$1 AND s.expires_at>now() AND o.status=ANY($2::varchar[])`,[digest(session),allowedStatuses]);
  const row=result.rows[0];
  if(!row||digest(row.password)!==row.password_fingerprint)return null;
  const {password:_password,password_fingerprint:_fingerprint,...owner}=row;
  return owner;
}
export async function logoutOwner(session:string):Promise<void> {
  await pool.query('DELETE FROM public.owner_sessions WHERE token_hash=$1',[digest(session)]);
}
