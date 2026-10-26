import { useState } from 'react';
import type { I18n } from '../i18n';
import { ApiError, type ApiClient, type LoginKind } from '../services/api';
import { loginHref, registerHref } from './router';

interface Props {
  mode: 'login' | 'register';
  i18n: I18n;
  api: ApiClient;
  locale: string;
  /** Validated in-site path to open after signing in. */
  next: string | null;
  onAuthenticated: (displayHint: string) => void;
  navigate: (to: string) => void;
}

const MIN_PASSWORD_LENGTH = 10;

/**
 * Sign-in / registration (design §7.1, R-01..R-03).
 *
 * The form deliberately shows the same message for "wrong password" and "unknown
 * identifier", states that the identifier is not verified, and never claims success
 * before the server answered. Errors from the API are mapped to translated text; the
 * raw error body is not rendered.
 */
export function LoginPage({
  mode,
  i18n,
  api,
  locale,
  next,
  onAuthenticated,
  navigate,
}: Props): JSX.Element {
  const [loginKind, setLoginKind] = useState<LoginKind>('email');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const t = (key: string, params?: Record<string, string | number>): string => i18n.t(key, params);
  const isRegister = mode === 'register';

  const messageFor = (failure: unknown): string => {
    if (failure instanceof ApiError) {
      switch (failure.code) {
        case 'invalid_credentials':
          return t('auth.error.invalidCredentials');
        case 'identifier_taken':
          return t('auth.error.identifierTaken');
        case 'validation_failed':
          return isRegister ? t('auth.error.invalidRegistration') : t('auth.error.invalidLogin');
        case 'rate_limited':
          return t('auth.error.rateLimited');
        case 'network_error':
          return t('auth.error.network');
        case 'already_authenticated':
          return t('auth.error.alreadyAuthenticated');
        default:
          return t('auth.error.unexpected');
      }
    }
    return t('auth.error.unexpected');
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const account = isRegister
        ? await api.register({ loginKind, identifier, password })
        : await api.login({ loginKind, identifier, password });
      onAuthenticated(account.displayHint);
    } catch (failure) {
      setError(messageFor(failure));
      setBusy(false);
    }
  };

  const switchHref = isRegister ? loginHref(locale, next) : registerHref(locale, next);

  return (
    <section className="auth" aria-labelledby="auth-heading" data-testid={`auth-${mode}`}>
      <h1 id="auth-heading">{isRegister ? t('auth.register.heading') : t('auth.login.heading')}</h1>
      <p className="muted">
        {isRegister ? t('auth.register.subheading') : t('auth.login.subheading')}
      </p>

      <form className="auth__form" onSubmit={(event) => void submit(event)} noValidate>
        <fieldset className="auth__kind">
          <legend>{t('auth.field.kind')}</legend>
          <div className="segmented" role="group" aria-label={t('auth.field.kind')}>
            <button
              type="button"
              aria-pressed={loginKind === 'email'}
              onClick={() => setLoginKind('email')}
              data-testid="auth-kind-email"
            >
              {t('auth.kind.email')}
            </button>
            <button
              type="button"
              aria-pressed={loginKind === 'phone'}
              onClick={() => setLoginKind('phone')}
              data-testid="auth-kind-phone"
            >
              {t('auth.kind.phone')}
            </button>
          </div>
        </fieldset>

        <div className="auth__field">
          <label htmlFor="auth-identifier">
            {loginKind === 'email' ? t('auth.field.email') : t('auth.field.phone')}
          </label>
          <input
            id="auth-identifier"
            data-testid="auth-identifier"
            type={loginKind === 'email' ? 'email' : 'tel'}
            inputMode={loginKind === 'email' ? 'email' : 'tel'}
            autoComplete="username"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            aria-describedby="auth-identifier-hint"
            required
          />
          <p className="muted small" id="auth-identifier-hint">
            {t('auth.hint.unverified')}
          </p>
        </div>

        <div className="auth__field">
          <label htmlFor="auth-password">{t('auth.field.password')}</label>
          <input
            id="auth-password"
            data-testid="auth-password"
            type="password"
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby="auth-password-hint"
            required
            minLength={MIN_PASSWORD_LENGTH}
          />
          <p className="muted small" id="auth-password-hint">
            {t('auth.hint.password', { min: MIN_PASSWORD_LENGTH })}
          </p>
        </div>

        {error !== null ? (
          <p className="auth__error" role="alert" data-testid="auth-error">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          className="button button--primary"
          disabled={busy}
          data-testid="auth-submit"
        >
          {busy
            ? t('auth.submitting')
            : isRegister
              ? t('auth.register.submit')
              : t('auth.login.submit')}
        </button>
      </form>

      <p className="auth__switch">
        {isRegister ? t('auth.register.haveAccount') : t('auth.login.noAccount')}{' '}
        <a
          href={switchHref}
          onClick={(event) => {
            event.preventDefault();
            navigate(switchHref);
          }}
        >
          {isRegister ? t('auth.register.switchToLogin') : t('auth.register.switchToRegister')}
        </a>
      </p>
    </section>
  );
}
