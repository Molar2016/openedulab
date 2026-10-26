import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Locale } from '../experiment/contract';
import { SDK_VERSION } from '../experiment/contract';
import { getExperimentBySlug, type RegistryEntry } from '../experiment/registry';
import { ExperimentHost } from '../host/ExperimentHost';
import { createI18n, persistLocale, resolveInitialLocale } from '../i18n';
import type { AppServices } from '../services';
import { ApiError, type ExperimentDetail } from '../services/api';
import { CatalogPage } from './CatalogPage';
import { LoginPage } from './LoginPage';
import { MePage } from './MePage';
import {
  aboutHref,
  catalogHref,
  loginHref,
  meHref,
  parseRoute,
  nextFromSearch,
  type Route,
} from './router';

interface Props {
  services: AppServices;
}

type SessionState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'authenticated'; readonly displayHint: string };

function NotFound({
  i18n,
  navigate,
}: {
  i18n: ReturnType<typeof createI18n>;
  navigate: (to: string) => void;
}): JSX.Element {
  return (
    <section className="empty" data-testid="not-found">
      <h1>{i18n.t('notFound.title')}</h1>
      <p className="muted">{i18n.t('notFound.body')}</p>
      <button type="button" className="button" onClick={() => navigate(catalogHref(i18n.locale))}>
        {i18n.t('notFound.home')}
      </button>
    </section>
  );
}

function About({ i18n }: { i18n: ReturnType<typeof createI18n> }): JSX.Element {
  return (
    <section className="about" aria-labelledby="about-heading">
      <h1 id="about-heading">{i18n.t('about.heading')}</h1>
      <p>{i18n.t('about.body')}</p>
      <h2>{i18n.t('about.privacyHeading')}</h2>
      <p>{i18n.t('about.privacyBody')}</p>
      <p className="muted">{i18n.t('about.unverified')}</p>
      <p className="muted">{i18n.t('about.licensePending')}</p>
    </section>
  );
}

type ExperimentState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly detail: ExperimentDetail };

/** What the server says about this account's saved parameters (design §7.5). */
type SavedView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'none' }
  | { readonly kind: 'saved'; readonly values: Readonly<Record<string, number | string>> }
  | { readonly kind: 'incompatible' }
  | { readonly kind: 'error' };

/**
 * One experiment route: metadata is fetched from `GET /api/experiments/:id` before the
 * experiment renders, so the page itself is a protected resource rather than a local
 * module that happens to be in the bundle.
 */
