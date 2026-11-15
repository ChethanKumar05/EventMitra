import { PoolClient } from 'pg';
import { pool } from '../config/database';
import { generateId } from '../utils/id';
import { digest } from '../security/password';
import { BookingActor, NotificationRecipient } from '../types/booking';
import { normalizeEmail } from '../utils/adminValidation';
import { httpError } from '../utils/httpError';
import { assertBookingActor } from './bookingAuthorizationService';

export async function enqueueBookingNotifications(client: PoolClient, booking: Record<string, any>, event: string, body: string): Promise<void> {
  const eventKey = `${event}:${booking.booking_id}`, title = `Booking ${booking.booking_code}: ${event.replaceAll('_', ' ')}`;
  const user = (await client.query('SELECT email FROM public."user" WHERE user_id=$1', [booking.user_id])).rows[0];
  const owner = (await client.query('SELECT email FROM public.owner WHERE owner_id=$1', [booking.owner_id])).rows[0];
  const admins = (await client.query("SELECT admin_id,admin_email FROM public.admin WHERE status='active' AND is_super_admin")).rows;
  const recipients: Array<{ type: NotificationRecipient; id: string; email?: string }> = [
    { type: 'user', id: booking.user_id, email: booking.contact_email ?? user?.email },
    { type: 'owner', id: booking.owner_id, email: owner?.email },
    ...admins.map(admin => ({ type: 'admin' as const, id: admin.admin_id, email: admin.admin_email })),
  ];
  let inboxes:string[];
  try{inboxes=(process.env.BOOKING_ADMIN_EMAILS ?? '').split(',').map(value => value.trim()).filter(Boolean).map(normalizeEmail);}
  catch{httpError(503,'Invalid BOOKING_ADMIN_EMAILS configuration');}
  for (const recipient of recipients) {
    const notificationId = generateId(), data = { booking_id: booking.booking_id, booking_code: booking.booking_code, venue_id: booking.venue_id, event };
    const notification = await client.query(`INSERT INTO public.notifications(notification_id,event_key,recipient_type,recipient_id,title,body,data)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_key,recipient_type,recipient_id) DO NOTHING RETURNING notification_id`,
    [notificationId,eventKey,recipient.type,recipient.id,title,body,data]);
    if (!notification.rowCount) continue;
    const payload = { notification_id: notificationId, title, body, data };
    for (const channel of ['email','push']) {
      if (channel === 'email' && recipient.type === 'admin' && inboxes.length) continue;
      await client.query(`INSERT INTO public.notification_outbox(delivery_id,event_key,channel,recipient_key,recipient_type,recipient_id,destination,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(event_key,channel,recipient_key) DO NOTHING`,
      [generateId(),eventKey,channel,`${recipient.type}:${recipient.id}`,recipient.type,recipient.id,channel === 'email' ? recipient.email ?? null : null,payload]);
    }
  }
  for (const inbox of inboxes) await client.query(`INSERT INTO public.notification_outbox(delivery_id,event_key,channel,recipient_key,recipient_type,destination,payload)
    VALUES($1,$2,'email',$3,'admin',$4,$5) ON CONFLICT(event_key,channel,recipient_key) DO NOTHING`,
  [generateId(),eventKey,`inbox:${inbox}`,inbox,{ notification_id: generateId(),title,body,data: { booking_id: booking.booking_id,booking_code: booking.booking_code,venue_id: booking.venue_id,event } }]);
}

export async function listNotifications(actor: BookingActor, page: number, limit: number, unreadOnly: boolean) {
  const result = (await pool.query(`WITH matching AS (SELECT notification_id,title,body,data,is_read,created_at FROM public.notifications
      WHERE recipient_type=$1 AND recipient_id=$2 AND ($3=false OR is_read=false)),
    page_items AS (SELECT * FROM matching ORDER BY created_at DESC,notification_id DESC LIMIT $4 OFFSET $5)
    SELECT (SELECT count(*)::int FROM matching) AS total,coalesce((SELECT json_agg(page_items ORDER BY created_at DESC,notification_id DESC) FROM page_items),'[]'::json) AS items`,
  [actor.type,actor.id,unreadOnly,limit,(page-1)*limit])).rows[0];
  const totalPages = Math.ceil(result.total/limit);
  return { ...result,page,limit,totalPages,hasNextPage: page<totalPages,hasPreviousPage: page>1 };
}
export async function markNotificationRead(actor: BookingActor, id: string) {
  const result = await pool.query('UPDATE public.notifications SET is_read=true WHERE notification_id=$1 AND recipient_type=$2 AND recipient_id=$3 RETURNING notification_id,is_read', [id,actor.type,actor.id]);
  if (!result.rowCount) httpError(404,'Notification not found'); return result.rows[0];
}
export async function registerDevice(actor: BookingActor, token: string, platform: string) {
  // Authentication is per identity, not a caller-supplied recipient ID.
  if (actor.type !== 'admin') await assertBookingActor(actor);
  const result = await pool.query(`INSERT INTO public.notification_devices(device_id,recipient_type,recipient_id,token,token_hash,platform)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(token_hash) DO UPDATE SET recipient_type=EXCLUDED.recipient_type,recipient_id=EXCLUDED.recipient_id,platform=EXCLUDED.platform,updated_at=now()
    RETURNING device_id,platform,updated_at`, [generateId(),actor.type,actor.id,token,digest(token),platform]);
  return result.rows[0];
}
export async function removeDevice(actor: BookingActor, id: string) {
  if (!(await pool.query('DELETE FROM public.notification_devices WHERE device_id=$1 AND recipient_type=$2 AND recipient_id=$3', [id,actor.type,actor.id])).rowCount) httpError(404,'Device not found'); return null;
}
