import { PoolClient } from 'pg';

export async function defaultVenuePricesMigration(client:PoolClient):Promise<void>{
  await client.query(`
    ALTER TABLE public.venue_price_details ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE public.venue_price_details ADD CONSTRAINT default_price_requires_slot CHECK(NOT is_default OR venue_type_slot_id IS NOT NULL);
    CREATE UNIQUE INDEX venue_price_default_per_slot ON public.venue_price_details(venue_id,venue_type_slot_id) WHERE is_default;
    CREATE INDEX venue_price_date_lookup ON public.venue_price_details(venue_id,venue_type_slot_id,venue_from_date,venue_to_date) WHERE NOT is_default;
  `);
}
