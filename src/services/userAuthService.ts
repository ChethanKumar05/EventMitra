import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PoolClient } from 'pg';
import { pool, withClient } from '../config/database';
import { digest } from '../security/password';
import { UserIdentity, UserPhone, UserSignupInput } from '../types/user';
import { httpError } from '../utils/httpError';
import { generateId } from '../utils/id';

const publicColumns = 'user_id,user_code,country_code,user_phone_number,email,gender,user_name,profile_image,whatsapp_number,alternative_number,status,is_active,is_phone_number_verified';
const allowedStatuses = ['pending', 'verified'];
const otpCode = '1111';

function developmentOtp(): void {
  if (process.env.NODE_ENV === 'production') httpError(503, 'OTP delivery is not configured for production');
}

async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async client => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [71003603]);
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function limit(key: string, max: number): Promise<void> {
  const result = await pool.query(`INSERT INTO public.user_otp_limits(attempt_key,attempts) VALUES($1,1)
    ON CONFLICT(attempt_key) DO UPDATE SET
      attempts=CASE WHEN user_otp_limits.window_start<now()-interval '15 minutes' THEN 1 ELSE user_otp_limits.attempts+1 END,
      window_start=CASE WHEN user_otp_limits.window_start<now()-interval '15 minutes' THEN now() ELSE user_otp_limits.window_start END
    RETURNING attempts`, [digest(key)]);
  if (result.rows[0].attempts > max) httpError(429, 'Too many requests. Try again in 15 minutes.');
}

const phoneValues = (phone: UserPhone): string[] => [phone.country_code, phone.user_phone_number];
const phoneFingerprint = (phone: UserPhone): string => digest(`${phone.country_code}:${phone.user_phone_number}`);
const eligible = (user: UserIdentity | undefined): user is UserIdentity =>
  !!user && user.is_active && allowedStatuses.includes(user.status);

export async function signupUser(input: UserSignupInput, ip: string): Promise<UserIdentity> {
  await limit(`signup-ip:${ip}`, 20);
  return transaction(async client => {
    if ((await client.query('SELECT 1 FROM public."user" WHERE country_code=$1 AND user_phone_number=$2', phoneValues(input))).rowCount) {
      httpError(409, 'User phone number already exists');
    }
    if (input.email && (await client.query('SELECT 1 FROM public."user" WHERE lower(email)=$1', [input.email])).rowCount) {
      httpError(409, 'Email already exists');
    }
    const result = await client.query<UserIdentity>(`INSERT INTO public."user"
      (user_id,country_code,user_phone_number,user_name,gender,email,profile_image,whatsapp_number,alternative_number)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${publicColumns}`,
    [generateId(), input.country_code, input.user_phone_number, input.user_name, input.gender,
      input.email, input.profile_image, input.whatsapp_number, input.alternative_number]);
    return result.rows[0]!;
  });
}

// Login and resend intentionally share a target budget and invalidate earlier challenges.
export async function issueUserOtp(phone: UserPhone, ip: string) {
  developmentOtp();
  await limit(`otp-ip:${ip}`, 20);
  await limit(`otp-phone:${phone.country_code}:${phone.user_phone_number}`, 5);
  const token = randomBytes(32).toString('hex');
  return transaction(async client => {
    const user = (await client.query<UserIdentity>(`SELECT ${publicColumns} FROM public."user"
      WHERE country_code=$1 AND user_phone_number=$2 FOR UPDATE`, phoneValues(phone))).rows[0];
    await client.query(`UPDATE public.user_phone_verification SET consumed_at=now()
      WHERE country_code=$1 AND user_phone_number=$2 AND consumed_at IS NULL`, phoneValues(phone));
    await client.query(`INSERT INTO public.user_phone_verification
      (otp_id,country_code,user_phone_number,otp,otp_token,account_fingerprint,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,now()+interval '5 minutes')`,
    [generateId(), ...phoneValues(phone), digest(`${token}:${otpCode}`), digest(token), eligible(user) ? digest(user.user_id) : null]);
    await client.query('DELETE FROM public.user_sessions WHERE expires_at<=now()');
    await client.query("DELETE FROM public.user_otp_limits WHERE window_start<now()-interval '1 day'");
    // Unknown/ineligible accounts receive the same response, but their proof cannot create a session.
    return { otp_token: token, expires_in: 300, delivery: 'development-fixed-otp' };
  });
}

