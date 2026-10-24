import { PoolClient } from "pg";

export async function adminMigration(client: PoolClient): Promise<void> {
  await client.query(`
CREATE TABLE IF NOT EXISTS public.roles (
  role_id VARCHAR(26) PRIMARY KEY,
  role_code VARCHAR(50) NOT NULL UNIQUE,
  role_type VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.modules (
  module_id VARCHAR(26) PRIMARY KEY,
  module_code VARCHAR(60) NOT NULL UNIQUE,
  module_name VARCHAR(150) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.admin (
  admin_id VARCHAR(26) PRIMARY KEY,
  admin_code VARCHAR(50) NOT NULL UNIQUE,
  role_id VARCHAR(26) NOT NULL REFERENCES public.roles(role_id),
  admin_name VARCHAR(150) NOT NULL,
  admin_phone_number VARCHAR(20) NOT NULL UNIQUE,
  admin_email VARCHAR(255) UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('reject','active','block','delete')),
  gender VARCHAR(1) CHECK (gender IN ('m','f')),
  profile_image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_role ON public.admin(role_id);
CREATE TABLE IF NOT EXISTS public.admin_permission (
  module_id VARCHAR(26) NOT NULL REFERENCES public.modules(module_id) ON DELETE CASCADE,
  admin_id VARCHAR(26) NOT NULL REFERENCES public.admin(admin_id) ON DELETE CASCADE,
  role_id VARCHAR(26) NOT NULL REFERENCES public.roles(role_id),
  "create" BOOLEAN NOT NULL DEFAULT FALSE,
  "delete" BOOLEAN NOT NULL DEFAULT FALSE,
  "edit" BOOLEAN NOT NULL DEFAULT FALSE,
  "view" BOOLEAN NOT NULL DEFAULT FALSE,
  "all" BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (admin_id,module_id)
);
CREATE INDEX IF NOT EXISTS idx_admin_permission_role ON public.admin_permission(role_id);
  `);
}
