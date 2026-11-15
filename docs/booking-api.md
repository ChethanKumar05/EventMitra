# Venue discovery, booking, advances and notifications

Apply new migrations **016 and 017** with `npm run migrate`. Previously applied migrations are unchanged. Start the API with `npm run dev` and, in a second terminal, run `npm run booking:worker`. The worker delivers notifications, expires unpaid reservations, reconciles Razorpay orders/payments and processes approved refunds. For a single pass use `npm run booking:worker -- --once`.

Import [Booking collection](postman/EventMitra.Booking.postman_collection.json) and [Booking environment](postman/EventMitra.Booking.local.postman_environment.json). This collection uses separate user, owner and admin session cookies. Fill your own credentials and existing venue/price IDs; no default accounts or payment secrets are supplied. Run folders individually. The payment callback and refund folders require deliberate action as described below.

## Booking flow

1. A logged-in user chooses an approved, active venue and a configured price row, gets a quote and creates a request. This atomically inserts `booking`, `booking_price_details` and a pending `booking_payment_details` row. Codes such as `BKG00001` are generated automatically.
2. The owner accepts or rejects their own request. Requested bookings do not reserve inventory. Acceptance reserves the whole venue for the chosen time window; PostgreSQL prevents overlapping Accepted bookings, including concurrent acceptance requests.
3. After acceptance, the user pays **only the configured advance amounts** through Razorpay. The default payment window is 30 minutes, capped at the booking start time. A configured zero advance immediately produces `not_required`; no Razorpay order is created.
4. A captured payment with matching server order, INR currency and exact amount marks the booking paid. Frontend callbacks alone do not prove capture. Use `is_confirmed` from booking detail: it is true only for Accepted bookings with `paid` or `not_required` payment state.
5. The worker cancels unpaid Accepted bookings when the window expires, releasing inventory. A late payment is recorded and sent to admin refund review; it never confirms a released reservation.
6. Owner rejection after payment opens a Pending refund review. An authorized admin must approve before the worker requests a refund. Owner rejection never automatically sends money back.

Booking creation queues email, push and in-app notifications for the user, the venue owner and all active super admins. Acceptance, rejection, payment, expiry and refund decisions also queue notifications. `BOOKING_ADMIN_EMAILS` optionally replaces admin email recipients with configured inboxes; super-admin push/in-app notifications remain enabled.

## Authentication and authorization

User routes use the existing user session cookie; owner routes use the owner cookie. IDs come from the authenticated session. Cross-user and cross-owner booking access returns 404. Browser clients must serve/proxy `/api` through the same origin as the frontend and include `credentials: 'include'`. Existing session middleware rejects mutations from a different origin; adding a CORS entry alone does not bypass this protection.

Admin booking reads require `booking_management` Read (or View, as in existing management authorization); refund decisions require Edit. Super admins have access automatically. Create the main module and assign action flags through the existing super-admin security APIs:

```json
{"module_name":"Booking Management","module_key":"booking_management"}
```

Notification inbox/device APIs need authentication only and always operate on the current identity. Neither body nor query can choose another recipient.

## Venue discovery

`GET /api/user/venues?page=1&limit=20`

Only `status='Active'` and `is_active=true` venues with an eligible pending/verified owner are returned. Unapproved venues, private owner documents and owner contact details are excluded.

| Query | Behavior |
| --- | --- |
| `page`, `limit` | Page starts at 1; default limit 20, maximum 100 |
| `search` | Literal partial search across venue name, city, state, area and PIN code |
| `city`, `state`, `area`, `pin_code` | Combined exact, case-insensitive filters |
| `lat`, `long` | Supply both; latitude -90..90, longitude -180..180 |
| `distance_km` | Radius 0.001..20040 km; requires coordinates |
| `sort_by` | `distance` or `rating`; defaults to distance with coordinates, otherwise rating |
| `min_rating` | Minimum average venue rating, 0..5 |

Without coordinates, the highest-rated venues appear first; lower-rated and unrated venues follow. With distance sorting, nearest venues appear first, then rating breaks ties. Distance uses the Haversine formula and is returned in kilometres. Venues without coordinates sort last and are excluded by a radius filter. Unrated venues have rating 0. Ranking uses `venue_rating`, not meal/decoration ratings.

Examples:

```text
GET /api/user/venues?lat=12.9716&long=77.5946&distance_km=25&page=1&limit=20
GET /api/user/venues?city=Bengaluru&state=Karnataka&sort_by=rating&min_rating=3
GET /api/user/venues?area=Indiranagar&pin_code=560038&search=Hall
```

`GET /api/user/venues/:venueId` returns safe venue details plus `venue_type_slots`, `venue_price_details`, `venue_decoration_details`, `venue_meals_details` and `venue_aminites`. Choose an active slot-linked price valid on the booking date. The selected price identifies its linked decoration and meal packages. The quote endpoint performs the final eligibility, capacity, date and availability checks.

