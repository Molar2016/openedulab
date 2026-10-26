import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  findAccountByLogin,
  insertAccount,
  isUniqueViolation,
  updateAccountPasswordHash,
  type AccountRecord,
} from '../db/account-repository.js';
import {
  findSessionByTokenHash,
  insertSession,
  revokeSessionByTokenHash,
  touchSessionLastSeen,
} from '../db/session-repository.js';
import { type LoginKind, type NormalizedIdentifier } from '../security/identifier.js';
import { hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from '../security/password.js';
import {
  SESSION_IDLE_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_MS,
} from '../security/session-policy.js';
import { createSessionToken, hashSessionToken, isPlausibleSessionToken } from '../security/session-token.js';

/**
 * Authentication domain service (design §4.2/§4.3).
 *
 * Rules enforced here rather than in the HTTP layer:
 * - the caller never supplies an account id; identities are created and derived here;
 * - a missing account still costs one scrypt verification;
 * - an account is only usable while `status = 'active'`;
 * - sessions are server-side, revocable and checked on every request.
 */

export interface SessionContext {
  readonly accountId: string;
  readonly displayHint: string;
  readonly accountCreatedAt: number;
  readonly sessionId: string;
}

export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: number;
}

export interface AuthenticatedResult {
  readonly account: AccountRecord;
  readonly session: IssuedSession;
}

export type LoginResult = { readonly ok: true; readonly value: AuthenticatedResult } | { readonly ok: false };

export class DuplicateIdentifierError extends Error {
  constructor() {
    super('An account with this identifier already exists.');
    this.name = 'DuplicateIdentifierError';
  }
}

export interface AuthServiceOptions {
  readonly db: DatabaseSync;
  readonly now: () => number;
}

export interface AuthService {
  register(input: { loginKind: LoginKind; identifier: NormalizedIdentifier; password: string }): Promise<AuthenticatedResult>;
  login(input: { identifier: NormalizedIdentifier; password: string }): Promise<LoginResult>;
  resolve(token: string | null): SessionContext | null;
  revoke(token: string | null): boolean;
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const { db, now } = options;

  function issueSession(accountId: string): IssuedSession {
    const createdAt = now();
    const { token, tokenHash } = createSessionToken();
    insertSession(db, {
      id: randomUUID(),
      accountId,
      tokenHash,
      createdAt,
      lastSeenAt: createdAt,
      expiresAt: createdAt + SESSION_TTL_MS,
      revokedAt: null,
    });
    return { token, expiresAt: createdAt + SESSION_TTL_MS };
  }

  return {
    async register(input) {
      const createdAt = now();
      const passwordHash = await hashPassword(input.password);
      const account: AccountRecord = {
        id: randomUUID(),
        loginKind: input.identifier.kind,
        normalizedLogin: input.identifier.normalized,
        displayHint: input.identifier.displayHint,
        passwordHash,
        status: 'active',
        verifiedAt: null,
        createdAt,
      };
      try {
        insertAccount(db, account);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DuplicateIdentifierError();
        }
        throw error;
      }
      return { account, session: issueSession(account.id) };
    },

    async login(input) {
      const found = findAccountByLogin(db, input.identifier.kind, input.identifier.normalized);
      if (found === null) {
        // Same work as a real verification: no timing signal for "this identifier exists".
        await verifyAgainstDummy(input.password);
        return { ok: false };
      }
      const matches = await verifyPassword(found.passwordHash, input.password);
      if (!matches || found.status !== 'active') {
        return { ok: false };
      }
      if (needsRehash(found.passwordHash)) {
        updateAccountPasswordHash(db, found.id, await hashPassword(input.password));
      }
      return { ok: true, value: { account: found, session: issueSession(found.id) } };
    },

    resolve(token) {
      if (token === null || !isPlausibleSessionToken(token)) {
        return null;
      }
      const session = findSessionByTokenHash(db, hashSessionToken(token));
      if (session === null) {
        return null;
      }
      const at = now();
      if (session.revokedAt !== null) {
        return null;
      }
      if (session.expiresAt <= at) {
        return null;
      }
      if (session.lastSeenAt + SESSION_IDLE_TTL_MS <= at) {
        return null;
      }
      if (session.accountStatus !== 'active') {
        return null;
      }
      if (at - session.lastSeenAt > SESSION_TOUCH_INTERVAL_MS) {
        touchSessionLastSeen(db, session.id, at);
      }
      return {
        accountId: session.accountId,
        displayHint: session.displayHint,
        accountCreatedAt: session.accountCreatedAt,
        sessionId: session.id,
      };
    },

    revoke(token) {
      if (token === null || !isPlausibleSessionToken(token)) {
        return false;
      }
      return revokeSessionByTokenHash(db, hashSessionToken(token), now());
    },
  };
}
