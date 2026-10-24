import { PoolClient } from "pg";

export async function ownerMigration(client: PoolClient): Promise<void> {
  await client.query(`
CREATE TABLE IF NOT EXISTS public.owner (
  owner_id VARCHAR(26) PRIMARY KEY,
  owner_code VARCHAR(50) NOT NULL UNIQUE,
  country_code VARCHAR(8) NOT NULL,
  owner_phone_number VARCHAR(20) NOT NULL,
  alternative_number VARCHAR(20),
  owner_name VARCHAR(150) NOT NULL,
  profile_image TEXT,
  email VARCHAR(255),
  alternative_email VARCHAR(255),
  kyc_verification BOOLEAN NOT NULL DEFAULT FALSE,
  password VARCHAR(255) NOT NULL, -- store a password HASH only
  is_phone_number_verified BOOLEAN NOT NULL DEFAULT FALSE,
  whatsapp_number VARCHAR(20),
  gender VARCHAR(1) CHECK (gender IN ('m','f')),
  doc_type VARCHAR(50),
  doc_number VARCHAR(100),
  doc_image TEXT,
  doc_json JSONB,
  pin_code VARCHAR(12),
  state VARCHAR(100),
  city VARCHAR(100),
  area VARCHAR(150),
  lat NUMERIC(10,7),
  "long" NUMERIC(10,7),
  address TEXT,
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('verified','rejected','blocked','hold','pending','deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (country_code,owner_phone_number),
  CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  CHECK ("long" IS NULL OR "long" BETWEEN -180 AND 180)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_email_unique ON public.owner(LOWER(email)) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.owner_account_details (
  owner_account_id VARCHAR(26) PRIMARY KEY,
  owner_id VARCHAR(26) NOT NULL REFERENCES public.owner(owner_id) ON DELETE CASCADE,
  passbook_image TEXT,
  ifsc_code VARCHAR(20),
  branch_name VARCHAR(150),
  account_holder_name VARCHAR(150),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_owner_account_owner ON public.owner_account_details(owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_account_one_default ON public.owner_account_details(owner_id) WHERE is_default = TRUE;
CREATE TABLE IF NOT EXISTS public.owner_phone_verification (
  otp_id VARCHAR(26) PRIMARY KEY,
  otp VARCHAR(255) NOT NULL, -- store a HASH, not a raw OTP
  owner_id VARCHAR(26) NOT NULL REFERENCES public.owner(owner_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_owner_otp_owner_id ON public.owner_phone_verification(owner_id);
  `);
}
