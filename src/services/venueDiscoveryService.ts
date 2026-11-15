import { pool } from '../config/database';
import { DiscoveryQuery } from '../types/booking';
import { ListFilters } from './listService';
import { httpError } from '../utils/httpError';
import { effectivePricesJson } from './venuePricingService';

const publicColumns = 'v.venue_id,v.venue_code,v.venue_name,v.venue_address,v.venue_images,v.venue_hall_capacity,v.venue_dining_capacity,v.venue_available_rooms_count,v.venue_parking_capacity,v.pin_code,v.city,v.state,v.area,v.lat,v."long",v.description,v.refund_policy,v.cancellation_policy,v.is_cancellation_availble';
const eligible = "v.status='Active' AND v.is_active=true AND o.status IN ('pending','verified')";

export async function discoverVenues(query: DiscoveryQuery) {
  const filters = new ListFilters(); filters.add(eligible);
  for (const key of ['city', 'state', 'area', 'pin_code'] as const) filters.equal(`v.${key}`, query[key], true);
  filters.search(['v.venue_name', 'v.city', 'v.state', 'v.area', 'v.pin_code'], query.search);
  let distance = 'NULL::double precision';
  if (query.lat !== undefined && query.long !== undefined) {
    const lat = filters.bind(query.lat), long = filters.bind(query.long);
    distance = `CASE WHEN v.lat IS NOT NULL AND v."long" IS NOT NULL THEN
      6371.0088*2*asin(sqrt(least(1.0,greatest(0.0,
        power(sin(radians(v.lat::double precision-${lat}::double precision)/2),2)
        +cos(radians(${lat}::double precision))*cos(radians(v.lat::double precision))
        *power(sin(radians(v."long"::double precision-${long}::double precision)/2),2))))) END`;
  }
  const conditions = [];
  if (query.distance_km !== undefined) conditions.push(`distance_km<=${filters.bind(query.distance_km)}`);
  if (query.min_rating !== undefined) conditions.push(`rating>=${filters.bind(query.min_rating)}`);
  const dateParameter=query.booking_date===undefined?undefined:filters.bind(query.booking_date);
  const values = [...filters.values, query.limit, (query.page - 1) * query.limit];
  const order = query.sort_by === 'distance' ? 'distance_km ASC NULLS LAST,rating DESC,rating_count DESC,venue_id ASC' : 'rating DESC,rating_count DESC,venue_id ASC';
  const result = (await pool.query(`WITH ranked AS (
      SELECT ${publicColumns},coalesce(r.rating,0)::numeric AS rating,coalesce(r.rating_count,0)::int AS rating_count,${distance} AS distance_km
      FROM public.venue_details v JOIN public.owner o USING(owner_id)
      LEFT JOIN LATERAL (SELECT round(avg(venue_rating),2) AS rating,count(venue_rating)::int AS rating_count
        FROM public.venue_meal_decoration_ratings WHERE venue_id=v.venue_id AND venue_rating IS NOT NULL) r ON true
      ${filters.where}
    ), matching AS (SELECT * FROM ranked ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}),
    page_items AS (SELECT * FROM matching ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length}),
    expanded AS (SELECT page_items.*${dateParameter?`,${dateParameter}::text AS booking_date,options.venue_price_details,jsonb_array_length(options.venue_price_details)>0 AS has_price_for_date`:''}
      FROM page_items ${dateParameter?`CROSS JOIN LATERAL (SELECT ${effectivePricesJson('page_items.venue_id',dateParameter)} AS venue_price_details) options`:''})
    SELECT (SELECT count(*)::int FROM matching) AS total,coalesce((SELECT json_agg(expanded ORDER BY ${order}) FROM expanded),'[]'::json) AS items`, values)).rows[0];
  const totalPages = Math.ceil(result.total / query.limit);
  return { ...result, page: query.page, limit: query.limit, totalPages, hasNextPage: query.page < totalPages, hasPreviousPage: query.page > 1 };
}

export async function getBookableVenue(venueId: string,bookingDate?:string) {
  const priceOptions=bookingDate===undefined
    ? `coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.venue_from_date,p.venue_price_id) FROM public.venue_price_details p JOIN public.venue_type_slots s USING(venue_type_slot_id) WHERE p.venue_id=summary.venue_id AND s.is_active),'[]'::jsonb)`
    : effectivePricesJson('summary.venue_id','$2');
  const result = (await pool.query(`SELECT to_jsonb(summary)||jsonb_build_object(
      'venue_type_slots',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.from_time,s.venue_type_slot_id) FROM public.venue_type_slots s WHERE s.venue_id=summary.venue_id AND s.is_active),'[]'::jsonb),
      'venue_price_details',options.venue_price_details,
      'venue_decoration_details',coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.venue_decoration_id) FROM public.venue_decoration_details d WHERE d.venue_id=summary.venue_id),'[]'::jsonb),
      'venue_meals_details',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.venue_meals_id) FROM public.venue_meals_details m WHERE m.venue_id=summary.venue_id),'[]'::jsonb),
      'venue_aminites',(SELECT to_jsonb(a) FROM public.venue_aminites a WHERE a.venue_id=summary.venue_id)
      ${bookingDate===undefined?'':",'booking_date',$2::text,'has_price_for_date',jsonb_array_length(options.venue_price_details)>0"}) AS record
    FROM (SELECT ${publicColumns} FROM public.venue_details v JOIN public.owner o USING(owner_id) WHERE v.venue_id=$1 AND ${eligible}) summary
    CROSS JOIN LATERAL (SELECT ${priceOptions} AS venue_price_details) options`, bookingDate===undefined?[venueId]:[venueId,bookingDate])).rows[0];
  if (!result) httpError(404, 'Bookable venue not found'); return result.record;
}
