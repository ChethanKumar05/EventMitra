import { PoolClient } from 'pg';
import { generateId } from '../utils/id';
export async function adminIdentityValidationMigration(client:PoolClient):Promise<void> {
  // Do not silently rename or merge existing roles/modules. Report conflicts for review.
  for(const [table,column] of [['roles','role_type'],['modules','module_name']] as const) {
    const duplicates=await client.query(`SELECT lower(regexp_replace(btrim(${column}),'[[:space:]]+',' ','g')) AS name
      FROM public.${table} GROUP BY 1 HAVING count(*)>1 LIMIT 10`);
    if(duplicates.rowCount) throw new Error(`Duplicate ${column} values must be renamed before migration 010: ${duplicates.rows.map(row=>row.name).join(', ')}`);
  }
  await client.query('ALTER TABLE public.admin ADD COLUMN admin_username VARCHAR(50)');
  const existing=await client.query('SELECT admin_id,admin_code FROM public.admin ORDER BY admin_id');
  const used=new Set<string>();
  for(const row of existing.rows) {
    let username=String(row.admin_code).toLowerCase();
    if(!/^[a-z0-9][a-z0-9_.-]{2,49}$/.test(username)||used.has(username))username=`admin_${generateId().toLowerCase()}`;
    used.add(username);
    await client.query('UPDATE public.admin SET admin_username=$1 WHERE admin_id=$2',[username,row.admin_id]);
  }
  await client.query(`
    CREATE SEQUENCE public.admin_username_seq;
    SELECT setval('public.admin_username_seq',coalesce(max(substring(admin_username FROM 5)::bigint)+1,1),false)
      FROM public.admin WHERE admin_username ~ '^user[0-9]{1,18}$';
    ALTER SEQUENCE public.admin_username_seq OWNED BY public.admin.admin_username;
    -- Retain compatibility with previously generated pgAdmin bootstrap scripts.
    ALTER TABLE public.admin ALTER COLUMN admin_username SET DEFAULT lower(public.next_security_code('user','public.admin_username_seq'));
    ALTER TABLE public.admin ALTER COLUMN admin_username SET NOT NULL;
    ALTER TABLE public.admin ADD CONSTRAINT admin_username_format CHECK(admin_username ~ '^[a-z0-9][a-z0-9_.-]{2,49}$');
    CREATE UNIQUE INDEX admin_username_lower_unique ON public.admin(lower(admin_username));
    CREATE UNIQUE INDEX roles_type_normalized_unique ON public.roles(lower(regexp_replace(btrim(role_type),'[[:space:]]+',' ','g')));
    CREATE UNIQUE INDEX modules_name_normalized_unique ON public.modules(lower(regexp_replace(btrim(module_name),'[[:space:]]+',' ','g')));
  `);
}
