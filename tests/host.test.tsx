import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ExperimentHost } from '../apps/web/src/host/ExperimentHost';
import { ExperimentErrorBoundary } from '../apps/web/src/host/ErrorBoundary';
import { getExperimentBySlug, type RegistryEntry } from '../apps/web/src/experiment/registry';
import { createI18n } from '../apps/web/src/i18n';
import { createAppServices, type AppServices } from '../apps/web/src/services';

const entry = getExperimentBySlug('math-functions') as RegistryEntry;
const i18n = createI18n('en');

interface FeedbackSubmission {
  experimentId: string;
  contentVersion: string;
  appVersion: string;
  category: 'content' | 'bug' | 'other';
  message: string;
}

const noFeedback = async (): Promise<void> => undefined;

function renderHost(
  services: AppServices,
  target: RegistryEntry = entry,
  onSubmitFeedback: (payload: FeedbackSubmission) => Promise<void> = noFeedback,
) {
  return render(
    <ExperimentHost
      entry={target}
      locale="en"
      i18n={i18n}
      services={services}
      contentVersion={target.manifest.contentVersion}
      reviewedStatus={target.manifest.reviewedStatus}
      appVersion={services.appVersion}
      onSubmitFeedback={onSubmitFeedback}
      onBack={() => undefined}
    />,
  );
}

/** Analytics stay off the network in unit tests: the flush timer never fires. */
function servicesWithAnalytics(): AppServices {
  return createAppServices({ analyticsEnabled: true, analyticsFlushDelayMs: 600_000 });
}

