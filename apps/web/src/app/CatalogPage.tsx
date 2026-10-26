import { useMemo, useState } from 'react';
import type { Locale } from '../experiment/contract';
import { experiments, textFor } from '../experiment/registry';
import type { I18n } from '../i18n';
import { experimentHref } from './router';

interface Props {
  locale: Locale;
  i18n: I18n;
  navigate: (to: string) => void;
}

const ALL = 'all';

function tagLabel(i18n: I18n, kind: 'subject' | 'grade' | 'concept', value: string): string {
  const key = `tag.${kind}.${value}`;
  const label = i18n.t(key);
  return label === key ? value : label;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function CatalogPage({ locale, i18n, navigate }: Props): JSX.Element {
  const [query, setQuery] = useState('');
  const [subject, setSubject] = useState(ALL);
  const [grade, setGrade] = useState(ALL);
  const [concept, setConcept] = useState(ALL);
  const t = (key: string, params?: Record<string, string | number>): string => i18n.t(key, params);

  const available = useMemo(() => experiments.filter((entry) => entry.compatible && entry.issues.length === 0), []);

  const options = useMemo(
    () => ({
      subjects: uniqueSorted(available.flatMap((entry) => entry.manifest.subjects)),
      grades: uniqueSorted(available.flatMap((entry) => entry.manifest.grades)),
      concepts: uniqueSorted(available.flatMap((entry) => entry.manifest.concepts)),
    }),
    [available],
  );

  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  const visible = available.filter((entry) => {
    if (subject !== ALL && !entry.manifest.subjects.includes(subject)) return false;
    if (grade !== ALL && !entry.manifest.grades.includes(grade)) return false;
    if (concept !== ALL && !entry.manifest.concepts.includes(concept)) return false;
    if (tokens.length === 0) return true;
    const haystack = [
      textFor(entry, locale, 'title'),
      textFor(entry, locale, 'description'),
      entry.manifest.id,
      entry.manifest.slug,
      ...entry.manifest.subjects.map((value) => tagLabel(i18n, 'subject', value)),
      ...entry.manifest.grades.map((value) => tagLabel(i18n, 'grade', value)),
      ...entry.manifest.concepts.map((value) => tagLabel(i18n, 'concept', value)),
    ]
      .join(' ')
      .toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });

  const hasFilters = subject !== ALL || grade !== ALL || concept !== ALL || query.trim() !== '';
  const clearFilters = (): void => {
    setQuery('');
    setSubject(ALL);
    setGrade(ALL);
    setConcept(ALL);
  };

  const filterGroup = (
    label: string,
    values: string[],
    selected: string,
    onSelect: (value: string) => void,
    kind: 'subject' | 'grade' | 'concept',
  ): JSX.Element => (
    <div className="filter" role="group" aria-label={label}>
      <span className="filter__label">{label}</span>
      <div className="chips">
        <button type="button" aria-pressed={selected === ALL} onClick={() => onSelect(ALL)}>
          {t('catalog.all')}
        </button>
        {values.map((value) => (
          <button key={value} type="button" aria-pressed={selected === value} onClick={() => onSelect(value)}>
            {tagLabel(i18n, kind, value)}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <section className="catalog" aria-labelledby="catalog-heading">
      <div className="catalog__intro">
        <h1 id="catalog-heading">{t('catalog.heading')}</h1>
        <p className="muted">{t('catalog.subheading')}</p>
      </div>

      <div className="search">
        <label htmlFor="catalog-search">{t('catalog.searchLabel')}</label>
        <input
          id="catalog-search"
          type="search"
          value={query}
          placeholder={t('catalog.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="filters" aria-label={t('catalog.filters')}>
        {filterGroup(t('catalog.filter.subject'), options.subjects, subject, setSubject, 'subject')}
        {filterGroup(t('catalog.filter.grade'), options.grades, grade, setGrade, 'grade')}
        {filterGroup(t('catalog.filter.concept'), options.concepts, concept, setConcept, 'concept')}
      </div>

      <div className="catalog__summary">
        <p aria-live="polite" className="small" data-testid="result-count">
          {t('catalog.resultCount', { count: visible.length })}
        </p>
        {hasFilters ? (
          <button type="button" className="button button--ghost small" onClick={clearFilters}>
            {t('catalog.clearFilters')}
          </button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <div className="empty" data-testid="catalog-empty">
          <h2>{t('catalog.empty')}</h2>
          <p className="muted">{t('catalog.emptyHint')}</p>
          <button type="button" className="button" onClick={clearFilters}>
            {t('catalog.clearFilters')}
          </button>
        </div>
      ) : (
        <ul className="cards">
          {visible.map((entry) => {
            const href = experimentHref(entry.manifest.slug, locale);
            const title = textFor(entry, locale, 'title');
            return (
              <li key={entry.manifest.id}>
                <article className="card" data-testid={`experiment-card-${entry.manifest.slug}`}>
                  <div className="card__meta">
                    <span className="badge">{tagLabel(i18n, 'subject', entry.manifest.subjects[0])}</span>
                    <span className="badge badge--muted">
                      {entry.manifest.reviewedStatus === 'verified'
                        ? t('catalog.reviewed.verified')
                        : t('catalog.reviewed.draft')}
                    </span>
                    <span className="badge badge--muted">v{entry.manifest.moduleVersion}</span>
                  </div>
                  <h2>
                    <a
                      href={href}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(href);
                      }}
                    >
                      {title}
                    </a>
                  </h2>
                  <p className="muted">{textFor(entry, locale, 'description')}</p>
                  <ul className="tags">
                    {entry.manifest.grades.map((value) => (
                      <li key={`grade-${value}`}>{tagLabel(i18n, 'grade', value)}</li>
                    ))}
                    {entry.manifest.concepts.map((value) => (
                      <li key={`concept-${value}`}>{tagLabel(i18n, 'concept', value)}</li>
                    ))}
                  </ul>
                  <a
                    className="button"
                    href={href}
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(href);
                    }}
                  >
                    {t('catalog.start')}
                  </a>
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