List responses use `data.items`, `total`, `page`, `limit`, `totalPages`, `hasNextPage` and `hasPreviousPage`. Invalid or unsupported parameters return 400.

## Quote and creation bodies

`POST /api/user/bookings/quote` and `POST /api/user/bookings` accept the same JSON:

```json
{
  "venue_price_id": "01M6WRQE0YM3TDXF5HSMPMYJ3Q",
  "booking_date": "2027-02-20",
  "guest_count": 100,
  "include_decoration": true,
  "include_meals": true,
  "contact_email": "guest@example.com"
}
```

Replace the sample ID/date. The first three fields are required. Package booleans default to false. `contact_email` is optional when the user profile has an email; otherwise creation requires it so the user can receive booking email. Amounts, user ID, owner ID and status are calculated or assigned on the server and cannot be supplied.

Creation also requires a header, for example `Idempotency-Key: 847a9ab7-8686-493f-a45e-00118031e8ed` (16–100 letters, digits, underscores or hyphens). Keep the same key and body when retrying: first creation returns 201; replay returns 200 with the same booking. Reusing a key for a different body returns 409. Generate a new key for each new intended booking.

The price snapshot is fixed at creation. Venue amount is flat; decoration amount is flat when included; meals amount is per-plate price multiplied by guest count. Advance is venue advance + selected decoration advance + selected flat meals advance, capped at the meals total. `BOOKING_TAX_BPS` explicitly configures tax in basis points (default 0); tax applies proportionally to total and advance. For example, 1000 means 10%. Amounts are calculated in integer paise. Quotes use rupee decimal strings; persisted JSON detail fields may be numeric rupee values. Razorpay order amounts are integer paise. Remaining balance is recorded; balance collection is outside these advance APIs.

Dates use `BOOKING_TIME_ZONE` (default Asia/Kolkata) and the selected price's start/end times. An end time at or before the start time ends on the following day. Venue capacity and package date ranges are checked. A quote does not reserve inventory or freeze prices; creation recalculates and acceptance may still conflict with another booking.

## Booking reads and owner decisions

| Method | Route | Body |
| --- | --- | --- |
| GET | `/api/user/bookings` | None |
| GET | `/api/user/bookings/:bookingId` | None |
| GET | `/api/owner/bookings` | None |
| GET | `/api/owner/bookings/:bookingId` | None |
| POST | `/api/owner/bookings/:bookingId/decision` | `{"decision":"accept"}` |
| POST | Same decision route | `{"decision":"reject","reason":"Venue unavailable"}` |
| GET | `/api/admin/bookings` | None |
| GET | `/api/admin/bookings/:bookingId` | None |

Lists support `page`, `limit`, `search` (booking code or venue name), `booking_status`, `payment_state` and `venue_id`. Admins can additionally filter by `owner_id` and `user_id`. Newest bookings appear first. Detail includes the immutable price snapshot, price breakdown, safe payment fields, refund reviews and `is_confirmed`.

Booking statuses include Requested, Accepted, Rejected and Cancelled; Pending/Hold remain readable for legacy records. Payment states are `awaiting_acceptance`, `awaiting_payment`, `paid`, `not_required`, `expired`, `refund_review`, `refunded` and `legacy`. Historical bookings retain their original amounts and reservation state; migration 016 does not reprice or charge them.

## Razorpay Checkout

