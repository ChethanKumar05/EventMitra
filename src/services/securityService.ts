import { AdminListQuery, RoleListQuery, PermissionListQuery, ModuleListQuery, listColumns } from '../types/list';
import { ListFilters, paginatedQuery, applySearch, listOrder } from './listService';
import { PoolClient } from 'pg';
import { withClient, pool } from '../config/database';
import { generateId } from '../utils/id';
import { hashPassword, digest, securityLock } from '../security/password';
import { httpError } from '../utils/httpError';
import { AdminInput, SecurityActor, SecurityInput, SecurityResource, RoleInput } from '../security/types';

type ManagedResource = Exclude<SecurityResource,'admin-permissions'>;
const definitions = {
  admins: { table: 'admin', id: 'admin_id', columns: 'admin_id, admin_code, admin_username, admin_name, admin_email, admin_phone_number, department, role_id, status, is_super_admin, created_at, updated_at, (SELECT role_type FROM public.roles ro WHERE ro.role_id=r.role_id) AS role_type, (SELECT role_code FROM public.roles ro WHERE ro.role_id=r.role_id) AS role_code' },
  roles: { table: 'roles', id: 'role_id', columns: 'role_id, role_code, role_type, created_at' },
  modules: { table: 'modules', id: 'module_id', columns: 'module_id, module_code, module_key, module_name, created_at' },
  permissions: { table: 'permissions', id: 'permission_id', columns: 'permission_id, permission_code, permission_key, permission_name' },
} as const;

export async function securityTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async client => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [securityLock]);
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  });
}
export async function listSecurityRecords(resource: ManagedResource, query: AdminListQuery | RoleListQuery | PermissionListQuery | ModuleListQuery) {
  const { table, id, columns } = definitions[resource];
  const filters = new ListFilters();
  const searchExpressions: Record<string,string> = Object.fromEntries(listColumns[resource].map(column=>[column,`r."${column}"`]));
  if(resource==='admins') searchExpressions.role_type='(SELECT role_type FROM public.roles ro WHERE ro.role_id=r.role_id)';
  applySearch(filters,query,searchExpressions);
  if (resource === 'admins') {
    const input = query as AdminListQuery;
    filters.equal('r.admin_code',input.admin_code,true);
    filters.equal('r.status',input.status);
    for (const field of ['admin_name','admin_username','admin_email','admin_phone_number','department'] as const) filters.equal(`r.${field}`,input[field],true);
    filters.equal(searchExpressions.role_type!,input.role_type,true);
    filters.equal('r.role_id',input.role_id);
    filters.equal('r.is_super_admin',input.is_super_admin);
  } else if (resource === 'roles') {
    const input = query as RoleListQuery;
    filters.equal('r.role_code',input.role_code,true);
    filters.equal('r.role_type',input.role_type,true);
    if (input.permission_id) filters.add(`EXISTS (SELECT 1 FROM public.role_permissions rp WHERE rp.role_id=r.role_id AND rp.permission_id=${filters.bind(input.permission_id)})`);
  } else if(resource==='modules') {
    const input=query as ModuleListQuery;
    for(const field of ['module_code','module_key','module_name'] as const) filters.equal(`r.${field}`,input[field],true);
  } else {
    const input = query as PermissionListQuery;
    filters.equal('r.permission_code',input.permission_code,true);
    filters.equal('r.permission_key',input.permission_key,true);
    if (input.role_id) filters.add(`EXISTS (SELECT 1 FROM public.role_permissions rp WHERE rp.permission_id=r.permission_id AND rp.role_id=${filters.bind(input.role_id)})`);
  }
  return paginatedQuery(table, columns, listOrder(query,listColumns[resource],id,id), filters, query);
}
export async function getSecurityRecord(resource: ManagedResource, recordId: string) {
  const { table, id, columns } = definitions[resource];
  const row = (await pool.query(`SELECT ${columns} FROM public.${table} r WHERE ${id}=$1`, [recordId])).rows[0];
  if (!row) httpError(404, 'Not found');
  if (resource === 'roles') {
    const permissions = await pool.query('SELECT permission_id FROM public.role_permissions WHERE role_id=$1 ORDER BY permission_id', [recordId]);
    row.permission_ids = permissions.rows.map(p => p.permission_id);
  }
  return row;
}
export async function writeSecurityRecord(resource: ManagedResource, operation: 'create' | 'update' | 'delete', actor: SecurityActor, input: SecurityInput, existingId?: string) {
  const { table, id, columns } = definitions[resource];
  const recordId = existingId ?? generateId();
  const adminInput = input as AdminInput;
  // Expensive password hashing happens before acquiring the security-write lock.
  const passwordHash = resource === 'admins' && adminInput.password !== undefined ? await hashPassword(adminInput.password) : undefined;
  return securityTransaction(async client => {
    await assertSecurityActor(client,actor);
    let previous;
    if (operation !== 'create') {
      previous = (await client.query(`SELECT * FROM public.${table} r WHERE ${id}=$1 FOR UPDATE`, [recordId])).rows[0];
      if (!previous) httpError(404, 'Not found');
    }
    if(operation!=='delete')await validateSecurityReferences(client,resource,input,recordId);
    if (resource === 'admins' && previous?.is_super_admin && previous.status === 'active' &&
      (operation === 'delete' || adminInput.is_super_admin === false || (adminInput.status !== undefined && adminInput.status !== 'active'))) {
      const count = await client.query("SELECT count(*)::int AS count FROM public.admin WHERE is_super_admin AND status='active'");
      if (count.rows[0].count <= 1) httpError(409, 'Cannot remove or disable the last active super admin');
    }
    if (resource === 'modules' && previous && ['admin_management','role_management','permission_management','module_management'].includes(previous.module_key) && (operation==='delete' || ('module_key' in input && input.module_key!==previous.module_key))) httpError(409,'System management modules cannot be removed or have their keys changed');
    if (resource === 'admins' && operation==='update' && adminInput.role_id && adminInput.role_id!==previous.role_id) await client.query('DELETE FROM public.admin_permission WHERE admin_id=$1',[recordId]);
    if (operation === 'delete') {
      await client.query(`DELETE FROM public.${table} r WHERE ${id}=$1`, [recordId]);
      return null;
    }
    const values: Record<string, unknown> = { ...input };
    delete values.password;
    delete values.permission_ids;
    if (passwordHash) values.password_hash = passwordHash;
    if (operation === 'create' && resource === 'admins') {
      values.status ??= 'active';
      values.is_super_admin ??= false;
    }
    const keys = Object.keys(values), params = Object.values(values);
    let row;
    if (operation === 'create') {
      // Codes are intentionally omitted: the database default allocates them.
      row = (await client.query(`INSERT INTO public.${table} AS r (${id},${keys.join(',')})
        VALUES ($1,${keys.map((_,i) => `$${i+2}`).join(',')}) RETURNING ${columns}`, [recordId,...params])).rows[0];
    } else if (keys.length) {
      row = (await client.query(`UPDATE public.${table} AS r SET ${keys.map((k,i) => `${k}=$${i+2}`).join(',')}${resource === 'admins' ? ',updated_at=now()' : ''}
        WHERE ${id}=$1 RETURNING ${columns}`, [recordId,...params])).rows[0];
    } else {
      row = (await client.query(`SELECT ${columns} FROM public.${table} r WHERE ${id}=$1`, [recordId])).rows[0];
    }
    const roleInput = input as RoleInput;
    if (resource === 'roles' && roleInput.permission_ids !== undefined) {
      await client.query('DELETE FROM public.role_permissions WHERE role_id=$1', [recordId]);
      await client.query(`INSERT INTO public.role_permissions(role_id,permission_id) SELECT $1, unnest($2::varchar[]) ON CONFLICT DO NOTHING`, [recordId,roleInput.permission_ids]);
      row.permission_ids = [...new Set(roleInput.permission_ids)];
    }
    if (resource === 'admins' && operation === 'update') await client.query('DELETE FROM public.admin_sessions WHERE admin_id=$1', [recordId]);
    return row;
  });
}

