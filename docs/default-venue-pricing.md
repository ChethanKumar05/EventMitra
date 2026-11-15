# Default venue prices and booking-date fallback

Apply new migration **020_default_venue_prices_migration** using `npm run migrate`. It adds `venue_price_details.is_default BOOLEAN NOT NULL DEFAULT false`. Existing prices remain unchanged and nondefault; no default price or amount is invented. Earlier migration files are unchanged.

## Owner and admin configuration

There is **at most one default per venue and time slot**. Morning and evening slots can have different defaults. Setting another price as default atomically clears the old default for the same venue/slot. A database unique index prevents competing defaults, including direct SQL writes. Prices are saved through the existing single POST API:

```text
POST /api/owner/venues/:venueId/prices
POST /api/admin/venues/:venueId/prices
```

Mark an existing price as default:

```json
{
  "venue_price_id": "EXISTING_PRICE_ID",
  "is_default": true
}
```

Clear it with the same body and `false`. Omission on an update preserves the flag. Only JSON booleans are accepted; strings, numbers and null return 400. Ownership and existing `venue_management` authorization still apply. An admin who replaces an existing default needs Edit permission, including when creating a new replacement row. Owner changes to an approved venue still return it to Pending for admin approval.

Create a default price:

```json
{
  "venue_price_id": null,
  "venue_type_slot_id": "EXISTING_SLOT_ID",
  "venue_from_date": "2027-01-01",
  "venue_to_date": "2027-12-31",
  "venue_from_time": "08:00",
  "venue_to_time": "16:00",
  "venue_price": "5000.00",
  "venue_advance_price": "1000.00",
  "is_default": true
}
```

For a date-specific price, send `is_default: false` or omit the flag. Required date/time fields remain required when creating any price, preserving the existing payload. A default's venue date range is retained but **does not restrict its fallback dates**. Slot activation, venue/owner eligibility, capacity, booking conflicts, selected package availability and configured package date ranges continue to be checked. Defaults use their own configured times, linked packages, amounts and advances.

## User search and price resolution

Supply the selected date when browsing:

```text
GET /api/user/venues?booking_date=2027-02-20&page=1&limit=20
GET /api/user/venues/:venueId?booking_date=2027-02-20
```

For each active slot:

1. Return nondefault prices whose `venue_from_date <= booking_date <= venue_to_date` (inclusive).
2. If none cover that date for the slot, return its default price regardless of the default row's venue date range.
3. If neither exists, return no price for that slot. Never substitute another slot's default or a zero amount.

Date-aware search items and venue detail contain:

```json
{
  "booking_date": "2027-02-20",
  "has_price_for_date": true,
  "venue_price_details": [
    {
      "venue_price_id": "RESOLVED_PRICE_ID",
      "venue_type_slot_id": "SLOT_ID",
      "venue_price": 5000,
      "venue_advance_price": 1000,
      "is_default": true,
      "price_source": "default"
    }
  ]
}
```

Each price object also contains the normal price fields. `price_source` is `date_specific` or `default`. Use the returned rows directly; do not reapply the default's venue date range in the frontend. Multiple overlapping date-specific configurations remain selectable; the API does not choose an arbitrary package or lowest price.

Venues without any effective price remain visible with `venue_price_details: []` and `has_price_for_date: false`. Counts and pagination count venues, regardless of the number of price rows. Existing rating/distance/location filters still work together with `booking_date`. This indicates configured pricing, not reservation availability; the quote endpoint checks booking conflicts.

Without `booking_date`, search keeps its existing response and venue detail returns all active-slot price configurations. `booking_date` must be a single valid YYYY-MM-DD value. Malformed or repeated dates return 400.

## Quotes and booking creation

The body for both APIs remains unchanged:

```text
POST /api/user/bookings/quote
POST /api/user/bookings
```

Send a `venue_price_id` returned by the date-aware search/detail response plus `booking_date`, `guest_count` and the existing optional package/contact fields. Creation still requires its `Idempotency-Key` header.

Quotes include the actual resolved `venue_price_id`, `requested_venue_price_id`, `is_default` and `price_source`. If a previously selected date-specific price no longer covers the requested date, the server can resolve that same slot's default when no date-specific price covers it. If date-specific pricing exists, a client cannot force a default to bypass it: refresh pricing and choose a date-specific ID. Missing effective pricing returns 409.

Creation recalculates the price, persists the actual resolved price ID and freezes the full price/advance breakdown. New booking details expose `price_snapshot.price.is_default`, `price_snapshot.price_source` and `price_snapshot.requested_venue_price_id`. Later edits, switches or deletion of default configurations do not reprice an existing booking. Configured advances are still collected only after owner acceptance.

## Updated APIs

| Method | Endpoint | Change |
| --- | --- | --- |
| POST | `/api/owner/venues/:venueId/prices` | Create/update `is_default`; replace the same slot's previous default atomically |
| POST | `/api/admin/venues/:venueId/prices` | Same behavior, with current module action checks |
| GET | `/api/owner/venues` | Embedded price rows include `is_default` |
| GET | `/api/owner/venues/:venueId` | Price configurations include `is_default` |
| GET | `/api/admin/venues` | Embedded price rows include `is_default` |
| GET | `/api/admin/venues/:venueId` | Price configurations include `is_default` |
| GET | `/api/user/venues` | Optional `booking_date`; effective date-specific/default prices and availability flag |
| GET | `/api/user/venues/:venueId` | Optional `booking_date`; same effective price resolution |
| POST | `/api/user/bookings/quote` | Resolve/enforce default precedence and return the actual price source/ID |
| POST | `/api/user/bookings` | Apply the same rule and save an immutable resolved price snapshot |
| GET | `/api/{user,owner,admin}/bookings/:bookingId` | New booking snapshots include the default/source metadata |

Reimport the Owner/Admin/User/Booking Postman collections. Owner/Admin price creation examples show `is_default: false`, with a separate request to mark a selected price as default. User and Booking discovery examples include `booking_date`.

Integration tests cover inclusive date ranges, fallback outside default ranges, slot isolation, absence of fallback, search/detail/quote/create consistency, stale selected IDs, bypass prevention, immutable booking amounts, invalid dates/flags, owner isolation, live admin action checks, concurrent default switches and direct-SQL uniqueness. Run `npm run test:venue:integration:local` and `npm run test:booking:integration:local`, or all suites with `npm run test:integration:local`.
