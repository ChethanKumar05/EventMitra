import { PoolClient } from 'pg';
import { pool } from '../config/database';
import { SecurityActor } from '../security/types';
import { digest } from '../security/password';
import { ManagementAction, PersonKind } from '../types/management';
import { httpError } from '../utils/httpError';

export async function assertManagementActor(actor: SecurityActor, kind: PersonKind, action: ManagementAction, db: Pick<PoolClient, 'query'> = pool): Promise<void> {
  const flags = action === 'read' ? '(p."read" OR p."view" OR p."all")' : `(p."${action}" OR p."all")`;
  const result = await db.query(`SELECT 1 FROM public.admin a JOIN public.admin_sessions s USING(admin_id)
    WHERE a.admin_id=$1 AND a.status='active' AND s.token_hash=$2 AND s.expires_at>now()
      AND (a.is_super_admin OR EXISTS (
        SELECT 1 FROM public.admin_permission p JOIN public.modules m USING(module_id)
        WHERE p.admin_id=a.admin_id AND p.role_id=a.role_id AND m.module_key=$3 AND ${flags}))`,
  [actor.adminId, digest(actor.sessionToken), `${kind}_management`]);
  if (!result.rowCount) httpError(403, 'Permission denied');
}
