# Admin API: roles, admins, main modules and per-admin permissions

Run `npm run migrate`, then `npm run admin:bootstrap` in an interactive terminal to create
the first super admin with privately entered credentials. There are no default credentials.
Run `npm run dev` and open `http://localhost:3600/admin/` for the connected sample screens.

## Workflow

1. Create a role such as Operations (`POST /api/admin/roles`).
2. Create an admin and assign that role (`POST /api/admin/admins`).
3. Create main modules such as Owner Management or Booking Management (`POST /api/admin/modules`).
4. Select the role and one of its admins in the permission matrix. Assign Create, Read, Edit,
   Delete, View and All for each main module. Save to `admin_permission` using the current role.
5. Login and current-admin responses return effective module permissions for showing menus and actions.

There are no submodules, parent modules, print, export or send permission actions. New records
receive generated codes: ADM00001, RL00001, MOD00001 and PER00001. IDs remain ULIDs. Code fields
are read-only. Each admin/module pair has at most one permission row.

## Authentication

Base path: `/api/admin`. JSON bodies use `Content-Type: application/json`.

| Method | Path | Body / result |
| --- | --- | --- |
| POST | `/auth/login` | Email or username + password; sets cookie and returns admin, role and permissions |
| GET | `/auth/me` | Current admin, role and effective module permissions |
| POST | `/auth/logout` | No body; revokes current session and clears cookie |

