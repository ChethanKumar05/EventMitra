import { VenueRow, findActiveVenueById, listActiveVenues } from '../models/venueModel';
import { VenueListQuery, listColumns } from '../types/list';
import { ListFilters, paginatedQuery, applySearch, listOrder } from './listService';
export { findActiveVenueById, listActiveVenues };
export async function listVenues(query: VenueListQuery) {
  const filters = new ListFilters();
  filters.add("r.status='Active' AND r.is_active=TRUE");
  applySearch(filters,query,Object.fromEntries([...listColumns.venues,'area'].map(column=>[column,`r.${column}`])));
  filters.equal('r.venue_code',query.venue_code,true);
  filters.equal('r.city',query.city,true);
  filters.equal('r.state',query.state,true);
  filters.equal('r.area',query.area,true);
  filters.equal('r.owner_id',query.owner_id);
  if (query.min_capacity !== undefined) filters.add(`r.venue_hall_capacity>=${filters.bind(query.min_capacity)}`);
  if (query.max_capacity !== undefined) filters.add(`r.venue_hall_capacity<=${filters.bind(query.max_capacity)}`);
  return paginatedQuery<VenueRow>('venue_details','venue_id, venue_code, owner_id, venue_name, city, state, status, is_active, created_at',listOrder(query,listColumns.venues,'created_at DESC, venue_id DESC','venue_id'),filters,query);
}
