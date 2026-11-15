import { SecurityActor } from '../security/types';
import { ManagementListQuery } from './management';

export type VenueActor = { type: 'admin'; actor: SecurityActor } | { type: 'owner'; ownerId: string; token: string };
export type VenueInput = Record<string, string | number | boolean | string[] | null>;
export type VenuePart = 'type-slots' | 'amenities' | 'prices' | 'decorations' | 'meals';
export type VenuePriceDropdown = Extract<VenuePart, 'type-slots' | 'decorations' | 'meals'>;
export const venuePartIdFields = {
  'type-slots': 'venue_type_slot_id',
  amenities: 'venue_id',
  prices: 'venue_price_id',
  decorations: 'venue_decoration_id',
  meals: 'venue_meals_id',
} as const;
export interface ManagedVenueQuery extends ManagementListQuery { min_capacity?: number; max_capacity?: number; }
export const venueStatuses = ['Active', 'Rejected', 'Blocked', 'Deleted', 'Pending', 'Hold'] as const;
export const managedVenueColumns = ['venue_id', 'venue_code', 'owner_id', 'venue_name', 'venue_address', 'venue_hall_capacity', 'venue_dining_capacity', 'venue_available_rooms_count', 'venue_parking_capacity', 'pin_code', 'state', 'city', 'area', 'venue_number', 'email', 'status', 'is_active', 'is_cancellation_availble', 'venue_year_established', 'created_at', 'updated_at'] as const;
export const ownerDropdownColumns = ['owner_id', 'owner_code', 'owner_name', 'user_name', 'status'] as const;
