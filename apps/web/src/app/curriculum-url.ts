import type { CurriculumStage } from '../services/api';

/**
 * The curriculum view state that belongs in the URL (teacher navigation A).
 *
 * 学段 → 课程 → 册 → 展开的章 and the textbook search term are navigation: a shared link, a
 * reload and the browser's back button all have to land on the same screen. The page reads
 * this state from its own query parameters instead of keeping it in component memory, and
 * writes it back with `history.pushState`/`replaceState` (through `buildCurriculumSearch`).
 *
 * The rules are deliberately strict: a value the page cannot interpret is dropped, not
 * guessed at. An unknown stage must not silently open the wrong shelf, and a chapter id
 * without a book describes nothing a teacher could see.
 */

export const CURRICULUM_STAGES: readonly CurriculumStage[] = ['primary', 'middle', 'high'];

/** The stage a link opens when it names none: the directory's only populated shelf today. */
export const DEFAULT_CURRICULUM_STAGE: CurriculumStage = 'middle';

export interface CurriculumView {
  readonly stage: CurriculumStage | null;
  readonly subject: string | null;
  readonly book: string | null;
  readonly chapter: string | null;
  readonly q: string;
}

export const EMPTY_CURRICULUM_VIEW: CurriculumView = {
  stage: null,
  subject: null,
  book: null,
  chapter: null,
  q: '',
};

const VIEW_PARAMS = ['stage', 'subject', 'book', 'chapter', 'q'] as const;

/** Catalog, book, chapter and subject ids are kebab-case tags; anything else is not one. */
const ID_TAG = /^[a-z0-9][a-z0-9-]{0,79}$/;

function readTag(value: string | null): string | null {
  return value !== null && ID_TAG.test(value) ? value : null;
}

function readStage(value: string | null): CurriculumStage | null {
  return value !== null && (CURRICULUM_STAGES as readonly string[]).includes(value)
    ? (value as CurriculumStage)
    : null;
}

export function parseCurriculumView(search: string): CurriculumView {
  const params = new URLSearchParams(search);
  const book = readTag(params.get('book'));
  return {
    stage: readStage(params.get('stage')),
    subject: readTag(params.get('subject')),
    book,
    // A chapter only means something inside a book: without one it is dropped.
    chapter: book === null ? null : readTag(params.get('chapter')),
    // Kept verbatim: the field is written back on every keystroke, and trimming here would
    // swallow the space between two search words before the teacher could type the second.
    // Whitespace is ignored by the matcher (`matchesTextbook` splits on it), not by the URL.
    q: params.get('q') ?? '',
  };
}

/**
 * Writes one change onto `currentSearch`, keeping every parameter this page does not own
 * (`lang`, and anything a later screen adds). A cleared value is removed from the URL instead
 * of being written as an empty string.
 */
export function buildCurriculumSearch(
  currentSearch: string,
  patch: Partial<CurriculumView>,
): string {
  const params = new URLSearchParams(currentSearch);
  for (const key of VIEW_PARAMS) params.delete(key);

  const merged: CurriculumView = { ...parseCurriculumView(currentSearch), ...patch };
  const book = merged.book;
  const chapter = book === null ? null : merged.chapter;
  const q = merged.q;

  if (merged.stage !== null) params.set('stage', merged.stage);
  if (merged.subject !== null) params.set('subject', merged.subject);
  if (book !== null) params.set('book', book);
  if (chapter !== null) params.set('chapter', chapter);
  if (q !== '') params.set('q', q);

  const suffix = params.toString();
  return suffix === '' ? '' : `?${suffix}`;
}
