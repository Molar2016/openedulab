import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { CatalogPage } from '../apps/web/src/app/CatalogPage';
import { createI18n } from '../apps/web/src/i18n';
import type { ApiClient, CatalogItem } from '../apps/web/src/services/api';

/**
 * Experiment catalog (teacher navigation, A): search only.
 *
 * The page used to carry three chip rows (subject / grade / concept). A teacher who knows
 * what they need searches for it; the rows cost a screen of vertical space and invited
 * filtering by a taxonomy the directory does not really have. The experiment list now shows
 * one search field and the tool cards — the API keeps its filters for older clients.
 */

const i18n = createI18n('en');

function catalogItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: 'math.functions',
    slug: 'math-functions',
    title: 'Linear and quadratic functions',
    description: 'Compare a line with a parabola.',
    subjects: ['math'],
    grades: ['middle'],
    concepts: ['functions'],
    contentVersion: '1.0.0',
    languages: ['zh-CN', 'en'],
    ...overrides,
  };
}

const ITEMS: readonly CatalogItem[] = [
  catalogItem(),
  catalogItem({
    id: 'math.geometry',
    slug: 'math-geometry',
    title: 'Triangle congruence',
    description: 'Move a triangle and compare its sides.',
    concepts: ['geometry'],
  }),
];

function fakeApi(): ApiClient {
  return {
    catalog: vi.fn(async () => ITEMS),
  } as unknown as ApiClient;
}

function renderPage(): void {
  render(
    <CatalogPage api={fakeApi()} locale="en" i18n={i18n} navigate={() => undefined} />,
  );
}

describe('experiment catalog', () => {
  it('offers exactly one search field and no subject/grade/concept chip rows', async () => {
    renderPage();

    expect(await screen.findByTestId('result-count')).toHaveTextContent('2 experiments');
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
    expect(screen.queryByRole('group', { name: 'Filters' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Subject' })).toBeNull();
    // The old chip rows each started with an "All" chip; nothing like that is left.
    expect(screen.queryByRole('button', { name: 'All' })).toBeNull();
  });

  it('filters the tool list by what the teacher types', async () => {
    renderPage();
    await screen.findByTestId('result-count');

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'triangle' } });

    expect(screen.getByTestId('result-count')).toHaveTextContent('1 experiment');
    expect(screen.getByTestId('experiment-card-math-geometry')).toBeInTheDocument();
    expect(screen.queryByTestId('experiment-card-math-functions')).toBeNull();
  });

  it('clears the search and restores the full list', async () => {
    renderPage();
    await screen.findByTestId('result-count');

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing-matches' } });
    expect(screen.getByTestId('catalog-empty')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(screen.getByTestId('result-count')).toHaveTextContent('2 experiments');
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });
});
