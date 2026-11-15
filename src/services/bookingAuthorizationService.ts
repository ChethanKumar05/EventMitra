import { PoolClient } from 'pg';
import { pool, withClient } from '../config/database';
import { BookingActor } from '../types/booking';
import { digest } from '../security/password';
import { httpError } from '../utils/httpError';
import { assertManagementActor } from './managementAuthorizationService';

export async function bookingTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async client => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [71003604]);
      const result = await callback(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  });
}

export async function assertBookingActor(actor: BookingActor, db: Pick<PoolClient, 'query'> = pool, action: 'read' | 'edit' = 'read', lock = false): Promise<Record<string, any>> {
  if (actor.type === 'admin') {
    await assertManagementActor({ adminId: actor.id, sessionToken: actor.token }, 'booking', action, db); return {};
  }
  const kind = actor.type, table = kind === 'user' ? '"user"' : 'owner';
  const profile = (await db.query(`SELECT * FROM public.${table} WHERE ${kind}_id=$1${lock ? ' FOR UPDATE' : ''}`, [actor.id])).rows[0];
  const session = (await db.query(`SELECT * FROM public.${kind}_sessions WHERE ${kind}_id=$1 AND token_hash=$2 AND expires_at>now()`, [actor.id, digest(actor.token)])).rows[0];
  if (!profile || !session || !['pending','verified'].includes(profile.status)) httpError(401, 'Authentication required');
  if (kind === 'user' ? !profile.is_active || !profile.is_phone_number_verified || session.phone_fingerprint !== digest(`${profile.country_code}:${profile.user_phone_number}`) : session.password_fingerprint !== digest(profile.password)) httpError(401, 'Authentication required');
  return profile;
}
