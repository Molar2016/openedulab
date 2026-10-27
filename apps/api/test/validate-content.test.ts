import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  writeContentDir,
  writeCurriculaDir,
  type ContentFixtureEntry,
  type CurriculumCatalogFile,
} from './support/content.js';

/**
 * Offline content validation (`npm run validate:content`) must reject the same catalog
 * mistakes the server refuses at startup (ADR-005): a duplicated order, a dangling
 * (catalogId, bookId, chapterId) reference, or a catalog file whose subject is not the
 * directory it lives in. Otherwise a contributor would only find out at deploy time — or,
 * worse, CI would pass and the running site would keep serving yesterday's directory.
 *
 * `OEL_VALIDATE_ROOT` points the script at a throwaway repository fixture so the check can
 * be exercised without touching the real content.
 */

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../../scripts/validate-content.mjs', import.meta.url));

const STATE_SCHEMA = {
  schemaVersion: 1,
  fields: {
    mode: { kind: 'enum', values: ['linear', 'quadratic'], default: 'quadratic' },
    a: { kind: 'number', min: -10, max: 10, step: 0.1, default: 1 },
    b: { kind: 'number', min: -10, max: 10, step: 0.1, default: 0 },
    c: { kind: 'number', min: -10, max: 10, step: 0.1, default: 0 },
  },
} as const;

const roots: string[] = [];

afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  readonly contentDir: string;
}

async function writeRepoFixture(
  entries: readonly ContentFixtureEntry[],
  catalogs: readonly CurriculumCatalogFile[],
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'oel-validate-'));
  roots.push(root);

  await mkdir(path.join(root, 'apps/web/src/experiment'), { recursive: true });
  await writeFile(
    path.join(root, 'apps/web/src/experiment/contract.ts'),
    "export const SDK_VERSION = '1.0.0';\n",
    'utf8',
  );
  await mkdir(path.join(root, 'apps/web/src/i18n/locales'), { recursive: true });
  for (const locale of ['en', 'zh-CN']) {
    await writeFile(
      path.join(root, 'apps/web/src/i18n/locales', `${locale}.json`),
      `${JSON.stringify({ 'catalog.title': '目录' }, null, 2)}\n`,
      'utf8',
    );
  }

  const contentDir = await writeContentDir(root, entries);
  // The validator also insists an experiment ships its view/model entry points.
  for (const entry of entries) {
    for (const file of ['view.tsx', 'model.ts']) {
      await writeFile(path.join(contentDir, entry.slug, file), 'export {};\n', 'utf8');
    }
  }
  if (catalogs.length > 0) await writeCurriculaDir(root, catalogs);
  return { root, contentDir };
}

async function validate(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT], {
      env: { ...process.env, OEL_VALIDATE_ROOT: root },
      cwd: root,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

const tool: ContentFixtureEntry = {
  id: 'math.functions',
  slug: 'math-functions',
  titleEn: 'Functions',
  titleZh: '函数',
  stateSchema: STATE_SCHEMA as unknown as Record<string, unknown>,
  curriculum: {
    schemaVersion: 3,
    placements: [
      {
        placementId: 'math.functions.chapter-one',
        slug: 'chapter-one',
        version: 1,
        status: 'illustrative',
        catalogId: 'pilot-edition',
        bookId: 'book-a',
        chapterId: 'chapter-a',
        order: 1,
        title: { 'zh-CN': '示例标题', en: 'Sample title' },
        summary: { 'zh-CN': '示例说明', en: 'Sample summary' },
        preset: { mode: 'linear', a: 2, b: 3, c: 0 },
      },
    ],
  },
};

function catalog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    catalogId: 'pilot-edition',
    subject: 'math',
    version: 1,
    status: 'illustrative',
    order: 1,
    label: { 'zh-CN': '示例教材', en: 'Sample textbook' },
    books: [
      {
        bookId: 'book-a',
        order: 1,
        label: { 'zh-CN': '示例册', en: 'Sample book' },
        chapters: [
          { chapterId: 'chapter-a', order: 1, label: { 'zh-CN': '示例章', en: 'Sample chapter' } },
        ],
      },
    ],
    ...overrides,
  };
}

