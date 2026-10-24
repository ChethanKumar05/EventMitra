import { PoolClient } from 'pg';
import { pool } from '../config/database';
import { AdminIdentity,AdminPermissionInput,PermissionFlags,SecurityActor,permissionActions } from '../security/types';
import { AdminPermissionListQuery,listColumns } from '../types/list';
import { assertSecurityActor,securityTransaction } from './securityService';
import { ListFilters,applySearch,listOrder,paginatedQuery } from './listService';
import { httpError } from '../utils/httpError';
import { generateId } from '../utils/id';
const from='public.admin_permission r JOIN public.admin a ON a.admin_id=r.admin_id AND a.role_id=r.role_id JOIN public.roles ro ON ro.role_id=r.role_id JOIN public.modules m ON m.module_id=r.module_id';
const columns='r.permission_id,r.permission_code,r.admin_id,r.role_id,r.module_id,a.admin_name,a.admin_code,ro.role_type,m.module_name,m.module_key,r."create",r."read",r."edit",r."delete",r."view",r."all",r.created_at,r.updated_at';
const emptyFlags:PermissionFlags={create:false,read:false,edit:false,delete:false,view:false,all:false};
function normalize(input:AdminPermissionInput,previous?:PermissionFlags):PermissionFlags {
  const flags={...emptyFlags,...previous};
  for(const action of permissionActions) if(input[action]!==undefined) flags[action]=input[action]!;
  if(input.all!==true && permissionActions.some(action=>action!=='all' && input[action]===false)) flags.all=false;
  if(flags.all) for(const action of permissionActions) flags[action]=true;
  return flags;
}
async function targetAdmin(client:PoolClient,adminId:string,roleId?:string) {
  const result=await client.query('SELECT admin_id,role_id,is_super_admin,admin_name FROM public.admin WHERE admin_id=$1 FOR UPDATE',[adminId]);
  const admin=result.rows[0]; if(!admin) httpError(404,'Admin not found');
  if(roleId!==undefined && admin.role_id!==roleId) httpError(409,'Role does not match the admin current role');
  return admin;
}
async function saveRow(client:PoolClient,adminId:string,roleId:string,moduleId:string,flags:PermissionFlags) {
  return (await client.query(`INSERT INTO public.admin_permission(permission_id,admin_id,role_id,module_id,"create","read","edit","delete","view","all")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(admin_id,module_id) DO UPDATE SET role_id=EXCLUDED.role_id,
      "create"=EXCLUDED."create","read"=EXCLUDED."read","edit"=EXCLUDED."edit","delete"=EXCLUDED."delete","view"=EXCLUDED."view","all"=EXCLUDED."all",updated_at=now()
    RETURNING *`,[generateId(),adminId,roleId,moduleId,...permissionActions.map(action=>flags[action])])).rows[0];
}
export async function listAdminPermissions(query:AdminPermissionListQuery) {
  const filters=new ListFilters();
  const expressions:Record<string,string>=Object.fromEntries(listColumns['admin-permissions'].map(key=>[key,`r."${key}"`]));
  Object.assign(expressions,{admin_name:'a.admin_name',role_type:'ro.role_type',module_name:'m.module_name'});
  applySearch(filters,query,expressions);
  for(const field of ['admin_id','role_id','module_id','permission_code'] as const) filters.equal(`r.${field}`,query[field],field==='permission_code');
  for(const [field,expression] of [['admin_name','a.admin_name'],['role_type','ro.role_type'],['module_name','m.module_name']] as const) filters.equal(expression,query[field],true);
  for(const action of permissionActions) filters.equal(`r."${action}"`,query[action]);
  return paginatedQuery('admin_permission',columns,listOrder(query,listColumns['admin-permissions'],'permission_id','permission_id'),filters,query,from);
}
export async function getAdminPermission(id:string) {
  const row=(await pool.query(`SELECT ${columns} FROM ${from} WHERE r.permission_id=$1`,[id])).rows[0];
  if(!row) httpError(404,'Permission not found'); return row;
}
export async function upsertAdminPermissions(actor:SecurityActor,inputs:AdminPermissionInput[]) {
  return securityTransaction(async client=>{
    await assertSecurityActor(client,actor);
    const saved=[];
    for(const input of inputs){
      const admin=await targetAdmin(client,input.admin_id!,input.role_id);
      if(!(await client.query('SELECT 1 FROM public.modules WHERE module_id=$1',[input.module_id])).rowCount)httpError(409,'Module not found');
      const previous=(await client.query('SELECT * FROM public.admin_permission WHERE admin_id=$1 AND module_id=$2 FOR UPDATE',[input.admin_id,input.module_id])).rows[0];
      saved.push(await saveRow(client,admin.admin_id,admin.role_id,input.module_id!,normalize(input,previous?.role_id===admin.role_id?previous:undefined)));
    }
    return saved;
  });
}
export async function deleteAdminPermission(actor:SecurityActor,id:string) {
  return securityTransaction(async client=>{
    await assertSecurityActor(client,actor);
    if(!(await client.query('DELETE FROM public.admin_permission WHERE permission_id=$1',[id])).rowCount) httpError(404,'Permission not found');
    return null;
  });
}
export async function adminPermissionMatrix(adminId:string) {
  const admin=(await pool.query('SELECT a.admin_id,a.admin_name,a.role_id,a.is_super_admin,r.role_type FROM public.admin a JOIN public.roles r USING(role_id) WHERE a.admin_id=$1',[adminId])).rows[0];
  if(!admin) httpError(404,'Admin not found');
  const result=await pool.query(`SELECT m.module_id,m.module_code,m.module_key,m.module_name,ap.permission_id,ap.permission_code,
    coalesce(ap."create",false) AS "create",coalesce(ap."read",false) AS "read",coalesce(ap."edit",false) AS "edit",
    coalesce(ap."delete",false) AS "delete",coalesce(ap."view",false) AS "view",coalesce(ap."all",false) AS "all"
    FROM public.modules m LEFT JOIN public.admin_permission ap ON ap.module_id=m.module_id AND ap.admin_id=$1 AND ap.role_id=$2 ORDER BY m.module_name,m.module_id`,[adminId,admin.role_id]);
  return {admin,permissions:result.rows};
}
export async function replaceAdminPermissions(actor:SecurityActor,adminId:string,roleId:string,rows:AdminPermissionInput[]) {
  return securityTransaction(async client=>{
    await assertSecurityActor(client,actor);
    const admin=await targetAdmin(client,adminId,roleId);
    const moduleIds=rows.map(row=>row.module_id!);
    const modules=await client.query('SELECT module_id FROM public.modules WHERE module_id=ANY($1::varchar[])',[moduleIds]);
    if(modules.rowCount!==moduleIds.length) httpError(409,'Module not found');
    await client.query('DELETE FROM public.admin_permission WHERE admin_id=$1 AND NOT (module_id=ANY($2::varchar[]))',[adminId,moduleIds]);
    const saved=[];
    for(const row of rows) saved.push(await saveRow(client,admin.admin_id,admin.role_id,row.module_id!,normalize(row)));
    return {admin_id:adminId,role_id:admin.role_id,permissions:saved};
  });
}
export async function effectivePermissions(admin:AdminIdentity,db:Pick<PoolClient,'query'>=pool) {
  const rows=await db.query(`SELECT m.module_id,m.module_code,m.module_key,m.module_name,
    ( $3 OR coalesce(ap."all",false) OR coalesce(ap."create",false)) AS "create",
    ( $3 OR coalesce(ap."all",false) OR coalesce(ap."read",false)) AS "read",
    ( $3 OR coalesce(ap."all",false) OR coalesce(ap."edit",false)) AS "edit",
    ( $3 OR coalesce(ap."all",false) OR coalesce(ap."delete",false)) AS "delete",
    ( $3 OR coalesce(ap."all",false) OR coalesce(ap."view",false)) AS "view",
    ( $3 OR coalesce(ap."all",false)) AS "all"
    FROM public.modules m LEFT JOIN public.admin_permission ap ON ap.module_id=m.module_id AND ap.admin_id=$1 AND ap.role_id=$2
    ORDER BY m.module_name,m.module_id`,[admin.admin_id,admin.role_id,admin.is_super_admin]);
  return rows.rows;
}
