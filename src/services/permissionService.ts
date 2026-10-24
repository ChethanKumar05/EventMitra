import { PermissionListQuery } from '../types/list';
import { PermissionInput, SecurityActor } from '../security/types';
import { getSecurityRecord, listSecurityRecords, writeSecurityRecord } from './securityService';
export const listPermissions = (query: PermissionListQuery) => listSecurityRecords('permissions', query);
export const getPermission = (id: string) => getSecurityRecord('permissions', id);
export const createPermission = (actor: SecurityActor, input: PermissionInput) => writeSecurityRecord('permissions', 'create', actor, input);
export const updatePermission = (actor: SecurityActor, id: string, input: PermissionInput) => writeSecurityRecord('permissions', 'update', actor, input, id);
export const deletePermission = (actor: SecurityActor, id: string) => writeSecurityRecord('permissions', 'delete', actor, {}, id);
