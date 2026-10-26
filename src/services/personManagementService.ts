import { pool } from '../config/database';
import { SecurityActor } from '../security/types';
import { hashPassword } from '../security/password';
import { ManagementListQuery, PersonKind, ProfileInput, profileListColumns } from '../types/management';
import { httpError } from '../utils/httpError';
import { generateId } from '../utils/id';
import { applySearch, ListFilters, listOrder, paginatedQuery } from './listService';
import { assertManagementActor } from './managementAuthorizationService';
import { securityTransaction } from './securityService';

export const personDefinitions = {
  user: { table: '"user"', id: 'user_id', detail: 'user_id,user_code,user_name,country_code,user_phone_number,email,gender,profile_image,whatsapp_number,alternative_number,status,is_active,is_phone_number_verified,reason,created_at,updated_at' },
  owner: { table: 'owner', id: 'owner_id', detail: 'owner_id,owner_code,owner_name,country_code,owner_phone_number,email,gender,profile_image,whatsapp_number,alternative_number,alternative_email,kyc_verification,is_phone_number_verified,is_email_verified,doc_type,doc_number,doc_image,pin_code,state,city,area,lat,"long",address,reason,status,created_at,updated_at' },
} as const;

export function managementFilters(query: ManagementListQuery, columns: readonly string[]): ListFilters {
  const filters = new ListFilters();
  const expressions = Object.fromEntries(columns.map(column => [column, `r."${column}"`]));
  applySearch(filters, query, expressions);
  for (const [field, value] of Object.entries(query.filters)) {
    if (!columns.includes(field)) httpError(400, 'Invalid filter');
    filters.equal(`r."${field}"::text`, value, true);
  }
  return filters;
}

export async function listPeople(kind: PersonKind, query: ManagementListQuery) {
  const { table, id } = personDefinitions[kind], columns = profileListColumns[kind];
  return paginatedQuery(table, columns.map(column => `r."${column}"`).join(','),
    listOrder(query, columns, `"${id}" DESC`, id), managementFilters(query, columns), query);
}

export async function getPerson(kind: PersonKind, id: string) {
  const definition = personDefinitions[kind];
  const row = (await pool.query(`SELECT ${definition.detail} FROM public.${definition.table} WHERE ${definition.id}=$1`, [id])).rows[0];
  if (!row) httpError(404, `${kind} not found`);
  return row;
}

export async function writePerson(kind: PersonKind, operation: 'create' | 'update' | 'delete', actor: SecurityActor, input: ProfileInput, id = generateId()) {
  const definition = personDefinitions[kind];
  const values = { ...input };
  if (kind === 'owner' && typeof values.password === 'string') values.password = await hashPassword(values.password);
  return securityTransaction(async client => {
    await assertManagementActor(actor, kind, operation === 'update' ? 'edit' : operation, client);
    // Share the auth/signup mutation lock so contact/status edits cannot race with OTP verification.
    await client.query('SELECT pg_advisory_xact_lock($1)', [kind === 'owner' ? 71003602 : 71003603]);
    const previous = operation === 'create' ? undefined : (await client.query(`SELECT * FROM public.${definition.table} WHERE ${definition.id}=$1 FOR UPDATE`, [id])).rows[0];
    if (operation !== 'create' && !previous) httpError(404, `${kind} not found`);
    if (operation === 'delete') {
      await client.query(`UPDATE public.${definition.table} SET status='deleted',${kind === 'user' ? 'is_active=false,' : ''}updated_at=now() WHERE ${definition.id}=$1`, [id]);
      return null;
    }
    if (values.country_code !== undefined || values[`${kind}_phone_number`] !== undefined) {
      const country = String(values.country_code ?? previous?.country_code), phone = String(values[`${kind}_phone_number`] ?? previous?.[`${kind}_phone_number`]);
      if (country.length - 1 + phone.length > 15) httpError(400, 'Combined international phone number must not exceed 15 digits');
    }
    const keys = Object.keys(values), params = Object.values(values);
    // Keys originate exclusively from the controller's allowlisted field mapping.
    const row = operation === 'create'
      ? (await client.query(`INSERT INTO public.${definition.table} (${definition.id},${keys.map(key => `"${key}"`).join(',')})
          VALUES($1,${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING ${definition.detail}`, [id, ...params])).rows[0]
      : (await client.query(`UPDATE public.${definition.table} SET ${keys.map((key, i) => `"${key}"=$${i + 2}`).join(',')},updated_at=now()
          WHERE ${definition.id}=$1 RETURNING ${definition.detail}`, [id, ...params])).rows[0];
    if (operation === 'update') await client.query(`DELETE FROM public.${kind}_sessions WHERE ${definition.id}=$1`, [id]);
    return row;
  });
}
