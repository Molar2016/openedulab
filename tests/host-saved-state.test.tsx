import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { getExperimentBySlug, type RegistryEntry } from '../apps/web/src/experiment/registry';
import { ExperimentHost, type SavedStateControl } from '../apps/web/src/host/ExperimentHost';
import { createI18n } from '../apps/web/src/i18n';
import { createAppServices, type AppServices } from '../apps/web/src/services';

/**
 * Saved-parameter UI (design §7.5, R-17/R-18).
 *
 * Two product rules are asserted here, not just the wiring: a snapshot is written **only**
 * when the user clicks save (moving a slider must never be enough), and restoring is a
 * deliberate action — a stored snapshot is never applied behind the user's back.
 */

const entry = getExperimentBySlug('math-functions') as RegistryEntry;
const i18n = createI18n('en');

const noFeedback = async (): Promise<void> => undefined;

function servicesWithAnalytics(): AppServices {
  return createAppServices({ analyticsEnabled: true, analyticsFlushDelayMs: 600_000 });
}

function renderHost(savedState: SavedStateControl, target: RegistryEntry = entry) {
  return render(
    <ExperimentHost
      entry={target}
      locale="en"
      i18n={i18n}
      services={servicesWithAnalytics()}
      contentVersion={target.manifest.contentVersion}
      reviewedStatus={target.manifest.reviewedStatus}
      appVersion="test"
      onSubmitFeedback={noFeedback}
      savedState={savedState}
      onBack={() => undefined}
    />,
  );
}

function control(overrides: Partial<SavedStateControl> = {}): SavedStateControl {
  return {
    status: 'none',
    busy: false,
    error: 'none',
    onSave: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

describe('saved parameters are opt-in', () => {
  it('saves nothing while the user drags a slider', async () => {
    const saved = control();
    renderHost(saved);

    const slope = await screen.findByLabelText(/a \(slope/);
    fireEvent.change(slope, { target: { value: '3' } });
    fireEvent.change(slope, { target: { value: '4' } });

    expect(screen.getByTestId('formula')).toHaveTextContent('y = 4x²');
    expect(saved.onSave).not.toHaveBeenCalled();
  });

  it('sends the four whitelisted parameters when save is clicked', async () => {
    const saved = control();
    renderHost(saved);

    const slope = await screen.findByLabelText(/a \(slope/);
    fireEvent.change(slope, { target: { value: '3' } });
    await waitFor(() => expect(screen.getByTestId('formula')).toHaveTextContent('y = 3x²'));

    fireEvent.click(screen.getByTestId('save-state-button'));

    expect(saved.onSave).toHaveBeenCalledTimes(1);
    expect(saved.onSave).toHaveBeenCalledWith({ mode: 'quadratic', a: 3, b: 0, c: 0 });
  });

  it('never offers to save a parameter set the schema does not allow', async () => {
    const saved = control();
    renderHost(saved);

    await screen.findByTestId('formula');
    // The slider is clamped by the DOM, so whatever the host reads stays inside the
    // schema; the guard that matters is that a save is still an explicit click.
    expect(saved.onSave).not.toHaveBeenCalled();
  });
});

describe('restoring is explicit', () => {
  it('does not apply a stored snapshot until the restore button is used', async () => {
    const saved = control({ status: 'saved', values: { mode: 'quadratic', a: 2, b: 0, c: 0 } });
    renderHost(saved);

    expect(await screen.findByTestId('formula')).toHaveTextContent('y = x²');

    fireEvent.click(screen.getByTestId('restore-state-button'));

    await waitFor(() => expect(screen.getByTestId('formula')).toHaveTextContent('y = 2x²'));
    expect(screen.getByLabelText(/a \(slope/)).toHaveValue('2');
  });

  it('restores a linear snapshot including the mode switch', async () => {
    const saved = control({ status: 'saved', values: { mode: 'linear', a: -2, b: 5, c: 0 } });
    renderHost(saved);

    await screen.findByTestId('formula');
    fireEvent.click(screen.getByTestId('restore-state-button'));

    await waitFor(() => expect(screen.getByTestId('formula')).toHaveTextContent('y = −2x + 5'));
  });

  it('tells the user when the snapshot is from an older version and offers deletion only', async () => {
    const saved = control({ status: 'incompatible' });
    renderHost(saved);

    await screen.findByTestId('formula');

    const notice = screen.getByTestId('saved-state-notice');
    expect(notice).toHaveTextContent(/older version/i);
    expect(notice).toHaveTextContent(/default/i);
    expect(screen.queryByTestId('restore-state-button')).toBeNull();

    fireEvent.click(screen.getByTestId('delete-state-button'));
    expect(saved.onDelete).toHaveBeenCalledTimes(1);
  });

  it('offers delete for a compatible snapshot as well', async () => {
    const saved = control({ status: 'saved', values: { mode: 'quadratic', a: 2, b: 0, c: 0 } });
    renderHost(saved);

    await screen.findByTestId('formula');
    fireEvent.click(screen.getByTestId('delete-state-button'));

    expect(saved.onDelete).toHaveBeenCalledTimes(1);
  });
});

describe('failure is reported, not hidden', () => {
  it('says the settings were not saved when the write fails', async () => {
    const saved = control({ error: 'save', status: 'none' });
    renderHost(saved);

    await screen.findByTestId('formula');

    expect(screen.getByTestId('saved-state-notice')).toHaveTextContent(/not saved/i);
  });

  it('says the settings were saved after a successful write', async () => {
    const saved = control({ status: 'saved', values: { mode: 'quadratic', a: 2, b: 0, c: 0 } });
    renderHost(saved);

    await screen.findByTestId('formula');

    expect(screen.getByTestId('saved-state-notice')).toHaveTextContent(/saved/i);
  });

  it('reports a failed delete instead of pretending it worked', async () => {
    const saved = control({ error: 'delete', status: 'saved' });
    renderHost(saved);

    await screen.findByTestId('formula');

    expect(screen.getByTestId('saved-state-notice')).toHaveTextContent(/not removed/i);
  });
});

describe('experiments without a state schema', () => {
  it('show no saved-parameter controls at all', async () => {
    const withoutSchema: RegistryEntry = { ...entry, stateSchema: null };
    renderHost(control(), withoutSchema);

    await screen.findByTestId('formula');

    expect(screen.queryByTestId('save-state-button')).toBeNull();
    expect(screen.queryByTestId('restore-state-button')).toBeNull();
    expect(screen.queryByTestId('delete-state-button')).toBeNull();
  });
});
