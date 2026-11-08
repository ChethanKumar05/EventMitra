import { PoolClient } from 'pg';
import { pool, withClient } from '../config/database';
import { digest } from '../security/password';
import { ManagementAction, ManagementListQuery } from '../types/management';
import { ManagedVenueQuery, managedVenueColumns, ownerDropdownColumns, VenueActor, VenueInput, VenuePart, VenuePriceDropdown } from '../types/venueManagement';
import { generateId } from '../utils/id';
import { httpError } from '../utils/httpError';
import { listOrder, paginatedQuery } from './listService';
import { managementFilters } from './personManagementService';
import { assertManagementActor } from './managementAuthorizationService';
import { securityTransaction } from './securityService';

export const venueParts = {
  'type-slots': { table: 'venue_type_slots', id: 'venue_type_slot_id' },
  amenities: { table: 'venue_aminites', id: 'venue_id' },
  prices: { table: 'venue_price_details', id: 'venue_price_id' },
  decorations: { table: 'venue_decoration_details', id: 'venue_decoration_id' },
  meals: { table: 'venue_meals_details', id: 'venue_meals_id' },
} as const;

async function ownerTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async client => {
    await client.query('BEGIN');
    try { const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
  });
}

async function writeTransaction<T>(actor: VenueActor, action: ManagementAction, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const run = actor.type === 'admin' ? securityTransaction : ownerTransaction;
  return run(async client => {
    if (actor.type === 'admin') await assertManagementActor(actor.actor, 'venue', action, client);
    return callback(client);
  });
}

async function lockOwner(client: PoolClient, actor: VenueActor, ownerId: string, create = false): Promise<void> {
  const owner = (await client.query('SELECT owner_id,password,status FROM public.owner WHERE owner_id=$1 FOR UPDATE', [ownerId])).rows[0];
  if (!owner) httpError(404, 'Owner not found');
  if (actor.type === 'owner') {
    const session = (await client.query('SELECT password_fingerprint FROM public.owner_sessions WHERE token_hash=$1 AND owner_id=$2 AND expires_at>now()', [digest(actor.token), ownerId])).rows[0];
    if (ownerId !== actor.ownerId || !session || session.password_fingerprint !== digest(owner.password) || !['pending', 'verified'].includes(owner.status)) httpError(401, 'Owner authentication required');
  } else if (create && !['pending', 'verified'].includes(owner.status)) httpError(409, 'Venues can only be created for pending or verified owners');
}

async function lockVenue(client: PoolClient, actor: VenueActor, venueId: string) {
  // Lock owner before venue, matching profile/contact management and other venue writes.
  const ownerId = actor.type === 'owner' ? actor.ownerId : (await client.query('SELECT owner_id FROM public.venue_details WHERE venue_id=$1', [venueId])).rows[0]?.owner_id;
  if (!ownerId) httpError(404, 'Venue not found');
  await lockOwner(client, actor, ownerId);
  const venue = (await client.query('SELECT * FROM public.venue_details WHERE venue_id=$1 AND owner_id=$2 FOR UPDATE', [venueId, ownerId])).rows[0];
  if (!venue) httpError(404, 'Venue not found');
  if (actor.type === 'owner' && ['Blocked', 'Deleted'].includes(venue.status)) httpError(403, 'This venue cannot be edited by the owner');
  return venue;
}

async function touchVenue(client: PoolClient, actor: VenueActor, venueId: string): Promise<void> {
  await client.query(`UPDATE public.venue_details SET updated_at=now(),
    status=CASE WHEN $2 AND status IN ('Active','Rejected') THEN 'Pending' ELSE status END,
    reason=CASE WHEN $2 AND status IN ('Active','Rejected') THEN NULL ELSE reason END WHERE venue_id=$1`, [venueId, actor.type === 'owner']);
}

export async function listManagedVenues(actor: VenueActor, query: ManagedVenueQuery) {
  const filters = managementFilters(query, managedVenueColumns);
  if (actor.type === 'owner') filters.equal('r.owner_id', actor.ownerId);
  if (query.min_capacity !== undefined) filters.add(`r.venue_hall_capacity>=${filters.bind(query.min_capacity)}`);
  if (query.max_capacity !== undefined) filters.add(`r.venue_hall_capacity<=${filters.bind(query.max_capacity)}`);
  const columns = managedVenueColumns.map(column => `r."${column}"`).join(',') + (actor.type === 'admin' ? ',(SELECT owner_name FROM public.owner o WHERE o.owner_id=r.owner_id) AS owner_name,(SELECT owner_code FROM public.owner o WHERE o.owner_id=r.owner_id) AS owner_code' : '');
  return paginatedQuery('venue_details', columns, listOrder(query, managedVenueColumns, 'created_at DESC,venue_id DESC', 'venue_id'), filters, query);
}

export async function venueOwnerDropdown(query: ManagementListQuery) {
  return paginatedQuery('owner', ownerDropdownColumns.map(column => `r.${column}`).join(','), listOrder(query, ownerDropdownColumns, 'owner_name ASC,owner_id ASC', 'owner_id'), managementFilters(query, ownerDropdownColumns), query);
}