describe('offline content validation of shared catalogs', () => {
  it('accepts a catalog file plus a placement that references it', async () => {
    const fixture = await writeRepoFixture([tool], [
      { subject: 'math', file: 'sample-edition', catalogs: [catalog()] },
    ]);

    const result = await validate(fixture.root);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Content validation OK/);
    expect(result.stdout).toMatch(/curriculum catalogs: 1 \(curricula\/math\/sample-edition\.json/);
    expect(result.stdout).toMatch(/curriculum placements: math\.functions: 1/);
  });

  it('rejects two catalog files in one subject that claim the same order', async () => {
    const fixture = await writeRepoFixture([tool], [
      { subject: 'math', file: 'first', catalogs: [catalog({ catalogId: 'first', order: 1 })] },
      {
        subject: 'math',
        file: 'second',
        catalogs: [
          catalog({
            catalogId: 'second',
            order: 1,
            books: [
              {
                bookId: 'book-b',
                order: 1,
                label: { 'zh-CN': '示例册', en: 'Sample book' },
                chapters: [
                  {
                    chapterId: 'chapter-b',
                    order: 1,
                    label: { 'zh-CN': '示例章', en: 'Sample chapter' },
                  },
                ],
              },
            ],
          }),
        ],
      },
    ]);

    const result = await validate(fixture.root);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/catalog order 1 is already used by "first"/);
  });

  it('rejects a placement that references a chapter nobody declares', async () => {
    const fixture = await writeRepoFixture(
      [
        {
          ...tool,
          rawCurriculum: true,
          curriculum: {
            schemaVersion: 3,
            placements: [
              {
                ...(tool.curriculum?.placements as Record<string, unknown>[])[0],
                chapterId: 'chapter-missing',
              },
            ],
          },
        },
      ],
      [{ subject: 'math', file: 'sample-edition', catalogs: [catalog()] }],
    );

    const result = await validate(fixture.root);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/unknown chapter "chapter-missing"/);
  });

  it('rejects two tools that claim the same position in one chapter', async () => {
    const second: ContentFixtureEntry = {
      id: 'math.geometry',
      slug: 'math-geometry',
      titleEn: 'Geometry',
      titleZh: '几何',
      stateSchema: STATE_SCHEMA as unknown as Record<string, unknown>,
      curriculum: {
        schemaVersion: 3,
        placements: [
          {
            ...(tool.curriculum?.placements as Record<string, unknown>[])[0],
            placementId: 'math.geometry.chapter-one',
            slug: 'geometry-chapter-one',
          },
        ],
      },
    };

    const fixture = await writeRepoFixture([tool, second], [
      { subject: 'math', file: 'sample-edition', catalogs: [catalog()] },
    ]);

    const result = await validate(fixture.root);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/tool order 1 is already used by "math.functions.chapter-one"/);
  });

  it('rejects a catalog file whose subject disagrees with its directory', async () => {
    const fixture = await writeRepoFixture([tool], [
      {
        subject: 'math',
        file: 'mislabelled',
        declaredSubject: 'physics',
        catalogs: [catalog({ subject: 'physics' })],
      },
    ]);

    const result = await validate(fixture.root);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/subject "physics".*directory/i);
  });
});

// Sections (ADR-006): the offline validator must reach the same verdict as the server, or CI
// would pass a directory the running process refuses to serve.
const section = (sectionId: string, order: number, extra: Record<string, unknown> = {}) => ({
  sectionId,
  order,
  label: { 'zh-CN': `示例节 ${sectionId}`, en: `Sample section ${sectionId}` },
  ...extra,
});

const sectionedChapter = (
  chapterId: string,
  order: number,
  sections: readonly Record<string, unknown>[],
) => ({
  chapterId,
  order,
  label: { 'zh-CN': `示例章 ${chapterId}`, en: `Sample chapter ${chapterId}` },
  sections: [...sections],
});

const sectionedCatalog = (overrides: Record<string, unknown> = {}) =>
  catalog({
    books: [
      {
        bookId: 'book-a',
        order: 1,
        label: { 'zh-CN': '示例册', en: 'Sample book' },
        chapters: [
          sectionedChapter('chapter-a', 1, [
            section('chapter-a-s1', 1, { printedPage: 114 }),
            section('chapter-a-s2', 2, { printedPage: 117 }),
          ]),
          sectionedChapter('chapter-b', 2, [section('chapter-b-s1', 1)]),
        ],
      },
    ],
    ...overrides,
  });

function sectionedTool(placementOverrides: Record<string, unknown>): ContentFixtureEntry {
  return {
    ...tool,
    rawCurriculum: true,
    curriculum: {
      schemaVersion: 3,
      placements: [
        {
          ...(tool.curriculum?.placements as Record<string, unknown>[])[0],
          ...placementOverrides,
        },
      ],
    },
  };
}

describe('offline content validation of chapter sections', () => {
  it('accepts a section tree and a placement that targets one of its sections', async () => {
    const fixture = await writeRepoFixture(
      [sectionedTool({ sectionId: 'chapter-a-s2' })],
      [{ subject: 'math', file: 'sectioned', catalogs: [sectionedCatalog()] }],
    );

    const result = await validate(fixture.root);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Content validation OK/);
    expect(result.stdout).toMatch(/curriculum tree: 2 chapters, 3 sections/);
  });

  it('rejects a placement that targets a section of another chapter', async () => {
    const fixture = await writeRepoFixture(
      [sectionedTool({ sectionId: 'chapter-b-s1' })],
      [{ subject: 'math', file: 'sectioned', catalogs: [sectionedCatalog()] }],
    );

    const result = await validate(fixture.root);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/unknown section "chapter-b-s1" in chapter "chapter-a"/);
  });

  it('rejects a duplicated section order inside one chapter', async () => {
    const fixture = await writeRepoFixture(
      [sectionedTool({})],
      [
        {
          subject: 'math',
          file: 'sectioned',
          catalogs: [
            sectionedCatalog({
              books: [
                {
                  bookId: 'book-a',
                  order: 1,
                  label: { 'zh-CN': '示例册', en: 'Sample book' },
                  chapters: [
                    sectionedChapter('chapter-a', 1, [
                      section('chapter-a-s1', 1),
                      section('chapter-a-s2', 1),
                    ]),
                  ],
                },
              ],
            }),
          ],
        },
      ],
    );

    const result = await validate(fixture.root);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/section order 1 is already used by "chapter-a-s1"/);
  });

  it('rejects an edition status it cannot label', async () => {
    const fixture = await writeRepoFixture(
      [sectionedTool({})],
      [
        {
          subject: 'math',
          file: 'sectioned',
          catalogs: [sectionedCatalog({ editionStatus: 'new-2027' })],
        },
      ],
    );

    const result = await validate(fixture.root);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /editionStatus "new-2027" must be one of "current-2022", "legacy-2011"/,
    );
  });
});
