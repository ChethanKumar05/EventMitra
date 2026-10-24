import { PoolClient } from 'pg';
export async function securityMigration(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE public.admin ALTER COLUMN admin_phone_number DROP NOT NULL;
    ALTER TABLE public.admin ADD COLUMN password_hash TEXT;
    ALTER TABLE public.admin ADD COLUMN is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE UNIQUE INDEX admin_email_lower_unique ON public.admin (lower(admin_email));
    CREATE TABLE public.permissions (
      permission_id VARCHAR(26) PRIMARY KEY,
      permission_code VARCHAR(100) NOT NULL UNIQUE,
      permission_name VARCHAR(150) NOT NULL
    );
    CREATE TABLE public.role_permissions (
      role_id VARCHAR(26) REFERENCES public.roles(role_id) ON DELETE CASCADE,
      permission_id VARCHAR(26) REFERENCES public.permissions(permission_id) ON DELETE CASCADE,
      PRIMARY KEY(role_id, permission_id)
    );
    CREATE TABLE public.admin_sessions (
      token_hash CHAR(64) PRIMARY KEY,
      admin_id VARCHAR(26) NOT NULL REFERENCES public.admin(admin_id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX admin_sessions_admin_idx ON public.admin_sessions(admin_id);
    CREATE INDEX admin_sessions_expiry_idx ON public.admin_sessions(expires_at);
    CREATE TABLE public.admin_login_attempts (
      attempt_key CHAR(64) PRIMARY KEY,
      attempts INTEGER NOT NULL,
      window_start TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
