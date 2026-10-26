import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { api, cookieHeader, register, startAuthHarness, type AuthHarness } from './support/auth-app.js';
import { CATALOG_FIXTURE, writeContentDir, type ContentFixtureEntry } from './support/content.js';

/**
 * `GET /api/catalog` (design §7.2, R-07): server-side content index, session-gated,
 * filterable, and never a filesystem pass-through.
 */

interface CatalogItem {
  id: string;
  slug: string;
  title: string;
  description: string;
  subjects: string[];
  grades: string[];
  concepts: string[];
  contentVersion: string;
  languages: string[];
}

interface CatalogBody {
  items: CatalogItem[];
}

let harness: AuthHarness | null = null;
let contentRoot: string | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
  if (contentRoot !== null) {
    await rm(contentRoot, { recursive: true, force: true });
    contentRoot = null;
  }
});

async function startWith(
  entries: readonly ContentFixtureEntry[] = CATALOG_FIXTURE,
): Promise<{ server: AuthHarness; cookie: Record<string, string> }> {
  contentRoot = await mkdtemp(path.join(tmpdir(), 'oel-content-'));
  const contentDir = await writeContentDir(contentRoot, entries);
  harness = await startAuthHarness({ OEL_CONTENT_DIR: contentDir });
  const server = harness;
  const created = await register(server.app, { identifier: 'teacher@example.com' });
  expect(created.status).toBe(201);
  return { server, cookie: cookieHeader(created.cookie()) };
}

async function catalog(
  server: AuthHarness,
  cookie: Record<string, string>,
  query = '',
): Promise<{ status: number; body: CatalogBody; text: string; headers: Record<string, unknown> }> {
  const response = await api(server.app, {
    method: 'GET',
    url: `/api/catalog${query}`,
    headers: cookie,
  });
  return {
    status: response.status,
    body: response.body as unknown as CatalogBody,
    text: response.text,
    headers: response.headers,
  };
}

describe('catalog content', () => {
  it('lists every indexed experiment sorted by id', async () => {
    const { server, cookie } = await startWith();

    const result = await catalog(server, cookie);

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.items.map((item) => item.id)).toEqual([
      'math.functions',
      'math.geometry',
      'physics.freefall',
    ]);
  });

  it('returns localized title and description, plus the content version', async () => {
    const { server, cookie } = await startWith();

    const english = await catalog(server, cookie, '?locale=en');
    const chinese = await catalog(server, cookie, '?locale=zh-CN');

    const en = english.body.items.find((item) => item.id === 'math.functions');
    const zh = chinese.body.items.find((item) => item.id === 'math.functions');
    expect(en?.title).toBe('Linear and quadratic functions');
    expect(zh?.title).toBe('一次函数与二次函数');
    expect(en?.contentVersion).toBe('1.0.0');
    expect(en?.languages).toEqual(['zh-CN', 'en']);
  });

  it('defaults to Chinese when no locale is requested', async () => {
    const { server, cookie } = await startWith();

    const result = await catalog(server, cookie);

    expect(result.body.items[0]?.title).toBe('一次函数与二次函数');
  });

  it('exposes exactly the catalog fields and no internal detail', async () => {
    const { server, cookie } = await startWith();

    const result = await catalog(server, cookie, '?locale=en');

    for (const item of result.body.items) {
      expect(Object.keys(item).sort()).toEqual([
        'concepts',
        'contentVersion',
        'description',
        'grades',
        'id',
        'languages',
        'slug',
        'subjects',
        'title',
      ]);
    }
    expect(result.text).not.toMatch(/manifest\.json/);
    expect(result.text).not.toContain('manifest.json');
  });
});

