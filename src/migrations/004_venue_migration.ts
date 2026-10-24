import { PoolClient } from "pg";

export async function venueMigration(client: PoolClient): Promise<void> {
  await client.query(`
CREATE TABLE IF NOT EXISTS public.venue_details (
  venue_id VARCHAR(26) PRIMARY KEY,
  venue_code VARCHAR(50) NOT NULL UNIQUE,
  owner_id VARCHAR(26) NOT NULL REFERENCES public.owner(owner_id),
  venue_name VARCHAR(200) NOT NULL,
  venue_hall_capacity INTEGER CHECK (venue_hall_capacity >= 0),
  venue_dining_capacity INTEGER CHECK (venue_dining_capacity >= 0),
  venue_available_rooms_count INTEGER CHECK (venue_available_rooms_count >= 0),
  venue_images TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  pin_code VARCHAR(12),
  state VARCHAR(100),
  city VARCHAR(100),
  area VARCHAR(150),
  lat NUMERIC(10,7),
  "long" NUMERIC(10,7),
  venue_documents TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  venue_number VARCHAR(20),
  venue_alternative_number VARCHAR(20),
  venue_website_url TEXT,
  email VARCHAR(255),
  venue_parking_capacity INTEGER CHECK (venue_parking_capacity >= 0),
  reason TEXT,
  venue_length NUMERIC(10,2),
  venue_width NUMERIC(10,2),
  venue_height NUMERIC(10,2),
  refund_policy TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  cancellation_policy TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_cancellation_availble BOOLEAN NOT NULL DEFAULT FALSE,
  venue_year_established INTEGER CHECK (venue_year_established BETWEEN 1800 AND 2200),
  status VARCHAR(20) NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Active','Rejected','Blocked','Deleted','Pending','Hold')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  CHECK ("long" IS NULL OR "long" BETWEEN -180 AND 180)
);
CREATE INDEX IF NOT EXISTS idx_venue_owner ON public.venue_details(owner_id);
CREATE INDEX IF NOT EXISTS idx_venue_city_status ON public.venue_details(city,status);

-- PROVISIONAL: detailed columns were not yet supplied for venue_type_slots.
CREATE TABLE IF NOT EXISTS public.venue_type_slots (
  venue_type_slot_id VARCHAR(26) PRIMARY KEY,
  venue_id VARCHAR(26) NOT NULL REFERENCES public.venue_details(venue_id) ON DELETE CASCADE,
  slot_name VARCHAR(100) NOT NULL,
  from_time TIME NOT NULL,
  to_time TIME NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_time <> to_time)
);
CREATE INDEX IF NOT EXISTS idx_venue_type_slots_venue ON public.venue_type_slots(venue_id);

-- PROVISIONAL: flags below are from handwritten notes and need final approval.
CREATE TABLE IF NOT EXISTS public.venue_aminites (
  venue_id VARCHAR(26) PRIMARY KEY REFERENCES public.venue_details(venue_id) ON DELETE CASCADE,
  is_chairs_available BOOLEAN NOT NULL DEFAULT FALSE,
  is_ac_available BOOLEAN NOT NULL DEFAULT FALSE,
  is_fan_available BOOLEAN NOT NULL DEFAULT FALSE,
  is_guest_room_available BOOLEAN NOT NULL DEFAULT FALSE,
  is_parking_available BOOLEAN NOT NULL DEFAULT FALSE,
  is_washroom_available BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.venue_decoration_details (
  venue_decoration_id VARCHAR(26) PRIMARY KEY,
  venue_decoration_code VARCHAR(50) UNIQUE,
  venue_id VARCHAR(26) NOT NULL REFERENCES public.venue_details(venue_id) ON DELETE CASCADE,
  venue_decoration_name VARCHAR(150) NOT NULL,
  venue_decoration_images TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  venue_decoration_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (venue_decoration_price >= 0),
  venue_decoration_advance_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (venue_decoration_advance_price >= 0),
  advance_return_within_date DATE,
  is_cancellation_availble BOOLEAN NOT NULL DEFAULT FALSE,
  cancelation_policy TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  return_policy TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (venue_decoration_advance_price <= venue_decoration_price)
);
CREATE INDEX IF NOT EXISTS idx_venue_decoration_venue ON public.venue_decoration_details(venue_id);

CREATE TABLE IF NOT EXISTS public.venue_meals_details (
  venue_meals_id VARCHAR(26) PRIMARY KEY,
  venue_id VARCHAR(26) NOT NULL REFERENCES public.venue_details(venue_id) ON DELETE CASCADE,
  meal_deatails TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  is_veg BOOLEAN NOT NULL DEFAULT FALSE,
  is_non_veg BOOLEAN NOT NULL DEFAULT FALSE,
  per_plate_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (per_plate_price >= 0),
  meals_advance_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (meals_advance_price >= 0),
  advance_return_within_date DATE,
  is_cancellation_availble BOOLEAN NOT NULL DEFAULT FALSE,
  cancelation_policy TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  return_policy TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_venue_meals_venue ON public.venue_meals_details(venue_id);

CREATE TABLE IF NOT EXISTS public.venue_price_details (
  venue_price_id VARCHAR(26) PRIMARY KEY,
  venue_id VARCHAR(26) NOT NULL REFERENCES public.venue_details(venue_id) ON DELETE CASCADE,
  venue_from_date DATE NOT NULL,
  venue_to_date DATE NOT NULL,
  venue_from_time TIME NOT NULL,
  venue_to_time TIME NOT NULL,
  venue_price NUMERIC(12,2) NOT NULL CHECK (venue_price >= 0),
  venue_advance_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (venue_advance_price >= 0),
  venue_decoration_id VARCHAR(26) REFERENCES public.venue_decoration_details(venue_decoration_id),
  venue_decoration_from_date DATE,
  venue_decoration_to_date DATE,
  venue_decoration_from_time TIME,
  venue_decoration_to_time TIME,
  venue_meals_id VARCHAR(26) REFERENCES public.venue_meals_details(venue_meals_id),
  venue_meals_from_date DATE,
  venue_meals_to_date DATE,
  venue_meals_from_time TIME,
  venue_meals_to_time TIME,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (venue_from_date <= venue_to_date),
  CHECK (venue_advance_price <= venue_price),
  CHECK (venue_decoration_from_date IS NULL OR venue_decoration_to_date IS NULL OR venue_decoration_from_date <= venue_decoration_to_date),
  CHECK (venue_meals_from_date IS NULL OR venue_meals_to_date IS NULL OR venue_meals_from_date <= venue_meals_to_date)
);
CREATE INDEX IF NOT EXISTS idx_venue_price_venue_dates ON public.venue_price_details(venue_id,venue_from_date,venue_to_date);
  `);
}
