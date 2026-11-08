# Owner and admin venue APIs

Apply **migration 015** with `npm run migrate`. Earlier migrations are unchanged. Codes are generated as `VEN00001` for venues and `DEC00001` for decorations. IDs are ULIDs. No profiles, credentials or permission grants are created.

Owner base: `/api/owner/venues`, using the owner login cookie. Every request is scoped to the authenticated owner, including venues assigned by an admin. Owners cannot supply `owner_id`. Admin base: `/api/admin/venues`, using the admin cookie. Super admins have full access. Other admins need a module with key **`venue_management`**, with grants for their own admin ID and current role.

| Admin operation | Required permission |
| --- | --- |
| List/get venue, owner dropdown | Read, View or All |
| Create venue/slot/price/decoration/meal | Create or All |
| Update venue/child, upsert amenities | Edit or All |
| Delete venue/child | Delete or All |

Permissions and owner sessions are rechecked inside write transactions. Responses use `{status,message,code,data}`. Create returns `201`, update/get/list/delete `200`. Amenities PUT returns `201` on first insert, `200` afterward, and requires admin Edit in either case.

## Venue routes and approval

| Method | Owner | Admin |
| --- | --- | --- |
| POST create | `/api/owner/venues` | `/api/admin/venues` |
| PUT partial update | `/api/owner/venues/:venueId` | `/api/admin/venues/:venueId` |
| GET list | `/api/owner/venues` | `/api/admin/venues` |
| GET full detail | `/api/owner/venues/:venueId` | `/api/admin/venues/:venueId` |
| DELETE | — | `/api/admin/venues/:venueId` |
| GET owner dropdown | — | `/api/admin/venues/owners` |

Owner-created venues start Pending. Only admins set `status` and `reason`. Owner changes to an Active or Rejected venue, including child changes, return it to Pending for review and clear the previous reason. Hold remains Hold. Owners cannot edit Blocked or Deleted venues. Admin deletion sets `status=Deleted,is_active=false`, preserving the venue, configuration and bookings. Owners can still read their retained configuration.

Venue ownership is immutable through updates. Admin creation requires `owner_id` of a pending/verified owner. Admin-created venues default Pending unless another status is supplied. Status values are case-sensitive: `Active`, `Rejected`, `Blocked`, `Deleted`, `Pending`, `Hold`.

## Venue body

Only `venue_name` is required on owner creation. Optional fields follow the existing schema:

```json
{
  "venue_name": "Garden Hall",
  "venue_hall_capacity": 300,
  "venue_dining_capacity": 100,
  "venue_available_rooms_count": 5,
  "venue_images": ["/uploads/hall.jpg"],
  "venue_documents": ["/uploads/venue-proof.pdf"],
  "pin_code": "560001",
  "state": "Karnataka",
  "city": "Bengaluru",
  "area": "Central",
  "lat": 12.9716,
  "long": 77.5946,
  "venue_number": "+919876543210",
  "venue_alternative_number": null,
  "venue_website_url": "https://example.com/hall",
  "email": "hall@example.com",
  "venue_parking_capacity": 30,
  "venue_length": "100.50",
  "venue_width": "50.00",
  "venue_height": "15.00",
  "refund_policy": ["Refund terms"],
  "cancellation_policy": ["Cancellation terms"],
  "description": "Venue description",
  "is_active": true,
  "is_cancellation_availble": true,
  "venue_year_established": 2020
}
```

Admin creation accepts those fields plus required `owner_id` and optional `status`, `reason`:

```json
{
  "owner_id": "OWNER_ID",
  "venue_name": "Admin-created Hall",
  "city": "Bengaluru",
  "status": "Pending",
  "reason": null
}
```

PUT accepts any nonempty subset of mutable fields. Example owner update:

```json
{
  "venue_hall_capacity": 350,
  "venue_images": ["/uploads/new-hall.jpg"],
  "description": "Updated description"
}
```

Example admin approval:

```json
{
  "status": "Active",
  "is_active": true,
  "reason": null
}
```

IDs, codes, timestamps and unsupported fields are rejected. Owner status/reason are rejected. PUT cannot change owner. Validation: nonempty name max 200; nonnegative integer capacities/counts; establishment year 1800–2200; finite JSON-number coordinates within ±90/±180; nonnegative dimensions with at most two decimals and eight integral digits; email/phone formats; HTTP(S) website URL; JSON booleans. Optional scalar fields may be null except flags/name/status. Arrays contain at most 100 nonempty strings; use `[]` to clear. Images/documents are stored references, not uploaded files. Description max 10000, reason 2000, state/city 100, area 150, pin code 12.

