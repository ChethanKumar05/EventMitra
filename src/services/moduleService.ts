import { ModuleInput, SecurityActor } from '../security/types';
import { ModuleListQuery } from '../types/list';
import { getSecurityRecord,listSecurityRecords,writeSecurityRecord } from './securityService';
export const listModules=(query:ModuleListQuery)=>listSecurityRecords('modules',query);
export const getModule=(id:string)=>getSecurityRecord('modules',id);
export const createModule=(actor:SecurityActor,input:ModuleInput)=>writeSecurityRecord('modules','create',actor,input);
export const updateModule=(actor:SecurityActor,id:string,input:ModuleInput)=>writeSecurityRecord('modules','update',actor,input,id);
export const deleteModule=(actor:SecurityActor,id:string)=>writeSecurityRecord('modules','delete',actor,{},id);
