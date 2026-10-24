# List APIs: pagination, column search, filters and sorting

Lists are GET requests with no body. All use `page` (1-1000000, default 1), `limit`
(1-100, default 20), `search` (max 200), `search_column`, `sort_by` and `sort_order` (`asc`/`desc`).
`search_column=all` searches all listed fields; selecting a column restricts search to it.
Search is a case-insensitive literal substring; %, underscore and backslash are literal.
Sorting uses an allowlist and adds the resource ID as a tie breaker. No client SQL is accepted.

Filters combine with search using AND. Text filters are case-insensitive exact matches after
trimming. IDs are case sensitive. Empty optional text filters are ignored. Booleans must be
true or false. Invalid columns/directions, arrays, repeated/nested parameters, unknown parameters,
invalid enums/ranges and overlong values return 400. Page/limit/capacity must be integer strings.

## Admins: /api/admin/admins

Search/sort columns: admin_id, admin_code, admin_username, admin_name, admin_email, admin_phone_number,
department, role_type, status, is_super_admin, created_at.
Filters: admin_code, admin_username, admin_name, admin_email, admin_phone_number, department, role_id,
role_type, status, is_super_admin. Status: active, block, reject or delete.
Lists include role_type and role_code, so the UI displays a role name instead of an ID.

```text
/api/admin/admins?page=1&limit=20&search=Finance&search_column=department&role_id=ROLE_ID&sort_by=admin_name&sort_order=asc
```

## Roles: /api/admin/roles

Search/sort columns: role_id, role_code, role_type, created_at.
Filters: role_code, role_type, permission_id (legacy catalog relationship; not runtime authorization).

## Main modules: /api/admin/modules

Search/sort columns: module_id, module_code, module_key, module_name, created_at.
Filters: module_code, module_key, module_name. There are no submodules.

## Per-admin permissions: /api/admin/admin-permissions

Search/sort columns: permission_id, permission_code, admin_name, role_type, module_name,
all, create, read, edit, delete, view, updated_at.
Filters: permission_code, admin_id, role_id, module_id, admin_name, role_type, module_name,
and each action boolean: all, create, read, edit, delete, view.
Only rows matching the admin's current role are returned; historical stale rows never grant access.

```text
/api/admin/admin-permissions?admin_id=ADMIN_ID&role_id=ROLE_ID&read=true&sort_by=module_name&sort_order=asc
```

## Public venues: /api/venues

Search/sort columns: venue_id, venue_code, venue_name, city, state, created_at.
Global search also covers area. Filters: venue_code, city, state, area, owner_id,
min_capacity and max_capacity (inclusive nonnegative hall capacities, maximum 2147483647).
min_capacity must not exceed max_capacity. Null capacities do not match capacity filters.
Only status Active and is_active true are returned; clients cannot change that visibility rule.

## Legacy permission catalog: /api/admin/permissions

Kept for compatibility. Search/sort: permission_id, permission_code, permission_key,
permission_name. Filters: permission_code, permission_key, role_id. Catalog grants do not
authorize runtime access after migration 009; use admin-permissions instead.

## Responses

The existing success envelope contains:

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "limit": 20,
  "totalPages": 0,
  "hasNextPage": false,
  "hasPreviousPage": false
}
```

Items and totals use the same SQL filters/database snapshot. No matches return an empty array
and zero total/totalPages. Pages beyond the last return an empty array and the matching total.
hasPreviousPage is true for page > 1. Security resources default to ascending IDs; venues default
to created_at descending then venue_id descending. Null sort values are placed last.

[Postman collection](postman/EventMitra.postman_collection.json) exposes disabled optional search,
column, sort and filter parameters in Params. Enable only the parameters you need. The sample
screens provide the same controls, including sortable headers and Clear All.
