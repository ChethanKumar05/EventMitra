# EventMitra backend (TypeScript + PostgreSQL + raw SQL)

A **runnable backend foundation**, not a production-ready booking/payments platform. Built around the uploaded `server.ts`: Express, Socket.IO, CORS, helmet, compression and default port `3600`. The original `Server`, `socket` and `response` references were undefined; they have been replaced with typed imports/helpers.

## Admin authentication and security management

Admin email-or-username/password login, database sessions, admin/role/permission CRUD, and responsive sample
screens are implemented. The current flow is role -> admin -> main modules -> per-admin module
permissions stored in `admin_permission`. Login includes the effective module action flags. See [Admin API documentation](docs/admin-api.md) for setup, endpoints,
permissions, request bodies, security behavior, and integration tests.

After reviewing the new migration, run `npm run migrate`, then `npm run admin:bootstrap` in
an interactive terminal. This privately prompts for the first super admin; no default credentials
are created. New admin, role and permission codes are generated automatically as `ADM00001`,
`RL00001` and `PER00001`. Modules receive `MOD00001`. Migration 009 adds the per-admin
main-module permission flow, preserves existing records and migrates earlier security read grants. Start the server and open `http://localhost:3600/admin/`.

## Folder layout

```text
src/
  server.ts                 # main entry / HTTP server / startup and shutdown
  app.ts                    # Express app and middleware
  config/{env,database}.ts  # .env configuration and pg Pool
  migrations/
    001_admin_migration.ts
    002_user_migration.ts
    003_owner_migration.ts
    004_venue_migration.ts
    005_booking_migration.ts
    006_reviews_migration.ts
    runMigrations.ts
  models/{admin,user,owner,venue,booking}Model.ts  # parameterized raw SQL
  services/venueService.ts
  controllers/venueController.ts
  routes/{index,venueRoutes}.ts
  middleware/errorHandler.ts
  socket/index.ts
  utils/{id,response}.ts
```

## Original domain tables

- **Admin (4):** `roles`, `modules`, `admin`, `admin_permission`
- **User (3):** `"user"`, `user_phone_verification`, `user_account_details`
- **Owner (3):** `owner`, `owner_account_details`, `owner_phone_verification`
- **Venue (7):** `venue_details`, `venue_type_slots`, `venue_aminites`, `venue_decoration_details`, `venue_meals_details`, `venue_price_details`, `venue_meal_decoration_ratings`
- **Booking (3):** `booking`, `booking_price_details`, `booking_payment_details`
- Additional migrations add sessions, OTP controls, security catalogs, refund reviews, webhook events, notifications, device registrations and outbox tables; `migrations_history` tracks applied versions.

**Important:** The names and odd spellings such as `venue_aminites`, `meal_deatails`, `booking_totoal_tax`, and `is_cancellation_availble` intentionally match your notes. SQL uses `public."user"` because `user` is reserved in PostgreSQL. The review table uses your latest name (`venue_meal_decoration_ratings`), not the earlier `venue_meal_decoration_details`.

**Provisional definitions:** You have not yet provided approved columns for `venue_type_slots`, `venue_aminites`, or `booking_price_details`; these tables have pragmatic starter columns labeled `PROVISIONAL` in their SQL migrations. Confirm them before production data is stored.

**Additional columns recommended for functionality:** `venue_price_details.venue_id`, `booking.booking_from`, `booking.booking_to`, `booking_price_details` line amounts, `booking_payment_details.payment_amount`, OTP expiry/attempt counts, `venue_meal_decoration_ratings.rating_id`. All models use ULID-shaped 26-character string keys; the DB does not itself generate ULIDs. Raw model `createUser` uses the `ulid` helper. Related constraints have been added where practical.

## Installation

Prerequisites: Node.js 20+ and PostgreSQL 14+.

```bash
# From the repository folder:
npm install
cp .env.example .env
# Update DATABASE_URL in .env, create PostgreSQL database 'eventmitra' manually.
npm run migrate
npm run dev
```

Example `.env`:

```dotenv
NODE_ENV=development
APP_PORT=3600
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/eventmitra
DB_SSL=false
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
```

Commands:

```bash
npm run migrate            # apply pending migrations only
npm run dev                # TS dev server with watch
npm run typecheck          # verify types
npm run build              # output dist/
npm start                  # start compiled server
npm run migrate:compiled   # apply migrations from built JS
npm test                   # builds and runs tests; database suite requires TEST_DATABASE_URL
```

Migrations run **sequentially**, using `migrations_history`. The runner creates that history table, takes a PostgreSQL advisory lock, wraps **each migration** in a transaction, records it on success, and rolls it back on error. Do not edit an already-applied migration in production: add a new migration instead. Avoid running migration scripts with `Promise.all()`.

## Read-only API routes included

```text
GET  /                       # service status
GET  /api/user/health        # preserves endpoint from your server.ts
GET  /api/health             # database connectivity check
GET  /api/venues?page=1&limit=20
GET  /api/venues/:venueId
```

