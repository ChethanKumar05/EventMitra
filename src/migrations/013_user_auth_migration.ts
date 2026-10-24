import { randomBytes } from 'node:crypto';
import { PoolClient } from 'pg';
import { digest } from '../security/password';

export async function userAuthMigration(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE SEQUENCE public.user_code_seq;
    SELECT setval('public.user_code_seq', coalesce(max(substring(user_code FROM 4)::bigint)+1,1), false)
      FROM public."user" WHERE user_code ~ '^USR[0-9]{1,18}$';
    ALTER SEQUENCE public.user_code_seq OWNED BY public."user".user_code;
    ALTER TABLE public."user" ALTER COLUMN user_code SET DEFAULT public.next_security_code('USR','public.user_code_seq');
    ALTER TABLE public."user" ADD COLUMN is_phone_number_verified BOOLEAN NOT NULL DEFAULT false;

    ALTER TABLE public.user_phone_verification ADD COLUMN country_code VARCHAR(8);
    ALTER TABLE public.user_phone_verification ADD COLUMN user_phone_number VARCHAR(20);
    ALTER TABLE public.user_phone_verification ADD COLUMN otp_token CHAR(64);
    ALTER TABLE public.user_phone_verification ADD COLUMN account_fingerprint CHAR(64);
    ALTER TABLE public.user_phone_verification ADD COLUMN verified_at TIMESTAMPTZ;
    ALTER TABLE public.user_phone_verification ADD COLUMN consumed_at TIMESTAMPTZ;
    UPDATE public.user_phone_verification v SET country_code=u.country_code, user_phone_number=u.user_phone_number,
      expires_at=least(v.expires_at,now()), consumed_at=now()
      FROM public."user" u WHERE u.user_id=v.user_id;
  `);
  // Keep historical challenges for auditing, but make every legacy proof unusable.
  const legacy = await client.query('SELECT otp_id FROM public.user_phone_verification');
  for (const row of legacy.rows) {
    await client.query('UPDATE public.user_phone_verification SET otp_token=$1,otp=$2 WHERE otp_id=$3',
      [digest(randomBytes(32).toString('hex')), digest(randomBytes(32).toString('hex')), row.otp_id]);
  }
  await client.query(`
    ALTER TABLE public.user_phone_verification DROP COLUMN user_id;
    ALTER TABLE public.user_phone_verification ALTER COLUMN country_code SET NOT NULL;
    ALTER TABLE public.user_phone_verification ALTER COLUMN user_phone_number SET NOT NULL;
    ALTER TABLE public.user_phone_verification ALTER COLUMN otp_token SET NOT NULL;
    ALTER TABLE public.user_phone_verification ADD CONSTRAINT user_otp_token_unique UNIQUE(otp_token);
    CREATE INDEX user_otp_phone_idx ON public.user_phone_verification(country_code,user_phone_number);
    CREATE INDEX user_otp_expiry_idx ON public.user_phone_verification(expires_at);
    CREATE TABLE public.user_otp_limits (
      attempt_key CHAR(64) PRIMARY KEY,
      attempts INTEGER NOT NULL,
      window_start TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX user_otp_limits_window_idx ON public.user_otp_limits(window_start);
    CREATE TABLE public.user_sessions (
      token_hash CHAR(64) PRIMARY KEY,
      user_id VARCHAR(26) NOT NULL REFERENCES public."user"(user_id) ON DELETE CASCADE,
      phone_fingerprint CHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX user_sessions_user_idx ON public.user_sessions(user_id);
    CREATE INDEX user_sessions_expiry_idx ON public.user_sessions(expires_at);
    CREATE FUNCTION public.invalidate_user_auth() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT NEW.is_active OR NEW.status NOT IN ('pending','verified')
        OR NEW.country_code IS DISTINCT FROM OLD.country_code
        OR NEW.user_phone_number IS DISTINCT FROM OLD.user_phone_number
        OR (OLD.is_phone_number_verified AND NOT NEW.is_phone_number_verified) THEN
        DELETE FROM public.user_sessions WHERE user_id=NEW.user_id;
        UPDATE public.user_phone_verification SET consumed_at=now()
          WHERE country_code=OLD.country_code AND user_phone_number=OLD.user_phone_number AND consumed_at IS NULL;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER user_auth_changes AFTER UPDATE OF country_code,user_phone_number,status,is_active,is_phone_number_verified ON public."user"
      FOR EACH ROW EXECUTE FUNCTION public.invalidate_user_auth();
  `);
}
