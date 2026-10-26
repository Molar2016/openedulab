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
import {
  aboutHref,
  catalogHref,
  loginHref,
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
    <ExperimentHost
      entry={entry}
      locale={locale}
      i18n={i18n}
      services={services}
      contentVersion={state.detail.contentVersion}
      reviewedStatus={state.detail.reviewedStatus}
      onBack={onBack}
    />
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
