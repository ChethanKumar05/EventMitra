# Admin user/owner management and bank accounts

Apply pending migrations with `npm run migrate`. Migration **014** adds `account_number`, `branch_address` and `updated_at` to **both** account tables. Earlier migrations are unchanged. Existing accounts are retained, with the two new fields initially null. If a person already has more than five accounts, migration stops for those records to be reviewed before retrying.

All bodies are JSON. Responses use `{status,message,code,data}`. Creation returns `201`; reads, PUT and DELETE return `200`. IDs/codes are generated. Password hashes, OTPs and session tokens are never included in profile/account responses.

## Admin permissions

Use the existing admin login cookie. Super admins can perform every operation below. Ordinary admins need grants on a main module with key `user_management` or `owner_management`, assigned to their own admin ID and current role. Create those modules through the existing module API if needed; migration 014 creates no modules, credentials or grants.

| Operation | Required module action |
| --- | --- |
| List/get profile or bank account | Read, View or All |
| Create profile or add bank account | Create or All |
| Update profile or bank account | Edit or All |
| Delete profile | Delete or All |

Permissions are checked live and rechecked inside write transactions. Existing security-management writes (admins, roles, modules, grants) remain super-admin-only.

## Admin profile APIs

| Method | User route | Owner route |
| --- | --- | --- |
| POST | `/api/admin/users` | `/api/admin/owners` |
| GET list | `/api/admin/users` | `/api/admin/owners` |
| GET by ID | `/api/admin/users/:id` | `/api/admin/owners/:id` |
| PUT | `/api/admin/users/:id` | `/api/admin/owners/:id` |
| DELETE | `/api/admin/users/:id` | `/api/admin/owners/:id` |

DELETE marks `status=deleted` and, for users, `is_active=false`. It preserves the profile, bank accounts and related history, and revokes sessions/challenges. Authorized admins can still get/list deleted records (`status=deleted`).

Admin creation uses the same required/optional fields as [user signup](user-auth.md) and [owner signup](owner-signup-otp.md). Users additionally accept optional `status`, `is_active`, `reason`; owners accept `status`, `kyc_verification`, `reason`. User create example:

```json
{
  "country_code": "+91",
  "user_phone_number": "9876543210",
  "user_name": "Ravi Kumar",
  "gender": "m",
  "email": "ravi@example.com",
  "profile_image": null,
  "whatsapp_number": null,
  "alternative_number": null,
  "status": "pending",
  "is_active": true,
  "reason": null
}
```

Owner create example (replace the password and document values with your private inputs):

```json
{
  "country_code": "+91",
  "owner_phone_number": "9876543211",
  "owner_name": "Anita Kumar",
  "email": "anita@example.com",
  "password": "REPLACE_WITH_A_PRIVATE_PASSWORD",
  "gender": "f",
  "alternative_number": null,
  "profile_image": null,
  "alternative_email": null,
  "whatsapp_number": null,
  "doc_type": "passport",
  "doc_number": "REPLACE_WITH_DOCUMENT_NUMBER",
  "doc_image": "/uploads/owner-document.jpg",
  "pin_code": "560001",
  "state": "Karnataka",
  "city": "Bengaluru",
  "area": "Central",
  "lat": 12.9716,
  "long": 77.5946,
  "address": "Owner address",
  "status": "pending",
  "kyc_verification": false,
  "reason": null
}
```

PUT is partial: send only fields to change. Supported fields are the signup fields plus the administrative fields above. Codes, IDs and verification flags are read-only. Unknown fields and empty updates are rejected. Valid statuses for both resources: `pending`, `verified`, `rejected`, `blocked`, `hold`, `deleted`. Duplicate phone/email or normalized owner name returns `409`. User names need not be unique.

Example user update:

```json
{
  "user_name": "Ravi Sharma",
  "status": "blocked",
  "is_active": false,
  "reason": "Blocked after review"
}
```

Example owner update:

```json
{
  "owner_name": "Anita Sharma",
  "status": "verified",
  "kyc_verification": true,
  "reason": null
}
```

Admin profile updates revoke existing sessions. Phone/country changes reset phone verification and invalidate outstanding challenges. Owner email changes reset email verification and invalidate old-target challenges. Contact protections also apply through database triggers to direct SQL updates. Restoring eligibility does not restore revoked sessions or proofs. Optional signup fields may be cleared with null/empty strings; required fields cannot be cleared. Owner passwords may be changed through admin PUT (12+ characters, maximum 256 UTF-8 bytes, salted scrypt hashing); user profiles have no password.

## Bank account APIs

| Operation | User self-service | Owner self-service |
| --- | --- | --- |
| POST add | `/api/user/accounts` | `/api/owner/accounts` |
| GET list | `/api/user/accounts` | `/api/owner/accounts` |
| GET by ID | `/api/user/accounts/:accountId` | `/api/owner/accounts/:accountId` |
| PUT default only | `/api/user/accounts/:accountId` | `/api/owner/accounts/:accountId` |

