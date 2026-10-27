import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { CurriculumPage } from '../apps/web/src/app/CurriculumPage';
import { createI18n } from '../apps/web/src/i18n';
import type {
  ApiClient,
  CurriculumCatalog,
  CurriculumItem,
  CurriculumResponse,
} from '../apps/web/src/services/api';

/**
 * Curriculum directory (ADR-004).
 *
 * The page is a real navigation surface, not a hidden URL: 学科 → 教材 → 册 → 章 → 工具入口.
 * The same tool appears in two illustrative catalogs whose book/chapter order differs, and
 * the page must show each catalog's own order while stating plainly that neither is a
 * verified textbook.
 */

const i18n = createI18n('en');

function item(
  placementId: string,
  slug: string,
  catalogId: string,
  bookId: string,
  chapterId: string,
  title: string,
  chapterLabel: string,
  bookLabel: string,
): CurriculumItem {
  return {
    placementId,
    slug,
    version: 1,
    status: 'illustrative',
    order: 1,
    experimentId: 'math.functions',
    experimentSlug: 'math-functions',
    contentVersion: '1.0.0',
    stateSchemaVersion: 1,
    subject: 'math',
    catalogId,
    bookId,
    chapterId,
    title,
    summary: `${title} summary`,
    edition: { id: catalogId, label: `Catalog ${catalogId}` },
    book: { id: bookId, label: bookLabel },
    chapter: { id: chapterId, label: chapterLabel },
    preset: { mode: 'linear', a: 2, b: 3, c: 0 },
  };
}

const ITEMS: readonly CurriculumItem[] = [
  item(
    'math.functions.pilot-linear-slope',
    'pilot-linear-slope',
    'pilot-edition',
    'pilot-book-a',
    'pilot-chapter-a',
    'Slope and intercept of a linear function',
    'Sample chapter A · slope and intercept',
    'Sample book A',
  ),
  item(
    'math.functions.pilot-quadratic-vertex',
    'pilot-quadratic-vertex',
    'pilot-edition',
    'pilot-book-a',
    'pilot-chapter-b',
    'Vertex of a quadratic function',
    'Sample chapter B · vertex',
    'Sample book A',
  ),
  item(
    'math.functions.pilot-vertex-first',
    'pilot-vertex-first',
    'pilot-edition-b',
    'pilot-book-b1',
    'pilot-chapter-b1-vertex',
    'Vertex of a quadratic function',
    'Sample chapter B1-1 · vertex',
    'Sample book B1',
  ),
  item(
    'math.functions.pilot-slope-after',
    'pilot-slope-after',
    'pilot-edition-b',
    'pilot-book-b2',
    'pilot-chapter-b2-slope',
    'Slope and intercept of a linear function',
    'Sample chapter B2-1 · slope and intercept',
    'Sample book B2',
  ),
];

const CATALOGS: readonly CurriculumCatalog[] = [
  {
    catalogId: 'pilot-edition',
    subject: 'math',
    version: 1,
    status: 'illustrative',
    order: 1,
    label: 'Sample textbook A (not a textbook)',
    books: [
      {
        bookId: 'pilot-book-a',
        order: 1,
        label: 'Sample book A',
        chapters: [
          {
            chapterId: 'pilot-chapter-a',
            order: 1,
            label: 'Sample chapter A · slope and intercept',
            placementIds: ['math.functions.pilot-linear-slope'],
          },
          {
            chapterId: 'pilot-chapter-b',
            order: 2,
            label: 'Sample chapter B · vertex',
            placementIds: ['math.functions.pilot-quadratic-vertex'],
          },
        ],
      },
    ],
  },
  {
    catalogId: 'pilot-edition-b',
    subject: 'math',
    version: 1,
    status: 'illustrative',
    order: 2,
    label: 'Sample textbook B (not a textbook)',
    books: [
      {
        bookId: 'pilot-book-b1',
        order: 1,
        label: 'Sample book B1',
        chapters: [
          {
            chapterId: 'pilot-chapter-b1-vertex',
            order: 1,
            label: 'Sample chapter B1-1 · vertex',
            placementIds: ['math.functions.pilot-vertex-first'],
          },
        ],
      },
      {
        bookId: 'pilot-book-b2',
        order: 2,
        label: 'Sample book B2',
        chapters: [
          {
            chapterId: 'pilot-chapter-b2-slope',
            order: 1,
            label: 'Sample chapter B2-1 · slope and intercept',
            placementIds: ['math.functions.pilot-slope-after'],
          },
        ],
      },
    ],
  },
];

