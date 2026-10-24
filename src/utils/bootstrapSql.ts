import { randomBytes } from 'node:crypto';
import { generateId } from './id';

// Use one replacement pass and a unique DO delimiter so SQL quotes and dollar tags in
// names/passwords cannot change the generated statement's structure.
export function renderBootstrapSql(template: string, input: { email: string; name: string; passwordHash: string; username?:string }): string {
  const replacements: Record<string,string> = {
    ADMIN_EMAIL: input.email,
    ADMIN_USERNAME: input.username??`admin_${generateId().toLowerCase()}`,
    ADMIN_NAME: input.name,
    PASSWORD_HASH: input.passwordHash,
    ROLE_ID: generateId(),
    ADMIN_ID: generateId(),
  };
  let delimiter: string;
  do { delimiter = `$bootstrap_${randomBytes(16).toString('hex')}$`; }
  while (Object.values(replacements).some(value => value.includes(delimiter)));
  return template.replace(/\$eventmitra_bootstrap\$/g, delimiter)
    .replace(/__(ADMIN_EMAIL|ADMIN_USERNAME|ADMIN_NAME|PASSWORD_HASH|ROLE_ID|ADMIN_ID)__/g, (_, key: string) => replacements[key]!.replace(/\\/g, '\\\\').replace(/'/g, "''"));
}
