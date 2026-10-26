import type { AppConfig } from '../config.js';

/**
 * Session cookie policy and lifetime (design §4.3).
 *
 * - Production uses the `__Host-` prefix, which browsers only honour when the cookie is
 *   `Secure`, `Path=/` and has no `Domain`; the same rules are applied here.
 * - Local development runs on plain http, so `Secure` would make the cookie impossible
 *   to set. Anything served over HTTPS must run with `OEL_ENV=production`.
 * - The token itself never appears in a JSON body; only this cookie carries it.
 */

export const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000; // absolute expiry, 60 days
export const SESSION_IDLE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // idle expiry, 14 days
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000; // write last_seen at most hourly

export const PRODUCTION_SESSION_COOKIE = '__Host-oel_sid';
export const DEVELOPMENT_SESSION_COOKIE = 'oel_sid';

export interface SessionCookiePolicy {
  readonly name: string;
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
}

export function sessionCookiePolicy(config: AppConfig): SessionCookiePolicy {
  const production = config.env === 'production';
  return Object.freeze({
    name: production ? PRODUCTION_SESSION_COOKIE : DEVELOPMENT_SESSION_COOKIE,
    secure: production,
    maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** Reads one cookie value; malformed headers are treated as "no cookie". */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header.length === 0) {
    return null;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    if (part.slice(0, separator).trim() !== name) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    return value.length === 0 ? null : value;
  }
  return null;
}

export function serializeSessionCookie(policy: SessionCookiePolicy, token: string): string {
  return [
    `${policy.name}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(policy.maxAgeSeconds)}`,
    ...(policy.secure ? ['Secure'] : []),
  ].join('; ');
}

export function serializeClearedSessionCookie(policy: SessionCookiePolicy): string {
  return [
    `${policy.name}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(policy.secure ? ['Secure'] : []),
  ].join('; ');
}
