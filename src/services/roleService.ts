import { RoleListQuery } from '../types/list';
import { RoleInput, SecurityActor } from '../security/types';
import { getSecurityRecord, listSecurityRecords, writeSecurityRecord } from './securityService';
export const listRoles = (query: RoleListQuery) => listSecurityRecords('roles', query);
export const getRole = (id: string) => getSecurityRecord('roles', id);
export const createRole = (actor: SecurityActor, input: RoleInput) => writeSecurityRecord('roles', 'create', actor, input);
export const updateRole = (actor: SecurityActor, id: string, input: RoleInput) => writeSecurityRecord('roles', 'update', actor, input, id);
export const deleteRole = (actor: SecurityActor, id: string) => writeSecurityRecord('roles', 'delete', actor, {}, id);
