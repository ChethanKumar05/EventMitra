import { PoolClient } from 'pg';
import { pool, withClient } from '../config/database';
import { digest } from '../security/password';
import { AccountActor, AccountInput, ManagementListQuery, PersonKind, accountFields, accountListColumns } from '../types/management';
import { httpError } from '../utils/httpError';
import { generateId } from '../utils/id';
import { listOrder, paginatedQuery } from './listService';
import { assertManagementActor } from './managementAuthorizationService';
import { managementFilters, personDefinitions } from './personManagementService';
import { securityTransaction } from './securityService';

type Database = Pick<PoolClient, 'query'>;
export const bankColumns = (kind: PersonKind): string[] => [`${kind}_account_id`, ...accountListColumns];

async function authorize(kind: PersonKind, personId: string, actor: AccountActor, action: 'read' | 'create' | 'edit', db: Database, lock = false) {
  if (actor.type === 'admin') await assertManagementActor(actor.actor, kind, action, db);
  else if (actor.type !== kind || actor.id !== personId) httpError(403, 'Account access denied');
  const definition = personDefinitions[kind];
  const parent = (await db.query(`SELECT * FROM public.${definition.table} WHERE ${definition.id}=$1${lock ? ' FOR UPDATE' : ''}`, [personId])).rows[0];
  if (!parent) httpError(404, `${kind} not found`);
  if (actor.type !== 'admin') {
    const session = (await db.query(`SELECT * FROM public.${kind}_sessions WHERE token_hash=$1 AND ${definition.id}=$2 AND expires_at>now()`, [digest(actor.token), personId])).rows[0];
    const fingerprint = kind === 'owner' ? digest(parent.password) : digest(`${parent.country_code}:${parent.user_phone_number}`);
    if (!session || !['pending', 'verified'].includes(parent.status)
      || (kind === 'user' && (!parent.is_active || !parent.is_phone_number_verified))
      || session[kind === 'owner' ? 'password_fingerprint' : 'phone_fingerprint'] !== fingerprint) httpError(401, `${kind} authentication required`);
  }
}

export async function listBankAccounts(kind: PersonKind, personId: string, actor: AccountActor, query: ManagementListQuery) {
  await authorize(kind, personId, actor, 'read', pool);
  const columns = bankColumns(kind), filters = managementFilters(query, columns);
  filters.equal(`r.${kind}_id`, personId);
  return paginatedQuery(`${kind}_account_details`, 'r.*', listOrder(query, columns, `is_default DESC,"${kind}_account_id" ASC`, `${kind}_account_id`), filters, query);
}

export async function getBankAccount(kind: PersonKind, personId: string, accountId: string, actor: AccountActor) {
  await authorize(kind, personId, actor, 'read', pool);
  const row = (await pool.query(`SELECT * FROM public.${kind}_account_details WHERE ${kind}_id=$1 AND ${kind}_account_id=$2`, [personId, accountId])).rows[0];
  if (!row) httpError(404, 'Account not found');
  return row;
}

async function selfTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async client => {
    await client.query('BEGIN');
    try { const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
  });
}

export async function writeBankAccount(kind: PersonKind, personId: string, actor: AccountActor, input: AccountInput, accountId?: string) {
  for (const field of Object.keys(input)) {
    if (!accountFields.includes(field as typeof accountFields[number])) httpError(400, 'Unsupported account field');
    if (accountId && actor.type !== 'admin' && field !== 'is_default') httpError(400, 'Only is_default can be updated');
  }
  const run = actor.type === 'admin' ? securityTransaction : selfTransaction;
  return run(async client => {
    // All additions/default changes for one person serialize on the parent row.
    await authorize(kind, personId, actor, accountId ? 'edit' : 'create', client, true);
    const table = `${kind}_account_details`, id = `${kind}_account_id`;
    let existing;
    if (accountId) {
      existing = (await client.query(`SELECT * FROM public.${table} WHERE ${kind}_id=$1 AND ${id}=$2 FOR UPDATE`, [personId, accountId])).rows[0];
      if (!existing) httpError(404, 'Account not found');
    }
    const count = (await client.query(`SELECT count(*)::int AS n FROM public.${table} WHERE ${kind}_id=$1`, [personId])).rows[0].n;
    if (!accountId && count >= 5) httpError(409, 'A maximum of five accounts is allowed');
    const values = { ...input };
    if (!accountId) values.is_default ??= count === 0;
    if (values.is_default === true) {
      await client.query(`UPDATE public.${table} SET is_default=false WHERE ${kind}_id=$1 AND is_default=true AND ${id}<>$2`, [personId, accountId ?? '']);
    }
    const keys = Object.keys(values), params = Object.values(values);
    return accountId
      ? (await client.query(`UPDATE public.${table} SET ${keys.map((key, i) => `"${key}"=$${i + 3}`).join(',')}
          WHERE ${kind}_id=$1 AND ${id}=$2 RETURNING *`, [personId, accountId, ...params])).rows[0]
      : (await client.query(`INSERT INTO public.${table} (${kind}_id,${id},${keys.map(key => `"${key}"`).join(',')})
          VALUES($1,$2,${keys.map((_, i) => `$${i + 3}`).join(',')}) RETURNING *`, [personId, generateId(), ...params])).rows[0];
  });
}
