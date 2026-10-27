import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { ExperimentServices, ExperimentStateBridge, Locale } from '../experiment/contract';
import { textFor, type RegistryEntry } from '../experiment/registry';
import { canonicalStatePayload } from '../experiment/state-schema';
import type { I18n } from '../i18n';
import { ExperimentErrorBoundary } from './ErrorBoundary';
import { FeedbackDialog } from './FeedbackDialog';

interface FavoriteControl {
  readonly active: boolean;
  readonly busy: boolean;
  readonly error: boolean;
  readonly onToggle: () => void;
}

type ParameterValues = Readonly<Record<string, number | string>>;

/**
 * The entry that was opened (ADR-003).
 *
 * The same experiment is reachable two ways, and they deliberately differ: `tool` is the
 * direct URL (defaults come from the experiment's own schema), `placement` is a curriculum
 * chapter (defaults come from that chapter's validated preset). The host never derives one
 * from the other; it is told which context it is rendering.
 */
export interface ExperimentContext {
  readonly kind: 'tool' | 'placement';
  /** Preset values for this entry; absent means "the experiment's declared defaults". */
  readonly values?: ParameterValues;
  /** Localized chapter title, used for display only — never for persistence. */
  readonly label?: string;
}

/** Where the numbers currently on screen came from. Always shown to the user. */
export type ParameterOrigin = 'saved' | 'preset' | 'tool-default';

/**
 * Saved-parameter state owned by the app (ADR-003, replacing R2's restore/delete UX).
 *
 * The host only renders and reports intent: `status === 'saved'` means a compatible
 * snapshot was found and is applied automatically on entry; `none` means this entry has
 * no snapshot; `incompatible`/`error` mean a snapshot exists but must not be applied.
 */
export interface SavedParametersControl {
  readonly status: 'loading' | 'none' | 'saved' | 'incompatible' | 'error';
  readonly values?: ParameterValues;
  readonly busy: boolean;
  readonly error: 'none' | 'save';
  /** Resolves when the server stored the snapshot; rejects when it did not. */
  readonly onSave: (values: ParameterValues) => Promise<void>;
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
  /** Optional: supplied when the experiment declares a `state-schema.json`. */
  savedState?: SavedParametersControl;
  /** Which entry this is. Defaults to the direct tool entry. */
  context?: ExperimentContext;
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
  /** Where "back" goes is the caller's decision: catalog for a tool, curriculum for a chapter. */
  backLabel?: string;
  onBack: () => void;
}

const ORIGIN_KEYS: Record<ParameterOrigin, string> = {
  saved: 'state.origin.saved',
  preset: 'state.origin.preset',
  'tool-default': 'state.origin.toolDefault',
};

/**
 * Experiment Host: lifecycle, toolbar (save/reset/fullscreen/feedback), error isolation and
 * analytics. Experiments receive only locale, resetToken, initialState and services.
 */
