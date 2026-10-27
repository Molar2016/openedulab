import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { getExperimentBySlug, type RegistryEntry } from '../apps/web/src/experiment/registry';
import {
  ExperimentHost,
  type ExperimentContext,
  type SavedParametersControl,
} from '../apps/web/src/host/ExperimentHost';
import { createI18n } from '../apps/web/src/i18n';
import { createAppServices, type AppServices } from '../apps/web/src/services';

/**
 * Parameter context and saved settings (ADR-003, replacing R2's "restore/delete" UX).
 *
 * The rules under test are the product rules, not the wiring:
 *   - what the entry shows is decided by the *entry*: a chapter opens with its preset, the
 *     direct tool URL opens with the tool's own defaults;
 *   - a compatible personal snapshot is loaded automatically — there is no "restore" click;
 *   - the toolbar offers exactly two controls, save and reset, and reset only changes the
 *     current view (it never deletes the saved snapshot);
 *   - the page always says where the numbers on screen came from.
 */

const entry = getExperimentBySlug('math-functions') as RegistryEntry;
const i18n = createI18n('en');

const PRESET = { mode: 'linear', a: 2, b: 3, c: 0 } as const;
const SAVED = { mode: 'quadratic', a: 4, b: 0, c: 0 } as const;

const noFeedback = async (): Promise<void> => undefined;

const CHAPTER: ExperimentContext = { kind: 'placement', values: PRESET, label: 'Sample chapter A' };
const TOOL: ExperimentContext = { kind: 'tool' };

function servicesWithAnalytics(): AppServices {
  return createAppServices({ analyticsEnabled: true, analyticsFlushDelayMs: 600_000 });
}

