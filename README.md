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

## Database tables (20)

- **Admin (4):** `roles`, `modules`, `admin`, `admin_permission`
- **User (3):** `"user"`, `user_phone_verification`, `user_account_details`
- **Owner (3):** `owner`, `owner_account_details`, `owner_phone_verification`
- **Venue (7):** `venue_details`, `venue_type_slots`, `venue_aminites`, `venue_decoration_details`, `venue_meals_details`, `venue_price_details`, `venue_meal_decoration_ratings`
- **Booking (3):** `booking`, `booking_price_details`, `booking_payment_details`
- Supporting table: `migrations_history` (not counted above).

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

The venue read routes only return `status='Active'` and `is_active=true` rows. `/api/user/health` is a compatibility health check, **not** an implemented User API. Models for user, owner, and booking have raw query examples; their CRUD routes are **not** implemented yet. Admin management routes are documented in [docs/admin-api.md](docs/admin-api.md).

## Booking & payment safety notes

- **No reservation-writing endpoints are exposed yet.** The booking migration includes a PostgreSQL exclusion constraint that prevents overlapping `Accepted` bookings at the same venue, but `Requested` and `Hold` bookings have no expiry/concurrency management. Booking per-slot semantics and multi-hall bookings must be designed before accepting real reservations.
- **No payment-writing endpoints are exposed yet.** Razorpay order creation, signature verification, idempotent webhooks, reconciliation, refunds, and authorization are still to be implemented. Raw JSON must not be trusted as payment confirmation.
- **Admin authentication is implemented.** User/owner authentication, OTP hashing/expiry/attempt rate limiting, owner account approval and ownership checks remain to be implemented before exposing protected booking or owner mutations. The included public venues reads do not expose owner private information.
- Owner `password` column must receive a strong *hash*, never plaintext. `otp` columns must receive hashed OTPs, never plaintext codes.
- The user supplied `booking_payment_id` in `booking`. We retain it as a nullable pointer to a selected payment, while `booking_payment_details` supports multiple transactions for one booking.
- Decorations/meals/pricing associations do not yet enforce that referenced packages belong to the same venue. Validate this in booking logic before launch.
- For recurring/day slots, final pricing and availability rules need a business decision. Current SQL models use timestamp windows.
- Postgres extensions: migration 005 uses `btree_gist` for the exclusion constraint. Your DB role must have permission to create this trusted extension (or ask the database administrator to enable it).

## Build verification

Run `npm run typecheck`, `npm run build` and `npm test`. For real PostgreSQL/HTTP integration
tests, run `npm run test:integration:local` to create and remove an isolated temporary database,
or configure `TEST_DATABASE_URL` and use `npm run test:integration`. See the admin API
documentation for test database requirements and cleanup behavior.

List APIs include pagination, search and filters. See [List API documentation](docs/list-api.md) for admin/role/permission and public venue query parameters.

Migration 010 adds usernames, normalized unique role/module names, and stricter identity validation. Permission POST supports atomic object/array upserts; the separate per-record permission PUT endpoint is removed. See the updated API docs and Postman collection.

## Owner authentication

Owner login/logout is implemented separately. Owners can log in using owner_name + password
or email + password. Pending and verified owners are allowed; shared names require email.
See [owner authentication](docs/owner-auth.md) and import the separate
[owner Postman collection](docs/postman/EventMitra.Owner.postman_collection.json).
Apply pending migration 011 before running these endpoints.
