import { PoolClient } from 'pg';

export async function venueManagementMigration(client: PoolClient): Promise<void> {
  if ((await client.query('SELECT venue_id FROM public.venue_meals_details GROUP BY venue_id HAVING count(*)>2 LIMIT 1')).rowCount) {
    throw new Error('Review venues with more than two meal records before migration 015; no records were removed');
  }
  const invalid = await client.query(`SELECT p.venue_price_id FROM public.venue_price_details p
    LEFT JOIN public.venue_decoration_details d ON d.venue_decoration_id=p.venue_decoration_id
    LEFT JOIN public.venue_meals_details m ON m.venue_meals_id=p.venue_meals_id
    WHERE (p.venue_decoration_id IS NOT NULL AND d.venue_id<>p.venue_id)
       OR (p.venue_meals_id IS NOT NULL AND m.venue_id<>p.venue_id) LIMIT 1`);
  if (invalid.rowCount) throw new Error('Correct cross-venue price decoration/meal references before migration 015');
  await client.query(`
    CREATE SEQUENCE public.venue_code_seq;
    SELECT setval('public.venue_code_seq',coalesce(max(substring(venue_code FROM 4)::bigint)+1,1),false)
      FROM public.venue_details WHERE venue_code ~ '^VEN[0-9]{1,18}$';
    ALTER SEQUENCE public.venue_code_seq OWNED BY public.venue_details.venue_code;
    ALTER TABLE public.venue_details ALTER COLUMN venue_code SET DEFAULT public.next_security_code('VEN','public.venue_code_seq');
    CREATE SEQUENCE public.venue_decoration_code_seq;
    SELECT setval('public.venue_decoration_code_seq',coalesce(max(substring(venue_decoration_code FROM 4)::bigint)+1,1),false)
      FROM public.venue_decoration_details WHERE venue_decoration_code ~ '^DEC[0-9]{1,18}$';
    ALTER SEQUENCE public.venue_decoration_code_seq OWNED BY public.venue_decoration_details.venue_decoration_code;
    ALTER TABLE public.venue_decoration_details ALTER COLUMN venue_decoration_code SET DEFAULT public.next_security_code('DEC','public.venue_decoration_code_seq');
    ALTER TABLE public.venue_type_slots ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE public.venue_decoration_details ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE public.venue_meals_details ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE public.venue_price_details ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE public.venue_price_details ADD COLUMN venue_type_slot_id VARCHAR(26);
    ALTER TABLE public.venue_type_slots ADD CONSTRAINT venue_slot_identity UNIQUE(venue_id,venue_type_slot_id);
    ALTER TABLE public.venue_decoration_details ADD CONSTRAINT venue_decoration_identity UNIQUE(venue_id,venue_decoration_id);
    ALTER TABLE public.venue_meals_details ADD CONSTRAINT venue_meal_identity UNIQUE(venue_id,venue_meals_id);
    ALTER TABLE public.venue_price_details ADD CONSTRAINT price_same_venue_slot FOREIGN KEY(venue_id,venue_type_slot_id) REFERENCES public.venue_type_slots(venue_id,venue_type_slot_id);
    ALTER TABLE public.venue_price_details ADD CONSTRAINT price_same_venue_decoration FOREIGN KEY(venue_id,venue_decoration_id) REFERENCES public.venue_decoration_details(venue_id,venue_decoration_id);
    ALTER TABLE public.venue_price_details ADD CONSTRAINT price_same_venue_meal FOREIGN KEY(venue_id,venue_meals_id) REFERENCES public.venue_meals_details(venue_id,venue_meals_id);
    CREATE INDEX venue_price_slot_idx ON public.venue_price_details(venue_id,venue_type_slot_id);
    CREATE FUNCTION public.guard_venue_meals() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' AND NEW.venue_id IS DISTINCT FROM OLD.venue_id THEN
        RAISE EXCEPTION 'Meal ownership cannot be changed' USING ERRCODE='23514',CONSTRAINT='venue_meal_owner_immutable';
      END IF;
      IF TG_OP='INSERT' THEN
        PERFORM 1 FROM public.venue_details WHERE venue_id=NEW.venue_id FOR UPDATE;
        IF (SELECT count(*) FROM public.venue_meals_details WHERE venue_id=NEW.venue_id)>=2 THEN
          RAISE EXCEPTION 'A maximum of two meal records per venue is allowed' USING ERRCODE='23514',CONSTRAINT='venue_meal_limit';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER venue_meal_limit BEFORE INSERT OR UPDATE ON public.venue_meals_details
      FOR EACH ROW EXECUTE FUNCTION public.guard_venue_meals();
  `);
}