const priceDropdownDefinitions = {
  'type-slots': {
    columns: 'c.venue_type_slot_id,c.slot_name,c.from_time,c.to_time,c.is_active,c.slot_name AS label',
    order: 'o.from_time,o.slot_name,o.venue_type_slot_id',
  },
  decorations: {
    columns: 'c.venue_decoration_id,c.venue_decoration_code,c.venue_decoration_name,c.venue_decoration_price,c.venue_decoration_advance_price,c.venue_decoration_name AS label',
    order: 'o.venue_decoration_name,o.venue_decoration_id',
  },
  meals: {
    columns: `c.venue_meals_id,c.meal_deatails,c.is_veg,c.is_non_veg,c.per_plate_price,c.meals_advance_price,
      CASE WHEN c.is_veg AND c.is_non_veg THEN 'Vegetarian and non-vegetarian'
        WHEN c.is_veg THEN 'Vegetarian' WHEN c.is_non_veg THEN 'Non-vegetarian' ELSE 'Meals' END AS label`,
    order: 'o.label,o.venue_meals_id',
  },
} as const;

export async function venuePriceDropdown(actor: VenueActor, venueId: string, part: VenuePriceDropdown) {
  const { table, id } = venueParts[part], { columns, order } = priceDropdownDefinitions[part];
  // Venue existence, owner scope and options share one snapshot; an empty dropdown is not a missing venue.
  const row = (await pool.query(`SELECT coalesce((SELECT jsonb_agg(o ORDER BY ${order}) FROM (
      SELECT c.${id} AS value,${columns} FROM public.${table} c WHERE c.venue_id=v.venue_id
    ) o),'[]'::jsonb) AS options FROM public.venue_details v
    WHERE v.venue_id=$1${actor.type === 'owner' ? ' AND v.owner_id=$2' : ''}`,
  actor.type === 'owner' ? [venueId, actor.ownerId] : [venueId])).rows[0];
  if (!row) httpError(404, 'Venue not found');
  return row.options;
}

export async function getManagedVenue(actor: VenueActor, venueId: string) {
  const relations = Object.entries(venueParts).map(([part, definition]) => {
    const expression = part === 'amenities'
      ? `(SELECT to_jsonb(c) FROM public.${definition.table} c WHERE c.venue_id=v.venue_id)`
      : `coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.${definition.id}) FROM public.${definition.table} c WHERE c.venue_id=v.venue_id),'[]'::jsonb)`;
    return `'${definition.table}',${expression}`;
  });
  // One SQL snapshot covers the venue and all five configuration tables.
  const row = (await pool.query(`SELECT to_jsonb(v)||jsonb_build_object(${relations.join(',')}) AS record
    FROM public.venue_details v WHERE venue_id=$1${actor.type === 'owner' ? ' AND owner_id=$2' : ''}`, actor.type === 'owner' ? [venueId, actor.ownerId] : [venueId])).rows[0];
  if (!row) httpError(404, 'Venue not found');
  return row.record;
}

export async function createManagedVenue(actor: VenueActor, input: VenueInput) {
  return writeTransaction(actor, 'create', async client => {
    const ownerId = actor.type === 'owner' ? actor.ownerId : String(input.owner_id);
    await lockOwner(client, actor, ownerId, true);
    const values = { ...input, owner_id: ownerId }, keys = Object.keys(values);
    return (await client.query(`INSERT INTO public.venue_details AS r (venue_id,${keys.map(key => `"${key}"`).join(',')})
      VALUES($1,${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING to_jsonb(r) AS record`, [generateId(), ...Object.values(values)])).rows[0].record;
  });
}

export async function updateManagedVenue(actor: VenueActor, venueId: string, input: VenueInput) {
  return writeTransaction(actor, 'edit', async client => {
    await lockVenue(client, actor, venueId);
    const keys = Object.keys(input);
    await client.query(`UPDATE public.venue_details SET ${keys.map((key, i) => `"${key}"=$${i + 2}`).join(',')} WHERE venue_id=$1`, [venueId, ...Object.values(input)]);
    await touchVenue(client, actor, venueId);
    return (await client.query('SELECT to_jsonb(r) AS record FROM public.venue_details r WHERE venue_id=$1', [venueId])).rows[0].record;
  });
}

export async function deleteManagedVenue(actor: VenueActor, venueId: string) {
  if (actor.type !== 'admin') httpError(403, 'Admin permission required');
  return writeTransaction(actor, 'delete', async client => {
    await lockVenue(client, actor, venueId);
    await client.query("UPDATE public.venue_details SET status='Deleted',is_active=false,updated_at=now() WHERE venue_id=$1", [venueId]);
    return null;
  });
}

const cents = (value: unknown): bigint => {
  const [whole = '0', fraction = ''] = String(value ?? 0).split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
};
function validateWindows(row: Record<string, unknown>, prefix: string, optional = false): void {
  const keys = [`${prefix}_from_date`, `${prefix}_to_date`, `${prefix}_from_time`, `${prefix}_to_time`];
  const count = keys.filter(key => row[key] != null).length;
  if (optional && !count) return;
  if (count !== 4) httpError(400, `Supply all date/time fields for ${prefix}`);
  if (String(row[keys[0]!]) > String(row[keys[1]!])) httpError(400, `${prefix} from date must not exceed to date`);
  if (row[keys[2]!] === row[keys[3]!]) httpError(400, `${prefix} start/end times must differ`);
}

