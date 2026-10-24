import { normalizeEmail,validateUsername } from '../utils/adminValidation';
import { privateInput } from '../utils/privateInput';
import { pool } from '../config/database';
import { bootstrapSuperAdmin } from '../services/adminAuthService';

async function main() {
  const email=normalizeEmail(await privateInput('Email (hidden): '));
  const name = (await privateInput('Name (hidden): ')).trim();
  if (!name || name.length > 150) throw new Error('Invalid name');
  const username=validateUsername(await privateInput('Username (hidden, 3-50 characters, no spaces): '));
  const password = await privateInput('Password (hidden, minimum 12 characters): ');
  if (password !== await privateInput('Confirm password (hidden): ')) throw new Error('Passwords do not match');
  await bootstrapSuperAdmin({ name, email, password, username });
  console.log('First super admin created.');
}
if (require.main === module) main().catch(error => { console.error(error instanceof Error ? error.message : 'Bootstrap failed'); process.exitCode = 1; }).finally(() => pool.end());
