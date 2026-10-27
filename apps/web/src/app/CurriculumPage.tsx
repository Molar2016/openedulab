import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Locale } from '../experiment/contract';
import type { I18n } from '../i18n';
import type { ApiClient, CurriculumResponse, CurriculumStage } from '../services/api';
import {
  buildCurriculumTree,
  buildTextbookDirectory,
  matchesTextbook,
  type CurriculumChapterGroup,
  type CurriculumSectionGroup,
  type TextbookBook,
} from './curriculum-tree';
import {
  buildCurriculumSearch,
  CURRICULUM_STAGES,
  DEFAULT_CURRICULUM_STAGE,
  parseCurriculumView,
  type CurriculumView,
} from './curriculum-url';
import { placementHref } from './router';

interface Props {
  api: ApiClient;
  locale: Locale;
  i18n: I18n;
  navigate: (to: string) => void;
}

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly response: CurriculumResponse };

/** Subjects are tags; only the ones with a translated label are named in words. */
const SUBJECT_KEYS: Readonly<Record<string, string>> = {
  math: 'curriculum.subject.math',
  physics: 'curriculum.subject.physics',
};

function subjectLabel(i18n: I18n, subject: string): string {
  const key = SUBJECT_KEYS[subject];
  return key === undefined ? i18n.t('curriculum.subject.other', { subject }) : i18n.t(key);
}

/**
 * Curriculum directory, teacher navigation A: 学段 → 课程 → 一册册教材 → 章 → 节 → 工具.
 *
 * What a teacher holds is one printed volume, so the page shows one card per volume right
 * after the course choice. The server's catalog is a content container (the 2022 edition holds
 * five volumes; the current grade-9 lower volume is a catalog of its own) — the page projects
 * its books into cards and keeps the catalog only as metadata (publisher, edition).
 *
 * Choosing a volume opens *that* volume alone, its chapters collapsed. Expanding a chapter is
 * the only thing that reveals its sections and their tool entries; an entry keeps its own
 * `/curriculum/<slug>` URL, so the placement preset and the snapshot scoped to that placement
 * are exactly what they were before. No knowledge-point level is invented: the directory
 * publishes chapters and sections, and nothing here adds a node the data lacks.
 *
 * The view state (stage, course, volume, open chapter, search) lives in the URL through
 * `curriculum-url.ts`, so a reload, a shared link and the back button all restore the same
 * screen. Illustrative catalogs are examples, not textbooks: they stay out of the volume list,
 * while the direct placement routes that reference them keep working.
 */