Login accepts exactly one of `email`, `username` or `identifier`, plus `password`. `identifier` accepts either email or username. Passwords use salted scrypt (N=131072, r=8, p=1), following
[OWASP's recommendation](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
New passwords require 12 or more characters and at most 256 UTF-8 bytes. Password hashes are
never returned. Email and username matching are case insensitive. Usernames have 3-50 letters, digits, dots, underscores or hyphens, start with a letter/digit, and contain no whitespace. Login is limited to ten attempts per
account/IP pair per fifteen minutes (shared across email and username aliases), persisted in PostgreSQL.

Sessions last eight hours. Random session tokens are stored as SHA-256 digests and delivered
in an HttpOnly, SameSite=Strict cookie. Production uses a Secure `__Host-eventmitra` cookie and
requires HTTPS; development uses `eventmitra_session`. Serve the UI and API on the same origin.
Origin and Fetch Metadata checks reject cross-site mutations. If using a TLS reverse proxy,
configure Express's trusted proxy setting for that deployment; do not trust arbitrary forwarded
headers. Admin updates revoke that admin's sessions. Logout revokes the current session only.

Login and `/auth/me` return data in this shape (IDs below are placeholders):

```json
{
  "admin_id": "ADMIN_ID",
  "admin_name": "Operations admin",
  "admin_username": "operations_admin",
  "admin_email": "operations@example.com",
  "role_id": "ROLE_ID",
  "role_code": "RL00002",
  "role_type": "Operations",
  "is_super_admin": false,
  "permissions": [
    {
      "module_id": "MODULE_ID",
      "module_code": "MOD00005",
      "module_key": "owner_management",
      "module_name": "Owner Management",
      "all": false,
      "create": false,
      "read": true,
      "edit": false,
      "delete": false,
      "view": true
    }
  ]
}
```

Every main module is returned, with false flags when unassigned. `all` enables every action.
Super admins receive true for every module action. Ordinary admins receive only grants stored
for their own admin ID and current role. Role assignment alone does not grant module access.
Permissions are loaded from the database for each protected request; changes apply to existing
sessions immediately. UI visibility is not a replacement for server authorization.

## Authorization and role changes

All security-management writes remain restricted to active super admins, even if an ordinary
admin has Create, Edit, Delete or All on a security module. Read endpoints allow super admins
or an admin with Read, View or All on the corresponding main module:

| Resource | Module key |
| --- | --- |
| Admins | `admin_management` |
| Roles | `role_management` |
| Modules | `module_management` |
| Per-admin permissions | `permission_management` |

The four management modules are created by migration 009. Their keys cannot be changed and
they cannot be deleted. Other modules can be created, renamed and deleted. Keys are stable
identifiers; use `owner_management`, `booking_management`, etc. for application modules.

Changing an admin's role clears that admin's module grants in the same transaction and revokes
their sessions. Reassign permissions for the new role. Permission writes that supply a different
role from the admin's current role return 409; stale permission rows never authorize access.
Deleting a module deletes its permission assignments. Deleting an admin deletes their grants
and sessions. Roles in use by admins or historical permission rows cannot be deleted (409).

All security writes serialize using a PostgreSQL transaction advisory lock and recheck the
caller's session and active super-admin status inside the transaction. The last active super
admin cannot be demoted, disabled or deleted, including during concurrent API requests.

## CRUD endpoints

| Resource | List / create | Get / update / delete |
| --- | --- | --- |
| Admins | GET / POST `/admins` | GET / PUT / DELETE `/admins/:id` |
| Roles | GET / POST `/roles` | GET / PUT / DELETE `/roles/:id` |
| Main modules | GET / POST `/modules` | GET / PUT / DELETE `/modules/:id` |
| Per-admin module permissions | GET / POST `/admin-permissions` | GET / DELETE `/admin-permissions/:id` |

Admin/role/module creation returns 201. Permission upsert POST always returns 200. PUT updates supplied fields; omitted fields remain unchanged. DELETE returns
200 with null data. See [copyable payloads](api-payloads.md) for complete request examples.

Admin creation requires `admin_name`, `admin_username`, `admin_email`, `password`, `role_id`. Optional fields:
`department` (max 100), `admin_phone_number` (a string of 7-15 digits, optional leading +, unique when present), `status` (active,
block, reject or delete; default active), `is_super_admin` (boolean, default false). Department
and phone can be cleared with null. Name max 150, email max 255. Phone is not used for login.

Roles require `role_type` (max 100), unique ignoring case and repeated/outer whitespace. Modules require unique `module_name` (max 150, same normalization); optional
`module_key` is derived from the name on creation when omitted. Keys are lowercase letters,
digits and underscore, starting with a letter, max 100. There is no parent/submodule field.

Permission POST accepts one object or an array of 1-1000 objects, each requiring `admin_id`, `role_id`, `module_id`. It updates an existing admin/module pair for the current role or creates a missing row. Array input returns an array; object input returns one object. IDs/codes and omitted existing flags are preserved. New flags default false. Duplicate pairs in a batch return 400, and any bad row rolls back the complete batch. The standalone `PUT /admin-permissions/:id` endpoint has been removed. The matrix PUT below remains a distinct full-set replacement operation. Optional `create`, `read`,
`edit`, `delete`, `view`, `all` flags must be booleans and default false. The pair identifies which row is upserted. `all:true` sets all flags true. Setting an individual
action false also clears All. Setting only `all:false` preserves the other action flags.

## Permission matrix

| Method | Path | Result |
| --- | --- | --- |
| GET | `/admins/:adminId/permissions` | Admin/current-role metadata and all main modules with stored flags |
| PUT | `/admins/:adminId/permissions` | Atomically replace that admin's complete module grant set |

Both matrix endpoints require a super admin. PUT body:

```json
{
  "role_id": "CURRENT_ROLE_ID",
  "permissions": [
    { "module_id": "OWNER_MODULE_ID", "all": true },
    { "module_id": "BOOKING_MODULE_ID", "read": true, "view": true }
  ]
}
```

Omitted modules are removed. An empty permissions array clears all grants. Duplicate module
IDs return 400; missing modules or a stale role return 409 and roll back the complete operation.
Existing rows retain their permission IDs and codes when updated. Searching the sample matrix
only hides rows visually; saving still includes the complete edited matrix.

## Lists and screens

Lists support `page`, `limit`, `search`, `search_column`, `sort_by`, `sort_order` and exact
filters for displayed fields. See [list parameters](list-api.md). Responses include items,
filtered total, page, limit, totalPages, hasNextPage and hasPreviousPage. Pagination defaults
to page 1 / limit 20; limit is capped at 100. SQL sorting columns are explicitly allowlisted.

The sample screens follow the supplied design: column selector plus search, a filter popover
for all displayed fields, Clear All, clickable column sorting, action menus and pagination.
The permission matrix has role and admin selectors and one row per main module. Menus are
shown using the current admin's effective module flags. The sample does not implement the
business screens for custom modules such as bookings or owners.

## Responses

Success: `{"status":true,"message":"...","code":200,"data":...}`.
Failure: `{"status":false,"message":"...","code":400,"data":null}`.
400 invalid input; 401 invalid credentials/session; 403 unauthorized; 404 missing record;
409 duplicate/reference/current-role/last-super-admin conflict; 429 login throttled;
500 unexpected error without database details in the response.

## Migration, compatibility and testing

Migration **009_admin_module_permissions_migration** adds department, module keys/codes, Read,
and permission IDs/codes/timestamps to the existing tables. Migrations 001-008 remain unchanged.
Existing module rows, admin-permission rows, codes, roles and admins are retained. Historical
rows with a stale role remain stored but cannot grant access. Existing role-based security read
grants from the previous implementation are copied to each admin's current-role rows during
migration. New module and permission codes start after their sequences' existing values.

Legacy `/permissions` catalog CRUD and `role_permissions` assignment APIs remain available for
compatibility, but are not used for runtime access after migration 009. The canonical permission
API is `/admin-permissions`; use the new Postman collection. Subsequent edits to legacy role
permission bundles do not change admin module permissions.

- `npm run typecheck`
- `npm run build`
- `npm test` (database integration skips without TEST_DATABASE_URL)
- `npm run test:integration:local` (creates, tests and removes a temporary PostgreSQL database)
- `npm run test:integration` (requires a fresh empty disposable TEST_DATABASE_URL ending in `_test`)

Tests cover migration compatibility, per-admin isolation/current-role checks, matrix atomicity,
All behavior, live revocation, role-change clearing, login flags, module CRUD/cascades, generated
codes, search, filters, sorting, sessions, origins and last-super-admin concurrency.

[Postman setup](postman/README.md) | [Request payloads](api-payloads.md) | [List APIs](list-api.md)

To create the first account using pgAdmin instead of a database-writing CLI command, see
[the pgAdmin bootstrap instructions](sql/README.md). `npm run admin:bootstrap:sql` privately
generates `.local/admin-bootstrap.sql` for execution in Query Tool; no API login is required.

## Migration 010 and validation

Run `npm run migrate` before using usernames. Migration 010 adds required, unique admin_username values and normalized unique role/module-name indexes. Existing accounts receive usernames derived from admin_code (with a generated fallback for collisions/invalid codes). Email login remains available; auth/me and admin lists return admin_username. Previously generated private SQL files are left untouched and remain usable after migration 010 using its username default. New bootstrap commands prompt for a username.

If existing role/module names collide after case/whitespace normalization, migration 010 stops and reports them; rename those records before retrying. It does not merge/delete or silently rename existing roles/modules.

Invalid/missing fields return 400. Duplicate email/username/phone/role type/module name or key returns 409, as do missing referenced roles/modules and mismatched current roles. Phone remains optional, and null clears it. Email format validates the local part and domain labels. Database unique indexes back the duplicate checks under concurrency.
