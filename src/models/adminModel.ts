import { query } from '../config/database';

export interface AdminRow { admin_id: string; admin_code: string; admin_name: string; role_id: string; status: string; }
export async function findAdminById(adminId: string): Promise<AdminRow | null> {
  const rows = await query<AdminRow>(
    'SELECT admin_id, admin_code, admin_name, role_id, status FROM public.admin WHERE admin_id = $1',
    [adminId],
  );
  return rows[0] ?? null;
}