export function CurriculumPage({ api, locale, i18n, navigate }: Props): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [view, setView] = useState<CurriculumView>(() =>
    parseCurriculumView(window.location.search),
  );

  const t = (key: string, params?: Record<string, string | number>): string => i18n.t(key, params);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    api
      .curriculum(locale)
      .then((response) => {
        if (!cancelled) setState({ kind: 'ready', response });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [api, locale, reloadToken]);

  /**
   * The URL is the source of truth for navigation state: the back/forward buttons replay a
   * URL, so the page re-reads it rather than keeping its own memory of what was open.
   */
  useEffect(() => {
    const onPopState = (): void => setView(parseCurriculumView(window.location.search));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const commit = useCallback(
    (patch: Partial<CurriculumView>, mode: 'push' | 'replace' = 'push'): void => {
      const search = buildCurriculumSearch(window.location.search, patch);
      if (mode === 'replace') {
        window.history.replaceState({}, '', `/curriculum${search}`);
      } else {
        window.history.pushState({}, '', `/curriculum${search}`);
      }
      setView(parseCurriculumView(search));
    },
    [],
  );

  const directory = useMemo(
    () =>
      state.kind === 'ready'
        ? buildTextbookDirectory(
            buildCurriculumTree(state.response.items, state.response.catalogs),
          )
        : [],
    [state],
  );

  const stage: CurriculumStage = view.stage ?? DEFAULT_CURRICULUM_STAGE;
  const courses = directory.find((group) => group.stage === stage)?.courses ?? [];
  const subject =
    view.subject !== null && courses.some((course) => course.subject === view.subject)
      ? view.subject
      : courses.length === 1
        ? (courses[0]?.subject ?? null)
        : null;
  const course = courses.find((entry) => entry.subject === subject);
  const books = course?.books ?? [];
  const chosenBook: TextbookBook | 'missing' | null =
    view.book === null
      ? null
      : (courses.flatMap((entry) => entry.books).find((book) => book.bookId === view.book) ??
        'missing');

  const stageLabel = (value: CurriculumStage): string => t(`curriculum.stage.${value}`);

  const openBook = (book: TextbookBook): void => {
    commit({ stage: book.stage, subject: book.subject, book: book.bookId, chapter: null });
  };

  const bookHref = (book: TextbookBook): string =>
    `/curriculum${buildCurriculumSearch(window.location.search, {
      stage: book.stage,
      subject: book.subject,
      book: book.bookId,
      chapter: null,
    })}`;

  const toolLink = (entry: {
    readonly slug: string;
    readonly title: string;
  }): JSX.Element => {
    const href = placementHref(entry.slug, locale);
    return (
      <a
        className="curriculum__toolLink"
        href={href}
        onClick={(event) => {
          event.preventDefault();
          navigate(href);
        }}
      >
        {entry.title}
        <span aria-hidden="true"> →</span>
      </a>
    );
  };

  const entriesOf = (
    entries: readonly { readonly placementId: string; readonly slug: string; readonly title: string }[],
  ): JSX.Element => (
    <ul className="curriculum__entries">
      {entries.map((entry) => (
        <li key={entry.placementId}>{toolLink(entry)}</li>
      ))}
    </ul>
  );

  const renderSection = (group: CurriculumSectionGroup): JSX.Element => (
    <li
      key={group.section.sectionId}
      className="curriculum__section"
      data-testid={`curriculum-section-${group.section.sectionId}`}
    >
      <p className="curriculum__sectionHead">
        <span>{group.section.label}</span>
        {group.section.printedPage === undefined ? null : (
          <span className="curriculum__page">
            {t('curriculum.meta.page', { page: group.section.printedPage })}
          </span>
        )}
      </p>
      {group.entries.length > 0 ? entriesOf(group.entries) : null}
    </li>
  );

  const renderChapter = (group: CurriculumChapterGroup): JSX.Element => {
    const { chapter } = group;
    const open = view.chapter === chapter.chapterId;
    const panelId = `curriculum-chapter-panel-${chapter.chapterId}`;
    const meta = [
      chapter.printedPage === undefined
        ? null
        : t('curriculum.meta.page', { page: chapter.printedPage }),
      t('curriculum.sectionCount', { count: group.sections.length }),
    ]
      .filter((part): part is string => part !== null)
      .join(' · ');

    return (
      <li
        key={chapter.chapterId}
        className="curriculum__chapter"
        data-testid={`curriculum-chapter-${chapter.chapterId}`}
      >
        <h3 className="curriculum__chapterHeading">
          <button
            type="button"
            className="curriculum__chapterToggle"
            data-testid={`curriculum-chapter-toggle-${chapter.chapterId}`}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => commit({ chapter: open ? null : chapter.chapterId })}
          >
            <span className="curriculum__chapterLabel">{chapter.label}</span>
            <span className="curriculum__chapterMeta muted small">{meta}</span>
            <span className="curriculum__chevron" aria-hidden="true">
              {open ? '−' : '+'}
            </span>
          </button>
        </h3>
        <div
          id={panelId}
          data-testid={panelId}
          className="curriculum__chapterPanel"
          hidden={!open}
        >
          {group.sections.length > 0 ? (
            <ul className="curriculum__sections">{group.sections.map(renderSection)}</ul>
          ) : null}
          {group.entries.length > 0 ? entriesOf(group.entries) : null}
          {group.sections.length === 0 && group.entries.length === 0 ? (
            <p className="muted small curriculum__noTool">{t('curriculum.chapterEmpty')}</p>
          ) : null}
        </div>
      </li>
    );
  };

  const bookView = (book: TextbookBook): JSX.Element => (
    <section className="curriculum__book" data-testid="curriculum-book">
      <p className="muted small curriculum__crumb" data-testid="curriculum-crumb">
        {t('curriculum.crumb', {
          stage: stageLabel(book.stage),
          subject: subjectLabel(i18n, book.subject),
          book: book.label,
        })}
      </p>
      <button
        type="button"
        className="button button--ghost small curriculum__back"
        data-testid="curriculum-back-to-books"
        onClick={() => commit({ book: null, chapter: null })}
      >
        {t('curriculum.backToBooks')}
      </button>
      <header className="curriculum__bookHeader">
        <h2>{book.label}</h2>
        <p className="muted small">
          {[subjectLabel(i18n, book.subject), book.publisher, book.edition]
            .filter((part): part is string => part !== undefined && part !== '')
            .join(' · ')}
          {' · '}
          {t('curriculum.chapterCount', { count: book.chapterCount })}
        </p>
      </header>
      <ol className="curriculum__accordion" data-testid="curriculum-chapters">
        {book.chapters.map(renderChapter)}
      </ol>
    </section>
  );

  const visibleBooks = books.filter((book) =>
    matchesTextbook(book, {
      query: view.q,
      subject: subjectLabel(i18n, book.subject),
      stage: stageLabel(book.stage),
    }),
  );

  const listView = (): JSX.Element => (
    <>
      <div className="search search--lead">
        <label htmlFor="curriculum-search">{t('curriculum.searchLabel')}</label>
        <input
          id="curriculum-search"
          type="search"
          value={view.q}
          placeholder={t('curriculum.searchPlaceholder')}
          onChange={(event) => commit({ q: event.target.value }, 'replace')}
        />
      </div>

      <div className="chips curriculum__stages" role="group" aria-label={t('curriculum.stage.label')}>
        {CURRICULUM_STAGES.map((value) => (
          <button
            key={value}
            type="button"
            data-testid={`curriculum-stage-${value}`}
            aria-pressed={value === stage}
            onClick={() => commit({ stage: value, subject: null, book: null, chapter: null })}
          >
            {stageLabel(value)}
          </button>
        ))}
      </div>

      {courses.length === 0 ? (
        <div className="empty" data-testid="curriculum-stage-empty">
          <h2>{t('curriculum.stageEmpty')}</h2>
          <p className="muted">{t('curriculum.stageEmptyHint')}</p>
        </div>
      ) : null}

      {courses.length > 0 ? (
        <div
          className="chips curriculum__courses"
          role="group"
          aria-label={t('curriculum.course.label')}
        >
          {courses.map((entry) => (
            <button
              key={entry.subject}
              type="button"
              data-testid={`curriculum-course-${entry.subject}`}
              aria-pressed={entry.subject === subject}
              onClick={() =>
                commit({ stage, subject: entry.subject, book: null, chapter: null })
              }
            >
              {subjectLabel(i18n, entry.subject)}
            </button>
          ))}
        </div>
      ) : null}

      {courses.length > 0 && subject === null ? (
        <p className="muted small">{t('curriculum.chooseCourse')}</p>
      ) : null}

      {subject !== null && visibleBooks.length === 0 ? (
        <div className="empty" data-testid="curriculum-books-empty">
          <h2>{t('curriculum.booksEmpty')}</h2>
          <p className="muted">{t('curriculum.booksEmptyHint')}</p>
        </div>
      ) : null}

      {subject !== null && visibleBooks.length > 0 ? (
        <ul className="curriculum__bookGrid" data-testid="curriculum-books">
          {visibleBooks.map((book) => (
            <li key={book.key}>
              <article
                className="card curriculum__bookCard"
                data-testid={`curriculum-book-card-${book.bookId}`}
              >
                <a
                  className="curriculum__bookLink"
                  href={bookHref(book)}
                  onClick={(event) => {
                    event.preventDefault();
                    openBook(book);
                  }}
                >
                  <span className="badge">{subjectLabel(i18n, book.subject)}</span>
                  <h2>{book.label}</h2>
                  {book.publisher === undefined ? null : (
                    <p className="muted small">{book.publisher}</p>
                  )}
                  <p className="muted small">
                    {book.editionStatus === undefined
                      ? book.edition
                      : t(`curriculum.edition.${book.editionStatus}`)}{' · '}
                    {t('curriculum.chapterCount', { count: book.chapterCount })}
                  </p>
                </a>
              </article>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );

  return (
    <section className="curriculum" aria-labelledby="curriculum-heading">
      <div className="catalog__intro">
        <h1 id="curriculum-heading">{t('curriculum.heading')}</h1>
        <p className="muted">{t('curriculum.subheading')}</p>
        <p className="muted small">{t('curriculum.note')}</p>
      </div>

      {state.kind === 'loading' ? (
        <p className="muted" role="status" data-testid="curriculum-loading">
          {t('curriculum.loading')}
        </p>
      ) : null}

      {state.kind === 'error' ? (
        <div className="empty" role="alert" data-testid="curriculum-error">
          <h2>{t('curriculum.error.title')}</h2>
          <p className="muted">{t('curriculum.error.body')}</p>
          <button
            type="button"
            className="button"
            onClick={() => setReloadToken((value) => value + 1)}
          >
            {t('curriculum.error.retry')}
          </button>
        </div>
      ) : null}

      {state.kind === 'ready' && directory.length === 0 ? (
        <div className="empty" data-testid="curriculum-empty">
          <h2>{t('curriculum.empty')}</h2>
          <p className="muted">{t('curriculum.emptyHint')}</p>
        </div>
      ) : null}

      {state.kind === 'ready' && directory.length > 0 ? (
        <div className="curriculum__tree" data-testid="curriculum-list">
          {chosenBook === 'missing' ? (
            <div className="empty" data-testid="curriculum-book-missing">
              <h2>{t('curriculum.bookMissing')}</h2>
              <p className="muted">{t('curriculum.bookMissingHint')}</p>
              <button
                type="button"
                className="button"
                onClick={() => commit({ book: null, chapter: null })}
              >
                {t('curriculum.backToBooks')}
              </button>
            </div>
          ) : chosenBook === null ? (
            listView()
          ) : (
            bookView(chosenBook)
          )}
        </div>
      ) : null}
    </section>
  );
}
