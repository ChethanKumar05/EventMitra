import { PoolClient } from 'pg';

export async function notificationsMigration(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE public.notifications (
      notification_id VARCHAR(26) PRIMARY KEY,event_key VARCHAR(150) NOT NULL,
      recipient_type VARCHAR(5) NOT NULL CHECK(recipient_type IN ('user','owner','admin')),recipient_id VARCHAR(26) NOT NULL,
      title VARCHAR(200) NOT NULL,body TEXT NOT NULL,data JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_read BOOLEAN NOT NULL DEFAULT false,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(event_key,recipient_type,recipient_id)
    );
    CREATE INDEX notifications_recipient_idx ON public.notifications(recipient_type,recipient_id,created_at);
    CREATE TABLE public.notification_devices (
      device_id VARCHAR(26) PRIMARY KEY,recipient_type VARCHAR(5) NOT NULL CHECK(recipient_type IN ('user','owner','admin')),
      recipient_id VARCHAR(26) NOT NULL,token TEXT NOT NULL,token_hash CHAR(64) NOT NULL UNIQUE,
      platform VARCHAR(7) NOT NULL CHECK(platform IN ('web','android','ios')),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX notification_device_recipient_idx ON public.notification_devices(recipient_type,recipient_id);
    CREATE TABLE public.notification_outbox (
      delivery_id VARCHAR(26) PRIMARY KEY,event_key VARCHAR(150) NOT NULL,channel VARCHAR(5) NOT NULL CHECK(channel IN ('email','push')),
      recipient_key TEXT NOT NULL,recipient_type VARCHAR(5),recipient_id VARCHAR(26),destination TEXT,
      payload JSONB NOT NULL,status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed','skipped')),
      attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),locked_at TIMESTAMPTZ,
      last_error VARCHAR(200),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),delivered_at TIMESTAMPTZ,
      UNIQUE(event_key,channel,recipient_key)
    );
    CREATE INDEX notification_outbox_work_idx ON public.notification_outbox(status,next_attempt_at);
  `);
}
