import { describe, expect, it, vi } from 'vitest';
import {
  createAnalytics,
  createMemorySink,
  noopAnalytics,
  type AnalyticsSink,
} from '../apps/web/src/services/analytics';
import type { ExperimentEvent } from '../apps/web/src/experiment/contract';

const baseEvent: ExperimentEvent = {
  type: 'experiment_open',
  experimentId: 'math.functions',
  moduleVersion: '0.1.0',
  locale: 'en',
};

describe('analytics adapter (privacy boundary)', () => {
  it('records only whitelisted fields and drops free text', () => {
    const sink = createMemorySink();
    const analytics = createAnalytics({ sink, now: () => 1000 });
    analytics.track({
      ...baseEvent,
      type: 'experiment_interact',
      controlGroup: 'a',
      interactionBucket: '2-5',
      // Simulated caller mistakes / malicious extras:
      studentName: 'Li Ming',
      email: 'student@example.com',
      rawSliderValue: 3.14159,
      pageUrl: 'https://example.com/?token=secret',
    } as ExperimentEvent);

    expect(sink.events).toHaveLength(1);
    const event = sink.events[0] as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual(
      ['controlGroup', 'experimentId', 'interactionBucket', 'locale', 'moduleVersion', 'type'].sort(),
    );
    expect(JSON.stringify(event)).not.toContain('Li Ming');
    expect(JSON.stringify(event)).not.toContain('student@example.com');
    expect(JSON.stringify(event)).not.toContain('3.14159');
    expect(JSON.stringify(event)).not.toContain('token=secret');
  });

  it('rejects malformed events instead of forwarding them', () => {
    const sink = createMemorySink();
    const analytics = createAnalytics({ sink });
    analytics.track({ ...baseEvent, experimentId: 'Math Functions' });
    analytics.track({ ...baseEvent, moduleVersion: 'not-semver' });
    analytics.track({ ...baseEvent, locale: 'fr' as ExperimentEvent['locale'] });
    analytics.track({ ...baseEvent, type: 'page_view' as ExperimentEvent['type'] });
    expect(sink.events).toEqual([]);
  });

  it('throttles interact events but never other event types', () => {
    let now = 0;
    const sink = createMemorySink();
    const analytics = createAnalytics({ sink, now: () => now, interactThrottleMs: 1500 });

    analytics.track({ ...baseEvent, type: 'experiment_interact', controlGroup: 'a', interactionBucket: '1' });
    now = 500;
    analytics.track({ ...baseEvent, type: 'experiment_interact', controlGroup: 'a', interactionBucket: '2-5' });
    now = 1600;
    analytics.track({ ...baseEvent, type: 'experiment_interact', controlGroup: 'a', interactionBucket: '2-5' });
    analytics.track({ ...baseEvent, type: 'experiment_reset' });

    expect(sink.events.map((event) => event.type)).toEqual([
      'experiment_interact',
      'experiment_interact',
      'experiment_reset',
    ]);
  });

  it('is a true no-op when disabled: nothing recorded, nothing thrown', () => {
    const record = vi.fn();
    const sink: AnalyticsSink = { record };
    const analytics = createAnalytics({ sink, enabled: false });

    expect(() => analytics.track({ ...baseEvent, type: 'experiment_open' })).not.toThrow();
    expect(analytics.enabled).toBe(false);
    expect(record).not.toHaveBeenCalled();
    expect(noopAnalytics.enabled).toBe(false);
  });

  it('never performs network I/O', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const analytics = createAnalytics({ sink: createMemorySink() });
    analytics.track({ ...baseEvent, type: 'experiment_fullscreen', enterOrExit: 'enter' });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