| Operation | Admin user accounts | Admin owner accounts |
| --- | --- | --- |
| POST add | `/api/admin/users/:id/accounts` | `/api/admin/owners/:id/accounts` |
| GET list | `/api/admin/users/:id/accounts` | `/api/admin/owners/:id/accounts` |
| GET by ID | `/api/admin/users/:id/accounts/:accountId` | `/api/admin/owners/:id/accounts/:accountId` |
| PUT details | `/api/admin/users/:id/accounts/:accountId` | `/api/admin/owners/:id/accounts/:accountId` |

Self-service uses the authenticated user/owner identity; do not send a person ID. Admin routes name the parent person. Every get/update scopes the account to that person (`404` on mismatch). User and owner cookies/tables are separate; admin cookies cannot impersonate self-service sessions. Account IDs are `user_account_id` and `owner_account_id`. Bank accounts are not embedded in profile list/login responses.

POST body is the same for all four add routes:

```json
{
  "account_number": "001234567890",
  "account_holder_name": "Ravi Kumar",
  "ifsc_code": "SBIN0001234",
  "branch_name": "Central Branch",
  "branch_address": "Branch street address, Bengaluru 560001",
  "passbook_image": "/uploads/passbook.jpg",
  "is_default": true
}
```

Required for add: `account_number` (6–34 digits as a string, preserving leading zeros), `account_holder_name` (max 150 characters), `ifsc_code` (four letters, `0`, six letters/digits, normalized uppercase), `branch_name` (max 150), `branch_address` (max 2000). Optional: `passbook_image` (reference max 2048; null/empty allowed, no file upload) and `is_default` (JSON boolean). Ownership IDs, account IDs, timestamps and unsupported fields are rejected.

Each person can have **up to five accounts**, including historical rows. Concurrent API writes and database triggers enforce the cap; a sixth addition returns `409`. Duplicate account numbers for the same person return `409`; another person can use the same number. Account ownership cannot be transferred. No account-delete API was added.

When omitted, `is_default` is true for the first account and false afterward. Explicit false is respected. Setting true atomically clears the previous default; at most one is default. Setting false may leave no default. Failed additions/duplicate updates roll back default changes.

User/owner PUT accepts **only**:

```json
{
  "is_default": true
}
```

Other self-update fields are rejected even when `is_default` is also supplied. Admin PUT accepts any nonempty subset of add fields:

```json
{
  "account_number": "001234567891",
  "account_holder_name": "Ravi Sharma",
  "branch_name": "Updated Central Branch",
  "branch_address": "Corrected branch address",
  "is_default": true
}
```

Errors: `400` invalid body/query/field formats, `401` missing/expired session, `403` missing admin permission or cross-site request, `404` missing/mismatched record, `409` duplicate identity/account or five-account limit.

## Pagination, search, filters and sorting

Every list supports `page` (default 1), `limit` (default 20, max 100), `search`, `search_column=all|<column>`, `sort_by`, `sort_order=asc|desc`. Exact field filters combine with AND. Search is a case-insensitive literal substring match. Repeated, nested and unsupported parameters are rejected.

The following columns support search, exact filters and sorting:

- User profiles: `user_id`, `user_code`, `user_name`, `country_code`, `user_phone_number`, `email`, `gender`, `status`, `is_active`, `is_phone_number_verified`, `created_at`, `updated_at`.
- Owner profiles: `owner_id`, `owner_code`, `owner_name`, `country_code`, `owner_phone_number`, `email`, `gender`, `status`, `kyc_verification`, `is_phone_number_verified`, `is_email_verified`, `city`, `state`, `area`, `created_at`, `updated_at`.
- Accounts: resource account ID, `account_number`, `account_holder_name`, `ifsc_code`, `branch_name`, `branch_address`, `is_default`, `created_at`, `updated_at`.

Boolean filters use `true`/`false`. Response `data` contains `items`, `total`, `page`, `limit`, `totalPages`, `hasNextPage`, `hasPreviousPage`. Totals and page use the same filters/snapshot. Out-of-range pages return empty items with the filtered total.

```text
GET /api/admin/users?page=1&limit=20&search_column=user_name&search=ravi&status=pending&is_active=true&sort_by=user_name&sort_order=asc
GET /api/admin/owners?city=Bengaluru&kyc_verification=true&sort_by=created_at&sort_order=desc
GET /api/user/accounts?is_default=true
GET /api/admin/owners/OWNER_ID/accounts?search_column=branch_name&search=central
```

## Postman and tests

Reimport the updated [Admin](postman/EventMitra.postman_collection.json), [User](postman/EventMitra.User.postman_collection.json) and [Owner](postman/EventMitra.Owner.postman_collection.json) collections and environments. New folders have visible JSON bodies and capture profile/account IDs. Supply your own bank values. Account folders log in first; repeating adds counts toward the limit. Admin deletion samples mark only the sample managed profiles deleted.

Run `npm run typecheck`, `npm run build`, `npm test`, and `npm run test:people:integration:local`. The people suite creates/drops an isolated PostgreSQL database and tests permissions, ownership, field validation, pagination/search/sort/filter, duplicate rollback, concurrent default/limit enforcement, contact changes and soft deletion. Alternatively set `PEOPLE_TEST_DATABASE_URL` to a fresh expendable database ending in `_test` and run `npm run test:people:integration`. `npm run test:integration:local` runs all four admin, owner, user and people suites in separate databases.