async function validatePart(client: PoolClient, part: VenuePart, venueId: string, values: VenueInput, previous?: Record<string, unknown>): Promise<void> {
  if (part === 'prices') for (const prefix of ['venue_decoration', 'venue_meals']) {
    if (values[`${prefix}_id`] === null) for (const suffix of ['from_date', 'to_date', 'from_time', 'to_time']) values[`${prefix}_${suffix}`] = null;
  }
  const row = { ...previous, ...values };
  if (part === 'type-slots' && row.from_time === row.to_time) httpError(400, 'Slot start/end times must differ');
  if (part === 'decorations' && cents(row.venue_decoration_advance_price) > cents(row.venue_decoration_price)) httpError(400, 'Decoration advance cannot exceed its price');
  if (part === 'prices') {
    if (!row.venue_type_slot_id) httpError(400, 'venue_type_slot_id is required');
    validateWindows(row, 'venue');
    if (cents(row.venue_advance_price) > cents(row.venue_price)) httpError(400, 'Venue advance cannot exceed its price');
    for (const [id, table] of [['venue_type_slot_id', 'venue_type_slots'], ['venue_decoration_id', 'venue_decoration_details'], ['venue_meals_id', 'venue_meals_details']] as const) {
      if (row[id] != null && !(await client.query(`SELECT 1 FROM public.${table} WHERE venue_id=$1 AND ${id}=$2 FOR KEY SHARE`, [venueId, row[id]])).rowCount) httpError(409, `${id} must belong to this venue`);
    }
    for (const prefix of ['venue_decoration', 'venue_meals']) {
      const hasWindow = ['from_date', 'to_date', 'from_time', 'to_time'].some(suffix => row[`${prefix}_${suffix}`] != null);
      if (!row[`${prefix}_id`] && hasWindow) httpError(400, `${prefix}_id is required for its date/time window`);
      validateWindows(row, prefix, true);
    }
  }
}

export async function writeVenuePart(actor: VenueActor, venueId: string, part: VenuePart, input: VenueInput, partId?: string) {
  return writeTransaction(actor, partId || part === 'amenities' ? 'edit' : 'create', async client => {
    await lockVenue(client, actor, venueId);
    const definition = venueParts[part];
    const existing = partId || part === 'amenities' ? (await client.query(`SELECT to_jsonb(r) AS record FROM public.${definition.table} r
      WHERE venue_id=$1${part === 'amenities' ? '' : ` AND ${definition.id}=$2`} FOR UPDATE`, part === 'amenities' ? [venueId] : [venueId, partId])).rows[0]?.record : undefined;
    if (partId && !existing) httpError(404, 'Venue record not found');
    if (part === 'meals' && !existing && (await client.query('SELECT count(*)::int AS n FROM public.venue_meals_details WHERE venue_id=$1', [venueId])).rows[0].n >= 2) httpError(409, 'A maximum of two meal records per venue is allowed');
    const values = { ...input };
    await validatePart(client, part, venueId, values, existing);
    const keys = Object.keys(values), params = Object.values(values);
    let saved;
    if (existing) {
      saved = (await client.query(`UPDATE public.${definition.table} AS r SET ${keys.map((key, i) => `"${key}"=$${i + 2}`).join(',')},updated_at=now()
        WHERE ${definition.id}=$1 AND venue_id=$${params.length + 2} RETURNING to_jsonb(r) AS record`, [existing[definition.id], ...params, venueId])).rows[0].record;
    } else {
      const idValues = part === 'amenities' ? [venueId] : [venueId, generateId()];
      const idColumns = part === 'amenities' ? 'venue_id' : `venue_id,${definition.id}`;
      saved = (await client.query(`INSERT INTO public.${definition.table} AS r (${idColumns},${keys.map(key => `"${key}"`).join(',')})
        VALUES(${[...idValues, ...params].map((_, i) => `$${i + 1}`).join(',')}) RETURNING to_jsonb(r) AS record`, [...idValues, ...params])).rows[0].record;
    }
    await touchVenue(client, actor, venueId);
    return { created: !existing, record: saved };
  });
}

export async function deleteVenuePart(actor: VenueActor, venueId: string, part: VenuePart, partId?: string) {
  if (actor.type !== 'admin') httpError(403, 'Admin permission required');
  return writeTransaction(actor, 'delete', async client => {
    await lockVenue(client, actor, venueId);
    const { table, id } = venueParts[part];
    if (!(await client.query(`DELETE FROM public.${table} WHERE venue_id=$1${part === 'amenities' ? '' : ` AND ${id}=$2`}`, part === 'amenities' ? [venueId] : [venueId, partId])).rowCount) httpError(404, 'Venue record not found');
    await touchVenue(client, actor, venueId);
    return null;
  });
}