export async function assertSecurityActor(client: PoolClient, actor: SecurityActor): Promise<void> {
  const result=await client.query(`SELECT 1 FROM public.admin a JOIN public.admin_sessions s USING(admin_id)
    WHERE a.admin_id=$1 AND a.status='active' AND a.is_super_admin AND s.token_hash=$2 AND s.expires_at>now()`,[actor.adminId,digest(actor.sessionToken)]);
  if(!result.rowCount) httpError(403,'Super admin required');
}

async function validateSecurityReferences(client:PoolClient,resource:ManagedResource,input:SecurityInput,id:string):Promise<void> {
  if(resource==='admins'){
    const admin=input as AdminInput;
    if(admin.role_id && !(await client.query('SELECT 1 FROM public.roles WHERE role_id=$1',[admin.role_id])).rowCount)httpError(409,'Role not found');
    for(const [field,label]of [['admin_email','Email'],['admin_username','Username'],['admin_phone_number','Phone number']] as const){
      if(admin[field]===undefined||admin[field]===null)continue;
      if((await client.query(`SELECT 1 FROM public.admin WHERE lower(${field})=lower($1) AND admin_id<>$2`,[admin[field],id])).rowCount)httpError(409,`${label} already exists`);
    }
  }
  if(resource==='roles'||resource==='modules'){
    const field=resource==='roles'?'role_type':'module_name',table=resource==='roles'?'roles':'modules',key=resource==='roles'?'role_id':'module_id';
    const value=(input as Record<string,unknown>)[field];
    if(value!==undefined && (await client.query(`SELECT 1 FROM public.${table} WHERE lower(regexp_replace(btrim(${field}),'[[:space:]]+',' ','g'))=lower($1) AND ${key}<>$2`,[value,id])).rowCount)httpError(409,resource==='roles'?'Role type already exists':'Module name already exists');
  }
  if(resource==='modules' && 'module_key' in input && input.module_key!==undefined && (await client.query('SELECT 1 FROM public.modules WHERE module_key=$1 AND module_id<>$2',[input.module_key,id])).rowCount)httpError(409,'Module key already exists');
}