## Configuration routes

Append these paths to the owner or admin base:

| Table | Single save endpoint | Body ID (null = create) | Admin delete |
| --- | --- | --- | --- |
| `venue_type_slots` | POST `/:venueId/type-slots` | `venue_type_slot_id` | DELETE `/:venueId/type-slots/:partId` |
| `venue_aminites` | PUT `/:venueId/amenities` | None (one row per venue) | DELETE same path |
| `venue_price_details` | POST `/:venueId/prices` | `venue_price_id` | DELETE `/:venueId/prices/:partId` |
| `venue_decoration_details` | POST `/:venueId/decorations` | `venue_decoration_id` | DELETE `/:venueId/decorations/:partId` |
| `venue_meals_details` | POST `/:venueId/meals` | `venue_meals_id` | DELETE `/:venueId/meals/:partId` |

For each POST save endpoint, **send its record ID as null to insert** (omitting the ID also inserts; all create-required fields apply), or **include its existing record ID to update** (send mutable fields to change). IDs are returned in create/update responses and in GET venue detail. `venue_id` stays in the URL for both operations: it identifies the parent, not a particular slot/price/decoration/meal. Do not send it in the body. For prices, `venue_type_slot_id` is the required slot link; `venue_price_id` selects the price record being updated and may be null for creation.

Insert returns HTTP/code `201`, message `Venue record created`, and the generated ID in `data`. Update returns HTTP/code `200`, message `Venue record updated`, with the same ID in `data`. A supplied unknown/other-venue record ID returns `404` and never inserts. Empty/malformed non-null IDs and ID-only updates return `400`. A null ID still requires the fields for creation. Admin POST save requires Create/All for null/omitted IDs and Edit/All for populated IDs.

These four resources use one POST save endpoint each. Their separate PUT-by-record-ID routes have been removed for both owners and admins. Amenities continues to use one PUT upsert endpoint: it creates if absent and updates the same row thereafter; omitted flags remain unchanged. Slots, prices and decorations support multiple records per venue. Meals support **at most two**, enforced under concurrent API/SQL writes, including when creating/updating through POST. This does not impose one vegetarian/one nonvegetarian record. Amenities have one row per venue, enforced by the primary key.

### Frontend record selection

Fetch `GET /api/owner/venues/:venueId` (or its admin equivalent) when opening the editor. The response contains `venue_type_slots`, `venue_decoration_details`, `venue_meals_details` and `venue_price_details` arrays with each row's ID. An empty array means there are no records. When editing a selected row, send its ID in the save body. When adding another row, set that ID to null (or omit it). Amenities is an object or null and always uses the same PUT endpoint.

Examples of updates using the same POST endpoints as creation:

POST `/:venueId/type-slots`:

```json
{
  "venue_type_slot_id": "EXISTING_SLOT_ID",
  "slot_name": "Updated morning slot"
}
```

POST `/:venueId/decorations`:

```json
{
  "venue_decoration_id": "EXISTING_DECORATION_ID",
  "venue_decoration_name": "Updated flower decoration"
}
```

POST `/:venueId/meals`:

```json
{
  "venue_meals_id": "EXISTING_MEALS_ID",
  "per_plate_price": "350.00"
}
```

POST `/:venueId/prices`:

```json
{
  "venue_price_id": "EXISTING_PRICE_ID",
  "venue_price": "30000.00"
}
```

There are no owner delete routes. Admin child deletion removes configuration; referenced slots/decorations/meals return `409` until dependent pricing is removed or updated.

### Slots

Required on insert: `slot_name`, `from_time`, `to_time`. Optional: `description`, `is_active`. For updates, include `venue_type_slot_id` and only fields to change.

```json
{
  "venue_type_slot_id": null,
  "slot_name": "Morning",
  "from_time": "08:00",
  "to_time": "16:00",
  "description": "Morning event slot",
  "is_active": true
}
```

Time format is `HH:mm` or `HH:mm:ss`. Start/end must differ; overnight slots (`18:00`–`06:00`) are allowed. No slot-name uniqueness or booking reservation is implied.

### Amenities

Send any nonempty subset; flags default false:

```json
{
  "is_chairs_available": true,
  "is_ac_available": true,
  "is_fan_available": true,
  "is_guest_room_available": false,
  "is_parking_available": true,
  "is_washroom_available": true
}
```

### Decorations

