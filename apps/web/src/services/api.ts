/**
 * Same-origin API client (design §7).
 *
 * One place builds every request, so the security-relevant details cannot drift per
 * screen: credentials are always `same-origin` (the HttpOnly session cookie is never read
 * by JavaScript), bodies are always JSON, and every failure becomes a typed `ApiError`
 * carrying the server's error code — never a raw network error leaking into the UI.
 *
 * Nothing here stores a token: the server replies with a Set-Cookie header the browser
 * handles. This module cannot see it, which is the point.
 */

export type LoginKind = 'email' | 'phone';

export interface SessionInfo {
  readonly authenticated: boolean;
  readonly account?: { readonly displayHint: string; readonly createdAt: number };
}

export interface CatalogItem {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly subjects: readonly string[];
  readonly grades: readonly string[];
  readonly concepts: readonly string[];
  readonly contentVersion: string;
  readonly languages: readonly string[];
}

export interface ExperimentDetail extends CatalogItem {
  readonly moduleVersion: string;
  readonly sdkVersionRange: string;
  readonly reviewedStatus: 'draft' | 'verified';
  readonly offlineSupport: boolean;
  readonly updatedAt: number;
  readonly manifest: Readonly<Record<string, unknown>>;
}

export interface Credentials {
  readonly loginKind: LoginKind;
  readonly identifier: string;
  readonly password: string;
}

export type ApiErrorCode =
  | 'unauthenticated'
  | 'invalid_credentials'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'identifier_taken'
  | 'already_authenticated'
  | 'rate_limited'
  | 'payload_too_large'
  | 'server_error'
  | 'network_error';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, code: ApiErrorCode, options: { retryAfterSeconds?: number } = {}) {
    super(`${code} (${String(status)})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface CatalogQuery {
  readonly subject?: string;
  readonly grade?: string;
  readonly concept?: string;
  readonly q?: string;
  readonly locale?: string;
  readonly limit?: number;
}

export interface ApiClient {
  session(): Promise<SessionInfo>;
  register(credentials: Credentials): Promise<{ displayHint: string }>;
  login(credentials: Credentials): Promise<{ displayHint: string }>;
  logout(): Promise<void>;
  catalog(query?: CatalogQuery): Promise<readonly CatalogItem[]>;
  experiment(id: string, locale?: string): Promise<ExperimentDetail>;
}

export interface ApiClientOptions {
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Same-origin by default (empty prefix). */
  readonly baseUrl?: string;
}

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' } as const;

const KNOWN_CODES: readonly ApiErrorCode[] = [
  'unauthenticated',
  'invalid_credentials',
  'forbidden',
  'not_found',
  'validation_failed',
  'identifier_taken',
  'already_authenticated',
  'rate_limited',
  'payload_too_large',
  'server_error',
];

function asCode(value: unknown): ApiErrorCode | null {
  return typeof value === 'string' && (KNOWN_CODES as readonly string[]).includes(value)
    ? (value as ApiErrorCode)
    : null;
}

async function toApiError(response: Response): Promise<ApiError> {
  let code: ApiErrorCode = response.status === 401 ? 'unauthenticated' : 'server_error';
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    code = asCode(body.error?.code) ?? code;
  } catch {
    // Non-JSON failure (proxy, gateway): keep the status-derived code.
  }
  const retryAfter = Number(response.headers.get('retry-after') ?? '');
  return new ApiError(response.status, code, {
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
  });
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? '';
  const doFetch: typeof fetch =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        ...init,
        credentials: 'same-origin',
        headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
      });
    } catch {
      // Offline, DNS failure or a blocked request: reported as a first-class code so the
      // UI can say "not saved" instead of pretending success.
      throw new ApiError(0, 'network_error');
    }
    if (!response.ok) {
      throw await toApiError(response);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    if (text === '') {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  function credentialsBody(credentials: Credentials): string {
    return JSON.stringify({
      loginKind: credentials.loginKind,
      identifier: credentials.identifier,
      password: credentials.password,
    });
  }

  return {
    session: () => request<SessionInfo>('/api/auth/session'),

    async register(credentials) {
      const body = await request<{ account: { displayHint: string } }>('/api/auth/register', {
        method: 'POST',
        body: credentialsBody(credentials),
      });
      return body.account;
    },

    async login(credentials) {
      const body = await request<{ account: { displayHint: string } }>('/api/auth/login', {
        method: 'POST',
        body: credentialsBody(credentials),
      });
      return body.account;
    },

    logout: () => request<void>('/api/auth/logout', { method: 'POST', body: '{}' }),

    async catalog(query = {}) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      const suffix = params.toString();
      const body = await request<{ items: CatalogItem[] }>(
        `/api/catalog${suffix === '' ? '' : `?${suffix}`}`,
      );
      return body.items;
    },

    experiment: (id, locale) =>
      request<ExperimentDetail>(
        `/api/experiments/${encodeURIComponent(id)}${locale === undefined ? '' : `?locale=${encodeURIComponent(locale)}`}`,
      ),
  };
}
