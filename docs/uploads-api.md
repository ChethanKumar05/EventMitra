# Shared AWS S3 image and file upload

`POST /api/uploads` is shared by authenticated admins, users and owners. It uploads one file using the AWS S3 SDK and returns its object key, stable object URL and a ten-minute signed preview URL. It creates no buckets, changes no bucket policies and sets no public ACL. See [AWS SDK S3 upload examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html).

## Request

Log in first. Use the identity's existing cookie or an owner `Authorization: Bearer <access_token>`. The upload endpoint also recognizes valid admin/user session tokens as bearer tokens; their login endpoints continue using cookies.

If several valid identity cookies are present, set `X-Actor-Type: admin`, `user` or `owner` to choose the identity. Supplying that header cannot turn an owner token into an admin token. Browser calls use the existing same-origin protection; serve or proxy `/api` through your frontend origin.

Send **multipart/form-data**, with these fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `file` | File | Yes | Exactly one nonempty file, at most 10 MiB |
| `folder` | Text | No | Defaults to `general`; 1–50 lowercase letters/digits/underscores/hyphens, starting with a letter or digit |

In Postman choose Body → form-data, set `file` to the File type and select a local file. Add `folder=venues` or `folder=profile`. **Do not manually set Content-Type**: Postman supplies the multipart boundary. Owner, user and admin collections each include a shared-upload folder to run separately after login.

Example request:

```bash
curl -X POST http://localhost:3600/api/uploads \
  -H "Authorization: Bearer YOUR_OWNER_ACCESS_TOKEN" \
  -H "X-Actor-Type: owner" \
  -F "folder=venues" \
  -F "file=@hall.jpg;type=image/jpeg"
```

Accepted types: JPEG, PNG, GIF, WebP, PDF, ZIP, DOCX, XLSX, PPTX, UTF-8 plain text and CSV. Binary formats must match their expected file signature. HTML, SVG, executables and other MIME types are rejected. Non-image objects are served as attachments. These checks do not perform antivirus scanning or fully parse document/image contents.

Authentication runs before file parsing. The API limits uploads to 20 attempts per identity per 15 minutes and two concurrent uploads per identity in each API process. Multipart size/field/file limits also bound in-memory buffering. For multiple API instances, apply a shared gateway limit as well.

## Response

HTTP 201 uses the normal `{status,message,code,data}` envelope:

```json
{
  "key": "uploads/owner/OWNER_ID/venues/GENERATED_ID.jpg",
  "url": "https://YOUR_BUCKET.s3.ap-south-1.amazonaws.com/uploads/owner/OWNER_ID/venues/GENERATED_ID.jpg",
  "preview_url": "https://YOUR_BUCKET.s3.ap-south-1.amazonaws.com/...SIGNED_QUERY...",
  "preview_expires_in": 600,
  "original_name": "hall.jpg",
  "content_type": "image/jpeg",
  "size": 14567
}
```

Keys are generated under the authenticated identity's namespace. Caller-supplied filenames, owner IDs and bucket names cannot choose or overwrite an object. The uploaded object uses AES256 server-side encryption.

Persist `key` or the stable `url` in the existing image/file fields (`profile_image`, `doc_image`, `venue_images`, etc.). Use `preview_url` for an immediate preview; **do not persist it**, because it expires. A private object's stable URL does not grant public read access. Applications need their own authorized download/signing flow or a deliberately configured asset CDN for later viewing. This upload API does not change existing private document visibility or make a bucket public.

This endpoint requires an authenticated account. It is not an anonymous pre-signup upload endpoint; owner signup still requires an existing `doc_image` reference. Account onboarding that uploads the document before signup needs a separate pre-signup upload policy.

## Server setup

Set these privately in the server environment; placeholders are in `.env.example`:

```dotenv
AWS_REGION=ap-south-1
AWS_S3_BUCKET=YOUR_EXISTING_BUCKET
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_SESSION_TOKEN=
```

The AWS SDK uses its standard credential chain: environment credentials, local AWS profile or an attached IAM role. Prefer a role in hosted deployments. The identity needs `s3:PutObject` for the upload prefix and `s3:GetObject` for signed previews on the configured bucket; explicit bucket policy denials still apply. Scope permissions to `arn:aws:s3:::YOUR_BUCKET/uploads/*`. Bucket policies requiring KMS instead of AES256 need corresponding configuration before using this endpoint. Keep secrets out of Postman and source control.

Missing configuration or an S3 failure returns 503 with a generic message. Other responses: 400 malformed multipart/fields/folder, 401 no valid session, 403 cross-origin mutation, 413 oversized file, 415 unsupported or mismatched type, 429 upload limit. Errors do not return AWS credentials.

Run `npm run test:upload:integration:local` for isolated PostgreSQL/HTTP tests. The tests use actual session middleware, multipart parsing and SDK URL signing, with fake credentials and intercepted S3 PUTs. They do not upload to a real AWS bucket. Live validation requires your bucket and credentials.
