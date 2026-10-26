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
  | 'state_invalid'
  | 'state_schema_incompatible'
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

export interface FavoriteItem {
  readonly experimentId: string;
  readonly createdAt: number;
}

export interface RecentItem {
  readonly experimentId: string;
  readonly lastOpenedAt: number;
}

/** One saved parameter snapshot (design §7.5). Values are whitelisted by the experiment schema. */
export interface SavedStateSnapshot {
  readonly experimentId: string;
  readonly contentVersion: string;
  readonly stateSchemaVersion: number;
  readonly values: Readonly<Record<string, number | string>>;
  readonly updatedAt: number;
}

/** Wire shape of a diagnostic event (design §7.6). No free text, no values. */
export interface DiagnosticEvent {
  readonly clientEventId: string;
  readonly type: string;
  readonly experimentId: string;
  readonly contentVersion: string;
  readonly locale?: string;
  readonly controlGroup?: string;
  readonly interactionBucket?: string;
  readonly errorCode?: string;
}

export interface FeedbackInput {
  readonly experimentId: string;
  readonly contentVersion: string;
  readonly appVersion: string;
  readonly category: string;
  readonly message?: string;
  readonly locale?: string;
}

export interface ApiClient {
  session(): Promise<SessionInfo>;
  register(credentials: Credentials): Promise<{ displayHint: string }>;
  login(credentials: Credentials): Promise<{ displayHint: string }>;
  logout(): Promise<void>;
  catalog(query?: CatalogQuery): Promise<readonly CatalogItem[]>;
  experiment(id: string, locale?: string): Promise<ExperimentDetail>;
  favorites(): Promise<readonly FavoriteItem[]>;
  addFavorite(experimentId: string): Promise<FavoriteItem>;
  removeFavorite(experimentId: string): Promise<void>;
  recent(limit?: number): Promise<readonly RecentItem[]>;
  recordRecent(experimentId: string): Promise<void>;
  /** `null` means the server has no snapshot for this account and experiment. */
  savedState(experimentId: string): Promise<SavedStateSnapshot | null>;
  saveState(
    experimentId: string,
    input: { readonly stateSchemaVersion: number; readonly values: Readonly<Record<string, number | string>> },
  ): Promise<SavedStateSnapshot>;
  deleteState(experimentId: string): Promise<void>;
  /** Diagnostic batch. Best effort: the caller decides what a failure means. */
  postEvents(input: {
    visitId: string;
    appVersion: string;
    events: readonly DiagnosticEvent[];
  }): Promise<{ accepted: number; dropped: number }>;
  submitFeedback(input: FeedbackInput): Promise<{ id: string }>;
}

export interface ApiClientOptions {
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Same-origin by default (empty prefix). */
  readonly baseUrl?: string;
}

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
  'state_invalid',
  'state_schema_incompatible',
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
        // A JSON content type is only declared when a body is actually sent: an empty body
        // with `application/json` is rejected by the parser, and the CSRF guard treats a
        // declared non-JSON type as an attack.
        headers: {
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.headers ?? {}),
        },
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

    async favorites() {
      const body = await request<{ items: FavoriteItem[] }>('/api/me/favorites');
      return body.items;
    },

    addFavorite: (experimentId) =>
      request<FavoriteItem>(`/api/me/favorites/${encodeURIComponent(experimentId)}`, {
        method: 'PUT',
        body: '{}',
      }),

    removeFavorite: (experimentId) =>
      request<void>(`/api/me/favorites/${encodeURIComponent(experimentId)}`, {
        method: 'DELETE',
      }),

    async recent(limit) {
      const suffix = limit === undefined ? '' : `?limit=${String(limit)}`;
      const body = await request<{ items: RecentItem[] }>(`/api/me/recent${suffix}`);
      return body.items;
    },

    recordRecent: (experimentId) =>
      request<void>('/api/me/recent', {
        method: 'POST',
        body: JSON.stringify({ experimentId }),
      }),

    async savedState(experimentId) {
      try {
        return await request<SavedStateSnapshot>(
          `/api/me/saved-state/${encodeURIComponent(experimentId)}`,
        );
      } catch (error) {
        // 404 is the normal "nothing saved yet" answer, not a failure: the page must not
        // show an error for a user who has never pressed save.
        if (error instanceof ApiError && error.code === 'not_found') return null;
        throw error;
      }
    },

    saveState: (experimentId, input) =>
      request<SavedStateSnapshot>(`/api/me/saved-state/${encodeURIComponent(experimentId)}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),

    deleteState: (experimentId) =>
      request<void>(`/api/me/saved-state/${encodeURIComponent(experimentId)}`, {
        method: 'DELETE',
      }),

    postEvents: (input) =>
      request<{ accepted: number; dropped: number }>('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          schemaVersion: 1,
          appVersion: input.appVersion,
          visitId: input.visitId,
          events: input.events,
        }),
      }),

    submitFeedback: (input) =>
      request<{ id: string }>('/api/feedback', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  };
}
