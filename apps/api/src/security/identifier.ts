/**
 * Identifier normalization for mandatory self-registration.
 *
 * Design: docs/architecture/A-stage-design.md §4.1. Ownership of a phone number or an
 * email address is NOT verified in the first release, and nothing here may imply it is.
 * Normalization exists only so that "User@Example.com " and "user@example.com" are the
 * same station account, and so the UI can show a masked hint instead of the raw value.
 */

export type LoginKind = 'email' | 'phone';

export interface NormalizedIdentifier {
  readonly kind: LoginKind;
  readonly normalized: string;
  readonly displayHint: string;
}

export type IdentifierProblem =
  | 'unsupported_kind'
  | 'not_a_string'
  | 'email_too_long'
  | 'email_malformed'
  | 'phone_malformed';

export type IdentifierResult =
  | { readonly ok: true; readonly value: NormalizedIdentifier }
  | { readonly ok: false; readonly problem: IdentifierProblem };

const EMAIL_MAX_LENGTH = 254;
const EMAIL_LOCAL_MAX_LENGTH = 64;
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 20;
const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const LOCAL_PATTERN = /^[^\s@]+$/;
const PHONE_SEPARATORS = /[\s()\-.]/g;

export function normalizeIdentifier(kind: unknown, raw: unknown): IdentifierResult {
  if (typeof raw !== 'string') {
    return { ok: false, problem: 'not_a_string' };
  }
  if (kind === 'email') {
    return normalizeEmail(raw);
  }
  if (kind === 'phone') {
    return normalizePhone(raw);
  }
  return { ok: false, problem: 'unsupported_kind' };
}

function normalizeEmail(raw: string): IdentifierResult {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length > EMAIL_MAX_LENGTH) {
    return { ok: false, problem: 'email_too_long' };
  }
  if (trimmed.length === 0 || containsWhitespaceOrControl(trimmed)) {
    return { ok: false, problem: 'email_malformed' };
  }
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) {
    return { ok: false, problem: 'email_malformed' };
  }
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (local.length > EMAIL_LOCAL_MAX_LENGTH || !LOCAL_PATTERN.test(local)) {
    return { ok: false, problem: 'email_malformed' };
  }
  if (!DOMAIN_PATTERN.test(domain)) {
    return { ok: false, problem: 'email_malformed' };
  }
  return {
    ok: true,
    value: { kind: 'email', normalized: `${local}@${domain}`, displayHint: maskEmail(local, domain) },
  };
}

function normalizePhone(raw: string): IdentifierResult {
  const compact = raw.replace(PHONE_SEPARATORS, '');
  const hasPrefix = compact.startsWith('+');
  const digits = hasPrefix ? compact.slice(1) : compact;
  if (!/^\d+$/.test(digits)) {
    return { ok: false, problem: 'phone_malformed' };
  }
  if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) {
    return { ok: false, problem: 'phone_malformed' };
  }
  return {
    ok: true,
    value: {
      kind: 'phone',
      normalized: `${hasPrefix ? '+' : ''}${digits}`,
      displayHint: maskPhone(digits),
    },
  };
}

/** Spaces, tabs, newlines and control characters are never part of an email address. */
function containsWhitespaceOrControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || /\s/u.test(character)) {
      return true;
    }
  }
  return false;
}

/** `teacher@example.com` -> `t***@example.com`. Never reveals the local part. */
function maskEmail(local: string, domain: string): string {
  return `${local.slice(0, 1)}***@${domain}`;
}

/** `13800001234` -> `138****1234` (design §4.1: first 3 + **** + last 4). */
function maskPhone(digits: string): string {
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}
