import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
 * Curriculum directory, teacher navigation A.
 *
 * 学段 → 课程 → 一册册真实教材. The server still groups its books inside an edition catalog;
 * that grouping is a publishing fact, not a step a teacher takes. The page therefore shows one
 * card per volume right after the course choice, and clicking a volume shows only that
 * volume's chapters, collapsed. Expanding a chapter is the only way sections and their tool
 * entries appear. Examples (`illustrative`) are not textbooks and stay out of the list; their
 * direct `/curriculum/<slug>` URLs and personal snapshots are untouched.
 */

const i18n = createI18n('en');

const LINEAR: CurriculumItem = {
  placementId: 'math.functions.pep-8b-ch23-s2-linear-graph',
  slug: 'pep-8b-23-2-linear-graph',
  version: 1,
  status: 'verified',
  order: 1,
  experimentId: 'math.functions',
  experimentSlug: 'math-functions',
  contentVersion: '1.0.0',
  stateSchemaVersion: 1,
  subject: 'math',
  catalogId: 'pep-math-2022',
  bookId: 'pep-math-8b-2026',
  chapterId: 'pep-math-8b-2026-ch23',
  sectionId: 'pep-math-8b-2026-ch23-s2',
  section: { id: 'pep-math-8b-2026-ch23-s2', label: '23.2 Graphs and properties' },
  title: 'Linear and quadratic functions',
  summary: 'Compare a line with a parabola.',
  edition: { id: 'pep-math-2022', label: 'PEP mathematics (2022 curriculum revision)' },
  book: { id: 'pep-math-8b-2026', label: 'Grade 8, volume 2' },
  chapter: { id: 'pep-math-8b-2026-ch23', label: 'Chapter 23 Linear functions' },
  preset: { mode: 'linear', a: 2, b: 1, c: 0 },
};

const CURRENT: CurriculumCatalog = {
  catalogId: 'pep-math-2022',
  subject: 'math',
  version: 1,
  status: 'verified',
  order: 1,
  stage: 'middle',
  editionStatus: 'current-2022',
  label: 'PEP mathematics (2022 curriculum revision)',
  publisher: "People's Education Press",
  revision: '2022 curriculum revision',
  books: [
    {
      bookId: 'pep-math-7a-2024',
      order: 1,
      label: 'Grade 7, volume 1',
      chapters: [
        {
          chapterId: 'pep-math-7a-2024-ch1',
          order: 1,
          label: 'Chapter 1 Rational numbers',
          placementIds: [],
        },
      ],
    },
    {
      bookId: 'pep-math-8b-2026',
      order: 4,
      label: 'Grade 8, volume 2',
      chapters: [
        {
          chapterId: 'pep-math-8b-2026-ch23',
          order: 23,
          label: 'Chapter 23 Linear functions',
          printedPage: 113,
          placementIds: [LINEAR.placementId],
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
              label: '23.2 Graphs and properties',
              printedPage: 117,
              placementIds: [LINEAR.placementId],
            },
          ],
        },
      ],
    },
    {
      bookId: 'pep-math-9a-2026',
      order: 5,
      label: 'Grade 9, volume 1',
      chapters: [
        {
          chapterId: 'pep-math-9a-2026-ch26',
          order: 26,
          label: 'Chapter 26 Quadratic functions',
          placementIds: [],
        },
      ],
    },
  ],
};

const LEGACY: CurriculumCatalog = {
  catalogId: 'pep-math-9b-legacy',
  subject: 'math',
  version: 1,
  status: 'verified',
  order: 2,
  stage: 'middle',
  editionStatus: 'legacy-2011',
  label: 'PEP mathematics, grade 9 volume 2 (2011 edition)',
  publisher: "People's Education Press",
  revision: '2011 curriculum edition',
  books: [
    {
      bookId: 'pep-math-9b-legacy',
      order: 6,
      label: 'Grade 9, volume 2',
      chapters: [
        {
          chapterId: 'pep-math-9b-legacy-ch26',
          order: 26,
          label: 'Chapter 26 Inverse proportional functions',
          placementIds: [],
        },
      ],
    },
  ],
};

const PILOT: CurriculumCatalog = {
  catalogId: 'pilot-edition',
  subject: 'math',
  version: 1,
  status: 'illustrative',
  order: 3,
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
          label: 'Sample chapter A',
          placementIds: [],
        },
      ],
    },
  ],
};

const RESPONSE: CurriculumResponse = { items: [LINEAR], catalogs: [LEGACY, CURRENT, PILOT] };

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    curriculum: vi.fn(async () => RESPONSE),
    ...overrides,
  } as unknown as ApiClient;
}

function renderPage(
  api: ApiClient = fakeApi(),
  navigate: (to: string) => void = () => undefined,
): void {
  render(<CurriculumPage api={api} locale="en" i18n={i18n} navigate={navigate} />);
}

