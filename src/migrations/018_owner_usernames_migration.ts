import { PoolClient } from 'pg';

export async function ownerUsernamesMigration(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE public.owner ADD COLUMN user_name VARCHAR(100);
    WITH candidates AS (
      SELECT owner_id,lower(owner_code) AS candidate,count(*) OVER(PARTITION BY lower(owner_code)) AS n
      FROM public.owner
    )
    UPDATE public.owner o SET user_name=CASE
      WHEN c.n=1 AND c.candidate ~ '^[a-z0-9][a-z0-9_.-]{2,99}$' THEN c.candidate
      ELSE 'owner_'||md5(c.owner_id) END
    FROM candidates c WHERE o.owner_id=c.owner_id;
    ALTER TABLE public.owner ALTER COLUMN user_name SET NOT NULL;
    ALTER TABLE public.owner ADD CONSTRAINT owner_user_name_format CHECK(user_name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{2,99}$');
    CREATE UNIQUE INDEX owner_user_name_unique ON public.owner(lower(user_name));
    DROP INDEX public.owner_name_normalized_unique;
    -- Old contact-verification challenges were not bound to an account's password.
    UPDATE public.owner_phone_verification SET consumed_at=now(),expires_at=least(expires_at,now())
      WHERE purpose='verification' AND consumed_at IS NULL;
    CREATE FUNCTION public.invalidate_owner_username_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.user_name IS DISTINCT FROM OLD.user_name THEN
        DELETE FROM public.owner_sessions WHERE owner_id=NEW.owner_id;
        UPDATE public.owner_phone_verification SET consumed_at=now() WHERE consumed_at IS NULL AND
          ((type='phone' AND country_code=OLD.country_code AND phone_number=OLD.owner_phone_number)
            OR (type='email' AND lower(email)=lower(OLD.email)));
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER owner_username_auth_changes AFTER UPDATE OF user_name ON public.owner
      FOR EACH ROW EXECUTE FUNCTION public.invalidate_owner_username_sessions();
  `);
}
