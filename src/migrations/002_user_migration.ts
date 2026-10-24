import { PoolClient } from "pg";

export async function userMigration(client: PoolClient): Promise<void> {
  await client.query(`
CREATE TABLE IF NOT EXISTS public."user" (
  user_id VARCHAR(26) PRIMARY KEY,
  user_code VARCHAR(50) NOT NULL UNIQUE,
  country_code VARCHAR(8) NOT NULL,
  user_phone_number VARCHAR(20) NOT NULL,
  email VARCHAR(255),
  gender VARCHAR(1) CHECK (gender IN ('m','f')),
  user_name VARCHAR(150) NOT NULL,
  profile_image TEXT,
  whatsapp_number VARCHAR(20),
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  alternative_number VARCHAR(20),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (country_code,user_phone_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_unique ON public."user" (LOWER(email)) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.user_phone_verification (
  otp_id VARCHAR(26) PRIMARY KEY,
  otp VARCHAR(255) NOT NULL, -- store a HASH, not a raw OTP
  user_id VARCHAR(26) NOT NULL REFERENCES public."user"(user_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_otp_user_id ON public.user_phone_verification(user_id);
CREATE TABLE IF NOT EXISTS public.user_account_details (
  user_account_id VARCHAR(26) PRIMARY KEY,
  user_id VARCHAR(26) NOT NULL REFERENCES public."user"(user_id) ON DELETE CASCADE,
  passbook_image TEXT,
  ifsc_code VARCHAR(20),
  branch_name VARCHAR(150),
  account_holder_name VARCHAR(150),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_account_user ON public.user_account_details(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_account_one_default ON public.user_account_details(user_id) WHERE is_default = TRUE;
  `);
}