The venue read routes only return `status='Active'` and `is_active=true` rows. `/api/user/health` remains a compatibility health check. User/owner authentication, admin user/owner management and bank account APIs are implemented. User booking requests, owner decisions, configured advance payments and notifications are implemented; see [Booking API](docs/booking-api.md). Admin security routes are documented in [docs/admin-api.md](docs/admin-api.md).

## Booking, Razorpay advances and notifications

User discovery supports rating/distance ordering, radius and location filters. Booking creation snapshots server-calculated prices and configured advances. Owners accept before payment; acceptance reserves inventory with a payment deadline. Signed Checkout verification, raw signed webhooks and provider reconciliation confirm captures. Paid rejections require admin refund review. Email, FCM and private inbox notifications use a durable outbox.

Apply migrations 016/017 with `npm run migrate`, then run `npm run booking:worker` alongside the API. Configure private Razorpay, SMTP and Firebase credentials using `.env.example`. No provider credentials are supplied. Existing development OTP authentication remains disabled in production until real OTP delivery is implemented.

See [Booking API, payloads and setup](docs/booking-api.md), [Booking Postman collection](docs/postman/EventMitra.Booking.postman_collection.json) and [Booking environment](docs/postman/EventMitra.Booking.local.postman_environment.json). Run `npm run test:booking:integration:local` for isolated PostgreSQL/HTTP tests with mocked payment/push providers and a local SMTP server. Live provider validation needs your credentials and an actual test Checkout payment.

The flow reserves the whole venue and collects the configured advance. Remaining-balance collection, customer cancellation and independent hall inventory are outside this implementation. Historical bookings retain their reservation state and original amounts. PostgreSQL's `btree_gist` extension is required by migration 005; the database role needs permission to create it or a DBA must enable it.

## Build verification

Run `npm run typecheck`, `npm run build` and `npm test`. For real PostgreSQL/HTTP integration
tests, run `npm run test:integration:local` to create and remove an isolated temporary database,
or configure `TEST_DATABASE_URL` and use `npm run test:integration`. See the admin API
documentation for test database requirements and cleanup behavior.

List APIs include pagination, search and filters. See [List API documentation](docs/list-api.md) for admin/role/permission and public venue query parameters.

Migration 010 adds usernames, normalized unique role/module names, and stricter identity validation. Permission POST supports atomic object/array upserts; the separate per-record permission PUT endpoint is removed. See the updated API docs and Postman collection.

## Owner authentication

Owner login/logout is implemented separately. Owners can log in using unique user_name + password
or email + password. Pending and verified owners are allowed; display owner_name values can repeat after migration 018. Normal email/phone OTP verification also returns an eight-hour owner bearer/cookie session. Signup requires user_name.
See [owner authentication](docs/owner-auth.md) and import the separate
[owner Postman collection](docs/postman/EventMitra.Owner.postman_collection.json).
Apply pending migration 011 before running these endpoints.

Owner signup and email/phone test OTP verification, forgot-password and reset-password flows are implemented. Apply migration 012 and see [Owner signup and OTP documentation](docs/owner-signup-otp.md). OTP is fixed at 1111 for development only; no external email/SMS delivery is configured.

## User authentication

User signup and phone-only OTP login, verification, resend, current-user and logout endpoints are implemented under `/api/user/auth`. Signup creates a pending user; verification creates a separate user session. Apply migration 013. OTP is fixed at `1111` for development and disabled in production. See [User authentication and payloads](docs/user-auth.md) and the separate [User Postman collection](docs/postman/EventMitra.User.postman_collection.json). Run `npm run test:user:integration:local` for isolated PostgreSQL/HTTP tests.

Admin user/owner CRUD and bank account APIs are documented in [People and account APIs](docs/people-and-accounts-api.md). Apply migration 014 for account numbers, branch addresses, five-account limits and contact verification resets. Self-service account updates accept only `is_default`; admins with the corresponding module action can edit details. Profile deletion preserves history. Run `npm run test:people:integration:local` for the new suite.

Owner-scoped venue create/update/list/full-detail and admin venue management are documented in [Venue management](docs/venue-management-api.md). Apply migration 015 for generated venue/decoration codes, same-venue slot/package pricing links and the two-meal limit. Admin access uses `venue_management` module grants. Owner changes to approved venues return them to Pending. Updated owner/admin Postman collections include all configuration flows. Run `npm run test:venue:integration:local` for isolated integration tests.

Migration 019 adds nullable venue_address to create/update/list/detail responses. Owner/admin paginated venue lists also include meals, pricing and decoration arrays without changing page counts. Authenticated admin/user/owner file uploads share POST /api/uploads; configure AWS settings from .env.example and see [S3 upload bodies and setup](docs/uploads-api.md). Run `npm run test:upload:integration:local` for the new isolated suite.

Migration **020** adds `venue_price_details.is_default` (default false), one default per venue/slot, and booking-date fallback shared by user discovery, detail, quotes and booking creation. Owners/admins set defaults through existing price-save POST endpoints. [Default pricing rules and updated APIs](docs/default-venue-pricing.md).