Required on insert: `venue_decoration_name`. For updates, include `venue_decoration_id` and only fields to change. Money defaults zero, arrays empty. Advance cannot exceed the decoration price.

```json
{
  "venue_decoration_id": null,
  "venue_decoration_name": "Flower decoration",
  "venue_decoration_images": ["/uploads/flowers.jpg"],
  "venue_decoration_price": "10000.00",
  "venue_decoration_advance_price": "1000.00",
  "advance_return_within_date": "2027-01-01",
  "is_cancellation_availble": true,
  "cancelation_policy": ["Cancellation terms"],
  "return_policy": ["Return terms"]
}
```

### Meals

Send a nonempty object. Flags default false, money zero, arrays empty. Existing schema spelling `meal_deatails` is preserved.

```json
{
  "venue_meals_id": null,
  "meal_deatails": ["Rice", "Curry", "Dessert"],
  "is_veg": true,
  "is_non_veg": false,
  "per_plate_price": "300.00",
  "meals_advance_price": "1000.00",
  "advance_return_within_date": null,
  "is_cancellation_availble": true,
  "cancelation_policy": ["Cancellation terms"],
  "return_policy": ["Return terms"]
}
```

### Prices

Required on insert: `venue_type_slot_id`, `venue_from_date`, `venue_to_date`, `venue_from_time`, `venue_to_time`, `venue_price`. For updates, include `venue_price_id` and only fields to change. Advance defaults zero. Decoration/meal links and windows are optional.

```json
{
  "venue_price_id": null,
  "venue_type_slot_id": "VENUE_TYPE_SLOT_ID",
  "venue_from_date": "2027-01-01",
  "venue_to_date": "2027-12-31",
  "venue_from_time": "08:00",
  "venue_to_time": "16:00",
  "venue_price": "25000.00",
  "venue_advance_price": "2500.00",
  "venue_decoration_id": "VENUE_DECORATION_ID",
  "venue_decoration_from_date": null,
  "venue_decoration_to_date": null,
  "venue_decoration_from_time": null,
  "venue_decoration_to_time": null,
  "venue_meals_id": "VENUE_MEALS_ID",
  "venue_meals_from_date": null,
  "venue_meals_to_date": null,
  "venue_meals_from_time": null,
  "venue_meals_to_time": null
}
```

All links must belong to the same venue, enforced by service validation and composite foreign keys. Pricing has its own time window, not automatically copied from a slot. Multiple prices for a slot are allowed. Dates must be valid `YYYY-MM-DD`; from-date cannot exceed to-date. Times must differ; overnight windows are allowed. Venue advance cannot exceed venue price. Optional package windows require all four date/time fields together plus the matching package ID. Setting a package ID to null clears its window.

Money accepts JSON numbers or decimal strings, nonnegative, with at most two decimals and ten integral digits. Partial-update business checks use existing saved values. Dates remain date strings in responses. Legacy prices are preserved with null slot IDs; assign a valid slot when updating them.

## Price dropdowns

These GET APIs take `venue_id` in the URL and have no request body or query parameters. Use them to populate the price form:

| Options | Owner endpoint | Admin endpoint |
| --- | --- | --- |
| Type slots | `/api/owner/venues/:venueId/type-slots/dropdown` | `/api/admin/venues/:venueId/type-slots/dropdown` |
| Decorations | `/api/owner/venues/:venueId/decorations/dropdown` | `/api/admin/venues/:venueId/decorations/dropdown` |
| Meals | `/api/owner/venues/:venueId/meals/dropdown` | `/api/admin/venues/:venueId/meals/dropdown` |

Owners can access only their own venue. Admins need Venue Management Read, View or All (super admins have access). Each response is HTTP 200 with an unpaginated array in `data`; an existing venue without options returns `[]`. Missing/other-owner venues return `404`; unauthenticated requests return `401`; missing admin permission returns `403`. No additional migration is needed for these read APIs.

All options contain **`value`** (record ID) and **`label`** for direct dropdown binding, plus:

- Slots: `venue_type_slot_id`, `slot_name`, `from_time`, `to_time`, `is_active`. Sorted by start time, name, then ID. Inactive slots are included with their flag so existing price selections can still be displayed.
- Decorations: `venue_decoration_id`, `venue_decoration_code`, `venue_decoration_name`, `venue_decoration_price`, `venue_decoration_advance_price`. Sorted by name then ID.
- Meals: `venue_meals_id`, `meal_deatails`, `is_veg`, `is_non_veg`, `per_plate_price`, `meals_advance_price`. Labels are `Vegetarian`, `Non-vegetarian`, `Vegetarian and non-vegetarian`, or `Meals` according to flags. Sorted by label then ID.