const RESPONSE: CurriculumResponse = { items: ITEMS, catalogs: CATALOGS };

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    curriculum: vi.fn(async () => RESPONSE),
    ...overrides,
  } as unknown as ApiClient;
}

function renderPage(api: ApiClient = fakeApi(), navigate = (): void => undefined): void {
  render(<CurriculumPage api={api} locale="en" i18n={i18n} navigate={navigate} />);
}

describe('curriculum directory', () => {
  it('titles the page by subject and shows both illustrative catalogs in catalog order', async () => {
    renderPage();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Mathematics course' }),
    ).toBeInTheDocument();
    const sections = await screen.findAllByTestId(
      /^curriculum-catalog-(pilot-edition|pilot-edition-b)$/,
    );
    expect(sections.map((section) => section.getAttribute('data-testid'))).toEqual([
      'curriculum-catalog-pilot-edition',
      'curriculum-catalog-pilot-edition-b',
    ]);
    expect(sections[0]).toHaveTextContent('Sample textbook A (not a textbook)');
    expect(sections[1]).toHaveTextContent('Sample textbook B (not a textbook)');
  });

  it('marks every catalog and entry as a pilot example, never as a textbook chapter', async () => {
    renderPage();
    await screen.findByTestId('curriculum-list');

    for (const catalogId of ['pilot-edition', 'pilot-edition-b']) {
      expect(screen.getByTestId(`curriculum-catalog-status-${catalogId}`)).toHaveTextContent(
        /not a textbook chapter/i,
      );
    }
    const badges = screen.getAllByTestId(/^curriculum-status-/);
    expect(badges).toHaveLength(4);
    for (const badge of badges) {
      expect(badge).toHaveTextContent(/not a textbook chapter/i);
    }
  });

  it('renders the catalog → book → chapter path in the order the catalog declares', async () => {
    renderPage();
    await screen.findByTestId('curriculum-list');

    const catalogA = screen.getByTestId('curriculum-catalog-pilot-edition');
    const chaptersA = within(catalogA).getAllByTestId(/^curriculum-chapter-/);
    expect(chaptersA.map((node) => node.textContent)).toEqual([
      expect.stringContaining('Sample chapter A · slope and intercept'),
      expect.stringContaining('Sample chapter B · vertex'),
    ]);

    const catalogB = screen.getByTestId('curriculum-catalog-pilot-edition-b');
    const booksB = within(catalogB).getAllByTestId(/^curriculum-book-/);
    expect(booksB.map((node) => node.getAttribute('data-testid'))).toEqual([
      'curriculum-book-pilot-book-b1',
      'curriculum-book-pilot-book-b2',
    ]);
    // Catalog B teaches the vertex first and slope second; catalog A does the opposite.
    const entriesB = within(catalogB).getAllByTestId(/^curriculum-entry-/);
    expect(entriesB.map((node) => node.getAttribute('data-testid'))).toEqual([
      'curriculum-entry-pilot-vertex-first',
      'curriculum-entry-pilot-slope-after',
    ]);
    const entriesA = within(catalogA).getAllByTestId(/^curriculum-entry-/);
    expect(entriesA.map((node) => node.getAttribute('data-testid'))).toEqual([
      'curriculum-entry-pilot-linear-slope',
      'curriculum-entry-pilot-quadratic-vertex',
    ]);
  });

  it('links each entry to its own context page', async () => {
    renderPage();

    const links = await screen.findAllByRole('link', {
      name: /Slope and intercept of a linear function/i,
    });
    // The same title exists in both catalogs, and each entry links to its own URL.
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/curriculum/pilot-linear-slope?lang=en',
      '/curriculum/pilot-slope-after?lang=en',
    ]);
  });

  it('navigates in-app without a full page load', async () => {
    const navigate = vi.fn();
    renderPage(fakeApi(), navigate);

    const entry = await screen.findByTestId('curriculum-entry-pilot-vertex-first');
    fireEvent.click(
      within(entry).getAllByRole('link', { name: /Vertex of a quadratic function/i })[0] as HTMLElement,
    );

    expect(navigate).toHaveBeenCalledWith('/curriculum/pilot-vertex-first?lang=en');
  });

  it('shows a retry instead of an empty list when the directory cannot be loaded', async () => {
    const api = fakeApi({
      curriculum: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    renderPage(api);

    expect(await screen.findByTestId('curriculum-error')).toBeInTheDocument();
    expect(screen.queryByTestId('curriculum-list')).toBeNull();
  });

  it('says so when the server publishes no catalog instead of inventing one', async () => {
    const api = fakeApi({ curriculum: vi.fn(async () => ({ items: [], catalogs: [] })) });
    renderPage(api);

    expect(await screen.findByTestId('curriculum-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('curriculum-list')).toBeNull();
  });
});

/**
 * Sections and peer textbook editions (ADR-006, R9 approved scope reset).
 *
 * A chapter now shows its printed sections, including the ones no tool sits in. The two PEP
 * catalogs are peer editions of the same subject: each is its own textbook entry with its own
 * edition line (publisher + revision), and neither is singled out as the "old" or "new" one by
 * a badge, a warning colour or a separate zone.
 */
const PEP_CURRENT: CurriculumCatalog = {
  catalogId: 'pep-math-2022',
  subject: 'math',
  version: 1,
  status: 'verified',
  order: 1,
  editionStatus: 'current-2022',
  label: 'PEP middle-school mathematics (2022 curriculum revision)',
  publisher: "People's Education Press",
  revision: '2022 curriculum revision',
  books: [
    {
      bookId: 'pep-math-8b-2026',
      order: 1,
      label: 'Grade 8, volume 2',
      chapters: [
        {
          chapterId: 'pep-math-8b-2026-ch23',
          order: 23,
          label: 'Chapter 23 Linear functions',
          printedPage: 113,
          placementIds: ['math.functions.pep-8b-ch23-s2-linear-graph'],
          sections: [
            {
              sectionId: 'pep-math-8b-2026-ch23-s1',
              order: 1,
              label: '23.1 The concept of a linear function',
              printedPage: 114,
              placementIds: [],
            },
            {
              sectionId: 'pep-math-8b-2026-ch23-s2',
              order: 2,
              label: '23.2 Graphs and properties of linear functions',
              printedPage: 117,
              placementIds: ['math.functions.pep-8b-ch23-s2-linear-graph'],
            },
          ],
        },
      ],
    },
  ],
};

const PEP_LEGACY: CurriculumCatalog = {
  catalogId: 'pep-math-9b-legacy',
  subject: 'math',
  version: 1,
  status: 'verified',
  order: 2,
  editionStatus: 'legacy-2011',
  label: 'PEP middle-school mathematics, grade 9 volume 2 (2011 curriculum edition)',
  publisher: "People's Education Press",
  revision: '2011 curriculum edition',
  books: [
    {
      bookId: 'pep-math-9b-legacy',
      order: 1,
      label: 'Grade 9, volume 2',
      chapters: [
        {
          chapterId: 'pep-math-9b-legacy-ch26',
          order: 26,
          label: 'Chapter 26 Inverse proportional functions',
          printedPage: 1,
          placementIds: [],
          sections: [
            {
              sectionId: 'pep-math-9b-legacy-ch26-s1',
              order: 1,
              label: '26.1 Inverse proportional functions',
              printedPage: 2,
              placementIds: [],
            },
          ],
        },
      ],
    },
  ],
};

const LINEAR_ITEM: CurriculumItem = {
  ...item(
    'math.functions.pep-8b-ch23-s2-linear-graph',
    'pep-8b-23-2-linear-graph',
    'pep-math-2022',
    'pep-math-8b-2026',
    'pep-math-8b-2026-ch23',
    'Graphs and properties of linear functions',
    'Chapter 23 Linear functions',
    'Grade 8, volume 2',
  ),
  status: 'verified',
  sectionId: 'pep-math-8b-2026-ch23-s2',
  section: {
    id: 'pep-math-8b-2026-ch23-s2',
    label: '23.2 Graphs and properties of linear functions',
  },
  preset: { mode: 'linear', a: 2, b: 1, c: 0 },
};

function renderSectionedPage(): void {
  const response: CurriculumResponse = {
    items: [LINEAR_ITEM],
    catalogs: [PEP_CURRENT, PEP_LEGACY],
  };
  render(
    <CurriculumPage
      api={{ curriculum: vi.fn(async () => response) } as unknown as ApiClient}
      locale="en"
      i18n={i18n}
      navigate={() => undefined}
    />,
  );
}

describe('curriculum directory with sections', () => {
  it('shows the printed sections under a chapter, including the ones with no tool', async () => {
    renderSectionedPage();

    const chapter = await screen.findByTestId(
      'curriculum-chapter-pep-math-8b-2026-ch23',
    );
    expect(chapter).toHaveTextContent('Chapter 23 Linear functions');
    const sections = within(chapter).getAllByTestId(/^curriculum-section-/);
    expect(sections.map((section) => section.getAttribute('data-testid'))).toEqual([
      'curriculum-section-pep-math-8b-2026-ch23-s1',
      'curriculum-section-pep-math-8b-2026-ch23-s2',
    ]);
    expect(sections[0]).toHaveTextContent('23.1 The concept of a linear function');
    expect(sections[0]).toHaveTextContent('No tool is published in this section yet.');
    expect(sections[1]).toHaveTextContent('23.2 Graphs and properties of linear functions');
    // The printed page is shown so a teacher can find it in the book.
    expect(sections[1]).toHaveTextContent('Page 117');
  });

  it('renders a section entry once, under its section, and links to its own context', async () => {
    renderSectionedPage();

    const section = await screen.findByTestId('curriculum-section-pep-math-8b-2026-ch23-s2');
    const entries = within(section).getAllByTestId(/^curriculum-entry-/);
    expect(entries).toHaveLength(1);
    expect(within(section).getByTestId('curriculum-entry-pep-8b-23-2-linear-graph')).toHaveTextContent(
      '23.2 Graphs and properties of linear functions',
    );
    // The chapter lists the same tool for older clients, but it is not rendered twice.
    expect(
      screen.getAllByTestId('curriculum-entry-pep-8b-23-2-linear-graph'),
    ).toHaveLength(1);
    expect(
      within(section).getByRole('link', { name: /Graphs and properties of linear functions/i }),
    ).toHaveAttribute('href', expect.stringContaining('/curriculum/pep-8b-23-2-linear-graph'));
  });

  it('lists the two textbook editions as peer catalogs, with no old/new badge', async () => {
    renderSectionedPage();

    const current = await screen.findByTestId('curriculum-catalog-pep-math-2022');
    const legacy = await screen.findByTestId('curriculum-catalog-pep-math-9b-legacy');

    // One list of textbooks under the subject, in catalog order: a peer edition, not a zone.
    expect(current.parentElement).toBe(legacy.parentElement);
    const peerIds = [...(current.parentElement?.children ?? [])]
      .map((node) => node.getAttribute('data-testid'))
      .filter((id) => id?.startsWith('curriculum-catalog-'));
    expect(peerIds).toEqual([
      'curriculum-catalog-pep-math-2022',
      'curriculum-catalog-pep-math-9b-legacy',
    ]);

    // No edition badge and no warning colour: the edition is named in the catalog's own details.
    expect(screen.queryAllByTestId(/^curriculum-catalog-edition-/)).toHaveLength(0);
    for (const catalog of [current, legacy]) {
      expect(catalog.querySelector('.badge--legacy')).toBeNull();
    }
    expect(current).toHaveTextContent("People's Education Press");
    expect(current).toHaveTextContent('2022 curriculum revision');
    expect(legacy).toHaveTextContent("People's Education Press");
    expect(legacy).toHaveTextContent('2011 curriculum edition');

    // Each edition keeps its own chapters, including the chapter 26 that collides by number.
    expect(
      within(current).getByTestId('curriculum-chapter-pep-math-8b-2026-ch23'),
    ).toHaveTextContent('Chapter 23 Linear functions');
    const legacyChapter = within(legacy).getByTestId('curriculum-chapter-pep-math-9b-legacy-ch26');
    expect(legacyChapter).toHaveTextContent('Chapter 26 Inverse proportional functions');
    // Its empty chapter still names its sections rather than showing a blank book.
    expect(legacyChapter).toHaveTextContent('26.1 Inverse proportional functions');
    expect(legacyChapter).not.toHaveTextContent('No tool is published in this chapter yet.');
  });

  it('renders a chapter-level entry of a section-free catalog exactly as before', async () => {
    renderPage();

    const chapter = await screen.findByTestId('curriculum-chapter-pilot-chapter-a');
    // No section list and no page numbers: the R8 catalogs model chapters only.
    expect(within(chapter).queryAllByTestId(/^curriculum-section-/)).toHaveLength(0);
    expect(chapter).not.toHaveTextContent('Page ');
    const entries = within(chapter).getAllByTestId(/^curriculum-entry-/);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toHaveTextContent('Slope and intercept of a linear function');
  });
});
