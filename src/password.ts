import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 32).toString('hex')}`;
}
export function checkPassword(pw: string, stored: string): boolean {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex'), b = scryptSync(pw, salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
}
