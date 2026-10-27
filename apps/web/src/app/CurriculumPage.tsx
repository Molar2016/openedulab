import { createElement, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Locale } from '../experiment/contract';
import type { I18n } from '../i18n';
import type { ApiClient, CurriculumItem, CurriculumResponse } from '../services/api';
import {
  buildCurriculumTree,
  type CurriculumCatalogGroup,
  type CurriculumBookGroup,
  type CurriculumChapterGroup,
  type CurriculumSectionGroup,
} from './curriculum-tree';
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

function subjectHeading(i18n: I18n, subject: string): string {
  const key = SUBJECT_KEYS[subject];
  return key === undefined
    ? i18n.t('curriculum.subject.other', { subject })
    : i18n.t(key);
}

function Heading({
  level,
  id,
  children,
}: {
  level: number;
  id?: string;
  children: ReactNode;
}): JSX.Element {
  // Sections add one level to the hierarchy; HTML stops at h6, so the deepest entry heading
  // is clamped rather than emitting an invalid <h7>.
  const safeLevel = Math.min(Math.max(level, 1), 6);
  return createElement(`h${String(safeLevel)}`, id === undefined ? {} : { id }, children);
}

/**
 * Curriculum directory (ADR-003 → ADR-004).
 *
 * Navigation is 学科 → 教材 → 册 → 章 → 工具入口, rendered from what the *server* publishes:
 * `GET /api/curriculum` returns the flat entries plus the catalog tree, and this page joins
 * them. Two catalogs may place the same tool in a different order — the page shows each
 * catalog's own order instead of inventing a global one.
 *
 * A subject here is only a navigation grouping: there is no class, term, cohort, teacher
 * roster or progress record anywhere. Entries are labelled as pilot examples, and an
 * illustrative catalog carries no publisher or edition, so nothing on screen can be mistaken
 * for a verified textbook table of contents.
 */
