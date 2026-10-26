import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing (design §4.2): scrypt with a self-describing string so the work
 * factor can be raised later and upgraded on the next successful login.
 *
 * Format: `scrypt$<N>$<r>$<p>$<salt_base64>$<key_base64>`
 *
 * There is deliberately no plaintext or reversible storage anywhere in this module.
 */

export interface ScryptParameters {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

export const DEFAULT_SCRYPT_PARAMETERS: ScryptParameters = Object.freeze({ N: 32768, r: 8, p: 3 });

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

const ALGORITHM = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

/** Upper bounds for values read back from the database: never trust a stored cost. */
const MAX_R = 16;
const MAX_P = 8;
const MIN_N = 1024;

/** scrypt needs 128 * N * r bytes; refuse anything that cannot fit our maxmem budget. */
function withinMemoryBudget(parameters: ScryptParameters): boolean {
  return 128 * parameters.N * parameters.r + 1024 * 1024 <= MAX_MEMORY;
}

export type PasswordProblem = 'not_a_string' | 'too_short' | 'too_long' | 'blank';

export type PasswordResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly problem: PasswordProblem };

/**
 * Length in code points (not UTF-16 units), so a password of emoji or CJK characters is
 * measured the way a person counts it.
 */
export function validatePassword(raw: unknown): PasswordResult {
  if (typeof raw !== 'string') {
    return { ok: false, problem: 'not_a_string' };
  }
  const length = Array.from(raw).length;
  if (raw.trim().length === 0) {
    return { ok: false, problem: 'blank' };
  }
  if (length < MIN_PASSWORD_LENGTH) {
    return { ok: false, problem: 'too_short' };
  }
  if (length > MAX_PASSWORD_LENGTH) {
    return { ok: false, problem: 'too_long' };
  }
  return { ok: true, value: raw };
}

export interface ParsedPasswordHash {
  readonly parameters: ScryptParameters;
  readonly salt: Buffer;
  readonly key: Buffer;
}

export function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== ALGORITHM) {
    return null;
  }
  const [, nText, rText, pText, saltText, keyText] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!/^\d+$/.test(nText) || !/^\d+$/.test(rText) || !/^\d+$/.test(pText)) {
    return null;
  }
  const parameters: ScryptParameters = { N: Number(nText), r: Number(rText), p: Number(pText) };
  if (
    !Number.isSafeInteger(parameters.N) ||
    parameters.N < MIN_N ||
    (parameters.N & (parameters.N - 1)) !== 0 ||
    parameters.r < 1 ||
    parameters.r > MAX_R ||
    parameters.p < 1 ||
    parameters.p > MAX_P ||
    !withinMemoryBudget(parameters)
  ) {
    return null;
  }
  const salt = decodeBase64(saltText);
  const key = decodeBase64(keyText);
  if (salt === null || key === null) {
    return null;
  }
  // Exact lengths only: a truncated hash must not be able to match a shorter prefix.
  if (salt.length !== SALT_BYTES || key.length !== KEY_BYTES) {
    return null;
  }
  return { parameters, salt, key };
}

export async function hashPassword(
  password: string,
  parameters: ScryptParameters = DEFAULT_SCRYPT_PARAMETERS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, parameters);
  return [
    ALGORITHM,
    String(parameters.N),
    String(parameters.r),
    String(parameters.p),
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/**
 * Constant-time verification. A malformed or out-of-bounds stored hash returns false
 * without running scrypt, so a corrupted row cannot be turned into a CPU bomb.
 */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (parsed === null) {
    return false;
  }
  let candidate: Buffer;
  try {
    candidate = await derive(password, parsed.salt, parsed.parameters, parsed.key.length);
  } catch {
    return false;
  }
  if (candidate.length !== parsed.key.length) {
    return false;
  }
  return timingSafeEqual(candidate, parsed.key);
}

/**
 * Burns the same work as a real verification when no account matched, so that
 * "unknown identifier" and "wrong password" cost the same wall-clock time.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  await derive(password, DUMMY_SALT, DEFAULT_SCRYPT_PARAMETERS, KEY_BYTES);
}

/** True when a successfully verified hash should be replaced with current parameters. */
export function needsRehash(stored: string): boolean {
  const parsed = parsePasswordHash(stored);
  if (parsed === null) {
    return true;
  }
  const current = DEFAULT_SCRYPT_PARAMETERS;
  return (
    parsed.parameters.N !== current.N ||
    parsed.parameters.r !== current.r ||
    parsed.parameters.p !== current.p ||
    parsed.key.length !== KEY_BYTES
  );
}

const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 7);

function derive(
  password: string,
  salt: Buffer,
  parameters: ScryptParameters,
  keyLength: number = KEY_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      keyLength,
      { N: parameters.N, r: parameters.r, p: parameters.p, maxmem: MAX_MEMORY },
      (error, derivedKey) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

function decodeBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}
