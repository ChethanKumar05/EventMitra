import { AdminListQuery } from '../types/list';
import { query } from '../config/database';
import { AdminInput, SecurityActor } from '../security/types';
import { getSecurityRecord, listSecurityRecords, writeSecurityRecord } from './securityService';
export const listAdmins = (query: AdminListQuery) => listSecurityRecords('admins', query);
export const getAdmin = (id: string) => getSecurityRecord('admins', id);
export const createAdmin = (actor: SecurityActor, input: AdminInput) => writeSecurityRecord('admins', 'create', actor, input);
export const updateAdmin = (actor: SecurityActor, id: string, input: AdminInput) => writeSecurityRecord('admins', 'update', actor, input, id);
export const deleteAdmin = (actor: SecurityActor, id: string) => writeSecurityRecord('admins', 'delete', actor, {}, id);


export interface AdminRow { admin_id: string; admin_code: string; admin_name: string; role_id: string; status: string; }
export async function findAdminById(adminId: string): Promise<AdminRow | null> {
  const rows = await query<AdminRow>(
    'SELECT admin_id, admin_code, admin_name, role_id, status FROM public.admin WHERE admin_id = $1',
    [adminId],
  );
  return rows[0] ?? null;
}
