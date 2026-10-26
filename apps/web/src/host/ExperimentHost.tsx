import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { ExperimentServices, Locale } from '../experiment/contract';
import { textFor, type RegistryEntry } from '../experiment/registry';
import type { I18n } from '../i18n';
import { ExperimentErrorBoundary } from './ErrorBoundary';
import { FeedbackDialog } from './FeedbackDialog';

interface Props {
  entry: RegistryEntry;
  locale: Locale;
  i18n: I18n;
  services: ExperimentServices;
  /** Content version reported by `GET /api/experiments/:id`; not read from the bundle. */
  contentVersion: string;
  reviewedStatus: 'draft' | 'verified';
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
    const key = `${manifest.id}@${manifest.moduleVersion}:${locale}`;
    if (trackedOpen.current === key) return;
    trackedOpen.current = key;
    track({
      type: 'experiment_open',
      experimentId: manifest.id,
      moduleVersion: manifest.moduleVersion,
      locale,
    });
    // `track` and `services` are stable for the lifetime of a route in the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest.id, manifest.moduleVersion, locale]);

  useEffect(() => {
    const handleFullscreenChange = (): void => {
      const active = document.fullscreenElement === containerRef.current;
      if (active === fullscreenState.current) return;
      fullscreenState.current = active;
      setIsFullscreen(active);
      track({
        type: 'experiment_fullscreen',
        experimentId: manifest.id,
        moduleVersion: manifest.moduleVersion,
        locale,
        enterOrExit: active ? 'enter' : 'exit',
      });
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest.id, manifest.moduleVersion, locale]);

  const handleReset = (): void => {
    setResetToken((token) => token + 1);
    track({
      type: 'experiment_reset',
      experimentId: manifest.id,
      moduleVersion: manifest.moduleVersion,
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
      type: 'experiment_error',
      experimentId: manifest.id,
      moduleVersion: manifest.moduleVersion,
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
            notSent: t('feedback.notSent'),
            close: t('feedback.close'),
            privacy: t('feedback.privacy'),
          }}
        />
      ) : null}
    </div>
  );
}
