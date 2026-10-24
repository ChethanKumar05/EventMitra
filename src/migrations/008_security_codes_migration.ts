import { PoolClient } from 'pg';
export async function securityCodesMigration(client: PoolClient): Promise<void> {
  await client.query(`
    -- Retain existing codes and permission grants. New records use generated codes.
    ALTER TABLE public.permissions ADD COLUMN permission_key VARCHAR(100);
    UPDATE public.permissions SET permission_key=permission_code;
    ALTER TABLE public.permissions ALTER COLUMN permission_key SET NOT NULL;
    ALTER TABLE public.permissions ADD CONSTRAINT permissions_key_unique UNIQUE(permission_key);

    CREATE SEQUENCE public.admin_code_seq;
    CREATE SEQUENCE public.role_code_seq;
    CREATE SEQUENCE public.permission_code_seq;
    SELECT setval('public.admin_code_seq', coalesce(max(substring(admin_code FROM 4)::bigint)+1,1), false)
      FROM public.admin WHERE admin_code ~ '^ADM[0-9]{1,18}$';
    SELECT setval('public.role_code_seq', coalesce(max(substring(role_code FROM 3)::bigint)+1,1), false)
      FROM public.roles WHERE role_code ~ '^RL[0-9]{1,18}$';
    SELECT setval('public.permission_code_seq', coalesce(max(substring(permission_code FROM 4)::bigint)+1,1), false)
      FROM public.permissions WHERE permission_code ~ '^PER[0-9]{1,18}$';

    CREATE FUNCTION public.next_security_code(prefix TEXT, code_sequence regclass)
    RETURNS TEXT LANGUAGE SQL VOLATILE AS $$
      SELECT prefix || lpad(number, greatest(5,length(number)), '0')
      FROM (SELECT nextval(code_sequence)::text AS number) generated
    $$;
    ALTER SEQUENCE public.admin_code_seq OWNED BY public.admin.admin_code;
    ALTER SEQUENCE public.role_code_seq OWNED BY public.roles.role_code;
    ALTER SEQUENCE public.permission_code_seq OWNED BY public.permissions.permission_code;
    ALTER TABLE public.admin ALTER COLUMN admin_code SET DEFAULT public.next_security_code('ADM','public.admin_code_seq');
    ALTER TABLE public.roles ALTER COLUMN role_code SET DEFAULT public.next_security_code('RL','public.role_code_seq');
    ALTER TABLE public.permissions ALTER COLUMN permission_code SET DEFAULT public.next_security_code('PER','public.permission_code_seq');
  `);
}
