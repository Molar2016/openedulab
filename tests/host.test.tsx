import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ExperimentHost } from '../apps/web/src/host/ExperimentHost';
import { ExperimentErrorBoundary } from '../apps/web/src/host/ErrorBoundary';
import { getExperimentBySlug, type RegistryEntry } from '../apps/web/src/experiment/registry';
import { createI18n } from '../apps/web/src/i18n';
import { createAppServices, type AppServices } from '../apps/web/src/services';

const entry = getExperimentBySlug('math-functions') as RegistryEntry;
const i18n = createI18n('en');

function renderHost(services: AppServices, target: RegistryEntry = entry) {
  return render(
    <ExperimentHost
      entry={target}
      locale="en"
      i18n={i18n}
      services={services}
      contentVersion={target.manifest.contentVersion ?? target.manifest.moduleVersion}
      reviewedStatus={target.manifest.reviewedStatus}
      onBack={() => undefined}
    />,
  );
}

describe('ExperimentHost lifecycle', () => {
  it('loads the experiment, tracks one open event and shows the default curve', async () => {
    const services = createAppServices({ analyticsEnabled: true });
    renderHost(services);

    expect(await screen.findByTestId('formula')).toHaveTextContent('y = x²');
    expect(screen.getByTestId('function-curve')).toHaveAttribute('d');
    await waitFor(() =>
      expect(services.debug.analyticsSink.events.filter((event) => event.type === 'experiment_open')).toHaveLength(1),
    );
  });

  it('reset restores documented defaults and tracks the reset', async () => {
    const services = createAppServices({ analyticsEnabled: true });
    renderHost(services);

    const slope = await screen.findByLabelText(/a \(slope/);
    fireEvent.change(slope, { target: { value: '2' } });
    expect(screen.getByTestId('formula')).toHaveTextContent('y = 2x²');

    fireEvent.click(screen.getByTestId('reset-button'));
    expect(screen.getByTestId('formula')).toHaveTextContent('y = x²');
    expect(slope).toHaveValue('1');
    expect(services.debug.analyticsSink.events.some((event) => event.type === 'experiment_reset')).toBe(true);
  });

  it('records a bucketed interact event, never the raw slider value', async () => {
    const services = createAppServices({ analyticsEnabled: true });
    renderHost(services);

    const slope = await screen.findByLabelText(/a \(slope/);
    fireEvent.change(slope, { target: { value: '3.14159' } });

    const interact = services.debug.analyticsSink.events.find((event) => event.type === 'experiment_interact');
    expect(interact).toBeDefined();
    expect(interact?.controlGroup).toBe('a');
    expect(interact?.interactionBucket).toBe('1');
    expect(JSON.stringify(services.debug.analyticsSink.events)).not.toContain('3.14159');
  });

  it('runs normally when analytics is disabled', async () => {
    const services = createAppServices({ analyticsEnabled: false });
    renderHost(services);

    expect(await screen.findByTestId('formula')).toHaveTextContent('y = x²');
    expect(services.debug.analyticsSink.events).toEqual([]);
  });

  it('previews feedback and states that nothing is sent', async () => {
    const services = createAppServices({ analyticsEnabled: false });
    renderHost(services);
    await screen.findByTestId('formula');

    fireEvent.click(screen.getByTestId('feedback-button'));
    expect(screen.getByTestId('feedback-dialog')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'vertex looks wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview of what would be sent' }));

    const preview = screen.getByTestId('feedback-preview');
    expect(preview).toHaveTextContent('"messageLength": 18');
    expect(preview).toHaveTextContent('Not sent');
    expect(preview).not.toHaveTextContent('vertex looks wrong');
  });
});

describe('ExperimentHost error isolation', () => {
  it('catches a crashing experiment, reports a code and keeps the toolbar usable', async () => {
    const services = createAppServices({ analyticsEnabled: true });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Broken = (): JSX.Element => {
      throw new Error('render blew up with token=secret');
    };
    const brokenEntry: RegistryEntry = { ...entry, loadView: async () => ({ default: Broken }) };

    renderHost(services, brokenEntry);

    expect(await screen.findByTestId('experiment-error')).toBeInTheDocument();
    expect(screen.getByTestId('reset-button')).toBeInTheDocument();
    expect(screen.getByTestId('back-button')).toBeInTheDocument();
    expect(services.debug.analyticsSink.events.some((event) => event.type === 'experiment_error')).toBe(true);
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
    const services = createAppServices({ analyticsEnabled: true });
    renderHost(services);
    await screen.findByTestId('formula');

    fireEvent.click(screen.getByTestId('fullscreen-button'));

    await waitFor(() => expect(screen.getByTestId('fullscreen-button')).toHaveTextContent('Exit full screen'));
    expect(services.debug.analyticsSink.events.some(
      (event) => event.type === 'experiment_fullscreen' && event.enterOrExit === 'enter',
    )).toBe(true);
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
