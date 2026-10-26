import { useCallback, useEffect, useState } from 'react';
import type { Locale } from '../experiment/contract';
import type { I18n } from '../i18n';
import type { ApiClient, CatalogItem, FavoriteItem, RecentItem } from '../services/api';
import { experimentHref } from './router';

interface Props {
  api: ApiClient;
  locale: Locale;
  i18n: I18n;
  navigate: (to: string) => void;
}

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: 'load' | 'write' }
  | {
      readonly kind: 'ready';
      readonly catalog: readonly CatalogItem[];
      readonly favorites: readonly FavoriteItem[];
      readonly recent: readonly RecentItem[];
    };

/**
 * "My library" (design §3 A, R-11/R-12/R-13).
 *
 * Two separate things are shown and never mixed: favorites (explicit, strongly
 * consistent) and recent use (which resource, when last). Recent use comes from
 * `/api/me/recent`, not from usage events — and it shows no parameter values, because
 * none are stored.
 */
export function MePage({ api, locale, i18n, navigate }: Props): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  const t = (key: string, params?: Record<string, string | number>): string => i18n.t(key, params);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    Promise.all([api.catalog({ locale }), api.favorites(), api.recent(20)])
      .then(([catalog, favorites, recent]) => {
        if (!cancelled) setState({ kind: 'ready', catalog, favorites, recent });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error', message: 'load' });
      });
    return () => {
      cancelled = true;
    };
  }, [api, locale, reloadToken]);

  const removeFavorite = useCallback(
    (experimentId: string): void => {
      setBusyId(experimentId);
      api
        .removeFavorite(experimentId)
        .then(() => setReloadToken((value) => value + 1))
        .catch(() => setState({ kind: 'error', message: 'write' }))
        .finally(() => setBusyId(null));
    },
    [api],
  );

  if (state.kind === 'loading') {
    return (
      <p className="muted" role="status" data-testid="me-loading">
        {t('me.loading')}
      </p>
    );
  }

  if (state.kind === 'error') {
    return (
      <section className="empty" role="alert" data-testid="me-error">
        <h1>{state.message === 'write' ? t('me.error.writeTitle') : t('me.error.title')}</h1>
        <p className="muted">
          {state.message === 'write' ? t('me.error.writeBody') : t('me.error.body')}
        </p>
        <button type="button" className="button" onClick={() => setReloadToken((value) => value + 1)}>
          {t('me.error.retry')}
        </button>
      </section>
    );
  }

  const byId = new Map(state.catalog.map((item) => [item.id, item]));

  const card = (experimentId: string, action: JSX.Element | null): JSX.Element => {
    const item = byId.get(experimentId);
    if (item === undefined) {
      // A reference to content that is no longer published: say so instead of hiding it.
      return (
        <li key={experimentId} className="me__item me__item--missing">
          <span className="muted">{t('me.unavailable', { id: experimentId })}</span>
        </li>
      );
    }
    const href = experimentHref(item.slug, locale);
    return (
      <li key={experimentId} className="me__item" data-testid={`item-${item.slug}`}>
        <div>
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              navigate(href);
            }}
          >
            {item.title}
          </a>
          <p className="muted small">{item.description}</p>
        </div>
        {action}
      </li>
    );
  };

  return (
    <section className="me" aria-labelledby="me-heading">
      <h1 id="me-heading">{t('me.heading')}</h1>
      <p className="muted">{t('me.subheading')}</p>

      <section className="me__section" aria-labelledby="me-favorites-heading">
        <h2 id="me-favorites-heading">{t('me.favoritesHeading')}</h2>
        {state.favorites.length === 0 ? (
          <p className="muted" data-testid="favorites-empty">
            {t('me.favoritesEmpty')}
          </p>
        ) : (
          <ul className="me__list" data-testid="favorites-list">
            {state.favorites.map((favorite) =>
              card(
                favorite.experimentId,
                <button
                  type="button"
                  className="button button--ghost small"
                  disabled={busyId === favorite.experimentId}
                  onClick={() => removeFavorite(favorite.experimentId)}
                  data-testid={`remove-${favorite.experimentId}`}
                >
                  {t('me.remove')}
                </button>,
              ),
            )}
          </ul>
        )}
      </section>

      <section className="me__section" aria-labelledby="me-recent-heading">
        <h2 id="me-recent-heading">{t('me.recentHeading')}</h2>
        {state.recent.length === 0 ? (
          <p className="muted" data-testid="recent-empty">
            {t('me.recentEmpty')}
          </p>
        ) : (
          <ul className="me__list" data-testid="recent-list">
            {state.recent.map((entry) =>
              card(
                entry.experimentId,
                <span className="muted small" data-testid={`opened-${entry.experimentId}`}>
                  {new Date(entry.lastOpenedAt).toLocaleString(locale)}
                </span>,
              ),
            )}
          </ul>
        )}
        <p className="muted small">{t('me.recentNote')}</p>
      </section>
    </section>
  );
}
