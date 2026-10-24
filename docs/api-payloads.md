# Current API payloads

Use JSON bodies. Generated code fields are read-only. Replace IDs and credentials with your own.
Run `npm run migrate` through migration 010 first. Management writes require a super-admin session.

## Login: POST /api/admin/auth/login

Provide exactly one of email, username or identifier, plus password:

```json
{"email":"your-admin@example.com","password":"YOUR_PRIVATE_PASSWORD"}
```

```json
{"username":"operations_admin","password":"YOUR_PRIVATE_PASSWORD"}
```

```json
{"identifier":"operations_admin","password":"YOUR_PRIVATE_PASSWORD"}
```

identifier may also contain your email. Username matching ignores case. It must have 3-50
letters/digits/dots/underscores/hyphens, begin with a letter/digit and contain no whitespace.
Login returns admin_username, current role and effective main-module permissions.

## Create role: POST /api/admin/roles

```json
{"role_type":"Operations"}
```

PUT `/api/admin/roles/ROLE_ID` accepts the same field. Duplicate role types return 409,
ignoring case and outer/repeated whitespace.

## Create admin: POST /api/admin/admins

```json
{
  "admin_name":"Operations admin",
  "admin_username":"operations_admin",
  "admin_email":"operations@example.com",
  "password":"CHOOSE_YOUR_OWN_PASSWORD",
  "role_id":"ROLE_ID",
  "department":"Finance",
  "admin_phone_number":"+919876543210",
  "status":"active",
  "is_super_admin":false
}
```

Required: admin_name, admin_username, admin_email, password, role_id. Phone and department are
optional. Phone must be a string with 7-15 digits and optional leading +; no letters/spaces.
New passwords require at least 12 characters and at most 256 UTF-8 bytes. Username/email/phone
must be unique. Email is checked for local-part/domain format. Role must exist.

PUT `/api/admin/admins/ADMIN_ID` updates supplied fields:

```json
{"admin_name":"Updated name","admin_username":"updated_admin","department":"Operations","admin_phone_number":null}
```

Changing the role clears old grants. Any admin update revokes their sessions.

## Create module: POST /api/admin/modules

```json
{"module_name":"Owner Management","module_key":"owner_management"}
```

PUT `/api/admin/modules/MODULE_ID` accepts name/key updates. Names and keys must be unique;
names ignore case and repeated/outer whitespace. No submodules. Key is optional on creation
and derived from the name when omitted. Built-in management keys cannot be renamed/deleted.

## Upsert permissions: POST /api/admin/admin-permissions

One API creates missing rows and updates existing rows using the admin/module pair and the
admin's current role. It accepts an array of 1-1000 objects:

```json
[
  {
    "admin_id":"ADMIN_ID",
    "role_id":"ADMIN_CURRENT_ROLE_ID",
    "module_id":"OWNER_MODULE_ID",
    "all":false,
    "create":true,
    "read":true,
    "edit":true,
    "delete":false,
    "view":true
  },
  {
    "admin_id":"ADMIN_ID",
    "role_id":"ADMIN_CURRENT_ROLE_ID",
    "module_id":"BOOKING_MODULE_ID",
    "all":true
  }
]
```

A single object is also accepted:

```json
{"admin_id":"ADMIN_ID","role_id":"ADMIN_CURRENT_ROLE_ID","module_id":"OWNER_MODULE_ID","read":false,"view":false}
```

Returns HTTP 200. Array input returns a data array; an object returns one data object. Existing
IDs/codes and omitted flags are preserved. New rows default omitted flags to false. Unmentioned
modules are not changed or deleted. All true enables every action. Setting an action false
clears All. Setting only all false preserves individual flags. Each object requires all three
IDs. Missing modules, wrong roles, or any invalid row roll back the entire batch. Duplicate
admin/module pairs within an array return 400. There is no PUT `/admin-permissions/:id` endpoint.

## Full matrix replacement: PUT /api/admin/admins/ADMIN_ID/permissions

This separate operation replaces the admin's complete grant set; omitted modules are removed:

```json
{"role_id":"ADMIN_CURRENT_ROLE_ID","permissions":[{"module_id":"OWNER_MODULE_ID","all":true}]}
```

An empty permissions array clears all grants. Use normal POST upserts when omitted modules
should remain unchanged. Both operations require a super admin.

## No body

All GETs and DELETEs have no body, as does POST `/api/admin/auth/logout`.
GET `/api/admin/auth/me` returns the current account/role and module action flags.
GET `/api/admin/admins/ADMIN_ID/permissions` returns the permission matrix.
CRUD list paths: `/api/admin/admins`, `/api/admin/roles`, `/api/admin/modules`,
`/api/admin/admin-permissions`; individual GET/DELETE adds the record ID.
Public read paths remain `/api/venues`, `/api/venues/VENUE_ID` and health endpoints.
Lists use URL query parameters for pagination, search, filters and sorting.

[Full API documentation](admin-api.md) | [List parameters](list-api.md)
