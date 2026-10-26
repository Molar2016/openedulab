import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { ExperimentServices, Locale } from '../experiment/contract';
import { textFor, type RegistryEntry } from '../experiment/registry';
import type { I18n } from '../i18n';
import { ExperimentErrorBoundary } from './ErrorBoundary';
import { FeedbackDialog } from './FeedbackDialog';

interface FavoriteControl {
  readonly active: boolean;
  readonly busy: boolean;
  readonly error: boolean;
  readonly onToggle: () => void;
}

interface Props {
  entry: RegistryEntry;
  locale: Locale;
  i18n: I18n;
  services: ExperimentServices;
  /** Content version reported by `GET /api/experiments/:id`; not read from the bundle. */
  contentVersion: string;
  reviewedStatus: 'draft' | 'verified';
  /** Optional: supplied by the app when the viewer is signed in. */
  favorite?: FavoriteControl;
  /** Build version reported with diagnostics and feedback. */
  appVersion: string;
  /** Sends a feedback report; resolves when the server stored it. */
  onSubmitFeedback: (payload: {
    experimentId: string;
    contentVersion: string;
    appVersion: string;
    category: 'content' | 'bug' | 'other';
    message: string;
  }) => Promise<void>;
  onBack: () => void;
}

/**
 * Experiment Host: lifecycle, toolbar (reset/fullscreen/feedback), error isolation and
 * analytics. Experiments receive only locale, resetToken and services.
 */
export function ExperimentHost({
  entry,
  locale,
  i18n,
  services,
  contentVersion,
  reviewedStatus,
  favorite,
  appVersion,
  onSubmitFeedback,
  onBack,
}: Props): JSX.Element {
  const { manifest } = entry;
  const [resetToken, setResetToken] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const fullscreenState = useRef(false);
  const trackedOpen = useRef<string | null>(null);

  const View = useMemo(() => lazy(entry.loadView), [entry]);

  const t = (key: string): string => i18n.t(key);

  const track = (event: Parameters<ExperimentServices['analytics']['track']>[0]): void => {
    services.analytics.track(event);
  };

  useEffect(() => {
    const key = `${manifest.id}@${contentVersion}:${locale}`;
    if (trackedOpen.current === key) return;
    trackedOpen.current = key;
    track({
      type: 'experiment_open',
      experimentId: manifest.id,
      contentVersion,
      locale,
    });
    // `track` and `services` are stable for the lifetime of a route in the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest.id, contentVersion, locale]);

  useEffect(() => {
    const handleFullscreenChange = (): void => {
      const active = document.fullscreenElement === containerRef.current;
      if (active === fullscreenState.current) return;
      fullscreenState.current = active;
      setIsFullscreen(active);
      track({
        type: 'experiment_fullscreen',
        experimentId: manifest.id,
        contentVersion,
        locale,
        controlGroup: active ? 'fullscreen_enter' : 'fullscreen_exit',
      });
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest.id, contentVersion, locale]);

  const handleReset = (): void => {
    setResetToken((token) => token + 1);
    track({
      type: 'experiment_reset',
      experimentId: manifest.id,
      contentVersion,
      locale,
    });
  };

  const toggleFullscreen = async (): Promise<void> => {
    const node = containerRef.current;
    if (!node) return;
    try {
      if (document.fullscreenElement === node) {
        await document.exitFullscreen();
      } else {
        await node.requestFullscreen();
      }
    } catch {
      // Browsers can refuse (permissions, iframe policy). State follows the real event.
    }
  };

  const handleRenderError = (): void => {
    services.errors.report({ code: 'render_error' });
    track({
      type: 'client_error',
      experimentId: manifest.id,
      contentVersion,
      locale,
      errorCode: 'render_error',
    });
  };

  const title = textFor(entry, locale, 'title');
  const description = textFor(entry, locale, 'description');

  return (
    <div className="experiment-host" ref={containerRef}>
      <div className="experiment-host__toolbar">
        <button type="button" className="button button--ghost" onClick={onBack} data-testid="back-button">
          ← {t('experiment.back')}
        </button>
        <div className="experiment-host__actions">
          {favorite !== undefined ? (
            <button
              type="button"
              className="button button--ghost"
              aria-pressed={favorite.active}
              onClick={favorite.onToggle}
              disabled={favorite.busy}
              data-testid="favorite-button"
            >
              {favorite.active ? t('favorite.remove') : t('favorite.add')}
            </button>
          ) : null}
          {favorite?.error === true ? (
            <span className="small" role="status" data-testid="favorite-error">
              {t('favorite.failed')}
            </span>
          ) : null}
          <button type="button" className="button button--ghost" onClick={handleReset} data-testid="reset-button">
            {t('experiment.reset')}
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => void toggleFullscreen()}
            aria-pressed={isFullscreen}
            data-testid="fullscreen-button"
          >
            {isFullscreen ? t('experiment.exitFullscreen') : t('experiment.fullscreen')}
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => setFeedbackOpen(true)}
            data-testid="feedback-button"
          >
            {t('experiment.feedback')}
          </button>
        </div>
      </div>

      <header className="experiment-host__header">
        <h1>{title}</h1>
        <p className="muted">{description}</p>
        <p className="muted small" data-testid="experiment-meta">
          {t('experiment.contentVersion')} {contentVersion} ·{' '}
          {reviewedStatus === 'verified'
            ? t('catalog.reviewed.verified')
            : t('catalog.reviewed.draft')}
        </p>
      </header>

      {entry.issues.length > 0 || !entry.compatible ? (
        <div className="notice notice--warning" role="alert" data-testid="manifest-warning">
          <strong>{t('experiment.error.title')}</strong>
          <ul>
            {entry.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : (
        <Suspense
          fallback={
            <p className="muted" role="status">
              {t('experiment.loading')}
            </p>
          }
        >
          <ExperimentErrorBoundary
            onError={handleRenderError}
            labels={{
              title: t('experiment.error.title'),
              body: t('experiment.error.body'),
              retry: t('experiment.error.retry'),
              code: i18n.t('experiment.error.code', { code: 'render_error' }),
            }}
          >
            <View locale={locale} resetToken={resetToken} services={services} />
          </ExperimentErrorBoundary>
        </Suspense>
      )}

      {feedbackOpen ? (
        <FeedbackDialog
          experimentId={manifest.id}
          contentVersion={contentVersion}
          appVersion={appVersion}
          onSubmit={onSubmitFeedback}
          onClose={() => setFeedbackOpen(false)}
          labels={{
            title: t('feedback.title'),
            category: t('feedback.category'),
            categoryContent: t('feedback.category.content'),
            categoryBug: t('feedback.category.bug'),
            categoryOther: t('feedback.category.other'),
            message: t('feedback.messagePlaceholder'),
            messagePlaceholder: t('feedback.messagePlaceholder'),
            preview: t('feedback.preview'),
            previewNote: t('feedback.previewNote'),
            send: t('feedback.send'),
            sending: t('feedback.sending'),
            sent: t('feedback.sent'),
            sendFailed: t('feedback.sendFailed'),
            close: t('feedback.close'),
            privacy: t('feedback.privacy'),
          }}
        />
      ) : null}
    </div>
  );
}
