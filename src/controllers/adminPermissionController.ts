import * as service from '../services/adminPermissionService';
import { AdminPermissionInput,permissionActions } from '../security/types';
import { securityActor } from '../middleware/adminAuth';
import { success } from '../utils/response';
import { httpError } from '../utils/httpError';
import { handler,recordId,requestBody } from './securityValidation';
import { adminPermissionListQuery } from './listValidation';
function validate(value:unknown,create=false):AdminPermissionInput {
  const body=requestBody(value,'permission_code'),input:AdminPermissionInput={};
  for(const field of ['admin_id','role_id','module_id'] as const) if(create || body[field]!==undefined) input[field]=recordId(body[field]);
  for(const action of permissionActions) if(body[action]!==undefined) {
    if(typeof body[action]!=='boolean') httpError(400,`${action} must be a boolean`);
    input[action]=body[action] as boolean;
  }
  return input;
}
export const list=handler(async(req,res)=>{success(res,'Admin permissions',await service.listAdminPermissions(adminPermissionListQuery(req.query)));});
export const get=handler(async(req,res)=>{success(res,'Admin permission',await service.getAdminPermission(recordId(req.params.id)));});
export const upsert=handler(async(req,res)=>{
  const isArray=Array.isArray(req.body),values=isArray?req.body:[req.body];
  if(values.length===0||values.length>1000)httpError(400,'Provide 1-1000 permission objects');
  const inputs:AdminPermissionInput[]=values.map((value:unknown)=>validate(value,true));
  const pairs=inputs.map(input=>JSON.stringify([input.admin_id,input.module_id]));
  if(new Set(pairs).size!==pairs.length)httpError(400,'Duplicate admin/module pair in permission batch');
  const saved=await service.upsertAdminPermissions(securityActor(req,res.locals.admin),inputs);
  success(res,'Permissions saved',isArray?saved:saved[0]);
});
export const remove=handler(async(req,res)=>{success(res,'Deleted',await service.deleteAdminPermission(securityActor(req,res.locals.admin),recordId(req.params.id)));});
export const matrix=handler(async(req,res)=>{success(res,'Permission matrix',await service.adminPermissionMatrix(recordId(req.params.adminId)));});
export const replace=handler(async(req,res)=>{
  const adminId=recordId(req.params.adminId),body=requestBody(req.body,'permission_code'),roleId=recordId(body.role_id);
  if(!Array.isArray(body.permissions) || body.permissions.length>1000) httpError(400,'Invalid permissions');
  const rows=body.permissions.map(value=>{
    const row=validate(value);
    if(!row.module_id) httpError(400,'module_id required');
    if(row.admin_id!==undefined && row.admin_id!==adminId) httpError(400,'Conflicting admin_id');
    if(row.role_id!==undefined && row.role_id!==roleId) httpError(400,'Conflicting role_id');
    return row;
  });
  if(new Set(rows.map(row=>row.module_id)).size!==rows.length) httpError(400,'Duplicate module_id');
  success(res,'Permissions saved',await service.replaceAdminPermissions(securityActor(req,res.locals.admin),adminId,roleId,rows));
});