function control(overrides: Partial<SavedParametersControl> = {}): SavedParametersControl {
  return {
    status: 'none',
    busy: false,
    error: 'none',
    onSave: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderHost(
  savedState: SavedParametersControl | undefined,
  target: RegistryEntry = entry,
  context: ExperimentContext = TOOL,
) {
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
      context={context}
      {...(savedState === undefined ? {} : { savedState })}
      onBack={() => undefined}
    />,
  );
}

describe('what an entry opens with', () => {
  it('opens the direct tool entry with the tool defaults', async () => {
    renderHost(control(), entry, TOOL);

    expect(await screen.findByTestId('formula')).toHaveTextContent('y = x²');
    expect(screen.getByLabelText(/a \(slope/)).toHaveValue('1');
    expect(screen.getByTestId('parameter-origin')).toHaveTextContent(/tool defaults/i);
  });

  it('opens a chapter with that chapter preset, without asking', async () => {
    renderHost(control(), entry, CHAPTER);

    expect(await screen.findByTestId('formula')).toHaveTextContent('y = 2x + 3');
    expect(screen.getByLabelText(/a \(slope/)).toHaveValue('2');
    expect(screen.getByLabelText(/b \(intercept/)).toHaveValue('3');
    expect(screen.getByTestId('parameter-origin')).toHaveTextContent(/chapter preset/i);
  });

  it('loads a compatible snapshot automatically instead of the preset', async () => {
    const saved = control({ status: 'saved', values: SAVED });
    renderHost(saved, entry, { ...CHAPTER, values: PRESET });

    expect(await screen.findByTestId('formula')).toHaveTextContent('y = 4x²');
    expect(screen.getByTestId('parameter-origin')).toHaveTextContent(/your saved parameters/i);
    expect(saved.onSave).not.toHaveBeenCalled();
  });

  it('falls back to the chapter preset when the snapshot is from an older version', async () => {
    renderHost(control({ status: 'incompatible' }), entry, CHAPTER);

    expect(await screen.findByTestId('formula')).toHaveTextContent('y = 2x + 3');
    expect(screen.getByTestId('parameter-origin')).toHaveTextContent(/chapter preset/i);
    expect(screen.getByTestId('saved-state-notice')).toHaveTextContent(/older version/i);
  });

  it('falls back to the preset when the snapshot cannot be read', async () => {
    renderHost(control({ status: 'error' }), entry, CHAPTER);

    expect(await screen.findByTestId('formula')).toHaveTextContent('y = 2x + 3');
    expect(screen.getByTestId('saved-state-notice')).toHaveTextContent(/could not be read/i);
  });

  it('waits for the snapshot before mounting the experiment (no default-then-jump)', async () => {
    renderHost(control({ status: 'loading' }), entry, CHAPTER);

    expect(screen.getByTestId('parameter-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('formula')).toBeNull();
    expect(screen.queryByTestId('save-state-button')).toBeNull();
  });
});

describe('the two controls', () => {
  it('offers save and reset, and nothing that restores or deletes', async () => {
    renderHost(control({ status: 'saved', values: SAVED }), entry, CHAPTER);
    await screen.findByTestId('formula');

    expect(screen.getByTestId('save-state-button')).toHaveTextContent(/save/i);
    expect(screen.getByTestId('reset-button')).toHaveTextContent(/reset/i);
    expect(screen.queryByTestId('restore-state-button')).toBeNull();
    expect(screen.queryByTestId('delete-state-button')).toBeNull();
  });

  it('saves exactly the parameters currently on screen', async () => {
    const saved = control();
    renderHost(saved, entry, CHAPTER);

    const slope = await screen.findByLabelText(/a \(slope/);
    fireEvent.change(slope, { target: { value: '5' } });
    await waitFor(() => expect(screen.getByTestId('formula')).toHaveTextContent('y = 5x + 3'));

    fireEvent.click(screen.getByTestId('save-state-button'));

    expect(saved.onSave).toHaveBeenCalledTimes(1);
    expect(saved.onSave).toHaveBeenCalledWith({ mode: 'linear', a: 5, b: 3, c: 0 });
  });

  it('never saves anything while a slider is dragged', async () => {
    const saved = control();
    renderHost(saved, entry, CHAPTER);

    const slope = await screen.findByLabelText(/a \(slope/);
    fireEvent.change(slope, { target: { value: '3' } });
    fireEvent.change(slope, { target: { value: '4' } });

    expect(saved.onSave).not.toHaveBeenCalled();
  });

  it('reset returns the view to the chapter preset without deleting the snapshot', async () => {
    const saved = control({ status: 'saved', values: SAVED });
    renderHost(saved, entry, CHAPTER);

    expect(await screen.findByTestId('formula')).toHaveTextContent('y = 4x²');

    fireEvent.click(screen.getByTestId('reset-button'));

    await waitFor(() => expect(screen.getByTestId('formula')).toHaveTextContent('y = 2x + 3'));
    expect(screen.getByTestId('parameter-origin')).toHaveTextContent(/chapter preset/i);
    expect(screen.getByTestId('saved-state-notice')).toHaveTextContent(/kept/i);
    // Reset is not a write of any kind.
    expect(saved.onSave).not.toHaveBeenCalled();
  });

  it('reset then save labels the now-persisted preset as saved', async () => {
    const saved = control({ status: 'saved', values: SAVED });
    renderHost(saved, entry, CHAPTER);
    await screen.findByTestId('formula');
    fireEvent.click(screen.getByTestId('reset-button'));
    await waitFor(() => expect(screen.getByTestId('formula')).toHaveTextContent('y = 2x + 3'));
    fireEvent.click(screen.getByTestId('save-state-button'));
    await waitFor(() => expect(saved.onSave).toHaveBeenCalledWith(PRESET));
    await waitFor(() => expect(screen.getByTestId('parameter-origin')).toHaveTextContent(/your saved parameters/i));
  });

  it('reset on the direct entry goes back to the tool defaults', async () => {
    const saved = control({ status: 'saved', values: SAVED });
    renderHost(saved, entry, TOOL);

    expect(await screen.findByTestId('formula')).toHaveTextContent('y = 4x²');
    fireEvent.click(screen.getByTestId('reset-button'));

    await waitFor(() => expect(screen.getByTestId('formula')).toHaveTextContent('y = x²'));
    expect(screen.getByTestId('parameter-origin')).toHaveTextContent(/tool defaults/i);
  });

  it('reports a save that the server refused', async () => {
    const saved = control({ status: 'none', error: 'save' });
    renderHost(saved, entry, CHAPTER);

    await screen.findByTestId('formula');
    expect(screen.getByTestId('saved-state-notice')).toHaveTextContent(/not saved/i);
  });

  it('says the settings are saved after a successful write', async () => {
    const onSave = vi.fn(async () => undefined);
    const saved = control({ status: 'none', onSave });
    renderHost(saved, entry, CHAPTER);

    await screen.findByTestId('formula');
    fireEvent.click(screen.getByTestId('save-state-button'));

    await waitFor(() =>
      expect(screen.getByTestId('saved-state-notice')).toHaveTextContent(/saved/i),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe('experiments without a state schema', () => {
  it('offer no saving, while the plain reset control stays available', async () => {
    const withoutSchema: RegistryEntry = { ...entry, stateSchema: null };
    renderHost(undefined, withoutSchema, TOOL);

    await screen.findByTestId('formula');
    expect(screen.queryByTestId('save-state-button')).toBeNull();
    expect(screen.queryByTestId('parameter-origin')).toBeNull();
    expect(screen.getByTestId('reset-button')).toBeInTheDocument();
  });
});
