import { PoolClient } from 'pg';

export async function peopleAccountsMigration(client: PoolClient): Promise<void> {
  for (const kind of ['user', 'owner'] as const) {
    const table = `${kind}_account_details`, id = `${kind}_id`;
    const excessive = await client.query(`SELECT ${id} FROM public.${table} GROUP BY ${id} HAVING count(*)>5 LIMIT 1`);
    if (excessive.rowCount) throw new Error(`Resolve more than five ${kind} bank accounts before migration 014; existing accounts were not removed`);
  }
  for (const kind of ['user', 'owner'] as const) {
    const table = `${kind}_account_details`, parent = kind === 'user' ? '"user"' : 'owner', id = `${kind}_id`;
    await client.query(`
      ALTER TABLE public.${table} ADD COLUMN account_number VARCHAR(34);
      ALTER TABLE public.${table} ADD COLUMN branch_address TEXT;
      ALTER TABLE public.${table} ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
      ALTER TABLE public.${table} ADD CONSTRAINT ${kind}_account_number_format CHECK(account_number IS NULL OR account_number ~ '^[0-9]{6,34}$');
      CREATE UNIQUE INDEX ${kind}_account_number_unique ON public.${table}(${id},account_number) WHERE account_number IS NOT NULL;
      CREATE FUNCTION public.limit_${kind}_accounts() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='UPDATE' AND NEW.${id} IS DISTINCT FROM OLD.${id} THEN
          RAISE EXCEPTION 'Account ownership cannot be changed' USING ERRCODE='23514',CONSTRAINT='bank_account_owner_immutable';
        END IF;
        IF TG_OP='INSERT' THEN
          PERFORM 1 FROM public.${parent} WHERE ${id}=NEW.${id} FOR UPDATE;
          IF (SELECT count(*) FROM public.${table} WHERE ${id}=NEW.${id})>=5 THEN
            RAISE EXCEPTION 'A maximum of five accounts is allowed' USING ERRCODE='23514',CONSTRAINT='bank_account_limit';
          END IF;
        END IF;
        NEW.updated_at=now();
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER ${kind}_account_guard BEFORE INSERT OR UPDATE ON public.${table}
        FOR EACH ROW EXECUTE FUNCTION public.limit_${kind}_accounts();
    `);
  }
  await client.query(`
    CREATE FUNCTION public.reset_changed_user_contact() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.country_code IS DISTINCT FROM OLD.country_code OR NEW.user_phone_number IS DISTINCT FROM OLD.user_phone_number THEN
        NEW.is_phone_number_verified=false;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER user_contact_verification BEFORE UPDATE OF country_code,user_phone_number ON public."user"
      FOR EACH ROW EXECUTE FUNCTION public.reset_changed_user_contact();
    CREATE FUNCTION public.reset_changed_owner_contact() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.country_code IS DISTINCT FROM OLD.country_code OR NEW.owner_phone_number IS DISTINCT FROM OLD.owner_phone_number THEN
        NEW.is_phone_number_verified=false;
      END IF;
      IF NEW.email IS DISTINCT FROM OLD.email THEN NEW.is_email_verified=false; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER owner_contact_verification BEFORE UPDATE OF country_code,owner_phone_number,email ON public.owner
      FOR EACH ROW EXECUTE FUNCTION public.reset_changed_owner_contact();
    CREATE OR REPLACE FUNCTION public.invalidate_owner_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.password IS DISTINCT FROM OLD.password OR NEW.status NOT IN ('pending','verified')
        OR NEW.country_code IS DISTINCT FROM OLD.country_code OR NEW.owner_phone_number IS DISTINCT FROM OLD.owner_phone_number
        OR NEW.email IS DISTINCT FROM OLD.email THEN
        DELETE FROM public.owner_sessions WHERE owner_id=NEW.owner_id;
        UPDATE public.owner_phone_verification SET consumed_at=now() WHERE consumed_at IS NULL AND
          ((type='phone' AND country_code=OLD.country_code AND phone_number=OLD.owner_phone_number) OR (type='email' AND lower(email)=lower(OLD.email)));
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER owner_auth_changes ON public.owner;
    CREATE TRIGGER owner_auth_changes AFTER UPDATE OF password,status,country_code,owner_phone_number,email ON public.owner
      FOR EACH ROW EXECUTE FUNCTION public.invalidate_owner_sessions();
  `);
}
