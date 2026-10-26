# Owner login and logout

Owner authentication is separate from admin authentication. Login, logout and current-owner endpoints are implemented, along with signup, test OTP verification and password recovery described in [owner signup/OTP flows](owner-signup-otp.md). Admin owner management and owner bank account APIs are documented in [People and account APIs](people-and-accounts-api.md). No owner profiles or default credentials are created by migrations.

Apply pending migrations using `npm run migrate`, then start with `npm run dev`.
New migration **011_owner_auth_migration** adds owner sessions, throttling, a nonunique name
lookup index, and a trigger that revokes owner sessions after password changes or a move to
an ineligible status. Migrations 001-010 are unchanged. Existing owner names/data remain intact.

## Endpoints and bodies

Base URL: `http://localhost:3600`. Set `Content-Type: application/json` for login.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/owner/auth/login` | Login with exactly one of owner_name or email, plus password |
| GET | `/api/owner/auth/me` | Get the owner identified by the current owner session cookie |
| POST | `/api/owner/auth/logout` | Revoke the presented owner session and clear the owner cookie |

Login with email:

```json
{
  "email": "owner@example.com",
  "password": "YOUR_PRIVATE_PASSWORD"
}
```

Login with owner name:

```json
{
  "owner_name": "Ravi Kumar",
  "password": "YOUR_PRIVATE_PASSWORD"
}
```

Email and owner-name matching ignore case. Leading/trailing name whitespace is trimmed;
internal spaces are permitted and whitespace runs are normalized. Names are now unique ignoring case and repeated/outer spaces after migration 012. Names must be nonblank strings of at most
150 characters and contain no control characters. Email uses the existing format validator.
Password is required, must be a nonempty string and at most 256 UTF-8 bytes. Login never trims
or changes a password. Both identity fields supplied together, neither field, arrays, malformed
emails, invalid types, and missing passwords return 400.

**Pending and verified owners can log in.** Rejected, blocked, hold and deleted owners cannot.
Migration 012 rejects existing duplicate normalized names for review and prevents new duplicates. Name-based login also refuses ambiguous matches as a fallback.
Failures use a generic 401 message and never reveal password/account document details.

The existing owner.password column must hold a hash produced by the shared
`src/security/password.ts` hashPassword helper (`scrypt-v1`, N=131072, r=8, p=1), never plaintext.
Other hash formats and plaintext do not authenticate. Existing passwords are not rewritten.
Signup is available through /api/owner/auth/signup; no default password or account is created.

## Session behavior

Successful login returns basic owner data and an eight-hour session cookie:

```json
{
  "status": true,
  "message": "Owner logged in",
  "code": 200,
  "data": {
    "owner_id": "OWNER_ID",
    "owner_code": "OWNER_CODE",
    "owner_name": "Ravi Kumar",
    "email": "owner@example.com",
    "status": "pending",
    "kyc_verification": false,
    "is_email_verified": false,
    "is_phone_number_verified": false
  }
}
```

Responses never return password hashes, document data, bank details or OTPs. Login/current-owner
responses use explicit public fields. Pending login does not mark the owner as verified or
complete KYC/phone verification. Future verified-only business actions must check their own
approval requirements.

- Development cookie: `eventmitra_owner_session`.
- Production cookie: `__Host-eventmitra-owner`, Secure; production requires HTTPS.
- Cookies are HttpOnly, SameSite=Strict, path `/`. No bearer token is needed.
- Sessions store SHA-256 token digests and a password-hash fingerprint, never the raw token.
- Current-owner requests recheck session expiry, owner status and password fingerprint.
- Changing a password or moving to rejected/blocked/hold/deleted revokes all owner sessions,
  including when done directly through SQL. Returning to pending/verified does not restore them.
- Approval from pending to verified preserves a valid session. Owner deletion cascades sessions.
- Logout revokes the current owner session only and is idempotent (200 even without a valid
  session). It clears the owner cookie and leaves admin sessions intact.
- Owner cookies cannot authenticate admin APIs and admin cookies cannot authenticate owner APIs.

Serve browser clients and this API on the same origin. POSTs reject cross-site Fetch Metadata
or an Origin that differs from the server origin. When deploying behind a TLS reverse proxy,
configure trusted proxy settings for that deployment so Express sees the correct protocol.
Authentication responses use Cache-Control: no-store.

Login allows ten attempts per owner/IP per fifteen minutes, shared across name and email aliases.
Missing/ambiguous identities have an identifier/IP budget. A separate IP budget permits up to
100 owner login attempts per fifteen minutes to limit identifier cycling. Successful attempts
also count. Limits live in PostgreSQL and return 429 after exhaustion.

## Postman

Import the separate collection and environment:

- [Owner collection](postman/EventMitra.Owner.postman_collection.json)
- [Owner environment](postman/EventMitra.Owner.local.postman_environment.json)

Select **EventMitra - Owner Local**, set owner_password and the relevant owner_email or owner_name.
Keep the cookie jar enabled. Run **one** folder: Login with email OR Login with owner name.
Each folder logs in, fetches the current owner, logs out, and verifies logout with an expected
401. Use only the email folder when a name is shared. Bodies show actual JSON fields; credentials
in the supplied environment are empty. Keep entered values private.

## Validation and tests

400 invalid body; 401 invalid credentials, ambiguous name or missing/expired/revoked session;
403 rejected origin; 429 throttled. Logout returns 200 after clearing the presented session.

- `npm run typecheck`
- `npm run build`
- `npm test` (owner integration skips unless OWNER_TEST_DATABASE_URL is set)
- `npm run test:owner:integration:local` creates a fresh temporary database, runs the real
  PostgreSQL/HTTP owner tests, then removes it.
- `npm run test:integration:local` runs admin/security and owner suites sequentially, each in
  its own fresh temporary database.
- `npm run test:owner:integration` uses OWNER_TEST_DATABASE_URL, which must name a fresh empty
  disposable database ending in `_test`. It is distinct from TEST_DATABASE_URL so parallel test
  discovery cannot run both suites against the same schema. The owner suite clears its fixtures.

Integration tests cover both login methods, pending/verified eligibility, shared names,
incorrect/unsafe stored passwords, sensitive-field exclusion, admin/owner separation, multiple
sessions, logout, expiry, password/status revocation, deletion, origins and persistent throttling.

Apply migration 012 for signup, OTP and password reset support. See [required fields and complete payloads](owner-signup-otp.md). Owner verification records are target/token based and no longer contain owner_id.
