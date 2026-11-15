import { query } from '../config/database';

export interface BookingRow {
  booking_id: string; user_id: string; venue_id: string;
  booking_status: string; booking_from: Date; booking_to: Date;
}

export async function findBookingById(bookingId: string): Promise<BookingRow | null> {
  const rows = await query<BookingRow>(`
    SELECT booking_id, user_id, venue_id, booking_status, booking_from, booking_to
    FROM public.booking WHERE booking_id = $1
  `, [bookingId]);
  return rows[0] ?? null;
}

// Booking writes and database-backed availability checks are implemented in services/bookingService.ts.
