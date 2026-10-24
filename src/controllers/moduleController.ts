import * as service from '../services/moduleService';
import { ModuleInput } from '../security/types';
import { securityActor } from '../middleware/adminAuth';
import { success } from '../utils/response';
import { httpError } from '../utils/httpError';
import { handler,recordId,requestBody,text,uniqueName } from './securityValidation';
import { moduleListQuery } from './listValidation';
function validate(value:unknown,create=false):ModuleInput {
  const body=requestBody(value,'module_code'),input:ModuleInput={};
  if(body.parent_id!==undefined || body.parent_module_id!==undefined) httpError(400,'Only main modules are supported');
  if(create || body.module_name!==undefined) input.module_name=uniqueName(body.module_name,'module_name');
  if(create || body.module_key!==undefined) {
    input.module_key=body.module_key===undefined ? input.module_name!.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'') : text(body.module_key,'module_key',100);
    if(!/^[a-z][a-z0-9_]{0,99}$/.test(input.module_key)) httpError(400,'Invalid module_key');
  }
  return input;
}
export const list=handler(async(req,res)=>{success(res,'modules',await service.listModules(moduleListQuery(req.query)));});
export const get=handler(async(req,res)=>{success(res,'modules',await service.getModule(recordId(req.params.id)));});
export const create=handler(async(req,res)=>{success(res,'Saved',await service.createModule(securityActor(req,res.locals.admin),validate(req.body,true)),201);});
export const update=handler(async(req,res)=>{success(res,'Saved',await service.updateModule(securityActor(req,res.locals.admin),recordId(req.params.id),validate(req.body)));});
export const remove=handler(async(req,res)=>{success(res,'Deleted',await service.deleteModule(securityActor(req,res.locals.admin),recordId(req.params.id)));});
