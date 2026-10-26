import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Locale } from '../experiment/contract';
import { SDK_VERSION } from '../experiment/contract';
import { getExperimentBySlug } from '../experiment/registry';
import { ExperimentHost } from '../host/ExperimentHost';
import { createI18n, persistLocale, resolveInitialLocale } from '../i18n';
import type { AppServices } from '../services';
import { CatalogPage } from './CatalogPage';
import { aboutHref, catalogHref, parseRoute, type Route } from './router';

interface Props {
  services: AppServices;
}

function NotFound({ i18n, navigate }: { i18n: ReturnType<typeof createI18n>; navigate: (to: string) => void }): JSX.Element {
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
      <p className="muted">{i18n.t('about.noAccounts')}</p>
      <p className="muted">{i18n.t('about.licensePending')}</p>
      <p className="muted small">{i18n.t('footer.noBackend')}</p>
    </section>
  );
}

export function App({ services }: Props): JSX.Element {
  const [locale, setLocale] = useState<Locale>(() => resolveInitialLocale());
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

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
    if (target === current) return;
    window.history.pushState({}, '', target);
    setRoute(parseRoute(next.pathname));
  }, []);

  useEffect(() => {
    const onPopState = (): void => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

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

  const experimentEntry = route.name === 'experiment' ? getExperimentBySlug(route.slug) : undefined;

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
      </header>

      <p className="no-login small">{i18n.t('app.noLogin')}</p>

      <main id="main">
        {route.name === 'catalog' ? (
          <CatalogPage locale={locale} i18n={i18n} navigate={navigate} />
        ) : null}

        {route.name === 'about' ? <About i18n={i18n} /> : null}

        {route.name === 'experiment' ? (
          experimentEntry ? (
            <ExperimentHost
              entry={experimentEntry}
              locale={locale}
              i18n={i18n}
              services={services}
              onBack={() => navigate(catalogHref(locale))}
            />
          ) : (
            <NotFound i18n={i18n} navigate={navigate} />
          )
        ) : null}

        {route.name === 'notFound' ? <NotFound i18n={i18n} navigate={navigate} /> : null}
      </main>

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
        <span className="muted small">{i18n.t('footer.noBackend')}</span>
      </footer>
    </div>
  );
}
