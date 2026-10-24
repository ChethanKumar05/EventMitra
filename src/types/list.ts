export interface Pagination { page: number; limit: number; }
export interface ListQuery extends Pagination { search?: string; search_column?: string; sort_by?: string; sort_order?: 'asc' | 'desc'; }
export interface AdminListQuery extends ListQuery {
  admin_code?: string;
  admin_username?: string;
  admin_name?: string;
  admin_email?: string;
  admin_phone_number?: string;
  department?: string;
  role_type?: string;
  status?: 'active' | 'reject' | 'block' | 'delete';
  role_id?: string;
  is_super_admin?: boolean;
}
export interface RoleListQuery extends ListQuery { role_code?: string; role_type?: string; permission_id?: string; }
export interface PermissionListQuery extends ListQuery { permission_code?: string; permission_key?: string; role_id?: string; }
export interface VenueListQuery extends ListQuery {
  venue_code?: string;
  city?: string;
  state?: string;
  area?: string;
  owner_id?: string;
  min_capacity?: number;
  max_capacity?: number;
}
export interface PaginatedResult<T> extends Pagination {
  items: T[];
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface ModuleListQuery extends ListQuery { module_code?: string; module_key?: string; module_name?: string; }
export interface AdminPermissionListQuery extends ListQuery {
  admin_id?: string; role_id?: string; module_id?: string; permission_code?: string;
  admin_name?: string; role_type?: string; module_name?: string;
  create?: boolean; read?: boolean; edit?: boolean; delete?: boolean; view?: boolean; all?: boolean;
}
export const listColumns = {
  admins: ['admin_id','admin_code','admin_username','admin_name','admin_email','admin_phone_number','department','role_type','status','is_super_admin','created_at'],
  roles: ['role_id','role_code','role_type','created_at'],
  permissions: ['permission_id','permission_code','permission_key','permission_name'],
  modules: ['module_id','module_code','module_key','module_name','created_at'],
  'admin-permissions': ['permission_id','permission_code','admin_name','role_type','module_name','create','read','edit','delete','view','all','updated_at'],
  venues: ['venue_id','venue_code','venue_name','city','state','created_at']
} as const;