describe('ExperimentHost lifecycle', () => {
  it('loads the experiment, tracks one open event and shows the default curve', async () => {
    const services = servicesWithAnalytics();
    renderHost(services);

    expect(await screen.findByTestId('formula')).toHaveTextContent('y = x²');
    expect(screen.getByTestId('function-curve')).toHaveAttribute('d');
    await waitFor(() =>
      expect(
        services.debug.analyticsSink.events.filter((event) => event.type === 'experiment_open'),
      ).toHaveLength(1),
    );
    expect(
      services.debug.analyticsSink.events.find((event) => event.type === 'experiment_open')
        ?.contentVersion,
    ).toBe('1.0.0');
  });

  it('reset restores documented defaults and tracks the reset', async () => {
    const services = servicesWithAnalytics();
    renderHost(services);

    const slope = await screen.findByLabelText(/a \(slope/);
    fireEvent.change(slope, { target: { value: '2' } });
    expect(screen.getByTestId('formula')).toHaveTextContent('y = 2x²');

    fireEvent.click(screen.getByTestId('reset-button'));
    expect(screen.getByTestId('formula')).toHaveTextContent('y = x²');
    expect(slope).toHaveValue('1');
    expect(
      services.debug.analyticsSink.events.some((event) => event.type === 'experiment_reset'),
    ).toBe(true);
  });

  it('records a control category and the first interaction, never the raw slider value', async () => {
    const services = servicesWithAnalytics();
    renderHost(services);

    const slope = await screen.findByLabelText(/a \(slope/);
    fireEvent.change(slope, { target: { value: '3.14159' } });

    const events = services.debug.analyticsSink.events;
    const control = events.find((event) => event.type === 'experiment_control_used');
    expect(control).toBeDefined();
    expect(control?.controlGroup).toBe('a');
    expect(control?.interactionBucket).toBe('1');
    expect(events.some((event) => event.type === 'experiment_first_interaction')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('3.14159');
  });

  it('runs normally when analytics is disabled', async () => {
    const services = createAppServices({ analyticsEnabled: false });
    renderHost(services);

    expect(await screen.findByTestId('formula')).toHaveTextContent('y = x²');
    expect(services.debug.analyticsSink.events).toEqual([]);
  });

  it('previews the payload, sends only on request and reports the stored result', async () => {
    const submitted: FeedbackSubmission[] = [];
    const onSubmitFeedback = async (payload: FeedbackSubmission): Promise<void> => {
      submitted.push(payload);
    };

    const services = createAppServices({ analyticsEnabled: false });
    renderHost(services, entry, onSubmitFeedback);
    await screen.findByTestId('formula');

    fireEvent.click(screen.getByTestId('feedback-button'));
    expect(screen.getByTestId('feedback-dialog')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'vertex looks wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview of what would be sent' }));

    const preview = screen.getByTestId('feedback-preview');
    expect(preview).toHaveTextContent('"messageLength": 18');
    expect(preview).not.toHaveTextContent('vertex looks wrong');
    // Nothing leaves the page before the explicit Send.
    expect(submitted).toEqual([]);

    fireEvent.click(screen.getByTestId('feedback-send'));
    expect(await screen.findByTestId('feedback-sent')).toBeInTheDocument();
    expect(submitted).toEqual([
      {
        experimentId: 'math.functions',
        contentVersion: '1.0.0',
        appVersion: '0.1.0-m1',
        category: 'content',
        message: 'vertex looks wrong',
      },
    ]);
  });

  it('says the report was not saved when the send fails', async () => {
    const onSubmitFeedback = async (): Promise<void> => {
      throw new Error('offline');
    };
    const services = createAppServices({ analyticsEnabled: false });
    renderHost(services, entry, onSubmitFeedback);
    await screen.findByTestId('formula');

    fireEvent.click(screen.getByTestId('feedback-button'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview of what would be sent' }));
    fireEvent.click(screen.getByTestId('feedback-send'));

    expect(await screen.findByTestId('feedback-error')).toBeInTheDocument();
    expect(screen.queryByTestId('feedback-sent')).toBeNull();
  });
});

describe('ExperimentHost error isolation', () => {
  it('catches a crashing experiment, reports a code and keeps the toolbar usable', async () => {
    const services = servicesWithAnalytics();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Broken = (): JSX.Element => {
      throw new Error('render blew up with token=secret');
    };
    const brokenEntry: RegistryEntry = { ...entry, loadView: async () => ({ default: Broken }) };

    renderHost(services, brokenEntry);

    expect(await screen.findByTestId('experiment-error')).toBeInTheDocument();
    expect(screen.getByTestId('reset-button')).toBeInTheDocument();
    expect(screen.getByTestId('back-button')).toBeInTheDocument();
    expect(
      services.debug.analyticsSink.events.some((event) => event.type === 'client_error'),
    ).toBe(true);
    expect(JSON.stringify(services.debug.analyticsSink.events)).not.toContain('token=secret');
    consoleError.mockRestore();
  });

  it('renders a recoverable fallback in the boundary', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Boom = (): JSX.Element => {
      throw new Error('boom');
    };
    const onError = vi.fn();
    render(
      <ExperimentErrorBoundary
        labels={{ title: 'Broken', body: 'Try again', retry: 'Retry', code: 'render_error' }}
        onError={onError}
      >
        <Boom />
      </ExperimentErrorBoundary>,
    );

    expect(screen.getByTestId('experiment-error')).toHaveTextContent('Broken');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(onError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe('ExperimentHost fullscreen', () => {
  let fullscreenElement: Element | null = null;
  const originalRequest = Element.prototype.requestFullscreen;

  beforeEach(() => {
    fullscreenElement = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    });
    Element.prototype.requestFullscreen = function requestFullscreen() {
      fullscreenElement = document.querySelector('.experiment-host');
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    };
  });

  afterEach(() => {
    Element.prototype.requestFullscreen = originalRequest;
    Reflect.deleteProperty(document, 'fullscreenElement');
  });

  it('enters full screen and keeps the label and analytics in sync', async () => {
    const services = servicesWithAnalytics();
    renderHost(services);
    await screen.findByTestId('formula');

    fireEvent.click(screen.getByTestId('fullscreen-button'));

    await waitFor(() =>
      expect(screen.getByTestId('fullscreen-button')).toHaveTextContent('Exit full screen'),
    );
    expect(
      services.debug.analyticsSink.events.some(
        (event) =>
          event.type === 'experiment_fullscreen' && event.controlGroup === 'fullscreen_enter',
      ),
    ).toBe(true);
  });

  it('removes its fullscreen listener on unmount', async () => {
    const services = createAppServices({ analyticsEnabled: false });
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const view = renderHost(services);
    await screen.findByTestId('formula');

    view.unmount();
    expect(removeSpy.mock.calls.some(([type]) => type === 'fullscreenchange')).toBe(true);
    removeSpy.mockRestore();
  });
});
