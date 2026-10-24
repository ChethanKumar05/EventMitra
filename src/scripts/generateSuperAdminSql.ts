import { normalizeEmail,validateUsername } from '../utils/adminValidation';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { privateInput } from '../utils/privateInput';
import { hashPassword } from '../security/password';
import { renderBootstrapSql } from '../utils/bootstrapSql';

async function main(): Promise<void> {
  const email=normalizeEmail(await privateInput('Email (hidden): '));
  const name = (await privateInput('Super-admin name (hidden): ')).trim();
  if (!name || name.length>150) throw new Error('Name must contain 1-150 characters');
  const username=validateUsername(await privateInput('Username (hidden, 3-50 characters, no spaces): '));
  const password = await privateInput('Password (hidden, minimum 12 characters): ');
  if (password !== await privateInput('Confirm password (hidden): ')) throw new Error('Passwords do not match');
  const passwordHash = await hashPassword(password);
  const root = path.resolve(__dirname,'../..');
  const template = await readFile(path.join(root,'docs/sql/bootstrap-super-admin.sql'),'utf8');
  const output = path.join(root,'.local/admin-bootstrap.sql');
  await mkdir(path.dirname(output),{recursive:true});
  // Never replace a previously generated file without the user moving/removing it.
  await writeFile(output,renderBootstrapSql(template,{email,name,passwordHash,username}),{flag:'wx',mode:0o600});
  console.log(`SQL file generated: ${output}`);
  console.log('No database changes made. Open this file in pgAdmin Query Tool for your EventMitra database and execute it.');
}
if (require.main===module) main().catch(error=>{
  if (error?.code==='EEXIST') console.error('The generated .local/admin-bootstrap.sql already exists. Move or remove that file before generating another.');
  else console.error(error instanceof Error ? error.message : 'SQL generation failed');
  process.exitCode=1;
});
