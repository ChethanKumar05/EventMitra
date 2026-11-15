export interface DiscoveryQuery {
  page: number; limit: number; search?: string; city?: string; state?: string; area?: string; pin_code?: string;
  lat?: number; long?: number; distance_km?: number; min_rating?: number; sort_by: 'distance' | 'rating';
  booking_date?:string;
}
export type NotificationRecipient = 'user' | 'owner' | 'admin';
export interface BookingActor { type: NotificationRecipient; id: string; token: string; }
export interface BookingInput {
  venue_price_id: string; booking_date: string; guest_count: number; include_decoration: boolean; include_meals: boolean; contact_email?: string;
}
