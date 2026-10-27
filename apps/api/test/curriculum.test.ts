import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  api,
  cookieHeader,
  errorCode,
  register,
  startAuthHarness,
  type AuthHarness,
} from './support/auth-app.js';
import { writeContentDir, type ContentFixtureEntry } from './support/content.js';
import { ContentIndexError, loadContentIndex } from '../src/domain/content-index.js';

/**
 * Curriculum contexts (ADR-003).
 *
 * One tool (`math.functions`) appears in two curriculum placements. The directory is
 * protected content metadata, while a personal snapshot belongs to (account, placement) —
 * never to the tool — so a chapter can never read, overwrite or inherit another scope's
 * settings. The tool's own (account, experiment) snapshot stays exactly as R2 left it.
 */

const PLACEMENT_A = 'math.functions.pilot-linear-slope';
const PLACEMENT_B = 'math.functions.pilot-quadratic-vertex';
const TOOL = 'math.functions';

const TOOL_VALUES = { mode: 'quadratic', a: 4, b: 0, c: 0 } as const;

let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

interface CurriculumItem {
  placementId?: string;
  slug?: string;
  version?: number;
  status?: string;
  order?: number;
  experimentId?: string;
  experimentSlug?: string;
  contentVersion?: string;
  stateSchemaVersion?: number;
  title?: string;
  summary?: string;
  edition?: { id?: string; label?: string };
  book?: { id?: string; label?: string };
  chapter?: { id?: string; label?: string };
}

interface PlacementStateBody {
  placementId?: string;
  experimentId?: string;
  placementVersion?: number;
  contentVersion?: string;
  stateSchemaVersion?: number;
  values?: Record<string, string | number>;
  updatedAt?: number;
}

interface Shaped {
  status: number;
  body: {
    items?: CurriculumItem[];
    values?: Record<string, string | number>;
    error?: { code?: string };
  } & PlacementStateBody;
  text: string;
  headers: Record<string, string | string[] | number | undefined>;
  code: string | undefined;
}

async function shape(response: Awaited<ReturnType<typeof api>>): Promise<Shaped> {
  return {
    status: response.status,
    body: response.body as unknown as Shaped['body'],
    text: response.text,
    headers: response.headers,
    code: errorCode(response),
  };
}

async function signedIn(identifier = 'teacher@example.com') {
  harness = await startAuthHarness();
  const created = await register(harness.app, { identifier });
  expect(created.status).toBe(201);
  return { server: harness, cookie: cookieHeader(created.cookie()) };
}

function curriculum(server: AuthHarness, cookie: Record<string, string>, query = '') {
  return api(server.app, { method: 'GET', url: `/api/curriculum${query}`, headers: cookie }).then(
    shape,
  );
}

function getPlacement(
  server: AuthHarness,
  cookie: Record<string, string>,
  placementId = PLACEMENT_A,
) {
  return api(server.app, {
    method: 'GET',
    url: `/api/me/placement-state/${placementId}`,
    headers: cookie,
  }).then(shape);
}

function putPlacement(
  server: AuthHarness,
  cookie: Record<string, string>,
  payload: unknown,
  placementId = PLACEMENT_A,
) {
  return api(server.app, {
    method: 'PUT',
    url: `/api/me/placement-state/${placementId}`,
    headers: cookie,
    payload,
  }).then(shape);
}

function placementRows(databasePath: string): {
  placement_id: string;
  experiment_id: string;
  payload: string;
  placement_version: number;
}[] {
  const db = new DatabaseSync(databasePath);
  try {
    return db
      .prepare('SELECT placement_id, experiment_id, payload, placement_version FROM placement_saved_state')
      .all() as unknown as {
      placement_id: string;
      experiment_id: string;
      payload: string;
      placement_version: number;
    }[];
  } finally {
    db.close();
  }
}

function toolRows(databasePath: string): { payload: string }[] {
  const db = new DatabaseSync(databasePath);
  try {
    return db.prepare('SELECT payload FROM saved_state').all() as unknown as { payload: string }[];
  } finally {
    db.close();
  }
}

