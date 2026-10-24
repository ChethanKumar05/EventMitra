export type SecurityResource = 'admins' | 'roles' | 'permissions' | 'modules' | 'admin-permissions';
export interface AdminIdentity {
  admin_id: string;
  admin_name: string;
  admin_username: string;
  admin_email: string;
  role_id: string;
  is_super_admin: boolean;
}
export interface SecurityActor { adminId: string; sessionToken: string; }
export type { Pagination } from '../types/list';
export interface AdminInput {
  admin_name?: string;
  admin_username?: string;
  admin_phone_number?: string | null;
  department?: string | null;
  admin_email?: string;
  role_id?: string;
  password?: string;
  status?: 'active' | 'reject' | 'block' | 'delete';
  is_super_admin?: boolean;
}
export interface RoleInput { role_type?: string; permission_ids?: string[]; }
export interface PermissionInput { permission_key?: string; permission_name?: string; }
export interface ModuleInput { module_name?: string; module_key?: string; }
export const permissionActions = ['create','read','edit','delete','view','all'] as const;
export type PermissionAction = typeof permissionActions[number];
export type PermissionFlags = Record<PermissionAction, boolean>;
export interface AdminPermissionInput extends Partial<PermissionFlags> { admin_id?: string; role_id?: string; module_id?: string; }
export type SecurityInput = AdminInput | RoleInput | PermissionInput | ModuleInput;