interface Challenge extends UserPhone {
  otp_id: string;
  otp: string;
  account_fingerprint: string | null;
  attempts: number;
  is_verified: boolean;
  consumed_at: Date | null;
  unexpired: boolean;
}

export async function verifyUserOtp(token: string, otp: string, ip: string): Promise<{ session: string; user: UserIdentity }> {
  developmentOtp();
  await limit(`verify-ip:${ip}`, 100);
  const result = await transaction<{ error: 401 | 429 } | { session: string; user: UserIdentity }>(async client => {
    const target = (await client.query<UserPhone>('SELECT country_code,user_phone_number FROM public.user_phone_verification WHERE otp_token=$1', [digest(token)])).rows[0];
    if (!target) return { error: 401 };
    // Lock the account before its challenge, matching the revocation trigger's lock order.
    const user = (await client.query<UserIdentity>(`SELECT ${publicColumns} FROM public."user"
      WHERE country_code=$1 AND user_phone_number=$2 FOR UPDATE`, phoneValues(target))).rows[0];
    const challenge = (await client.query<Challenge>(`SELECT *,expires_at>now() AS unexpired
      FROM public.user_phone_verification WHERE otp_token=$1 FOR UPDATE`, [digest(token)])).rows[0];
    if (!challenge || !challenge.unexpired || challenge.consumed_at || challenge.is_verified) return { error: 401 };
    if (challenge.attempts >= 5) return { error: 429 };
    await client.query('UPDATE public.user_phone_verification SET attempts=attempts+1 WHERE otp_id=$1', [challenge.otp_id]);
    const expected = Buffer.from(challenge.otp, 'hex');
    const actual = Buffer.from(digest(`${token}:${otp}`), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
      return { error: challenge.attempts + 1 >= 5 ? 429 : 401 };
    }
    if (!eligible(user) || challenge.account_fingerprint !== digest(user.user_id)
      || challenge.country_code !== target.country_code || challenge.user_phone_number !== target.user_phone_number) return { error: 401 };
    await client.query(`UPDATE public.user_phone_verification SET is_verified=true,verified_at=now(),consumed_at=now() WHERE otp_id=$1`, [challenge.otp_id]);
    await client.query('UPDATE public."user" SET is_phone_number_verified=true,updated_at=now() WHERE user_id=$1', [user.user_id]);
    const session = randomBytes(32).toString('hex');
    await client.query(`INSERT INTO public.user_sessions(token_hash,user_id,phone_fingerprint,expires_at)
      VALUES($1,$2,$3,now()+interval '8 hours')`, [digest(session), user.user_id, phoneFingerprint(user)]);
    return { session, user: { ...user, is_phone_number_verified: true } };
  });
  // Throw after COMMIT so failed OTP attempts are not rolled back.
  if ('error' in result) httpError(result.error, result.error === 429 ? 'Too many OTP attempts' : 'Invalid, expired or already used OTP');
  return result;
}

export async function findSessionUser(session: string): Promise<UserIdentity | null> {
  const result = await pool.query<{ user_id: string; phone_fingerprint: string }>(`SELECT user_id,phone_fingerprint
    FROM public.user_sessions WHERE token_hash=$1 AND expires_at>now()`, [digest(session)]);
  const stored = result.rows[0];
  if (!stored) return null;
  const user = (await pool.query<UserIdentity>(`SELECT ${publicColumns} FROM public."user" WHERE user_id=$1`, [stored.user_id])).rows[0];
  return eligible(user) && user.is_phone_number_verified && stored.phone_fingerprint === phoneFingerprint(user) ? user : null;
}

export async function logoutUser(session: string): Promise<void> {
  await pool.query('DELETE FROM public.user_sessions WHERE token_hash=$1', [digest(session)]);
}
