import { normalizeEmail,validateUsername } from '../utils/adminValidation';
import { effectivePermissions } from './adminPermissionService';
import { PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { pool, withClient } from '../config/database';
import { hashPassword, digest, verifyPassword } from '../security/password';
import { AdminIdentity, SecurityResource } from '../security/types';
import { httpError } from '../utils/httpError';
import { generateId } from '../utils/id';
import { securityTransaction } from './securityService';

export async function loginAdmin(address: string, password: string, ip: string) {
  const key = digest(`identity:${address}`);
  const candidate = await pool.query("SELECT admin_id,password_hash FROM public.admin WHERE (lower(admin_email)=$1 OR lower(admin_username)=$1) AND status='active'",[address]);
  const accountKey=candidate.rows[0]?.admin_id ?? key;
  const attemptKey=digest(`${ip}|${accountKey}`);
  const attempts = await pool.query(`INSERT INTO public.admin_login_attempts (attempt_key, attempts) VALUES ($1,1)
    ON CONFLICT (attempt_key) DO UPDATE SET
      attempts = CASE WHEN admin_login_attempts.window_start < now() - interval '15 minutes' THEN 1 ELSE admin_login_attempts.attempts + 1 END,
      window_start = CASE WHEN admin_login_attempts.window_start < now() - interval '15 minutes' THEN now() ELSE admin_login_attempts.window_start END
    RETURNING attempts`, [attemptKey]);
  if (attempts.rows[0].attempts > 10) httpError(429, 'Too many login attempts. Try again in 15 minutes.');
  const admin = candidate.rows[0];
  if (!await verifyPassword(password, admin?.password_hash ?? null)) httpError(401, 'Invalid email/username or password');
  let profile: Awaited<ReturnType<typeof currentAdmin>> | undefined;
  const session = randomBytes(32).toString('hex');
  await withClient(async client => {
    await client.query('BEGIN');
    try {
      const current = await client.query('SELECT password_hash, status FROM public.admin WHERE admin_id=$1 FOR UPDATE', [admin.admin_id]);
      if (current.rows[0]?.status !== 'active' || current.rows[0]?.password_hash !== admin.password_hash) httpError(401, 'Invalid email/username or password');
      await client.query('DELETE FROM public.admin_sessions WHERE expires_at <= now()');
      await client.query("INSERT INTO public.admin_sessions(token_hash,admin_id,expires_at) VALUES ($1,$2,now()+interval '8 hours')", [digest(session), admin.admin_id]);
      const identity=(await client.query<AdminIdentity>('SELECT admin_id,admin_name,admin_username,admin_email,role_id,is_super_admin FROM public.admin WHERE admin_id=$1',[admin.admin_id])).rows[0]!;
      profile=await currentAdmin(identity,client);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  });
  return { session, admin: profile! };
}
export async function findSessionAdmin(session: string): Promise<AdminIdentity | null> {
  const result = await pool.query<AdminIdentity>(`SELECT a.admin_id, a.admin_name, a.admin_username, a.admin_email, a.role_id, a.is_super_admin
    FROM public.admin_sessions s JOIN public.admin a USING(admin_id)
    WHERE s.token_hash=$1 AND s.expires_at>now() AND a.status='active'`, [digest(session)]);
  return result.rows[0] ?? null;
}
export async function hasSecurityReadPermission(admin: AdminIdentity, resource: SecurityResource): Promise<boolean> {
  const key={admins:'admin_management',roles:'role_management',permissions:'permission_management',modules:'module_management','admin-permissions':'permission_management'}[resource];
  const result=await pool.query(`SELECT 1 FROM public.admin_permission ap JOIN public.modules m USING(module_id)
    JOIN public.admin a ON a.admin_id=ap.admin_id AND a.role_id=ap.role_id
    WHERE ap.admin_id=$1 AND ap.role_id=$2 AND a.status='active' AND m.module_key=$3 AND (ap."all" OR ap."read" OR ap."view")`,[admin.admin_id,admin.role_id,key]);
  return !!result.rowCount;
}
export async function currentAdmin(admin: AdminIdentity, db: Pick<PoolClient,'query'>=pool) {
  const role=(await db.query('SELECT role_code,role_type FROM public.roles WHERE role_id=$1',[admin.role_id])).rows[0];
  return {...admin,...role,permissions:await effectivePermissions(admin,db)};
}
export async function logoutAdmin(session: string): Promise<void> {
  await pool.query('DELETE FROM public.admin_sessions WHERE token_hash=$1', [digest(session)]);
}
export async function bootstrapSuperAdmin(input: { name: string; email: string; password: string; username?:string }): Promise<void> {
  const hash = await hashPassword(input.password);
  const address=normalizeEmail(input.email), username=input.username===undefined?null:validateUsername(input.username);
  await securityTransaction(async client => {
    const exists = await client.query('SELECT 1 FROM public.admin WHERE is_super_admin LIMIT 1');
    if (exists.rowCount) throw new Error('A super admin already exists; use the authenticated API');
    let role=await client.query("SELECT role_id FROM public.roles WHERE lower(regexp_replace(btrim(role_type),'[[:space:]]+',' ','g'))='super admin' FOR UPDATE");
    if(!role.rowCount)role=await client.query("INSERT INTO public.roles(role_id,role_type) VALUES ($1,'Super admin') RETURNING role_id",[generateId()]);
    await client.query(`INSERT INTO public.admin(admin_id,admin_name,admin_email,role_id,password_hash,is_super_admin,admin_username)
      VALUES ($1,$2,$3,$4,$5,true,coalesce($6,lower(public.next_security_code('user','public.admin_username_seq'))))`, [generateId(),input.name,address,role.rows[0].role_id,hash,username]);
  });
}