describe('catalog filtering and search', () => {
  it('filters by subject, grade and concept', async () => {
    const { server, cookie } = await startWith();

    expect((await catalog(server, cookie, '?subject=math')).body.items).toHaveLength(2);
    expect((await catalog(server, cookie, '?subject=physics')).body.items.map((item) => item.id)).toEqual([
      'physics.freefall',
    ]);
    expect((await catalog(server, cookie, '?grade=high')).body.items.map((item) => item.id)).toEqual([
      'math.functions',
      'physics.freefall',
    ]);
    expect((await catalog(server, cookie, '?concept=circle')).body.items.map((item) => item.id)).toEqual([
      'math.geometry',
    ]);
    expect(
      (await catalog(server, cookie, '?subject=math&grade=middle&concept=circle')).body.items.map(
        (item) => item.id,
      ),
    ).toEqual(['math.geometry']);
  });

  it('searches title, description, slug, id and concepts, case-insensitively', async () => {
    const { server, cookie } = await startWith();

    expect((await catalog(server, cookie, '?q=FREEFALL')).body.items.map((item) => item.id)).toEqual([
      'physics.freefall',
    ]);
    expect((await catalog(server, cookie, '?q=math.geometry')).body.items.map((item) => item.id)).toEqual([
      'math.geometry',
    ]);
    expect(
      (await catalog(server, cookie, '?q=quadratic&locale=en')).body.items.map((item) => item.id),
    ).toEqual(['math.functions']);
    // Several tokens must all match (AND), not any (OR).
    expect((await catalog(server, cookie, '?q=circle%20chord&locale=en')).body.items).toHaveLength(1);
    expect((await catalog(server, cookie, '?q=circle%20freefall')).body.items).toHaveLength(0);
  });

  it('caps the result set with limit', async () => {
    const { server, cookie } = await startWith();

    expect((await catalog(server, cookie, '?limit=2')).body.items).toHaveLength(2);
  });
});

describe('catalog rejects malformed input', () => {
  it.each([
    '?limit=0',
    '?limit=51',
    '?limit=abc',
    '?locale=fr',
    '?subject=math&unknown=1',
    `?q=${'a'.repeat(101)}`,
  ])('answers 400 for %s', async (query) => {
    const { server, cookie } = await startWith();

    const result = await catalog(server, cookie, query);

    expect(result.status).toBe(400);
    expect(JSON.parse(result.text)).toMatchObject({
      error: { code: 'validation_failed' },
    });
  });

  it('requires a session before any query is evaluated', async () => {
    const { server } = await startWith();

    const response = await api(server.app, {
      method: 'GET',
      url: '/api/catalog?limit=0',
    });

    expect(response.status).toBe(401);
  });
});

describe('content index fails closed', () => {
  it('refuses to start when two manifests share an id', async () => {
    contentRoot = await mkdtemp(path.join(tmpdir(), 'oel-content-bad-'));
    const contentDir = await writeContentDir(contentRoot, [
      { id: 'math.functions', slug: 'first', titleEn: 'A', titleZh: '甲' },
      { id: 'math.functions', slug: 'second', titleEn: 'B', titleZh: '乙' },
    ]);

    await expect(startAuthHarness({ OEL_CONTENT_DIR: contentDir })).rejects.toThrow(/duplicate id/i);
  });

  it('refuses to start when a manifest has no locale dictionary', async () => {
    contentRoot = await mkdtemp(path.join(tmpdir(), 'oel-content-bad-'));
    const contentDir = await writeContentDir(contentRoot, [
      { id: 'math.functions', slug: 'math-functions', titleEn: 'A', titleZh: '甲', omitLocales: true },
    ]);

    await expect(startAuthHarness({ OEL_CONTENT_DIR: contentDir })).rejects.toThrow(
      /locale|title/i,
    );
  });

  it('refuses to start when the content directory does not exist', async () => {
    await expect(
      startAuthHarness({ OEL_CONTENT_DIR: path.join(tmpdir(), 'oel-no-such-content-dir') }),
    ).rejects.toThrow(/OEL_CONTENT_DIR/);
  });
});