Example slot dropdown response:

```json
{
  "status": true,
  "message": "Venue price options",
  "code": 200,
  "data": [
    {
      "value": "VENUE_TYPE_SLOT_ID",
      "label": "Morning",
      "venue_type_slot_id": "VENUE_TYPE_SLOT_ID",
      "slot_name": "Morning",
      "from_time": "08:00:00",
      "to_time": "16:00:00",
      "is_active": true
    }
  ]
}
```

Send the selected values as `venue_type_slot_id`, `venue_decoration_id` and `venue_meals_id` in the price save body. Values come only from the specified venue; the price API also enforces this association independently. Documents and owner/profile data are not included in dropdown responses.

## Full detail and lists

Owner/admin GET by ID returns the venue fields plus all five configuration tables in one SQL snapshot:

```json
{
  "venue_type_slots": [],
  "venue_aminites": null,
  "venue_price_details": [],
  "venue_decoration_details": [],
  "venue_meals_details": []
}
```

Existing rows populate arrays; missing amenities is null. Prices include slot/package IDs. Booking/payment/owner-bank data and credentials are not included. Existing public `/api/venues` endpoints retain their approved/active summary response and do not expose documents/configuration.

Venue lists support `page` (default 1), `limit` (default 20, max 100), `search`, `search_column`, `sort_by`, `sort_order=asc|desc`, and exact filters on:

`venue_id`, `venue_code`, `venue_name`, `venue_hall_capacity`, `venue_dining_capacity`, `venue_available_rooms_count`, `venue_parking_capacity`, `pin_code`, `state`, `city`, `area`, `venue_number`, `email`, `status`, `is_active`, `is_cancellation_availble`, `venue_year_established`, `created_at`, `updated_at`.

Admin lists additionally support `owner_id` and return owner name/code. Owners cannot supply an owner filter. Both support inclusive nonnegative integer `min_capacity`, `max_capacity` for hall capacity. Search is case-insensitive literal substring matching. Filters combine with AND. Booleans use `true`/`false`; status capitalization must match. Invalid/repeated/nested/unsupported parameters are rejected. Owner lists include assigned venues in all statuses, including retained Deleted venues.

`GET /api/admin/venues/owners` returns paginated `owner_id`, `owner_code`, `owner_name`, `status`, with search/sort/exact filtering on these four fields. It uses Venue Management permission independently of Owner Management permission. All owner statuses are available for filtering existing venues; creation needs a pending/verified owner. Use the selected ID in admin venue create/list.

```text
GET /api/owner/venues?page=1&limit=20&search_column=venue_name&search=garden&city=Bengaluru&min_capacity=100&sort_by=created_at&sort_order=desc
GET /api/admin/venues/owners?search_column=owner_name&search=ravi&status=verified
GET /api/admin/venues?owner_id=OWNER_ID&status=Pending&is_active=true
```

List `data` includes `items,total,page,limit,totalPages,hasNextPage,hasPreviousPage`. Page/count use the same filters/snapshot. Errors: `400` invalid input/combined values, `401` missing/expired login, `403` permission/cross-site/owner edit to Blocked or Deleted venue, `404` absent or other-owner record, `409` cross-venue links, referenced records, third meal or ineligible owner.

## Postman, migration and tests

Reimport updated [Owner](postman/EventMitra.Owner.postman_collection.json) and [Admin](postman/EventMitra.postman_collection.json) collections and environments. New venue folders log in first, show JSON bodies, capture IDs and demonstrate configuration/detail/list APIs. Set `venue_name`; admins also set `venue_owner_id` from the dropdown. Existing owner/admin login variables remain required. Run the venue folder separately for an existing profile. Optional admin cleanup removes sample child configuration and marks the sample venue deleted.

Migration 015 stops before changes if existing venues have more than two meals or prices link to another venue's decoration/meal. Review those records before retrying; no records are silently removed or reassigned.

Run `npm run typecheck`, `npm run build`, `npm test`, `npm run test:venue:integration:local`. Local tests create/drop an isolated temporary database without migrating the application database. Alternatively set `VENUE_TEST_DATABASE_URL` to a fresh expendable database ending in `_test` and run `npm run test:venue:integration`. `npm run test:integration:local` runs all five suites, including legacy migration upgrade fixtures.