function eventCount(databasePath: string): number {
  const db = new DatabaseSync(databasePath);
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('curriculum directory', () => {
  it.each([
    { method: 'GET' as const, url: '/api/curriculum' },
    { method: 'GET' as const, url: '/api/me/placement-state/math.functions.pilot-linear-slope' },
    { method: 'PUT' as const, url: '/api/me/placement-state/math.functions.pilot-linear-slope' },
  ])('$method $url denies anonymous callers', async ({ method, url }) => {
    harness = await startAuthHarness();

    const response = await api(harness.app, {
      method,
      url,
      ...(method === 'PUT'
        ? {
            payload: {
              placementVersion: 1,
              stateSchemaVersion: 1,
              values: { mode: 'linear', a: 1, b: 0, c: 0 },
            },
          }
        : {}),
    });

    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe('unauthenticated');
  });

  it('lists the two pilot placements of one tool, localized and with directory metadata', async () => {
    const { server, cookie } = await signedIn();

    const listed = await curriculum(server, cookie, '?locale=en');
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');

    const items = listed.body.items ?? [];
    expect(items.map((item) => item.placementId)).toEqual([PLACEMENT_A, PLACEMENT_B]);

    // Same tool, one implementation — two directory positions.
    for (const item of items) {
      expect(item.experimentId).toBe(TOOL);
      expect(item.experimentSlug).toBe('math-functions');
      expect(item.contentVersion).toBe('1.0.0');
      expect(item.stateSchemaVersion).toBe(1);
      expect(item.status).toBe('illustrative');
      expect(item.edition?.label).toBe('Pilot edition (not a textbook)');
      expect(item.book?.label).toBe('Sample book A');
    }
    expect(items[0]?.title).toBe('Slope and intercept of a linear function');
    expect(items[1]?.title).toBe('Vertex of a quadratic function');
    expect(items[0]?.chapter?.label).toBe('Sample chapter A · slope and intercept');
    expect(items[0]?.order).toBe(1);
    expect(items[1]?.order).toBe(2);

    const zh = await curriculum(server, cookie, '?locale=zh-CN');
    expect(zh.body.items?.[0]?.title).toBe('一次函数的斜率与截距');
    expect(zh.body.items?.[0]?.chapter?.label).toBe('示例章 A · 斜率与截距');
  });

  it('does not leak filesystem paths or fixture file names', async () => {
    const { server, cookie } = await signedIn();
    const listed = await curriculum(server, cookie);

    expect(listed.text).not.toMatch(/curriculum\.json|experiments[\\/]|OEL_|[A-Za-z]:\\/);
  });

  it('rejects an unknown locale instead of guessing', async () => {
    const { server, cookie } = await signedIn();
    const listed = await curriculum(server, cookie, '?locale=fr');
    expect(listed.status).toBe(400);
    expect(listed.code).toBe('validation_failed');
  });

  it('rejects malicious or malformed placement ids before any lookup', async () => {
    const { server, cookie } = await signedIn();
    const payloads = [
      '..%2f..%2faccount',
      '%2e%2e%5caccount',
      'MATH.FUNCTIONS.PILOT-LINEAR-SLOPE',
      'math.functions.',
      '.math.functions',
      'math..functions',
      'math.functions.pilot-linear-slope%00',
      'a'.repeat(200),
      'math functions',
    ];

    for (const placementId of payloads) {
      const read = await api(server.app, {
        method: 'GET',
        url: `/api/me/placement-state/${placementId}`,
        headers: cookie,
      });
      expect([400, 404]).toContain(read.status);
      expect(read.text).not.toContain('linear-slope');
      expect(read.text).not.toContain('payload');
    }

    const write = await api(server.app, {
      method: 'PUT',
      url: '/api/me/placement-state/..%2f..%2faccount',
      headers: cookie,
      payload: { placementVersion: 1, stateSchemaVersion: 1, values: { mode: 'linear', a: 1, b: 0, c: 0 } },
    });
    expect(write.status).toBe(400);
    expect(placementRows(server.databasePath)).toHaveLength(0);
  });

  it('answers 404 for a well-formed placement that is not published', async () => {
    const { server, cookie } = await signedIn();
    const unknown = 'math.functions.not-a-chapter';

    expect((await getPlacement(server, cookie, unknown)).status).toBe(404);
    const write = await putPlacement(
      server,
      cookie,
      { placementVersion: 1, stateSchemaVersion: 1, values: { mode: 'linear', a: 1, b: 0, c: 0 } },
      unknown,
    );
    expect(write.status).toBe(404);
    expect(write.code).toBe('not_found');
    expect(placementRows(server.databasePath)).toHaveLength(0);
  });
});

describe('placement-scoped saved parameters', () => {
  it('saves one snapshot per account and placement, in canonical form', async () => {
    const { server, cookie } = await signedIn();

    const before = await getPlacement(server, cookie);
    expect(before.status).toBe(404);
    expect(before.code).toBe('not_found');

    const saved = await putPlacement(server, cookie, {
      placementVersion: 1,
      stateSchemaVersion: 1,
      values: { mode: 'linear', a: 4, b: -2, c: 0.5 },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.placementId).toBe(PLACEMENT_A);
    expect(saved.body.experimentId).toBe(TOOL);
    expect(saved.body.placementVersion).toBe(1);
    expect(saved.body.contentVersion).toBe('1.0.0');
    expect(saved.body.stateSchemaVersion).toBe(1);
    expect(saved.body.values).toEqual({ mode: 'linear', a: 4, b: -2, c: 0.5 });
    expect(saved.headers['cache-control']).toBe('no-store');

    const rows = placementRows(server.databasePath);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.placement_id).toBe(PLACEMENT_A);
    expect(rows[0]?.payload).toBe('{"a":4,"b":-2,"c":0.5,"mode":"linear"}');

    const reread = await getPlacement(server, cookie);
    expect(reread.status).toBe(200);
    expect(reread.body.values).toEqual({ mode: 'linear', a: 4, b: -2, c: 0.5 });
    expect(typeof reread.body.updatedAt).toBe('number');
  });

  it('keeps two placements of the same tool apart', async () => {
    const { server, cookie } = await signedIn();

    await putPlacement(server, cookie, {
      placementVersion: 1,
      stateSchemaVersion: 1,
      values: { mode: 'linear', a: 5, b: 1, c: 0 },
    });

    const other = await getPlacement(server, cookie, PLACEMENT_B);
    expect(other.status).toBe(404);

    await putPlacement(
      server,
      cookie,
      { placementVersion: 1, stateSchemaVersion: 1, values: { mode: 'quadratic', a: -3, b: 0, c: 1 } },
      PLACEMENT_B,
    );

    const first = await getPlacement(server, cookie, PLACEMENT_A);
    const second = await getPlacement(server, cookie, PLACEMENT_B);
    expect(first.body.values).toEqual({ mode: 'linear', a: 5, b: 1, c: 0 });
    expect(second.body.values).toEqual({ mode: 'quadratic', a: -3, b: 0, c: 1 });
    expect(placementRows(server.databasePath)).toHaveLength(2);
  });

  it('never copies between the chapter scope and the tool scope', async () => {
    const { server, cookie } = await signedIn();

    // A tool-level snapshot written through the R2 route.
    const toolSaved = await api(server.app, {
      method: 'PUT',
      url: `/api/me/saved-state/${TOOL}`,
      headers: cookie,
      payload: { stateSchemaVersion: 1, values: TOOL_VALUES },
    });
    expect(toolSaved.status).toBe(200);

    // The chapter has nothing yet: the tool snapshot is not inherited.
    const chapterBefore = await getPlacement(server, cookie);
    expect(chapterBefore.status).toBe(404);

    await putPlacement(server, cookie, {
      placementVersion: 1,
      stateSchemaVersion: 1,
      values: { mode: 'linear', a: 6, b: 2, c: 0 },
    });

    // And the tool snapshot is untouched by the chapter write.
    const toolRead = await api(server.app, {
      method: 'GET',
      url: `/api/me/saved-state/${TOOL}`,
      headers: cookie,
    });
    expect(toolRead.status).toBe(200);
    expect((toolRead.body as { values?: unknown }).values).toEqual(TOOL_VALUES);
    expect(toolRows(server.databasePath)).toHaveLength(1);
    expect(placementRows(server.databasePath)).toHaveLength(1);
  });

  it('is invisible to another account, which cannot overwrite it', async () => {
    harness = await startAuthHarness();
    const owner = await register(harness.app, { identifier: 'owner@example.com' });
    const other = await register(harness.app, { identifier: 'other@example.com' });
    expect(owner.status).toBe(201);
    expect(other.status).toBe(201);
    const ownerCookie = cookieHeader(owner.cookie());
    const otherCookie = cookieHeader(other.cookie());

    await putPlacement(harness, ownerCookie, {
      placementVersion: 1,
      stateSchemaVersion: 1,
      values: { mode: 'linear', a: 7, b: 0, c: 0 },
    });

    const otherRead = await getPlacement(harness, otherCookie);
    expect(otherRead.status).toBe(404);
    expect(otherRead.text).not.toContain('linear');

    const otherWrite = await putPlacement(harness, otherCookie, {
      placementVersion: 1,
      stateSchemaVersion: 1,
      values: { mode: 'linear', a: -7, b: 0, c: 0 },
    });
    expect(otherWrite.status).toBe(200);

    const ownerRead = await getPlacement(harness, ownerCookie);
    expect(ownerRead.body.values).toEqual({ mode: 'linear', a: 7, b: 0, c: 0 });
    expect(placementRows(harness.databasePath)).toHaveLength(2);
  });

  it('refuses a stale placement version and a stale state-schema version', async () => {
    const { server, cookie } = await signedIn();
    const values = { mode: 'linear', a: 1, b: 0, c: 0 };

    const stalePlacement = await putPlacement(server, cookie, {
      placementVersion: 2,
      stateSchemaVersion: 1,
      values,
    });
    expect(stalePlacement.status).toBe(409);
    expect(stalePlacement.code).toBe('state_schema_incompatible');

    const staleSchema = await putPlacement(server, cookie, {
      placementVersion: 1,
      stateSchemaVersion: 2,
      values,
    });
    expect(staleSchema.status).toBe(409);
    expect(staleSchema.code).toBe('state_schema_incompatible');

    // A string version is a client bug, not something to coerce (AJV would do that).
    const stringy = await putPlacement(server, cookie, {
      placementVersion: '1',
      stateSchemaVersion: 1,
      values,
    });
    expect(stringy.status).toBe(400);

    expect(placementRows(server.databasePath)).toHaveLength(0);
  });

  it('rejects values the tool schema does not allow', async () => {
    const { server, cookie } = await signedIn();
    const cases = [
      { values: { mode: 'linear', a: 1, b: 0 }, reason: 'missing_key' },
      { values: { mode: 'linear', a: 1, b: 0, c: 0, d: 1 }, reason: 'unknown_key' },
      { values: { mode: 'cubic', a: 1, b: 0, c: 0 }, reason: 'invalid_enum' },
      { values: { mode: 'linear', a: 99, b: 0, c: 0 }, reason: 'out_of_range' },
      { values: { mode: 'linear', a: 0.05, b: 0, c: 0 }, reason: 'off_step' },
      { values: { mode: 'linear', a: '2', b: 0, c: 0 }, reason: 'invalid_number' },
    ];

    for (const testCase of cases) {
      const response = await putPlacement(server, cookie, {
        placementVersion: 1,
        stateSchemaVersion: 1,
        values: testCase.values,
      });
      expect(response.status, testCase.reason).toBe(400);
      expect(response.code).toBe('state_invalid');
    }
    expect(placementRows(server.databasePath)).toHaveLength(0);
  });

  it('never writes parameter values into the diagnostics table', async () => {
    const { server, cookie } = await signedIn();
    const before = eventCount(server.databasePath);

    await putPlacement(server, cookie, {
      placementVersion: 1,
      stateSchemaVersion: 1,
      values: { mode: 'linear', a: 3, b: 0, c: 0 },
    });
    await getPlacement(server, cookie);

    expect(eventCount(server.databasePath)).toBe(before);
  });
});

describe('curriculum content validation', () => {
  const stateSchema = {
    schemaVersion: 1,
    fields: {
      mode: { kind: 'enum', values: ['linear', 'quadratic'], default: 'quadratic' },
      a: { kind: 'number', min: -10, max: 10, step: 0.1, default: 1 },
      b: { kind: 'number', min: -10, max: 10, step: 0.1, default: 0 },
      c: { kind: 'number', min: -10, max: 10, step: 0.1, default: 0 },
    },
  };

  const placement = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    placementId: 'math.functions.chapter-one',
    slug: 'chapter-one',
    version: 1,
    status: 'illustrative',
    order: 1,
    edition: { id: 'pilot-edition', labels: { 'zh-CN': '试点版', en: 'Pilot edition' } },
    book: { id: 'book-a', labels: { 'zh-CN': '示例册', en: 'Sample book' } },
    chapter: { id: 'chapter-a', labels: { 'zh-CN': '示例章', en: 'Sample chapter' } },
    title: { 'zh-CN': '示例标题', en: 'Sample title' },
    summary: { 'zh-CN': '示例说明', en: 'Sample summary' },
    preset: { mode: 'linear', a: 2, b: 3, c: 0 },
    ...overrides,
  });

  async function loadWith(
    entries: readonly ContentFixtureEntry[],
  ): Promise<{ ok: true; index: ReturnType<typeof loadContentIndex> } | { ok: false; error: ContentIndexError }> {
    const root = await mkdtemp(path.join(tmpdir(), 'oel-curriculum-'));
    try {
      const contentDir = await writeContentDir(root, entries);
      try {
        return { ok: true, index: loadContentIndex(contentDir) };
      } catch (error) {
        return { ok: false, error: error as ContentIndexError };
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const base: ContentFixtureEntry = {
    id: 'math.functions',
    slug: 'math-functions',
    titleEn: 'Functions',
    titleZh: '函数',
    stateSchema,
  };

  it('indexes a valid placement with its canonical preset', async () => {
    const result = await loadWith([
      { ...base, curriculum: { schemaVersion: 1, placements: [placement()] } },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const placements = result.index.placements;
    expect(placements).toHaveLength(1);
    expect(placements[0]?.placementId).toBe('math.functions.chapter-one');
    expect(placements[0]?.experimentId).toBe('math.functions');
    expect(placements[0]?.preset).toEqual({ a: 2, b: 3, c: 0, mode: 'linear' });
    expect(result.index.findPlacement('math.functions.chapter-one')?.placement.slug).toBe('chapter-one');
  });

  it('refuses a preset that the tool schema rejects', async () => {
    const result = await loadWith([
      {
        ...base,
        curriculum: {
          schemaVersion: 1,
          placements: [placement({ preset: { mode: 'cubic', a: 1, b: 0, c: 0 } })],
        },
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.join('\n')).toMatch(/preset/i);
  });

  it('refuses a placement for a tool without a state schema', async () => {
    const result = await loadWith([
      {
        ...base,
        stateSchema: undefined,
        curriculum: { schemaVersion: 1, placements: [placement()] },
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.join('\n')).toMatch(/state-schema\.json/);
  });

  it.each([
    { label: 'unknown schema version', curriculum: { schemaVersion: 2, placements: [] } },
    { label: 'unknown status', curriculum: { schemaVersion: 1, placements: [placement({ status: 'official' })] } },
    { label: 'bad placement id', curriculum: { schemaVersion: 1, placements: [placement({ placementId: 'Chapter One' })] } },
    { label: 'empty chapter label', curriculum: { schemaVersion: 1, placements: [placement({ chapter: { id: 'c', labels: { 'zh-CN': '', en: 'x' } } })] } },
    { label: 'missing summary locale', curriculum: { schemaVersion: 1, placements: [placement({ summary: { en: 'only english' } })] } },
    { label: 'non-integer order', curriculum: { schemaVersion: 1, placements: [placement({ order: 1.5 })] } },
    { label: 'extra top-level key', curriculum: { schemaVersion: 1, placements: [], textbook: 'x' } },
  ])('refuses $label', async ({ curriculum }) => {
    const result = await loadWith([{ ...base, curriculum }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.length).toBeGreaterThan(0);
  });

  it('refuses duplicate placement slugs across experiments (URLs must be unique)', async () => {
    const result = await loadWith([
      { ...base, curriculum: { schemaVersion: 1, placements: [placement()] } },
      {
        id: 'physics.freefall',
        slug: 'physics-freefall',
        titleEn: 'Free fall',
        titleZh: '自由落体',
        stateSchema,
        curriculum: {
          schemaVersion: 1,
          placements: [placement({ placementId: 'physics.freefall.chapter-one' })],
        },
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.join('\n')).toMatch(/duplicate.*slug/i);
  });
});
