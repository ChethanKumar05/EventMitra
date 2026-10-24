# Create the first super admin through pgAdmin

This bootstrap runs through your PostgreSQL connection; it does not require API authorization.
It creates an application role and an active admin with is_super_admin=true. That flag gives
full access to every current/future main module, so separate admin_permission rows are not
required for this super admin. You can then log in and create roles, admins, modules and grants.

1. From the EventMitra folder, apply pending schema migrations:

   ```powershell
   npm run migrate
   ```

2. Generate a ready-to-run SQL file:

   ```powershell
   npm run admin:bootstrap:sql
   ```

   Privately enter your email, name, username, password and confirmation. Input is hidden. The password
   needs at least 12 characters and at most 256 UTF-8 bytes. The command does not connect to or
   change the database. It creates `.local/admin-bootstrap.sql` with generated ULIDs and an
   application-compatible scrypt-v1 hash; the plaintext password is not stored in that file.
   The generated file is ignored by Git and existing generated files are not overwritten.

3. In pgAdmin, select the same EventMitra database used by DATABASE_URL and open Query Tool.
   Open `.local/admin-bootstrap.sql` using the Query Tool's Open File control. Execute the
   entire script (F5). The result shows your admin and role codes without the password hash.

4. Log in from Postman (`POST /api/admin/auth/login`) or `http://localhost:3600/admin/` using
   the email or username and original password you entered. You now have authorization for management APIs.

The template is [bootstrap-super-admin.sql](bootstrap-super-admin.sql); use the generated
copy to avoid manually producing hashes and IDs. It requires migrations through 010, uses
the same transaction lock as the app's bootstrap, and atomically creates both records. No
migration file is changed and no PostgreSQL server role or database user is created.

There are no default credentials. The script refuses if any super admin already exists or
if the chosen email belongs to an existing account. It does not promote, reset, enable or
overwrite existing accounts. To generate a replacement SQL file, first move/remove your old
`.local/admin-bootstrap.sql`. Keep the generated file private because it contains a password
hash, and remove it after completing your bootstrap.

Usernames must be 3-50 letters/digits/dots/underscores/hyphens, starting with a letter or digit, with no whitespace. Old generated files are not modified; after migration 010 they receive a generated username from the database default if they omit it. Existing admins receive a username based on their admin code. Use auth/me after email login to see it.
