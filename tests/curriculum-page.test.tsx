import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { CurriculumPage } from '../apps/web/src/app/CurriculumPage';
import { createI18n } from '../apps/web/src/i18n';
import type { ApiClient, CurriculumItem } from '../apps/web/src/services/api';

/**
 * Curriculum directory (ADR-003).
 *
 * The directory is a real page, not a hidden URL: it lists the same tool under two chapter
 * positions, states plainly that these are pilot entries rather than verified textbook
 * chapters, and every entry is a link a teacher can open (or bookmark).
 */

const i18n = createI18n('en');

const ITEMS: readonly CurriculumItem[] = [
  {
    placementId: 'math.functions.pilot-linear-slope',
    slug: 'pilot-linear-slope',
    version: 1,
    status: 'illustrative',
    order: 1,
    experimentId: 'math.functions',
    experimentSlug: 'math-functions',
    contentVersion: '1.0.0',
    stateSchemaVersion: 1,
    title: 'Slope and intercept of a linear function',
    summary: 'Opens the same experiment tuned for slope and intercept.',
    edition: { id: 'pilot-edition', label: 'Pilot edition (not a textbook)' },
    book: { id: 'pilot-book-a', label: 'Sample book A' },
    chapter: { id: 'pilot-chapter-a', label: 'Sample chapter A · slope and intercept' },
    preset: { mode: 'linear', a: 2, b: 3, c: 0 },
  },
  {
    placementId: 'math.functions.pilot-quadratic-vertex',
    slug: 'pilot-quadratic-vertex',
    version: 1,
    status: 'illustrative',
    order: 2,
    experimentId: 'math.functions',
    experimentSlug: 'math-functions',
    contentVersion: '1.0.0',
    stateSchemaVersion: 1,
    title: 'Vertex of a quadratic function',
    summary: 'Opens the same experiment tuned for the vertex.',
    edition: { id: 'pilot-edition', label: 'Pilot edition (not a textbook)' },
    book: { id: 'pilot-book-a', label: 'Sample book A' },
    chapter: { id: 'pilot-chapter-b', label: 'Sample chapter B · vertex' },
    preset: { mode: 'quadratic', a: 1, b: -2, c: 0 },
  },
];

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    curriculum: vi.fn(async () => ITEMS),
    ...overrides,
  } as unknown as ApiClient;
}

describe('curriculum directory', () => {
  it('lists the chapter positions of one tool with edition, book and chapter', async () => {
    render(
      <CurriculumPage
        api={fakeApi()}
        locale="en"
        i18n={i18n}
        navigate={() => undefined}
      />,
    );

    expect(await screen.findByTestId('curriculum-list')).toBeInTheDocument();
    expect(screen.getAllByTestId(/curriculum-entry-/)).toHaveLength(2);

    const first = screen.getByTestId('curriculum-entry-pilot-linear-slope');
    expect(first).toHaveTextContent('Pilot edition (not a textbook)');
    expect(first).toHaveTextContent('Sample book A');
    expect(first).toHaveTextContent('Sample chapter A · slope and intercept');
    expect(first).toHaveTextContent('Slope and intercept of a linear function');
  });

  it('marks every entry as a pilot entry, never as a textbook chapter', async () => {
    render(
      <CurriculumPage api={fakeApi()} locale="en" i18n={i18n} navigate={() => undefined} />,
    );

    await screen.findByTestId('curriculum-list');
    const badges = screen.getAllByTestId(/curriculum-status-/);
    expect(badges).toHaveLength(2);
    for (const badge of badges) {
      expect(badge).toHaveTextContent(/not a textbook chapter/i);
    }
  });

  it('links each entry to its own context page', async () => {
    render(
      <CurriculumPage api={fakeApi()} locale="en" i18n={i18n} navigate={() => undefined} />,
    );

    const link = await screen.findByRole('link', { name: /Slope and intercept of a linear function/i });
    expect(link).toHaveAttribute('href', '/curriculum/pilot-linear-slope?lang=en');
  });

  it('navigates in-app without a full page load', async () => {
    const navigate = vi.fn();
    render(
      <CurriculumPage api={fakeApi()} locale="en" i18n={i18n} navigate={navigate} />,
    );

    const link = await screen.findByRole('link', { name: /Vertex of a quadratic function/i });
    fireEvent.click(link);

    expect(navigate).toHaveBeenCalledWith('/curriculum/pilot-quadratic-vertex?lang=en');
  });

  it('shows a retry instead of an empty list when the directory cannot be loaded', async () => {
    const api = fakeApi({
      curriculum: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    render(<CurriculumPage api={api} locale="en" i18n={i18n} navigate={() => undefined} />);

    expect(await screen.findByTestId('curriculum-error')).toBeInTheDocument();
    expect(screen.queryByTestId('curriculum-list')).toBeNull();
  });
});
