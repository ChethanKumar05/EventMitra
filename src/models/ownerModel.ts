import { query } from '../config/database';

export interface OwnerRow { owner_id: string; owner_code: string; owner_name: string; status: string; }

export async function findOwnerById(ownerId: string): Promise<OwnerRow | null> {
  // Intentionally select explicit public fields; NEVER expose password/doc_json here.
  const rows = await query<OwnerRow>(
    'SELECT owner_id, owner_code, owner_name, status FROM public.owner WHERE owner_id = $1',
    [ownerId],
  );
  return rows[0] ?? null;
}
