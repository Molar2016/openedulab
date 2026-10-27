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

/** One curriculum directory entry: a chapter position that reuses a tool (ADR-003). */
export interface CurriculumNode {
  readonly id: string;
  readonly label: string;
}

/** One printed section (节) of a chapter (ADR-006). */
export interface CurriculumSection {
  readonly sectionId: string;
  /** Explicit order inside the chapter (1..n). */
  readonly order: number;
  readonly label: string;
  /** The page printed in the book, when the volume numbers it. */
  readonly printedPage?: number;
  /** Placement ids in tool order; join against `items` to render them. */
  readonly placementIds: readonly string[];
}

/** One chapter of a catalog: ordered, and holding references to the entries placed in it. */
export interface CurriculumChapter {
  readonly chapterId: string;
  /** Explicit order inside the book (1..n). */
  readonly order: number;
  readonly label: string;
  /** The page printed in the book for the chapter opening. */
  readonly printedPage?: number;
  /**
   * Placement ids in tool order, including the ones that sit in a section below — a
   * chapter-only client must not lose an entry. Join against `items` and split on
   * `item.sectionId` to render each entry once.
   */
  readonly placementIds: readonly string[];
  /** Printed sections in book order; empty or absent when the catalog models chapters only. */
  readonly sections?: readonly CurriculumSection[];
}

/** One book (册) of a catalog. */
export interface CurriculumBook {
  readonly bookId: string;
  /** Explicit order inside the catalog (1..n). */
  readonly order: number;
  readonly label: string;
  readonly chapters: readonly CurriculumChapter[];
}

/**
 * One textbook catalog (教材版本). `illustrative` catalogs are examples and carry no
 * publisher/revision; a real textbook would have to be verified before it is marked
 * `verified`, and only then does the wire shape include the bibliographic fields.
 */
export interface CurriculumCatalog {
  readonly catalogId: string;
  readonly subject: string;
  readonly version: number;
  readonly status: 'illustrative' | 'verified';
  /** Explicit order inside the subject (1..n). */
  readonly order: number;
  readonly label: string;
  readonly publisher?: string;
  readonly revision?: string;
  /**
   * Edition metadata (ADR-006): `current-2022` for the 2022 curriculum revision, `legacy-2011`
   * for the grade-9 volume printed under the 2011 curriculum. It is a catalog attribute the
   * directory reports inside the catalog's own details — every catalog is a peer entry, so
   * nothing in the interface badges one edition against the other. Absent on illustrative
   * catalogs.
   */
  readonly editionStatus?: 'current-2022' | 'legacy-2011';
  readonly books: readonly CurriculumBook[];
}

export interface CurriculumItem {
  readonly placementId: string;
  readonly slug: string;
  readonly version: number;
  readonly status: 'illustrative' | 'verified';
  /** Tool order inside its chapter — not the directory order. */
  readonly order: number;
  readonly experimentId: string;
  readonly experimentSlug: string;
  readonly contentVersion: string;
  readonly stateSchemaVersion: number;
  /** Navigation group: this is a subject tag, never a class or a cohort. */
  readonly subject: string;
  readonly catalogId: string;
  readonly bookId: string;
  readonly chapterId: string;
  /** The printed section this entry sits in (ADR-006); absent for a chapter-level entry. */
  readonly sectionId?: string;
  readonly title: string;
  readonly summary: string;
  /** Compatibility fields: the catalog/book/chapter labels this entry sits in. */
  readonly edition: CurriculumNode;
  readonly book: CurriculumNode;
  readonly chapter: CurriculumNode;
  /** The section label, present exactly when `sectionId` is. */
  readonly section?: CurriculumNode;
  /** The preset this entry opens with (validated server-side against the tool schema). */
  readonly preset: Readonly<Record<string, number | string>>;
}

/** `GET /api/curriculum`: flat entries (old shape) plus the catalog tree they belong to. */
export interface CurriculumResponse {
  readonly items: readonly CurriculumItem[];
  readonly catalogs: readonly CurriculumCatalog[];
}

/** A personal snapshot scoped to (account, placement) — never to the tool. */
export interface PlacementStateSnapshot {
  readonly placementId: string;
  readonly experimentId: string;
  readonly placementVersion: number;
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
  /** Curriculum directory: flat entries plus the subject → catalog → book → chapter tree. */
  curriculum(locale?: string): Promise<CurriculumResponse>;
  /** `null` means this account has nothing saved for this placement. */
  placementState(placementId: string): Promise<PlacementStateSnapshot | null>;
  savePlacementState(
    placementId: string,
    input: {
      readonly placementVersion: number;
      readonly stateSchemaVersion: number;
      readonly values: Readonly<Record<string, number | string>>;
    },
  ): Promise<PlacementStateSnapshot>;
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

    async curriculum(locale) {
      const suffix = locale === undefined ? '' : `?locale=${encodeURIComponent(locale)}`;
      return request<CurriculumResponse>(`/api/curriculum${suffix}`);
    },

    async placementState(placementId) {
      try {
        return await request<PlacementStateSnapshot>(
          `/api/me/placement-state/${encodeURIComponent(placementId)}`,
        );
      } catch (error) {
        // 404 is the normal "nothing saved for this entry yet" answer, not a failure.
        if (error instanceof ApiError && error.code === 'not_found') return null;
        throw error;
      }
    },

    savePlacementState: (placementId, input) =>
      request<PlacementStateSnapshot>(
        `/api/me/placement-state/${encodeURIComponent(placementId)}`,
        { method: 'PUT', body: JSON.stringify(input) },
      ),

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
