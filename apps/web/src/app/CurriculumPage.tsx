import { useEffect, useState } from 'react';
import type { Locale } from '../experiment/contract';
import type { I18n } from '../i18n';
import type { ApiClient, CurriculumItem } from '../services/api';
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
  | { readonly kind: 'ready'; readonly items: readonly CurriculumItem[] };

/**
 * Curriculum directory (ADR-003).
 *
 * This is the page that makes the chapter entrances reachable by navigation rather than by
 * typing a URL. It lists what the *server* publishes (`GET /api/curriculum`), says clearly
 * which entries are pilot examples rather than verified textbook chapters, and links each
 * one to its own context page. Two entries pointing at the same experiment are expected:
 * one tool, several curriculum positions.
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

  return (
    <section className="curriculum" aria-labelledby="curriculum-heading">
      <div className="catalog__intro">
        <h1 id="curriculum-heading">{t('curriculum.heading')}</h1>
        <p className="muted">{t('curriculum.subheading')}</p>
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

      {state.kind === 'ready' && state.items.length === 0 ? (
        <div className="empty" data-testid="curriculum-empty">
          <h2>{t('curriculum.empty')}</h2>
          <p className="muted">{t('curriculum.emptyHint')}</p>
        </div>
      ) : null}

      {state.kind === 'ready' && state.items.length > 0 ? (
        <ul className="cards" data-testid="curriculum-list">
          {state.items.map((item) => {
            const href = placementHref(item.slug, locale);
            return (
              <li key={item.placementId}>
                <article className="card" data-testid={`curriculum-entry-${item.slug}`}>
                  <div className="card__meta">
                    <span className="badge">{item.edition.label}</span>
                    <span
                      className="badge badge--muted"
                      data-testid={`curriculum-status-${item.slug}`}
                    >
                      {item.status === 'verified'
                        ? t('curriculum.verified')
                        : t('curriculum.illustrative')}
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
                  <p className="muted">{item.summary}</p>
                  <dl className="curriculum__meta">
                    <div>
                      <dt>{t('curriculum.meta.edition')}</dt>
                      <dd>{item.edition.label}</dd>
                    </div>
                    <div>
                      <dt>{t('curriculum.meta.book')}</dt>
                      <dd>{item.book.label}</dd>
                    </div>
                    <div>
                      <dt>{t('curriculum.meta.chapter')}</dt>
                      <dd>{item.chapter.label}</dd>
                    </div>
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
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