export function CurriculumPage({ api, locale, i18n, navigate }: Props): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

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

  const tree = useMemo(
    () =>
      state.kind === 'ready'
        ? buildCurriculumTree(state.response.items, state.response.catalogs)
        : [],
    [state],
  );

  const singleSubject = tree.length === 1 ? tree[0]?.subject : undefined;
  const catalogLevel = singleSubject === undefined ? 3 : 2;

  const renderEntry = (entry: CurriculumItem, level: number): JSX.Element => {
    const href = placementHref(entry.slug, locale);
    return (
      <article className="card" data-testid={`curriculum-entry-${entry.slug}`}>
        <div className="card__meta">
          <span className="badge">{entry.section?.label ?? entry.chapter.label}</span>
          <span className="badge badge--muted" data-testid={`curriculum-status-${entry.slug}`}>
            {entry.status === 'verified'
              ? t('curriculum.verified')
              : t('curriculum.illustrative')}
          </span>
        </div>
        <Heading level={level}>
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              navigate(href);
            }}
          >
            {entry.title}
          </a>
        </Heading>
        <p className="muted">{entry.summary}</p>
        <dl className="curriculum__meta">
          <div>
            <dt>{t('curriculum.meta.edition')}</dt>
            <dd>{entry.edition.label}</dd>
          </div>
          <div>
            <dt>{t('curriculum.meta.book')}</dt>
            <dd>{entry.book.label}</dd>
          </div>
          <div>
            <dt>{t('curriculum.meta.chapter')}</dt>
            <dd>{entry.chapter.label}</dd>
          </div>
          {entry.section === undefined ? null : (
            <div>
              <dt>{t('curriculum.meta.section')}</dt>
              <dd>{entry.section.label}</dd>
            </div>
          )}
        </dl>
        <a
          className="button"
          href={href}
          onClick={(event) => {
            event.preventDefault();
            navigate(href);
          }}
        >
          {t('curriculum.open')}
        </a>
      </article>
    );
  };

  return (
    <section className="curriculum" aria-labelledby="curriculum-heading">
      <div className="catalog__intro">
        <h1 id="curriculum-heading">
          {singleSubject === undefined
            ? t('curriculum.heading')
            : subjectHeading(i18n, singleSubject)}
        </h1>
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

      {state.kind === 'ready' && tree.length === 0 ? (
        <div className="empty" data-testid="curriculum-empty">
          <h2>{t('curriculum.empty')}</h2>
          <p className="muted">{t('curriculum.emptyHint')}</p>
        </div>
      ) : null}

      {state.kind === 'ready' && tree.length > 0 ? (
        <div className="curriculum__tree" data-testid="curriculum-list">
          {tree.map((subjectGroup) => (
            <section
              key={subjectGroup.subject}
              className="curriculum__subject"
              data-testid={`curriculum-subject-${subjectGroup.subject}`}
              {...(singleSubject === undefined
                ? { 'aria-labelledby': `curriculum-subject-heading-${subjectGroup.subject}` }
                : { 'aria-label': subjectHeading(i18n, subjectGroup.subject) })}
            >
              {singleSubject === undefined ? (
                <Heading level={2} id={`curriculum-subject-heading-${subjectGroup.subject}`}>
                  {subjectHeading(i18n, subjectGroup.subject)}
                </Heading>
              ) : null}

              {subjectGroup.catalogs.map((catalogGroup: CurriculumCatalogGroup) => {
                const { catalog } = catalogGroup;
                return (
                  <article
                    key={catalog.catalogId}
                    className="curriculum__catalog"
                    data-testid={`curriculum-catalog-${catalog.catalogId}`}
                    aria-labelledby={`curriculum-catalog-heading-${catalog.catalogId}`}
                  >
                    <header className="curriculum__catalogHeader">
                      <Heading level={catalogLevel} id={`curriculum-catalog-heading-${catalog.catalogId}`}>
                        {catalog.label}
                      </Heading>
                      <span
                        className="badge badge--muted"
                        data-testid={`curriculum-catalog-status-${catalog.catalogId}`}
                      >
                        {catalog.status === 'verified'
                          ? t('curriculum.verified')
                          : t('curriculum.illustrative')}
                      </span>
                      {catalog.publisher === undefined ? null : (
                        <p className="muted small">
                          {t('curriculum.meta.publisher')}: {catalog.publisher}
                          {catalog.revision === undefined
                            ? null
                            : ` · ${t('curriculum.meta.revision')}: ${catalog.revision}`}
                        </p>
                      )}
                    </header>

                    {catalogGroup.books.map((bookGroup: CurriculumBookGroup) => (
                      <section
                        key={bookGroup.book.bookId}
                        className="curriculum__book"
                        data-testid={`curriculum-book-${bookGroup.book.bookId}`}
                        aria-labelledby={`curriculum-book-heading-${bookGroup.book.bookId}`}
                      >
                        <Heading
                          level={catalogLevel + 1}
                          id={`curriculum-book-heading-${bookGroup.book.bookId}`}
                        >
                          {bookGroup.book.label}
                        </Heading>
                        <ol className="curriculum__chapters">
                          {bookGroup.chapters.map((chapterGroup: CurriculumChapterGroup) => (
                            <li
                              key={chapterGroup.chapter.chapterId}
                              className="curriculum__chapter"
                              data-testid={`curriculum-chapter-${chapterGroup.chapter.chapterId}`}
                            >
                              <Heading level={catalogLevel + 2}>
                                {chapterGroup.chapter.label}
                                {chapterGroup.chapter.printedPage === undefined ? null : (
                                  <span className="curriculum__page">
                                    {t('curriculum.meta.page', {
                                      page: chapterGroup.chapter.printedPage,
                                    })}
                                  </span>
                                )}
                              </Heading>
                              {chapterGroup.entries.length > 0 ? (
                                <ol className="curriculum__entries">
                                  {chapterGroup.entries.map((entry: CurriculumItem) => (
                                    <li key={entry.placementId}>
                                      {renderEntry(entry, catalogLevel + 3)}
                                    </li>
                                  ))}
                                </ol>
                              ) : null}
                              {chapterGroup.sections.length > 0 ? (
                                <ol className="curriculum__sections">
                                  {chapterGroup.sections.map((sectionGroup: CurriculumSectionGroup) => (
                                    <li
                                      key={sectionGroup.section.sectionId}
                                      className="curriculum__section"
                                      data-testid={`curriculum-section-${sectionGroup.section.sectionId}`}
                                    >
                                      <p className="curriculum__sectionHead">
                                        <span className="curriculum__sectionLabel">
                                          {sectionGroup.section.label}
                                        </span>
                                        {sectionGroup.section.printedPage === undefined ? null : (
                                          <span className="curriculum__page">
                                            {t('curriculum.meta.page', {
                                              page: sectionGroup.section.printedPage,
                                            })}
                                          </span>
                                        )}
                                      </p>
                                      {sectionGroup.entries.length === 0 ? (
                                        <p className="muted small">
                                          {t('curriculum.sectionEmpty')}
                                        </p>
                                      ) : (
                                        <ol className="curriculum__entries">
                                          {sectionGroup.entries.map((entry: CurriculumItem) => (
                                            <li key={entry.placementId}>
                                              {renderEntry(entry, catalogLevel + 4)}
                                            </li>
                                          ))}
                                        </ol>
                                      )}
                                    </li>
                                  ))}
                                </ol>
                              ) : null}
                              {chapterGroup.entries.length === 0 &&
                              chapterGroup.sections.length === 0 ? (
                                <p className="muted small">{t('curriculum.chapterEmpty')}</p>
                              ) : null}
                            </li>
                          ))}
                        </ol>
                      </section>
                    ))}
                  </article>
                );
              })}
            </section>
          ))}
        </div>
      ) : null}
    </section>
  );
}
