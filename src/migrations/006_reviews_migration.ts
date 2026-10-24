import { PoolClient } from "pg";

export async function reviewsMigration(client: PoolClient): Promise<void> {
  await client.query(`
CREATE TABLE IF NOT EXISTS public.venue_meal_decoration_ratings (
  rating_id VARCHAR(26) PRIMARY KEY,
  venue_id VARCHAR(26) NOT NULL REFERENCES public.venue_details(venue_id),
  venue_rating SMALLINT CHECK (venue_rating BETWEEN 1 AND 5),
  user_id VARCHAR(26) NOT NULL REFERENCES public."user"(user_id),
  booking_id VARCHAR(26) NOT NULL REFERENCES public.booking(booking_id),
  decoration_id VARCHAR(26) REFERENCES public.venue_decoration_details(venue_decoration_id),
  decoration_rating SMALLINT CHECK (decoration_rating BETWEEN 1 AND 5),
  meal_id VARCHAR(26) REFERENCES public.venue_meals_details(venue_meals_id),
  meal_rating SMALLINT CHECK (meal_rating BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(booking_id,user_id),
  CHECK (venue_rating IS NOT NULL OR decoration_rating IS NOT NULL OR meal_rating IS NOT NULL),
  CHECK (decoration_rating IS NULL OR decoration_id IS NOT NULL),
  CHECK (meal_rating IS NULL OR meal_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_reviews_venue ON public.venue_meal_decoration_ratings(venue_id);
  `);
}
