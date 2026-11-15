import { PoolClient } from 'pg';

export async function bookingFlowMigration(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE SEQUENCE public.booking_code_seq;
    ALTER TABLE public.booking ADD COLUMN booking_code VARCHAR(50) DEFAULT public.next_security_code('BKG','public.booking_code_seq');
    ALTER SEQUENCE public.booking_code_seq OWNED BY public.booking.booking_code;
    ALTER TABLE public.booking ALTER COLUMN booking_code SET NOT NULL;
    ALTER TABLE public.booking ADD CONSTRAINT booking_code_unique UNIQUE(booking_code);
    ALTER TABLE public.booking ADD COLUMN owner_id VARCHAR(26) REFERENCES public.owner(owner_id);
    UPDATE public.booking b SET owner_id=v.owner_id FROM public.venue_details v WHERE v.venue_id=b.venue_id;
    ALTER TABLE public.booking ALTER COLUMN owner_id SET NOT NULL;
    CREATE FUNCTION public.fill_booking_owner_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.owner_id IS NULL THEN SELECT owner_id INTO NEW.owner_id FROM public.venue_details WHERE venue_id=NEW.venue_id; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER booking_owner_snapshot BEFORE INSERT ON public.booking FOR EACH ROW EXECUTE FUNCTION public.fill_booking_owner_snapshot();
    ALTER TABLE public.booking ADD COLUMN venue_price_id VARCHAR(26) REFERENCES public.venue_price_details(venue_price_id) ON DELETE SET NULL;
    ALTER TABLE public.booking ADD COLUMN venue_type_slot_id VARCHAR(26) REFERENCES public.venue_type_slots(venue_type_slot_id) ON DELETE SET NULL;
    ALTER TABLE public.booking ADD COLUMN booking_date DATE;
    ALTER TABLE public.booking ADD COLUMN guest_count INTEGER CHECK(guest_count>0);
    ALTER TABLE public.booking ADD COLUMN contact_email VARCHAR(255);
    ALTER TABLE public.booking ADD COLUMN price_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE public.booking ADD COLUMN advance_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(advance_amount>=0);
    ALTER TABLE public.booking ADD COLUMN payment_state VARCHAR(30) NOT NULL DEFAULT 'awaiting_acceptance'
      CHECK(payment_state IN ('legacy','awaiting_acceptance','awaiting_payment','paid','not_required','expired','refund_review','refunded'));
    ALTER TABLE public.booking ADD COLUMN payment_expires_at TIMESTAMPTZ;
    ALTER TABLE public.booking ADD COLUMN idempotency_key VARCHAR(100);
    ALTER TABLE public.booking ADD COLUMN request_hash CHAR(64);
    UPDATE public.booking SET booking_date=(booking_from AT TIME ZONE 'Asia/Kolkata')::date,
      payment_state=CASE WHEN is_advance_paid THEN 'paid' ELSE 'legacy' END;
    CREATE UNIQUE INDEX booking_user_idempotency ON public.booking(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX booking_owner_created_idx ON public.booking(owner_id,created_at);
    CREATE INDEX booking_payment_expiry_idx ON public.booking(payment_expires_at) WHERE payment_state='awaiting_payment';
    ALTER TABLE public.booking_price_details ADD COLUMN advance_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(advance_amount>=0);
    ALTER TABLE public.booking_price_details ADD COLUMN tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(tax_rate_bps BETWEEN 0 AND 10000);
    ALTER TABLE public.booking_price_details ADD COLUMN balance_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(balance_amount>=0);
    ALTER TABLE public.booking_payment_details ADD COLUMN razorpay_order_id VARCHAR(100) UNIQUE;
    ALTER TABLE public.booking_payment_details ADD COLUMN razorpay_payment_id VARCHAR(100) UNIQUE;
    ALTER TABLE public.booking_payment_details ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'INR' CHECK(currency='INR');
    ALTER TABLE public.booking_payment_details ADD COLUMN order_state VARCHAR(20) NOT NULL DEFAULT 'not_created'
      CHECK(order_state IN ('not_created','creating','created','unknown'));
    ALTER TABLE public.booking_payment_details ADD COLUMN order_intent_at TIMESTAMPTZ;
    ALTER TABLE public.booking_payment_details ADD COLUMN captured_at TIMESTAMPTZ;
    ALTER TABLE public.booking_payment_details ADD COLUMN last_reconciled_at TIMESTAMPTZ;
    CREATE TABLE public.razorpay_webhook_events (
      event_id VARCHAR(150) PRIMARY KEY,event_type VARCHAR(100) NOT NULL,payload_hash CHAR(64) NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE public.booking_refund_reviews (
      refund_review_id VARCHAR(26) PRIMARY KEY,
      booking_id VARCHAR(26) NOT NULL REFERENCES public.booking(booking_id),
      booking_payment_id VARCHAR(26) NOT NULL UNIQUE REFERENCES public.booking_payment_details(booking_payment_id),
      amount NUMERIC(12,2) NOT NULL CHECK(amount>0),
      status VARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Approved','Rejected','Processing','Processed','Failed')),
      reason TEXT NOT NULL,admin_reason TEXT,reviewed_by VARCHAR(26) REFERENCES public.admin(admin_id),
      razorpay_refund_id VARCHAR(100) UNIQUE,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX booking_refund_work_idx ON public.booking_refund_reviews(status,next_attempt_at);
    CREATE TABLE public.booking_request_limits(attempt_key CHAR(64) PRIMARY KEY,attempts INTEGER NOT NULL,window_start TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
}
