// These expressions are composed by services only. Request values always use SQL parameters.
// Share the same eligibility rule between discovery, quotes and booking creation.
export function effectivePricePredicate(alias:string,dateParameter:string):string{
  return `((NOT ${alias}.is_default AND ${dateParameter}::date BETWEEN ${alias}.venue_from_date AND ${alias}.venue_to_date)
    OR (${alias}.is_default AND NOT EXISTS(SELECT 1 FROM public.venue_price_details dated
      WHERE dated.venue_id=${alias}.venue_id AND dated.venue_type_slot_id=${alias}.venue_type_slot_id
        AND NOT dated.is_default AND ${dateParameter}::date BETWEEN dated.venue_from_date AND dated.venue_to_date)))`;
}

export function effectivePricesJson(venueExpression:string,dateParameter:string):string{
  return `coalesce((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('price_source',CASE WHEN p.is_default THEN 'default' ELSE 'date_specific' END)
      ORDER BY p.venue_type_slot_id,p.venue_from_date,p.venue_price_id)
    FROM public.venue_price_details p JOIN public.venue_type_slots s ON s.venue_type_slot_id=p.venue_type_slot_id AND s.venue_id=p.venue_id
    WHERE p.venue_id=${venueExpression} AND s.is_active AND ${effectivePricePredicate('p',dateParameter)}),'[]'::jsonb)`;
}
