import { Request } from 'express';
import { httpError } from '../utils/httpError';
import { AdminListQuery, RoleListQuery, PermissionListQuery, VenueListQuery, ModuleListQuery, AdminPermissionListQuery, ListQuery, listColumns } from '../types/list';
import { permissionActions } from '../security/types';
type Query = Request['query'];
function scalar(query: Query, key: string, max = 150): string | undefined {
  const value = query[key]; if (value === undefined) return undefined;
  if (typeof value !== 'string') httpError(400, `${key} must be a single string`);
  const trimmed = value.trim(); if (trimmed.length > max) httpError(400, `${key} must contain at most ${max} characters`);
  return trimmed || undefined;
}
function integer(query: Query, key: string, min: number, max: number): number | undefined {
  const value = query[key]; if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) httpError(400, `Invalid ${key}`);
  const result = Number(value); if (!Number.isSafeInteger(result) || result < min || result > max) httpError(400, `Invalid ${key}`);
  return result;
}
function boolean(query: Query, key: string): boolean | undefined {
  const value=scalar(query,key,5); if (value===undefined) return undefined;
  if (value!=='true' && value!=='false') httpError(400,`${key} must be true or false`);
  return value==='true';
}
function base(query: Query, allowed: string[], resource: keyof typeof listColumns): ListQuery {
  const supported=new Set(['page','limit','search','search_column','sort_by','sort_order',...allowed]);
  for (const key of Object.keys(query)) if (!supported.has(key)) httpError(400,`Unsupported query parameter: ${key}`);
  const search_column=scalar(query,'search_column',50),sort_by=scalar(query,'sort_by',50),sort_order=scalar(query,'sort_order',4);
  const columns: readonly string[]=listColumns[resource];
  if (search_column && search_column!=='all' && !columns.includes(search_column)) httpError(400,'Invalid search_column');
  if (sort_by && !columns.includes(sort_by)) httpError(400,'Invalid sort_by');
  if (sort_order && sort_order!=='asc' && sort_order!=='desc') httpError(400,'sort_order must be asc or desc');
  return {page:integer(query,'page',1,1000000)??1,limit:integer(query,'limit',1,100)??20,search:scalar(query,'search',200),search_column,sort_by,sort_order:sort_order as ListQuery['sort_order']};
}
export function adminListQuery(query: Query): AdminListQuery {
  const common=base(query,['admin_code','admin_username','admin_name','admin_email','admin_phone_number','department','role_type','status','role_id','is_super_admin'],'admins');
  const status=scalar(query,'status',20); if (status && !['active','reject','block','delete'].includes(status)) httpError(400,'Invalid status');
  return {...common,admin_code:scalar(query,'admin_code',50),admin_username:scalar(query,'admin_username',50),admin_name:scalar(query,'admin_name'),admin_email:scalar(query,'admin_email',255),admin_phone_number:scalar(query,'admin_phone_number',20),department:scalar(query,'department',100),role_type:scalar(query,'role_type',100),status:status as AdminListQuery['status'],role_id:scalar(query,'role_id',26),is_super_admin:boolean(query,'is_super_admin')};
}
export function roleListQuery(query: Query): RoleListQuery {
  return {...base(query,['role_code','role_type','permission_id'],'roles'),role_code:scalar(query,'role_code',50),role_type:scalar(query,'role_type',100),permission_id:scalar(query,'permission_id',26)};
}
export function permissionListQuery(query: Query): PermissionListQuery {
  return {...base(query,['permission_code','permission_key','role_id'],'permissions'),permission_code:scalar(query,'permission_code',100),permission_key:scalar(query,'permission_key',100),role_id:scalar(query,'role_id',26)};
}
export function moduleListQuery(query: Query): ModuleListQuery {
  return {...base(query,['module_code','module_key','module_name'],'modules'),module_code:scalar(query,'module_code',60),module_key:scalar(query,'module_key',100),module_name:scalar(query,'module_name')};
}
export function adminPermissionListQuery(query: Query): AdminPermissionListQuery {
  const result: AdminPermissionListQuery={...base(query,['admin_id','role_id','module_id','permission_code','admin_name','role_type','module_name',...permissionActions],'admin-permissions'),admin_id:scalar(query,'admin_id',26),role_id:scalar(query,'role_id',26),module_id:scalar(query,'module_id',26),permission_code:scalar(query,'permission_code',100),admin_name:scalar(query,'admin_name'),role_type:scalar(query,'role_type',100),module_name:scalar(query,'module_name')};
  for (const action of permissionActions) result[action]=boolean(query,action);
  return result;
}
export function venueListQuery(query: Query): VenueListQuery {
  const result={...base(query,['venue_code','city','state','area','owner_id','min_capacity','max_capacity'],'venues'),venue_code:scalar(query,'venue_code',50),city:scalar(query,'city',100),state:scalar(query,'state',100),area:scalar(query,'area',150),owner_id:scalar(query,'owner_id',26),min_capacity:integer(query,'min_capacity',0,2147483647),max_capacity:integer(query,'max_capacity',0,2147483647)};
  if (result.min_capacity!==undefined && result.max_capacity!==undefined && result.min_capacity>result.max_capacity) httpError(400,'min_capacity must be <= max_capacity');
  return result;
}
