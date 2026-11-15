import { PoolClient } from 'pg';

export async function venueAddressMigration(client: PoolClient): Promise<void> {
  await client.query('ALTER TABLE public.venue_details ADD COLUMN venue_address TEXT');
}
