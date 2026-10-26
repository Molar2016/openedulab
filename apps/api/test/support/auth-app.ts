import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { baseEnv, INDEX_HTML } from '../helpers.js';

/**
 * B2 test harness.
 *
 * Unlike `createFixture()` (which writes a throwaway `0001_init.sql`), this fixture
 * copies the REAL migrations directory, so auth tests exercise the same `account` and
 * `session` tables that ship to production. The clock is injected and mutable, so
 * expiry, idle timeout and rate-limit windows can be tested without sleeping.
 */

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
export const TEST_ORIGIN = 'http://127.0.0.1:3210';
export const DEFAULT_PASSWORD = 'correct horse battery staple';

export interface ResponseBody {
  readonly error?: { readonly code?: string; readonly message?: string };
  readonly account?: { readonly displayHint?: string; readonly createdAt?: number };
  readonly authenticated?: boolean;
}

export interface ApiResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | number | undefined>;
  readonly body: ResponseBody;
  readonly text: string;
  readonly setCookie: string[];
  /** Returns `name=value` for the first Set-Cookie whose name matches. */
  cookie(name?: string): string | null;
}

export interface RequestSpec {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly payload?: unknown;
  readonly headers?: Record<string, string>;
  /** `null` sends no Origin header at all; defaults to the configured public origin. */
  readonly origin?: string | null;
}

export interface AuthHarness {
  readonly app: FastifyInstance;
  readonly clock: { value: number };
  readonly env: Record<string, string>;
  readonly databasePath: string;
  cleanup(): Promise<void>;
}

const START_TIME = Date.UTC(2026, 0, 15, 9, 0, 0);

export async function startAuthHarness(
  overrides: Record<string, string> = {},
): Promise<AuthHarness> {
  const root = await mkdtemp(path.join(tmpdir(), 'oel-auth-'));
  const staticDir = path.join(root, 'site');
  const migrationsDir = path.join(root, 'migrations');
  const databasePath = path.join(root, 'data', 'app.sqlite');

  await mkdir(path.join(staticDir, 'assets'), { recursive: true });
  await writeFile(path.join(staticDir, 'index.html'), INDEX_HTML, 'utf8');
  await mkdir(migrationsDir, { recursive: true });
  await cp(MIGRATIONS_DIR, migrationsDir, { recursive: true });

  const env = { ...baseEnv({ staticDir, migrationsDir, databasePath }), ...overrides };
  const clock = { value: START_TIME };
  const app = await buildApp({
    config: loadConfig(env),
    version: '9.9.9-test',
    now: () => clock.value,
  });

  return {
    app,
    clock,
    env,
    databasePath,
    cleanup: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Issues a request and normalizes the response for assertions. */
export async function api(app: FastifyInstance, spec: RequestSpec): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    origin: TEST_ORIGIN,
    ...spec.headers,
  };
  if (spec.origin === null) {
    delete headers.origin;
  } else if (spec.origin !== undefined) {
    headers.origin = spec.origin;
  }
  if (spec.payload !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  const response = await app.inject({
    method: spec.method,
    url: spec.url,
    headers,
    payload: spec.payload === undefined ? undefined : JSON.stringify(spec.payload),
  });

  const rawSetCookie = response.headers['set-cookie'];
  const setCookie =
    rawSetCookie === undefined
      ? []
      : Array.isArray(rawSetCookie)
        ? rawSetCookie
        : [rawSetCookie];
  const text = response.body;
  let body: ResponseBody = {};
  try {
    body = JSON.parse(text) as ResponseBody;
  } catch {
    body = {};
  }

  return {
    status: response.statusCode,
    headers: response.headers,
    body,
    text,
    setCookie,
    cookie: (name = 'oel_sid') => {
      for (const header of setCookie) {
        const [pair] = header.split(';');
        if (pair === undefined) {
          continue;
        }
        const separator = pair.indexOf('=');
        if (separator > 0 && pair.slice(0, separator).trim() === name) {
          return pair.trim();
        }
      }
      return null;
    },
  };
}

export interface RegisterOptions {
  readonly loginKind?: 'email' | 'phone';
  readonly identifier?: string;
  readonly password?: string;
  readonly headers?: Record<string, string>;
}

export async function register(
  app: FastifyInstance,
  options: RegisterOptions = {},
): Promise<ApiResponse> {
  return api(app, {
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      loginKind: options.loginKind ?? 'email',
      identifier: options.identifier ?? 'teacher@example.com',
      password: options.password ?? DEFAULT_PASSWORD,
    },
    headers: options.headers,
  });
}

export async function login(
  app: FastifyInstance,
  options: RegisterOptions = {},
): Promise<ApiResponse> {
  return api(app, {
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      loginKind: options.loginKind ?? 'email',
      identifier: options.identifier ?? 'teacher@example.com',
      password: options.password ?? DEFAULT_PASSWORD,
    },
    headers: options.headers,
  });
}

export function cookieHeader(cookie: string | null): Record<string, string> {
  return cookie === null ? {} : { cookie };
}

export function errorCode(response: ApiResponse): string | undefined {
  return response.body.error?.code;
}

export const SESSION_COOKIE = 'oel_sid';
export const PRODUCTION_SESSION_COOKIE = '__Host-oel_sid';
