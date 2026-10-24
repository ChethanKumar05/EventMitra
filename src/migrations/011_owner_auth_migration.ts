import { PoolClient } from 'pg';
export async function ownerAuthMigration(client:PoolClient):Promise<void> {
  await client.query(`
    CREATE TABLE public.owner_sessions (
      token_hash CHAR(64) PRIMARY KEY,
      owner_id VARCHAR(26) NOT NULL REFERENCES public.owner(owner_id) ON DELETE CASCADE,
      password_fingerprint CHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX owner_sessions_owner_idx ON public.owner_sessions(owner_id);
    CREATE INDEX owner_sessions_expiry_idx ON public.owner_sessions(expires_at);
    CREATE TABLE public.owner_login_attempts (
      attempt_key CHAR(64) PRIMARY KEY,
      attempts INTEGER NOT NULL,
      window_start TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX owner_login_attempts_window_idx ON public.owner_login_attempts(window_start);
    CREATE INDEX owner_name_login_idx ON public.owner(lower(btrim(owner_name)));
    CREATE FUNCTION public.invalidate_owner_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.password IS DISTINCT FROM OLD.password OR NEW.status NOT IN ('pending','verified') THEN
        DELETE FROM public.owner_sessions WHERE owner_id=NEW.owner_id;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER owner_auth_changes AFTER UPDATE OF password,status ON public.owner
      FOR EACH ROW EXECUTE FUNCTION public.invalidate_owner_sessions();
  `);
}