Set private server environment variables `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and a separate `RAZORPAY_WEBHOOK_SECRET`. Start with Razorpay test-mode keys. Configure automatic capture in the Razorpay dashboard. Keep secrets out of Postman collections, frontend bundles, source control and API responses.

After acceptance call `POST /api/user/bookings/:bookingId/payment-order` with no body. Successful `data` contains `key_id`, `order_id`, integer-paise `amount`, `currency`, `booking_id` and `booking_payment_id`. Repeated calls reuse the stored order. A 202 response means a previous uncertain order creation is being reconciled: poll later rather than initiating another order. If provider reconciliation finds no order, the intent stays pending for operational review; the backend does not blindly repeat a financial POST.

The frontend opens [Razorpay Standard Checkout](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/) using that response. Example after loading the official Checkout script:

```js
const base = window.location.origin; // Serve/proxy /api through this same origin.
const response = await fetch(`${base}/api/user/bookings/${bookingId}/payment-order`, {
  method: 'POST', credentials: 'include'
});
const result = await response.json();
if (!response.ok || result.data.pending) throw new Error(result.message);
const order = result.data;
new Razorpay({
  key: order.key_id, order_id: order.order_id,
  amount: order.amount, currency: order.currency,
  name: 'EventMitra',
  handler: async payment => {
    const verified = await fetch(`${base}/api/user/bookings/${bookingId}/verify-payment`, {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payment)
    });
    // A 202 means capture is still pending. Fetch booking detail to display current state.
    console.log(await verified.json());
  }
}).open();
```

`POST /api/user/bookings/:bookingId/verify-payment`:

```json
{
  "razorpay_order_id": "order_RETURNED_BY_API",
  "razorpay_payment_id": "pay_RETURNED_BY_CHECKOUT",
  "razorpay_signature": "64_lowercase_hex_characters_returned_by_checkout"
}
```

Use actual Checkout values. The server verifies the HMAC against its stored order ID, then fetches the order and payment from Razorpay and checks capture, amount and currency. Authorized-only payments return 202 and do not confirm the booking. The worker can recover a captured payment if the frontend callback or webhook is missed.

Configure a publicly reachable HTTPS webhook URL: `POST /api/payments/razorpay/webhook`. Subscribe to `payment.captured`, `order.paid`, `payment.authorized` and `refund.processed`. The endpoint verifies the exact raw body using `x-razorpay-signature`, deduplicates `x-razorpay-event-id`, and fetches current provider state. Failed/out-of-order events cannot undo a recorded capture. See [Razorpay webhook validation](https://razorpay.com/docs/webhooks/validate-test/).

## Admin refund review

```text
GET /api/admin/bookings/refund-reviews?page=1&limit=20&status=Pending
POST /api/admin/bookings/:bookingId/refund-reviews/:reviewId/decision
```

Approve body:

```json
{"decision":"approve","reason":"Owner cannot provide the venue; return the advance"}
```

Decline body:

```json
{"decision":"reject","reason":"Reviewed with the customer; advance retained"}
```

Approval queues the captured advance for a normal Razorpay refund. The worker uses a stable [refund idempotency key](https://razorpay.com/docs/api/refunds/normal-refunds-idempotent) on retries. A Processed review means Razorpay reported processing complete. Failed reviews can be reviewed again. Declining a review retains the recorded payment; it does not restore a rejected reservation. Provider-reported dashboard refunds also clear confirmation, with any remaining partial-refund amount sent to admin review.

## Email and FCM setup

Configure SMTP credentials privately using `.env.example`: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`. Gmail can use `smtp.gmail.com`, port 465, TLS and an account-enabled app password. Other SMTP providers use their own settings. See [Nodemailer Gmail configuration](https://nodemailer.com/usage/using-gmail/).

Enable Firebase Cloud Messaging HTTP v1, set `FIREBASE_PROJECT_ID` and configure Google Application Default Credentials, normally `GOOGLE_APPLICATION_CREDENTIALS` pointing to a private service-account JSON outside source control. The backend uses Google OAuth credentials and [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api). Frontends still need Firebase client setup, permission prompts and a real device/browser registration token.

For each authenticated identity (`user`, `owner` or `admin`):

| Method | Route | Body |
| --- | --- | --- |
| POST | `/api/{identity}/notifications/devices` | `{"token":"REAL_FCM_REGISTRATION_TOKEN","platform":"web"}` |
| DELETE | `/api/{identity}/notifications/devices/:deviceId` | None |
| GET | `/api/{identity}/notifications?page=1&limit=20&unread_only=true` | None |
| PUT | `/api/{identity}/notifications/:notificationId/read` | None |

Platform accepts web, android or ios. Registration returns `device_id`; store it and unregister when signing out on a shared device. Registration tokens are private and never returned by reads. Clients can deduplicate pushes using `notification_id` in the data payload.

Notification delivery is asynchronous and retried through `notification_outbox`. Booking success means notifications were durably queued, not that a provider delivered them. Missing provider configuration keeps deliveries pending; missing recipient email or device registration skips that channel while retaining the in-app notification. Invalid FCM tokens are removed. Transient failures retry with backoff; after eight failures inspect failed outbox rows. Provider retries may deliver duplicates, so clients should use the stable notification ID. SMTP cannot guarantee exactly-once delivery.

## Verification and current limits

Run `npm run typecheck`, `npm run build`, `npm test` and `npm run test:booking:integration:local`. The latter creates and drops a fresh temporary PostgreSQL database ending in `_test`; it does not migrate your application database. `npm run test:integration:local` runs all integration suites. Local test DB creation requires PostgreSQL CREATEDB privileges.

Booking integration tests cover authorization, discovery/ranking/radius filters, exact quotes, idempotent requests, reservation races, acceptance-before-payment, capture verification, webhook signatures/replays, expiry, uncertain order and missed-callback recovery, refunds, inbox privacy and delivery retries. Razorpay/FCM calls are mocked; SMTP uses a local test server. Live provider credentials and a real Checkout payment are needed for deployment validation.

These APIs reserve the whole venue rather than independent halls. They collect the configured advance; remaining-balance collection, customer cancellation and provider onboarding are outside this flow. Existing user phone authentication still uses the development OTP stub and is disabled in production until a real OTP provider is implemented. Booking SMTP/FCM configuration does not replace that authentication stub.

Migration **020** adds date-aware price lookup. Send `booking_date=YYYY-MM-DD` to user venue search/detail to receive date-specific prices or a default for each uncovered slot. Quotes and creation apply the same precedence and snapshot the actual resolved price ID/source. A default venue date range does not restrict fallback; existing slot/package/venue validation still applies. See [default pricing and complete API change list](default-venue-pricing.md).
