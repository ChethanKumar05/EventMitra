# Owner signup, OTP verification and password recovery

Run `npm run migrate` through **012_owner_signup_otp_migration**. Earlier migrations, including
003, remain unchanged. Migration 012 removes owner_id from owner_phone_verification and adds
target-bound email/phone challenges with otp_token hashes. Historical OTP rows are retained
as expired/consumed records. Owner names become unique ignoring case and repeated/outer spaces;
existing duplicates cause migration to stop and list them for correction rather than merging data.
New owners receive generated codes such as OWN00001.

## 1. Signup: POST /api/owner/auth/signup

Signup creates a **pending** owner first. Email/phone verification happens afterward. It does
not approve KYC, change status to verified, or start a login session.

```json
{
  "owner_name": "Ravi Kumar",
  "owner_phone_number": "9876543210",
  "country_code": "+91",
  "alternative_number": null,
  "profile_image": null,
  "email": "ravi@example.com",
  "alternative_email": null,
  "password": "YOUR_PRIVATE_PASSWORD",
  "whatsapp_number": null,
  "gender": "m",
  "doc_type": "passport",
  "doc_number": "YOUR_DOCUMENT_NUMBER",
  "doc_image": "/uploads/owner-document.jpg",
  "pin_code": "560001",
  "state": "Karnataka",
  "city": "Bengaluru",
  "area": "Indiranagar",
  "lat": 12.9716,
  "long": 77.5946,
  "address": "Your full address"
}
```

| Required | Validation |
| --- | --- |
| owner_name | Nonblank, max 150; unique ignoring case/repeated/outer spaces |
| owner_phone_number | String of 7-15 national digits; no country prefix |
| country_code | Calling code such as +91: + followed by 1-3 digits; international total max 15 digits |
| email | Valid primary email, max 255; unique ignoring case |
| password | At least 12 characters, at most 256 UTF-8 bytes; saved with scrypt hashing |
| gender | m or f |
| doc_type / doc_number | Nonblank strings, max 50 / 100 |
| doc_image | Nonblank asset reference/URL, max 2048; this endpoint does not upload files |
| pin_code | 2-12 alphanumeric characters, spaces or hyphens |
| state / city / area | Nonblank; max 100 / 100 / 150 |
| lat / long | JSON numbers in -90..90 / -180..180; zero is valid |
| address | Nonblank, max 2000 |

Optional: alternative_number and whatsapp_number (7-15 digits, optional leading +),
profile_image (asset reference/URL, max 2048), alternative_email (valid email). Optional fields
may be omitted, null or empty. Phone uniqueness uses country_code + national phone number.
Owner IDs/codes/status/KYC/verification flags cannot be supplied. Invalid fields return 400;
duplicate name/email/phone returns 409. Signup returns 201 with basic owner identity and flags,
never password/document/bank data. Signup is limited to 20 attempts/IP per fifteen minutes.

## 2. Send OTP: POST /api/owner/auth/send-otp

Email:

```json
{"type":"email","email":"ravi@example.com"}
```

Phone:

```json
{"type":"phone","country_code":"+91","phone_number":"9876543210"}
```

Provide only the fields for the chosen type. The response contains:

```json
{
  "otp_token":"64_CHARACTER_TOKEN_FROM_RESPONSE",
  "type":"email",
  "purpose":"verification",
  "expires_in":300,
  "delivery":"development-fixed-otp"
}
```

**Current test OTP is 1111.** No email or SMS provider is connected and no external message is
sent. These fixed-code OTP endpoints are disabled with 503 when NODE_ENV=production. Real
provider delivery and random OTP generation must be added before enabling production recovery.
OTP is a salted token-bound hash; otp_token is stored as SHA-256, not the raw bearer token.
Both email and phone challenges use owner_phone_verification, with no owner_id column.

Challenges expire after five minutes. A resend invalidates the previous challenge for the same
target and purpose, including verified but unused reset challenges. Send limits are five per
target and twenty per IP per fifteen minutes, shared across verification/recovery endpoints.

## 3. Verify OTP: POST /api/owner/auth/verify-otp

```json
{"otp":"1111","otp_token":"TOKEN_FROM_SEND_OTP"}
```

otp must be a four-digit string. The target and purpose come from the stored token, not from
client owner IDs. Wrong attempts persist and a challenge locks after five wrong attempts.
Expired/used/wrong codes return 401; exhausted challenges return 429. A verification challenge
is consumed once it succeeds. Email verification updates is_email_verified; phone verification
updates is_phone_number_verified for the matching primary country/phone. It does not change
KYC or approval status. Login and auth/me return both verification flags.

## 4. Forgot password: POST /api/owner/auth/forgot-password

Use the same email/phone body as send-otp. This issues a separate purpose=password_reset token:

```json
{"type":"email","email":"ravi@example.com"}
```

```json
{"type":"phone","country_code":"+91","phone_number":"9876543210"}
```

Verify that token through verify-otp with 1111. Responses have the same shape whether an
eligible account exists or not. Only pending/verified accounts can complete password recovery.
A normal email/phone verification token cannot reset a password.

## 5. Reset password: POST /api/owner/auth/reset-password

```json
{
  "otp_token":"VERIFIED_TOKEN_FROM_FORGOT_PASSWORD",
  "new_password":"YOUR_NEW_PRIVATE_PASSWORD",
  "confirm_password":"YOUR_NEW_PRIVATE_PASSWORD"
}
```

new_password is required and follows the signup password policy. confirm_password is optional
but must match when provided. The token must be verified, unexpired, unconsumed and issued for
password_reset. Its saved password fingerprint must still match the account. Reset consumes
the token, hashes the new password, and revokes every owner session atomically. It does not
log the owner in or change status. Replays and proofs issued before another password change
are rejected. Password reset requests are limited to twenty/IP per fifteen minutes.

## Postman and testing

Reimport [the Owner collection](postman/EventMitra.Owner.postman_collection.json) and
[Owner environment](postman/EventMitra.Owner.local.postman_environment.json). Fill owner_name,
owner_email, owner_phone_number, country_code, owner_password and owner_new_password privately.
Signup runs once per account. Follow email/phone verification folders, then login folders.
The recovery folders capture reset tokens, verify, reset, log in with the new password and log
out. After recovery, update owner_password to the new value for future login requests.

`npm run typecheck`, `npm test`, and `npm run test:integration:local` verify types/build/static
checks and isolated PostgreSQL suites. Tests cover required/optional fields, duplicate records,
token/OTP hashing, expiry, persisted failed attempts, resend/replay, purpose/target binding,
phone/email flags, password reset, session revocation, rate limits, and production fixed-OTP blocking.