function ExperimentRoute({
  entry,
  locale,
  i18n,
  services,
  onBack,
}: {
  entry: RegistryEntry;
  locale: Locale;
  i18n: ReturnType<typeof createI18n>;
  services: AppServices;
  onBack: () => void;
}): JSX.Element {
  const [state, setState] = useState<ExperimentState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [favorite, setFavorite] = useState<{ kind: 'unknown' | 'on' | 'off'; busy: boolean; error: boolean }>(
    { kind: 'unknown', busy: false, error: false },
  );
  const [recentFailed, setRecentFailed] = useState(false);
  const [savedView, setSavedView] = useState<SavedView>({ kind: 'loading' });
  const [savedBusy, setSavedBusy] = useState(false);
  const [savedError, setSavedError] = useState<'none' | 'save' | 'delete'>('none');
  const experimentId = entry.manifest.id;

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    services.api
      .experiment(entry.manifest.id, locale)
      .then((detail) => {
        if (!cancelled) setState({ kind: 'ready', detail });
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        const code = failure instanceof ApiError ? failure.code : 'network_error';
        setState({ kind: code === 'not_found' ? 'missing' : 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [services, entry.manifest.id, locale, reloadToken]);

  /**
   * Opening an experiment records "which resource, when" — once, on mount, deduplicated by
   * the server. It is a convenience: if it fails the experiment still works and the page
   * says the list was not updated. Nothing about the parameters is sent.
   */
  const readyContentVersion = state.kind === 'ready' ? state.detail.contentVersion : '';

  useEffect(() => {
    if (state.kind !== 'ready') return;
    let cancelled = false;
    services.api
      .recordRecent(experimentId)
      .catch(() => {
        if (!cancelled) setRecentFailed(true);
      });
    services.api
      .favorites()
      .then((items) => {
        if (cancelled) return;
        setFavorite({
          kind: items.some((item) => item.experimentId === experimentId) ? 'on' : 'off',
          busy: false,
          error: false,
        });
      })
      .catch(() => {
        if (!cancelled) setFavorite({ kind: 'unknown', busy: false, error: true });
      });

    /**
     * Saved parameters are compared against the version this page is running, not against
     * whatever the server happens to hold: a snapshot from an older content or schema
     * version must not be applied, and the UI says so instead of guessing (design §7.5).
     */
    services.api
      .savedState(experimentId)
      .then((snapshot) => {
        if (cancelled) return;
        if (snapshot === null) {
          setSavedView({ kind: 'none' });
          return;
        }
        const schemaVersion = entry.stateSchema?.version;
        const compatible =
          schemaVersion !== undefined &&
          snapshot.stateSchemaVersion === schemaVersion &&
          snapshot.contentVersion === readyContentVersion;
        setSavedView(
          compatible ? { kind: 'saved', values: snapshot.values } : { kind: 'incompatible' },
        );
      })
      .catch(() => {
        if (!cancelled) setSavedView({ kind: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, [state.kind, services, experimentId, entry.stateSchema, readyContentVersion]);

  const toggleFavorite = useCallback((): void => {
    const adding = favorite.kind !== 'on';
    setFavorite((previous) => ({ ...previous, busy: true, error: false }));
    const call = adding
      ? services.api.addFavorite(experimentId)
      : services.api.removeFavorite(experimentId);
    call
      .then(() => setFavorite({ kind: adding ? 'on' : 'off', busy: false, error: false }))
      .catch(() => setFavorite((previous) => ({ ...previous, busy: false, error: true })));
  }, [favorite.kind, services, experimentId]);

  /**
   * Saving is an explicit user action with a real failure mode: a failed write is reported
   * as "not saved" and the previously stored snapshot is left alone (the server only
   * overwrites on a successful, validated write).
   */
  const saveSettings = useCallback(
    (values: Readonly<Record<string, number | string>>): void => {
      const schema = entry.stateSchema;
      if (schema === null) return;
      setSavedBusy(true);
      setSavedError('none');
      services.api
        .saveState(experimentId, { stateSchemaVersion: schema.version, values })
        .then((snapshot) => setSavedView({ kind: 'saved', values: snapshot.values }))
        .catch(() => setSavedError('save'))
        .finally(() => setSavedBusy(false));
    },
    [entry.stateSchema, experimentId, services],
  );

  const deleteSettings = useCallback((): void => {
    setSavedBusy(true);
    setSavedError('none');
    services.api
      .deleteState(experimentId)
      .then(() => setSavedView({ kind: 'none' }))
      .catch(() => setSavedError('delete'))
      .finally(() => setSavedBusy(false));
  }, [experimentId, services]);

  if (state.kind === 'loading') {
    return (
      <p className="muted" role="status" data-testid="experiment-loading">
        {i18n.t('experiment.loading')}
      </p>
    );
  }

  if (state.kind === 'missing') {
    return <NotFound i18n={i18n} navigate={() => onBack()} />;
  }

  if (state.kind === 'error') {
    return (
      <section className="empty" role="alert" data-testid="experiment-meta-error">
        <h1>{i18n.t('catalog.error.title')}</h1>
        <p className="muted">{i18n.t('catalog.error.body')}</p>
        <button type="button" className="button" onClick={() => setReloadToken((value) => value + 1)}>
          {i18n.t('catalog.error.retry')}
        </button>
      </section>
    );
  }

  return (
    <>
      <ExperimentHost
        entry={entry}
        locale={locale}
        i18n={i18n}
        services={services}
        contentVersion={state.detail.contentVersion}
        reviewedStatus={state.detail.reviewedStatus}
        appVersion={services.appVersion}
        onSubmitFeedback={async (payload) => {
          await services.api.submitFeedback({ ...payload, locale });
        }}
        {...(favorite.kind === 'unknown'
          ? {}
          : {
              favorite: {
                active: favorite.kind === 'on',
                busy: favorite.busy,
                error: favorite.error,
                onToggle: toggleFavorite,
              },
            })}
        {...(savedView.kind === 'loading'
          ? {}
          : {
              savedState: {
                status: savedView.kind,
                ...(savedView.kind === 'saved' ? { values: savedView.values } : {}),
                busy: savedBusy,
                error: savedError,
                onSave: saveSettings,
                onDelete: deleteSettings,
              },
            })}
        onBack={onBack}
      />
      {recentFailed ? (
        <p className="muted small" role="status" data-testid="recent-notice">
          {i18n.t('experiment.recentFailed')}
        </p>
      ) : null}
    </>
  );
}

/**
 * Root component.
 *
 * The session is asked for once on load and after every credential change; the answer
 * decides what may be rendered. This is a convenience layer only — the server gate
 * (`requireSession`, deep-link 302) is what actually protects the resources, so a client
 * that ignores this component still gets nothing.
 */
export function App({ services }: Props): JSX.Element {
  const [locale, setLocale] = useState<Locale>(() => resolveInitialLocale());
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [session, setSession] = useState<SessionState>({ kind: 'loading' });
  const [pendingNext, setPendingNext] = useState<string | null>(() =>
    nextFromSearch(window.location.search),
  );
  const [accountError, setAccountError] = useState<string | null>(null);

  const i18n = useMemo(
    () =>
      createI18n(locale, {
        onMissingKey: (key, activeLocale) => {
          console.warn(`[i18n] missing key "${key}" for ${activeLocale}`);
        },
      }),
    [locale],
  );

  const navigate = useCallback((to: string): void => {
    const next = new URL(to, window.location.origin);
    const current = `${window.location.pathname}${window.location.search}`;
    const target = `${next.pathname}${next.search}`;
    if (target !== current) {
      window.history.pushState({}, '', target);
    }
    setRoute(parseRoute(next.pathname));
    setPendingNext(nextFromSearch(next.search));
  }, []);

  useEffect(() => {
    const onPopState = (): void => {
      setRoute(parseRoute(window.location.pathname));
      setPendingNext(nextFromSearch(window.location.search));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    services.api
      .session()
      .then((info) => {
        if (cancelled) return;
        setSession(
          info.authenticated && info.account !== undefined
            ? { kind: 'authenticated', displayHint: info.account.displayHint }
            : { kind: 'anonymous' },
        );
      })
      .catch(() => {
        if (!cancelled) setSession({ kind: 'anonymous' });
      });
    return () => {
      cancelled = true;
    };
  }, [services]);

  useEffect(() => {
    document.documentElement.lang = locale;
    persistLocale(locale);
    const params = new URLSearchParams(window.location.search);
    if (params.get('lang') !== locale) {
      params.set('lang', locale);
      window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
    }
  }, [locale]);

  useEffect(() => {
    const onError = (): void => services.errors.report({ code: 'unknown_error' });
    const onRejection = (): void => services.errors.report({ code: 'unknown_error' });
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [services]);

  useEffect(() => {
    try {
      window.scrollTo(0, 0);
    } catch {
      // jsdom and some embedded webviews do not implement scrolling.
    }
  }, [route]);

  const handleAuthenticated = useCallback(
    (displayHint: string): void => {
      setSession({ kind: 'authenticated', displayHint });
      setAccountError(null);
      const target = pendingNext ?? '/';
      navigate(target);
    },
    [navigate, pendingNext],
  );

  const handleLogout = useCallback((): void => {
    setAccountError(null);
    services.api
      .logout()
      .then(() => {
        setSession({ kind: 'anonymous' });
        navigate(loginHref(locale, null));
      })
      .catch((failure: unknown) => {
        // A failed logout must not look like a successful one: the session may still be
        // alive on the server, so the UI keeps showing "signed in" and says why.
        const code = failure instanceof ApiError ? failure.code : 'network_error';
        setAccountError(
          code === 'network_error'
            ? i18n.t('account.logoutOffline')
            : i18n.t('account.logoutFailed'),
        );
      });
  }, [i18n, locale, navigate, services]);

  const authenticated = session.kind === 'authenticated';
  const experimentEntry = route.name === 'experiment' ? getExperimentBySlug(route.slug) : undefined;
  const currentPath = `${window.location.pathname}${window.location.search}`;
  const nextTarget = pendingNext ?? (route.name === 'catalog' ? null : currentPath);

  const body = ((): JSX.Element => {
    if (route.name === 'about') {
      return <About i18n={i18n} />;
    }
    if (route.name === 'login' || route.name === 'register') {
      return (
        <LoginPage
          mode={route.name === 'register' ? 'register' : 'login'}
          i18n={i18n}
          api={services.api}
          locale={locale}
          next={pendingNext}
          onAuthenticated={handleAuthenticated}
          navigate={navigate}
        />
      );
    }
    if (session.kind === 'loading') {
      return (
        <p className="muted" role="status" data-testid="session-loading">
          {i18n.t('auth.session.loading')}
        </p>
      );
    }
    if (session.kind === 'anonymous') {
      return (
        <LoginPage
          mode="login"
          i18n={i18n}
          api={services.api}
          locale={locale}
          next={nextTarget}
          onAuthenticated={handleAuthenticated}
          navigate={navigate}
        />
      );
    }
    if (route.name === 'catalog') {
      return <CatalogPage api={services.api} locale={locale} i18n={i18n} navigate={navigate} />;
    }
    if (route.name === 'me') {
      return <MePage api={services.api} locale={locale} i18n={i18n} navigate={navigate} />;
    }
    if (route.name === 'experiment') {
      return experimentEntry === undefined ? (
        <NotFound i18n={i18n} navigate={navigate} />
      ) : (
        <ExperimentRoute
          entry={experimentEntry}
          locale={locale}
          i18n={i18n}
          services={services}
          onBack={() => navigate(catalogHref(locale))}
        />
      );
    }
    return <NotFound i18n={i18n} navigate={navigate} />;
  })();

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        {i18n.t('app.skipToContent')}
      </a>

      <header className="app-header">
        <div className="app-header__brand">
          <a
            href={catalogHref(locale)}
            className="brand"
            onClick={(event) => {
              event.preventDefault();
              navigate(catalogHref(locale));
            }}
          >
            {i18n.t('app.title')}
          </a>
          <p className="muted small">{i18n.t('app.tagline')}</p>
        </div>

        <nav className="app-header__nav" aria-label={i18n.t('nav.catalog')}>
          {authenticated ? (
            <a
              href={catalogHref(locale)}
              aria-current={route.name === 'catalog' ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault();
                navigate(catalogHref(locale));
              }}
            >
              {i18n.t('nav.catalog')}
            </a>
          ) : null}
          {authenticated ? (
            <a
              href={meHref(locale)}
              aria-current={route.name === 'me' ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault();
                navigate(meHref(locale));
              }}
            >
              {i18n.t('nav.me')}
            </a>
          ) : null}
          <a
            href={aboutHref(locale)}
            aria-current={route.name === 'about' ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate(aboutHref(locale));
            }}
          >
            {i18n.t('nav.about')}
          </a>
        </nav>

        <div className="locale-switch" role="group" aria-label={i18n.t('locale.switchLabel')}>
          <button type="button" aria-pressed={locale === 'zh-CN'} onClick={() => setLocale('zh-CN')}>
            {i18n.t('locale.zh')}
          </button>
          <button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>
            {i18n.t('locale.en')}
          </button>
        </div>

        {session.kind === 'authenticated' ? (
          <div className="account" data-testid="account-block">
            <span className="account__hint small">
              {i18n.t('account.signedInAs', { hint: session.displayHint })}
            </span>
            <button
              type="button"
              className="button button--ghost small"
              onClick={handleLogout}
              data-testid="logout-button"
            >
              {i18n.t('account.logout')}
            </button>
          </div>
        ) : null}
      </header>

      {accountError !== null ? (
        <p className="auth__error" role="alert" data-testid="account-error">
          {accountError}
        </p>
      ) : null}

      <main id="main">{body}</main>

      <footer className="app-footer">
        <a
          href={aboutHref(locale)}
          onClick={(event) => {
            event.preventDefault();
            navigate(aboutHref(locale));
          }}
        >
          {i18n.t('footer.privacy')}
        </a>
        <span className="muted small">{i18n.t('footer.disclaimer')}</span>
        <span className="muted small">
          v{services.appVersion} · SDK {SDK_VERSION}
        </span>
      </footer>
    </div>
  );
}
