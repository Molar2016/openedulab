import { describe, expect, it } from 'vitest';

import {
  buildCurriculumSearch,
  parseCurriculumView,
  type CurriculumView,
} from '../apps/web/src/app/curriculum-url';

/**
 * Curriculum state in the URL (teacher navigation A).
 *
 * 学段 → 课程 → 册 → 展开的章 is navigation, so it has to survive a reload, a shared link and
 * the browser's back button. The page keeps that state in its own query parameters and never
 * in component memory alone. Anything the page cannot interpret (an unknown stage, a chapter
 * without a book) is dropped rather than guessed at, and the language parameter other pages
 * write is left alone.
 */

const EMPTY: CurriculumView = { stage: null, subject: null, book: null, chapter: null, q: '' };

describe('curriculum URL state', () => {
  it('reads the stage, course, book, expanded chapter and search term', () => {
    expect(
      parseCurriculumView(
        '?lang=zh-CN&stage=middle&subject=math&book=pep-math-8b-2026&chapter=pep-math-8b-2026-ch23&q=%E4%BA%BA%E6%95%99',
      ),
    ).toEqual({
      stage: 'middle',
      subject: 'math',
      book: 'pep-math-8b-2026',
      chapter: 'pep-math-8b-2026-ch23',
      q: '人教',
    });
  });

  it('drops a stage it cannot label and a chapter that has no book', () => {
    expect(parseCurriculumView('?stage=university&chapter=pep-math-8b-2026-ch23')).toEqual(EMPTY);
    expect(parseCurriculumView('?book=&chapter=pep-math-8b-2026-ch23')).toEqual(EMPTY);
  });

  it('ignores ids that are not tags instead of passing them to the page', () => {
    expect(parseCurriculumView('?subject=../../etc&book=<script>')).toEqual(EMPTY);
  });

  it('writes a shareable search string and keeps the language parameter', () => {
    const search = buildCurriculumSearch('?lang=zh-CN', {
      stage: 'middle',
      subject: 'math',
      book: 'pep-math-8b-2026',
      chapter: 'pep-math-8b-2026-ch23',
      q: '人教 八下',
    });

    expect(search.startsWith('?')).toBe(true);
    expect(search).toContain('lang=zh-CN');
    expect(parseCurriculumView(search)).toEqual({
      stage: 'middle',
      subject: 'math',
      book: 'pep-math-8b-2026',
      chapter: 'pep-math-8b-2026-ch23',
      q: '人教 八下',
    });
  });

  it('removes a cleared value from the URL rather than writing nulls', () => {
    const search = buildCurriculumSearch(
      '?lang=en&stage=middle&subject=math&book=pep-math-8b-2026&chapter=pep-math-8b-2026-ch23&q=abc',
      { book: null, chapter: null, q: '' },
    );

    expect(search).not.toContain('book=');
    expect(search).not.toContain('chapter=');
    expect(search).not.toContain('q=');
    expect(search).toContain('stage=middle');
    expect(search).toContain('lang=en');
  });

  it('keeps the typed search verbatim, so a space between words is not swallowed', () => {
    // The field writes back on every keystroke: trimming here would turn "人教 八下" into
    // "人教八下" before the second word could be typed. The matcher ignores whitespace.
    expect(parseCurriculumView('?q=%E4%BA%BA%E6%95%99+%E5%85%AB%E4%B8%8B').q).toBe('人教 八下');
    expect(buildCurriculumSearch('', { q: '人教 八下' })).toBe(
      '?q=%E4%BA%BA%E6%95%99+%E5%85%AB%E4%B8%8B',
    );
    expect(parseCurriculumView(buildCurriculumSearch('', { q: '人教 ' })).q).toBe('人教 ');
  });
});
