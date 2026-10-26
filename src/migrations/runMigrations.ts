import { ownerSignupOtpMigration } from './012_owner_signup_otp_migration';
import { userAuthMigration } from './013_user_auth_migration';
import { peopleAccountsMigration } from './014_people_accounts_migration';
import { ownerAuthMigration } from './011_owner_auth_migration';
import { adminIdentityValidationMigration } from './010_admin_identity_validation_migration';
import { adminModulePermissionsMigration } from './009_admin_module_permissions_migration';
import { securityCodesMigration } from './008_security_codes_migration';
import { securityMigration } from './007_security_migration';
import { PoolClient } from 'pg';
import { pool } from '../config/database';
import { adminMigration } from './001_admin_migration';
import { userMigration } from './002_user_migration';
import { ownerMigration } from './003_owner_migration';
import { venueMigration } from './004_venue_migration';
import { bookingMigration } from './005_booking_migration';
import { reviewsMigration } from './006_reviews_migration';

const migrations: Array<{ name: string; run: (client: PoolClient) => Promise<void> }> = [
  { name: '001_admin_migration', run: adminMigration },
  { name: '002_user_migration', run: userMigration },
  { name: '003_owner_migration', run: ownerMigration },
  { name: '004_venue_migration', run: venueMigration },
  { name: '005_booking_migration', run: bookingMigration },
  { name: '006_reviews_migration', run: reviewsMigration },
  { name: '007_security_migration', run: securityMigration },
  { name: '008_security_codes_migration', run: securityCodesMigration },
  { name: '009_admin_module_permissions_migration', run: adminModulePermissionsMigration },
  { name: '010_admin_identity_validation_migration', run: adminIdentityValidationMigration },
  { name: '011_owner_auth_migration', run: ownerAuthMigration },
  { name: '012_owner_signup_otp_migration', run: ownerSignupOtpMigration },
  { name: '013_user_auth_migration', run: userAuthMigration },
  { name: '014_people_accounts_migration', run: peopleAccountsMigration },
];

export async function runMigrations() {
  const client = await pool.connect();
  try {
    // Session-scoped lock serializes migration runners on the same database.
    await client.query('SELECT pg_advisory_lock($1)', [71003600]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.migrations_history (
        migration_name VARCHAR(150) PRIMARY KEY,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    for (const migration of migrations) {
      const previous = await client.query(
        'SELECT 1 FROM public.migrations_history WHERE migration_name = $1',
        [migration.name],
      );
      if (previous.rowCount) {
        console.log(`Skipping ${migration.name} (already applied)`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await migration.run(client);
        await client.query(
          'INSERT INTO public.migrations_history (migration_name) VALUES ($1)',
          [migration.name],
        );
        await client.query('COMMIT');
        console.log(`Applied ${migration.name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration failed: ${migration.name}`, { cause: error });
      }
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [71003600]); }
    finally { client.release(); }
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => console.log('All pending migrations completed'))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
