import { useEffect, useMemo, useState } from 'react';
import type { Locale } from '../experiment/contract';
import type { I18n } from '../i18n';
import type { ApiClient, CatalogItem } from '../services/api';
import { experimentHref } from './router';

interface Props {
  api: ApiClient;
  locale: Locale;
  i18n: I18n;
  navigate: (to: string) => void;
}

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly items: readonly CatalogItem[] };

function tagLabel(i18n: I18n, kind: 'subject' | 'grade' | 'concept', value: string): string {
  const key = `tag.${kind}.${value}`;
  const label = i18n.t(key);
  return label === key ? value : label;
}

/**
 * Catalog (design §7.2, R-07).
 *
 * The list comes from `GET /api/catalog`, i.e. from an authenticated request — the page
 * shows no experiment metadata before the server answered. This screen is deliberately
 * search-only: a teacher who knows the tool they need types its name, and the subject /
 * grade-band / concept chip rows that used to sit above the list are gone. Matching happens
 * on the fetched set so the UI stays responsive; the API keeps its filters for older clients
 * and is still tested for them.
 */
export function CatalogPage({ api, locale, i18n, navigate }: Props): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const t = (key: string, params?: Record<string, string | number>): string => i18n.t(key, params);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    api
      .catalog({ locale })
      .then((items) => {
        if (!cancelled) setState({ kind: 'ready', items });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [api, locale, reloadToken]);

  const items = useMemo(
    () => (state.kind === 'ready' ? state.items : []),
    [state],
  );

  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  const visible = items.filter((item) => {
    if (tokens.length === 0) return true;
    const haystack = [
      item.title,
      item.description,
      item.id,
      item.slug,
      ...item.subjects.map((value) => tagLabel(i18n, 'subject', value)),
      ...item.grades.map((value) => tagLabel(i18n, 'grade', value)),
      ...item.concepts.map((value) => tagLabel(i18n, 'concept', value)),
    ]
      .join(' ')
      .toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });

  const clearSearch = (): void => setQuery('');

  return (
    <section className="catalog" aria-labelledby="catalog-heading">
      <div className="catalog__intro">
        <h1 id="catalog-heading">{t('catalog.heading')}</h1>
        <p className="muted">{t('catalog.subheading')}</p>
      </div>

      {state.kind === 'error' ? (
        <div className="empty" role="alert" data-testid="catalog-error">
          <h2>{t('catalog.error.title')}</h2>
          <p className="muted">{t('catalog.error.body')}</p>
          <button type="button" className="button" onClick={() => setReloadToken((value) => value + 1)}>
            {t('catalog.error.retry')}
          </button>
        </div>
      ) : null}

      {state.kind === 'loading' ? (
        <p className="muted" role="status" data-testid="catalog-loading">
          {t('catalog.loading')}
        </p>
      ) : null}

      {state.kind === 'ready' ? (
        <>
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

          <div className="catalog__summary">
            <p aria-live="polite" className="small" data-testid="result-count">
              {t('catalog.resultCount', { count: visible.length })}
            </p>
            {query.trim() === '' || visible.length === 0 ? null : (
              <button type="button" className="button button--ghost small" onClick={clearSearch}>
                {t('catalog.clearSearch')}
              </button>
            )}
          </div>

          {visible.length === 0 ? (
            <div className="empty" data-testid="catalog-empty">
              <h2>{t('catalog.empty')}</h2>
              <p className="muted">{t('catalog.emptyHint')}</p>
              <button type="button" className="button" onClick={clearSearch}>
                {t('catalog.clearSearch')}
              </button>
            </div>
          ) : (
            <ul className="cards">
              {visible.map((item) => {
                const href = experimentHref(item.slug, locale);
                return (
                  <li key={item.id}>
                    <article className="card" data-testid={`experiment-card-${item.slug}`}>
                      <div className="card__meta">
                        <span className="badge">{tagLabel(i18n, 'subject', item.subjects[0] ?? '')}</span>
                        <span className="badge badge--muted">
                          {t('catalog.contentVersion', { version: item.contentVersion })}
                        </span>
                      </div>
                      <h2>
                        <a
                          href={href}
                          onClick={(event) => {
                            event.preventDefault();
                            navigate(href);
                          }}
                        >
                          {item.title}
                        </a>
                      </h2>
                      <p className="muted">{item.description}</p>
                      <ul className="tags">
                        {item.grades.map((value) => (
                          <li key={`grade-${value}`}>{tagLabel(i18n, 'grade', value)}</li>
                        ))}
                        {item.concepts.map((value) => (
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
        </>
      ) : null}
    </section>
  );
}
