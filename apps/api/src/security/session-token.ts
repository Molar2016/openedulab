import { createHash, randomBytes } from 'node:crypto';

/**
 * Session tokens (design §4.3): 32 random bytes, base64url, sent only as a cookie.
 * The database stores `sha256(token)`, so a database leak cannot be replayed as a
 * live session.
 */

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface IssuedSessionToken {
  readonly token: string;
  readonly tokenHash: string;
}

export function createSessionToken(): IssuedSessionToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Cheap shape check before touching the database: anything that is not exactly one
 * base64url-encoded 32-byte value is treated as "no session", never as an error.
 */
export function isPlausibleSessionToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}