/** Points the address bar at a curriculum URL, the way a reload or a shared link would. */
function at(search: string): void {
  window.history.replaceState({}, '', `/curriculum${search}`);
}

beforeEach(() => at('?lang=en'));
afterEach(() => at('?lang=en'));

describe('curriculum directory (teacher navigation A)', () => {
  it('lists the real volumes directly after the course choice, one card per volume', async () => {
    renderPage();

    await screen.findByTestId('curriculum-books');
    const cards = screen.getAllByTestId(/^curriculum-book-card-/);
    expect(cards.map((card) => card.getAttribute('data-testid'))).toEqual([
      'curriculum-book-card-pep-math-7a-2024',
      'curriculum-book-card-pep-math-8b-2026',
      'curriculum-book-card-pep-math-9a-2026',
      'curriculum-book-card-pep-math-9b-legacy',
    ]);
    // The card names the volume, its publisher and its edition — there is no edition catalog
    // level between the course and the book.
    expect(cards[1]).toHaveTextContent('Grade 8, volume 2');
    expect(cards[1]).toHaveTextContent("People's Education Press");
    expect(cards[1]).toHaveTextContent('2022 curriculum revision');
    expect(cards[1]).toHaveTextContent('1 chapter');
    expect(cards[3]).toHaveTextContent('2011 curriculum edition');
    // No example catalog and no example book in the textbook list.
    expect(screen.queryByText('Sample textbook A (not a textbook)')).toBeNull();
    expect(screen.queryByText('Sample book A')).toBeNull();
  });

  it('offers the three school stages and the courses inside the active stage', async () => {
    renderPage();
    await screen.findByTestId('curriculum-books');

    const stages = screen.getByRole('group', { name: 'School stage' });
    expect(within(stages).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Primary school',
      'Middle school',
      'High school',
    ]);
    expect(within(stages).getByRole('button', { name: 'Middle school' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // One course is in this stage, so it is already chosen: no extra click before the volumes.
    expect(screen.getByRole('button', { name: 'Mathematics' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows an empty shelf for a stage with no textbook yet', async () => {
    renderPage();
    await screen.findByTestId('curriculum-books');

    fireEvent.click(screen.getByRole('button', { name: 'High school' }));

    expect(screen.getByTestId('curriculum-stage-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^curriculum-book-card-/)).toHaveLength(0);
    expect(window.location.search).toContain('stage=high');

    fireEvent.click(screen.getByRole('button', { name: 'Primary school' }));
    expect(screen.getByTestId('curriculum-stage-empty')).toBeInTheDocument();
    expect(window.location.search).toContain('stage=primary');
  });

  it('finds a volume with the shorthand a teacher types, e.g. 八下', async () => {
    renderPage();
    await screen.findByTestId('curriculum-books');
    const search = screen.getByRole('searchbox', { name: 'Search textbooks' });

    fireEvent.change(search, { target: { value: '八下' } });

    const cards = screen.getAllByTestId(/^curriculum-book-card-/);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveAttribute('data-testid', 'curriculum-book-card-pep-math-8b-2026');
    expect(window.location.search).toContain('q=');

    fireEvent.change(search, { target: { value: '九上' } });
    expect(screen.getAllByTestId(/^curriculum-book-card-/)[0]).toHaveAttribute(
      'data-testid',
      'curriculum-book-card-pep-math-9a-2026',
    );

    fireEvent.change(search, { target: { value: '2022 curriculum revision' } });
    expect(screen.getAllByTestId(/^curriculum-book-card-/)).toHaveLength(3);

    fireEvent.change(search, { target: { value: 'no such textbook' } });
    expect(screen.getByTestId('curriculum-books-empty')).toBeInTheDocument();
  });

  it('lets a teacher type a two-word search without losing the space', async () => {
    renderPage();
    await screen.findByTestId('curriculum-books');
    const search = screen.getByRole('searchbox', { name: 'Search textbooks' });

    // Each keystroke round-trips through the URL; the space has to survive it.
    fireEvent.change(search, { target: { value: '2022 ' } });
    expect(search).toHaveValue('2022 ');
    fireEvent.change(search, { target: { value: '2022 curriculum' } });

    expect(screen.getAllByTestId(/^curriculum-book-card-/)).toHaveLength(3);
    expect(window.location.search).toContain('q=2022+curriculum');
  });

  it('opens only the chosen volume, with its chapters collapsed', async () => {
    renderPage();
    const card = await screen.findByTestId('curriculum-book-card-pep-math-8b-2026');

    fireEvent.click(within(card).getByRole('link'));

    expect(window.location.search).toContain('book=pep-math-8b-2026');
    const chapters = screen.getByTestId('curriculum-chapters');
    expect(chapters).toHaveTextContent('Chapter 23 Linear functions');
    expect(chapters).not.toHaveTextContent('Chapter 26 Quadratic functions');
    expect(chapters).not.toHaveTextContent('Chapter 26 Inverse proportional functions');
    // Collapsed: the panel is in the DOM for the accordion, but it is not shown.
    expect(screen.getByTestId('curriculum-chapter-panel-pep-math-8b-2026-ch23')).not.toBeVisible();
    expect(screen.getByTestId('curriculum-chapter-toggle-pep-math-8b-2026-ch23')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // The long per-entry metadata of the old page is gone.
    expect(screen.queryByText('Compare a line with a parabola.')).toBeNull();
  });

  it('expands a chapter to its sections and keeps the placement link untouched', async () => {
    const navigate = vi.fn();
    renderPage(fakeApi(), navigate);
    fireEvent.click(
      within(await screen.findByTestId('curriculum-book-card-pep-math-8b-2026')).getByRole('link'),
    );

    fireEvent.click(screen.getByTestId('curriculum-chapter-toggle-pep-math-8b-2026-ch23'));

    const panel = screen.getByTestId('curriculum-chapter-panel-pep-math-8b-2026-ch23');
    expect(panel).toBeVisible();
    expect(panel).toHaveTextContent('23.1 The concept of a linear function');
    expect(panel).not.toHaveTextContent('No tool is published in this section yet.');
    expect(panel).toHaveTextContent('23.2 Graphs and properties');
    expect(window.location.search).toContain('chapter=pep-math-8b-2026-ch23');

    const link = within(panel).getByRole('link', { name: /Linear and quadratic functions/ });
    expect(link).toHaveAttribute('href', '/curriculum/pep-8b-23-2-linear-graph?lang=en');
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith('/curriculum/pep-8b-23-2-linear-graph?lang=en');
  });

  it('restores the chosen volume and the open chapter from the URL', async () => {
    at('?lang=en&stage=middle&subject=math&book=pep-math-8b-2026&chapter=pep-math-8b-2026-ch23');
    renderPage();

    expect(
      await screen.findByTestId('curriculum-chapter-toggle-pep-math-8b-2026-ch23'),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('curriculum-chapter-panel-pep-math-8b-2026-ch23')).toBeVisible();
    expect(screen.queryByTestId('curriculum-books')).toBeNull();
  });

  it('never mixes the two editions that both have a chapter 26', async () => {
    at('?lang=en&stage=middle&subject=math&book=pep-math-9a-2026');
    const { unmount } = render(
      <CurriculumPage api={fakeApi()} locale="en" i18n={i18n} navigate={() => undefined} />,
    );
    expect(await screen.findByTestId('curriculum-chapters')).toHaveTextContent(
      'Chapter 26 Quadratic functions',
    );
    expect(screen.getByTestId('curriculum-chapters')).not.toHaveTextContent(
      'Inverse proportional functions',
    );
    unmount();

    at('?lang=en&stage=middle&subject=math&book=pep-math-9b-legacy');
    render(<CurriculumPage api={fakeApi()} locale="en" i18n={i18n} navigate={() => undefined} />);
    expect(await screen.findByTestId('curriculum-chapters')).toHaveTextContent(
      'Chapter 26 Inverse proportional functions',
    );
    expect(screen.getByTestId('curriculum-chapters')).not.toHaveTextContent('Quadratic functions');
  });

  it('goes back to the volume list, and back again restores the open volume', async () => {
    renderPage();
    fireEvent.click(
      within(await screen.findByTestId('curriculum-book-card-pep-math-8b-2026')).getByRole('link'),
    );
    const bookUrl = window.location.search;

    fireEvent.click(screen.getByTestId('curriculum-back-to-books'));
    expect(screen.getByTestId('curriculum-books')).toBeInTheDocument();
    expect(window.location.search).not.toContain('book=');

    // The browser's back button replays a URL; the page re-reads it instead of trusting its
    // own memory of which volume was open.
    window.history.replaceState({}, '', `/curriculum${bookUrl}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(await screen.findByTestId('curriculum-chapters')).toHaveTextContent(
      'Chapter 23 Linear functions',
    );
  });

  it('says so when a link names a volume the directory does not publish', async () => {
    at('?lang=en&book=pep-math-9999');
    renderPage();

    expect(await screen.findByTestId('curriculum-book-missing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the textbook list' }));
    expect(screen.getByTestId('curriculum-books')).toBeInTheDocument();
  });

  it('shows a retry instead of an empty list when the directory cannot be loaded', async () => {
    renderPage(
      fakeApi({
        curriculum: vi.fn(async () => {
          throw new Error('offline');
        }),
      }),
    );

    expect(await screen.findByTestId('curriculum-error')).toBeInTheDocument();
    expect(screen.queryByTestId('curriculum-books')).toBeNull();
  });

  it('says so when the server publishes no catalog instead of inventing one', async () => {
    renderPage(fakeApi({ curriculum: vi.fn(async () => ({ items: [], catalogs: [] })) }));

    expect(await screen.findByTestId('curriculum-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('curriculum-books')).toBeNull();
  });
});
