import { query } from '../config/database';

export interface VenueRow {
  venue_id: string;
  venue_code: string;
  owner_id: string;
  venue_name: string;
  city: string | null;
  state: string | null;
  status: string;
  is_active: boolean;
}

export async function listActiveVenues(limit = 20, offset = 0): Promise<VenueRow[]> {
  return query<VenueRow>(`
    SELECT venue_id, venue_code, owner_id, venue_name, city, state, status, is_active
    FROM public.venue_details
    WHERE status = 'Active' AND is_active = TRUE
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
}

export async function findActiveVenueById(venueId: string): Promise<VenueRow | null> {
  const rows = await query<VenueRow>(`
    SELECT venue_id, venue_code, owner_id, venue_name, city, state, status, is_active
    FROM public.venue_details
    WHERE venue_id = $1 AND status = 'Active' AND is_active = TRUE
  `, [venueId]);
  return rows[0] ?? null;
}