export function ExperimentHost({
  entry,
  locale,
  i18n,
  services,
  contentVersion,
  reviewedStatus,
  favorite,
  savedState,
  context = { kind: 'tool' },
  appVersion,
  onSubmitFeedback,
  backLabel,
  onBack,
}: Props): JSX.Element {
  const { manifest } = entry;
  const [resetToken, setResetToken] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const fullscreenState = useRef(false);
  const trackedOpen = useRef<string | null>(null);

  // Saved parameters (ADR-003): the bridge is a hand-off, not a subscription — the host
  // reads the experiment's current values only inside the save click handler.
  const stateBridge = useRef<ExperimentStateBridge>({});
  const [saveRejected, setSaveRejected] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [resetToContext, setResetToContext] = useState(false);
  /** Set by reset: the view restarts from this entry's defaults, not from the snapshot. */
  const [resetView, setResetView] = useState<{ nonce: number } | null>(null);
  const [savedOrigin, setSavedOrigin] = useState<ParameterOrigin | null>(null);

  const stateSchema = entry.stateSchema;
  const showSave = stateSchema !== null && savedState !== undefined;
  /**
   * While the snapshot is being read the experiment is not mounted at all: no flash of
   * defaults that would then jump to the stored values.
   */
  const pending = savedState !== undefined && savedState.status === 'loading';
  const baseOrigin: ParameterOrigin = context.kind === 'placement' ? 'preset' : 'tool-default';

  const snapshotOrigin: ParameterOrigin = savedState?.status === 'saved' ? 'saved' : baseOrigin;
  const origin: ParameterOrigin = savedOrigin ?? (resetView === null ? snapshotOrigin : baseOrigin);

  const initialValues: ParameterValues | undefined =
    resetView !== null
      ? context.values
      : savedState?.status === 'saved'
        ? savedState.values
        : context.values;

  const t = (key: string): string => i18n.t(key);

  const handleSaveState = async (): Promise<void> => {
    if (savedState === undefined || stateSchema === null) return;
    const current: unknown = stateBridge.current.read?.();
    const payload = canonicalStatePayload(stateSchema, current);
    if (payload === null) {
      // The experiment reported something the schema does not allow: refuse here rather
      // than send a value the server would reject, and say so.
      setSaveRejected(true);
      return;
    }
    setSaveRejected(false);
    try {
      await savedState.onSave(JSON.parse(payload) as ParameterValues);
      setSavedOrigin('saved');
      setJustSaved(true);
      setResetToContext(false);
    } catch {
      // The failure is reported through `savedState.error`; the view stays exactly as it is.
    }
  };

  const stateNotice = ((): { tone: string; text: string } | null => {
    if (!showSave || savedState === undefined || pending) return null;
    if (savedState.error === 'save') return { tone: 'error', text: t('state.notSaved') };
    if (saveRejected) return { tone: 'error', text: t('state.rejected') };
    if (resetToContext) return { tone: 'ok', text: t('state.resetKept') };
    if (savedState.status === 'incompatible') {
      return { tone: 'warning', text: t('state.incompatible') };
    }
    if (savedState.status === 'error') return { tone: 'warning', text: t('state.unavailable') };
    if (justSaved) return { tone: 'ok', text: t('state.saved') };
    return null;
  })();

  const View = useMemo(() => lazy(entry.loadView), [entry]);

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

  /**
   * Reset is scoped to this entry (ADR-003): the view returns to the chapter preset (or to
   * the tool defaults on the direct entry) and nothing is written or deleted. A stored
   * snapshot survives; pressing save afterwards is what overwrites it.
   */
  const handleReset = (): void => {
    if (stateSchema !== null && savedState !== undefined) {
      setResetView({ nonce: (resetView?.nonce ?? 0) + 1 });
      setSavedOrigin(null);
      setJustSaved(false);
      setResetToContext(true);
      setSaveRejected(false);
    } else {
      setResetToken((token) => token + 1);
    }
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
          ← {backLabel ?? t('experiment.back')}
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
          {showSave && !pending ? (
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void handleSaveState()}
              disabled={savedState?.busy === true}
              data-testid="save-state-button"
            >
              {t('state.save')}
            </button>
          ) : null}
          <button
            type="button"
            className="button button--ghost"
            onClick={handleReset}
            data-testid="reset-button"
          >
            {stateSchema === null ? t('experiment.reset') : t('state.reset')}
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
        {showSave && !pending ? (
          <p className="small" role="status" data-testid="parameter-origin">
            {t(ORIGIN_KEYS[origin])}
          </p>
        ) : null}
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
      ) : pending ? (
        <p className="muted" role="status" data-testid="parameter-loading">
          {t('state.loading')}
        </p>
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
            <View
              key={`apply-${String(resetView?.nonce ?? 0)}`}
              locale={locale}
              resetToken={resetToken}
              services={services}
              initialState={initialValues}
              stateBridge={stateBridge.current}
            />
          </ExperimentErrorBoundary>
        </Suspense>
      )}

      {stateNotice !== null ? (
        <p
          className={`small ${stateNotice.tone === 'error' ? 'auth__error' : 'muted'}`}
          role={stateNotice.tone === 'error' ? 'alert' : 'status'}
          data-testid="saved-state-notice"
        >
          {stateNotice.text}
        </p>
      ) : null}

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
