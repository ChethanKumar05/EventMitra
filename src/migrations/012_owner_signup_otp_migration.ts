import { PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { digest } from '../security/password';
export async function ownerSignupOtpMigration(client:PoolClient):Promise<void> {
  const duplicates=await client.query(`SELECT lower(regexp_replace(btrim(owner_name),'[[:space:]]+',' ','g')) AS name FROM public.owner GROUP BY 1 HAVING count(*)>1 LIMIT 10`);
  if(duplicates.rowCount)throw new Error(`Rename duplicate owner_name values before migration 012: ${duplicates.rows.map(row=>row.name).join(', ')}`);
  await client.query(`
    CREATE UNIQUE INDEX owner_name_normalized_unique ON public.owner(lower(regexp_replace(btrim(owner_name),'[[:space:]]+',' ','g')));
    ALTER TABLE public.owner ADD COLUMN is_email_verified BOOLEAN NOT NULL DEFAULT false;
    CREATE SEQUENCE public.owner_code_seq;
    SELECT setval('public.owner_code_seq',coalesce(max(substring(owner_code FROM 4)::bigint)+1,1),false) FROM public.owner WHERE owner_code ~ '^OWN[0-9]{1,18}$';
    ALTER SEQUENCE public.owner_code_seq OWNED BY public.owner.owner_code;
    ALTER TABLE public.owner ALTER COLUMN owner_code SET DEFAULT public.next_security_code('OWN','public.owner_code_seq');
    ALTER TABLE public.owner_phone_verification ADD COLUMN otp_token CHAR(64);
    ALTER TABLE public.owner_phone_verification ADD COLUMN type VARCHAR(5) CHECK(type IN ('email','phone'));
    ALTER TABLE public.owner_phone_verification ADD COLUMN email VARCHAR(255);
    ALTER TABLE public.owner_phone_verification ADD COLUMN phone_number VARCHAR(20);
    ALTER TABLE public.owner_phone_verification ADD COLUMN country_code VARCHAR(8);
    ALTER TABLE public.owner_phone_verification ADD COLUMN purpose VARCHAR(20) NOT NULL DEFAULT 'verification' CHECK(purpose IN ('verification','password_reset'));
    ALTER TABLE public.owner_phone_verification ADD COLUMN password_fingerprint CHAR(64);
    ALTER TABLE public.owner_phone_verification ADD COLUMN verified_at TIMESTAMPTZ;
    ALTER TABLE public.owner_phone_verification ADD COLUMN consumed_at TIMESTAMPTZ;
    UPDATE public.owner_phone_verification v SET type='phone',phone_number=o.owner_phone_number,country_code=o.country_code,
      expires_at=least(v.expires_at,now()),consumed_at=now() FROM public.owner o WHERE o.owner_id=v.owner_id;
  `);
  // Preserve historical rows as expired challenges; old OTPs/tokens must not authorize anything.
  const old=await client.query('SELECT otp_id FROM public.owner_phone_verification');
  for(const row of old.rows)await client.query('UPDATE public.owner_phone_verification SET otp_token=$1,otp=$2 WHERE otp_id=$3',[digest(randomBytes(32).toString('hex')),digest(randomBytes(32).toString('hex')),row.otp_id]);
  await client.query(`
    ALTER TABLE public.owner_phone_verification DROP COLUMN owner_id;
    ALTER TABLE public.owner_phone_verification ALTER COLUMN otp_token SET NOT NULL;
    ALTER TABLE public.owner_phone_verification ALTER COLUMN type SET NOT NULL;
    ALTER TABLE public.owner_phone_verification ADD CONSTRAINT owner_otp_token_unique UNIQUE(otp_token);
    ALTER TABLE public.owner_phone_verification ADD CONSTRAINT owner_otp_target CHECK(
      (type='email' AND email IS NOT NULL AND phone_number IS NULL AND country_code IS NULL) OR
      (type='phone' AND email IS NULL AND phone_number IS NOT NULL AND country_code IS NOT NULL));
    CREATE INDEX owner_otp_target_idx ON public.owner_phone_verification(type,email,country_code,phone_number,purpose);
    CREATE TABLE public.owner_otp_limits(attempt_key CHAR(64) PRIMARY KEY,attempts INTEGER NOT NULL,window_start TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
}
