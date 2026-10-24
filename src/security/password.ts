import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
// OWASP scrypt minimum: N=2^17, r=8, p=1; allow overhead beyond 128 MiB.
const options = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
const derive = (password: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, 64, options, (error, key) => error ? reject(error) : resolve(key));
});
export function checkPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 256) {
    throw Object.assign(new Error('Password must contain 12–256 bytes (at least 12 characters)'), { status: 400 });
  }
}
export async function hashPassword(password: string): Promise<string> {
  checkPassword(password);
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt) as Buffer;
  return `scrypt-v1$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [, salt, hex] = (stored ?? '').split('$');
  const valid = /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(stored ?? '');
  const key = await derive(password, valid ? salt! : '00000000000000000000000000000000') as Buffer;
  return valid && timingSafeEqual(key, Buffer.from(hex!, 'hex'));
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const securityLock = 71003601;


