import { PoolClient } from 'pg';
import { generateId } from '../utils/id';
export async function adminModulePermissionsMigration(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE public.admin ADD COLUMN department VARCHAR(100);
    ALTER TABLE public.modules ADD COLUMN module_key VARCHAR(100);
    UPDATE public.modules SET module_key='legacy_' || lower(module_id);
    ALTER TABLE public.modules ALTER COLUMN module_key SET NOT NULL;
    ALTER TABLE public.modules ADD CONSTRAINT modules_key_unique UNIQUE(module_key);
    CREATE SEQUENCE public.module_code_seq;
    SELECT setval('public.module_code_seq',coalesce(max(substring(module_code FROM 4)::bigint)+1,1),false)
      FROM public.modules WHERE module_code ~ '^MOD[0-9]{1,18}$';
    ALTER SEQUENCE public.module_code_seq OWNED BY public.modules.module_code;
    ALTER TABLE public.modules ALTER COLUMN module_code SET DEFAULT public.next_security_code('MOD','public.module_code_seq');
    ALTER TABLE public.admin_permission ADD COLUMN "read" BOOLEAN NOT NULL DEFAULT FALSE;
    UPDATE public.admin_permission SET "create"=true,"read"=true,"edit"=true,"delete"=true,"view"=true WHERE "all";
    ALTER TABLE public.admin_permission ADD COLUMN permission_id VARCHAR(26);
    ALTER TABLE public.admin_permission ADD COLUMN permission_code VARCHAR(100)
      NOT NULL DEFAULT public.next_security_code('PER','public.permission_code_seq');
    ALTER TABLE public.admin_permission ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE public.admin ADD CONSTRAINT admin_id_role_unique UNIQUE(admin_id,role_id);

  `);
  const oldRows = await client.query('SELECT admin_id,module_id FROM public.admin_permission');
  for (const row of oldRows.rows) await client.query('UPDATE public.admin_permission SET permission_id=$1 WHERE admin_id=$2 AND module_id=$3',[generateId(),row.admin_id,row.module_id]);
  await client.query(`ALTER TABLE public.admin_permission ALTER COLUMN permission_id SET NOT NULL;
    ALTER TABLE public.admin_permission ADD CONSTRAINT admin_permission_id_unique UNIQUE(permission_id);
    ALTER TABLE public.admin_permission ADD CONSTRAINT admin_permission_code_unique UNIQUE(permission_code);
    -- Add after backfilling: historical stale rows remain stored but never authorize.
    ALTER TABLE public.admin_permission ADD CONSTRAINT admin_permission_current_role_fk
      FOREIGN KEY(admin_id,role_id) REFERENCES public.admin(admin_id,role_id) ON DELETE CASCADE NOT VALID;`);
  for (const [key,name] of [['admin_management','Admin Management'],['role_management','Role Management'],['permission_management','Permission Management'],['module_management','Module Management']]) {
    await client.query('INSERT INTO public.modules(module_id,module_key,module_name) VALUES ($1,$2,$3)',[generateId(),key,name]);
  }
  // Snapshot existing role-based security read grants per admin; runtime uses admin_permission.
  const grants = await client.query(`SELECT DISTINCT a.admin_id,a.role_id,m.module_id FROM public.admin a
    JOIN public.role_permissions rp ON rp.role_id=a.role_id JOIN public.permissions p USING(permission_id)
    JOIN public.modules m ON m.module_key=CASE p.permission_key
      WHEN 'security.admins.read' THEN 'admin_management' WHEN 'security.roles.read' THEN 'role_management'
      WHEN 'security.permissions.read' THEN 'permission_management' END`);
  for (const grant of grants.rows) {
    await client.query(`INSERT INTO public.admin_permission(permission_id,admin_id,role_id,module_id,"read","view")
      VALUES ($1,$2,$3,$4,true,true) ON CONFLICT(admin_id,module_id) DO NOTHING`,[generateId(),grant.admin_id,grant.role_id,grant.module_id]);
  }
}
