import { PoolClient } from "pg";

export async function bookingMigration(client: PoolClient): Promise<void> {
  await client.query(`
CREATE TABLE IF NOT EXISTS public.booking (
  booking_id VARCHAR(26) PRIMARY KEY,
  user_id VARCHAR(26) NOT NULL REFERENCES public."user"(user_id),
  venue_id VARCHAR(26) NOT NULL REFERENCES public.venue_details(venue_id),
  booking_from TIMESTAMPTZ NOT NULL,
  booking_to TIMESTAMPTZ NOT NULL,
  booking_status VARCHAR(20) NOT NULL DEFAULT 'Requested'
    CHECK (booking_status IN ('Accepted','Rejected','Cancelled','Pending','Requested','Hold')),
  reason TEXT,
  is_advance_paid BOOLEAN NOT NULL DEFAULT FALSE,
  booking_payment_id VARCHAR(26), -- FK added below after payment table exists
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (booking_from < booking_to)
);
CREATE INDEX IF NOT EXISTS idx_booking_venue_window ON public.booking(venue_id,booking_from,booking_to);
CREATE INDEX IF NOT EXISTS idx_booking_user ON public.booking(user_id);

-- PROVISIONAL: original handwritten notes did not contain final booking_price_details columns.
CREATE TABLE IF NOT EXISTS public.booking_price_details (
  booking_price_id VARCHAR(26) PRIMARY KEY,
  booking_id VARCHAR(26) NOT NULL UNIQUE REFERENCES public.booking(booking_id) ON DELETE CASCADE,
  venue_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (venue_amount >= 0),
  decoration_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (decoration_amount >= 0),
  meals_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (meals_amount >= 0),
  tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.booking_payment_details (
  booking_payment_id VARCHAR(26) PRIMARY KEY,
  booking_id VARCHAR(26) NOT NULL REFERENCES public.booking(booking_id),
  booking_total_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (booking_total_amount >= 0),
  booking_totoal_tax NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (booking_totoal_tax >= 0),
  payment_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (payment_amount >= 0),
  booking_razorpay_details JSONB,
  booking_other_payment_details JSONB,
  booking_payment_status VARCHAR(30) NOT NULL DEFAULT 'Pending'
    CHECK (booking_payment_status IN ('Completed','Pending','Hold','In Progress','Rejected','Cancelled','Other')),
  booking_other_payment_status VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(booking_payment_id, booking_id)
);
CREATE INDEX IF NOT EXISTS idx_booking_payment_booking ON public.booking_payment_details(booking_id);

-- Nullable "latest/reference payment" pointer. A booking can have multiple payments.
-- Composite FK prevents linking to another booking's payment transaction.
ALTER TABLE public.booking
  ADD CONSTRAINT fk_booking_selected_payment
  FOREIGN KEY (booking_payment_id,booking_id)
  REFERENCES public.booking_payment_details(booking_payment_id,booking_id)
  DEFERRABLE INITIALLY IMMEDIATE;

-- Basic non-overlap guard for accepted bookings. 'Hold'/'Requested' require explicit
-- expiration and concurrency rules in the service before real booking launch.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE public.booking
  ADD CONSTRAINT booking_no_accepted_overlap EXCLUDE USING gist (
    venue_id WITH =,
    tstzrange(booking_from,booking_to,'[)') WITH &&
  ) WHERE (booking_status = 'Accepted');
  `);
}
