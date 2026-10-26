import { describe, expect, it, vi } from 'vitest';
import {
  createAnalytics,
  createBatchingSink,
  createMemorySink,
  noopAnalytics,
  sanitizeEvent,
  type AnalyticsSink,
} from '../apps/web/src/services/analytics';
import type { ExperimentEvent, SafeExperimentEvent } from '../apps/web/src/experiment/contract';

/**
 * Analytics adapter (contract v2): whitelist, semantics, transport.
 *
 * These tests are the privacy boundary's regression net. If someone adds "just one more
 * field" or lets a slider value through, one of these fails.
 */

let counter = 0;
const nextId = (): string => `ce-test-${String((counter += 1)).padStart(3, '0')}`;

const baseEvent: ExperimentEvent = {
  type: 'experiment_open',
  experimentId: 'math.functions',
  contentVersion: '1.0.0',
  locale: 'en',
};

describe('sanitizeEvent (whitelist)', () => {
  it('keeps only the fields that belong to the event type', () => {
    const safe = sanitizeEvent(
      {
        type: 'experiment_control_used',
        experimentId: 'math.functions',
        contentVersion: '1.0.0',
        locale: 'en',
        controlGroup: 'a',
        interactionBucket: '2-5',
        // Simulated caller mistakes or a malicious component:
        studentName: 'Li Ming',
        email: 'student@example.com',
        rawSliderValue: 3.14159,
        pageUrl: 'https://example.com/?token=secret',
      } as ExperimentEvent,
      { appVersion: '0.1.0-m1', newClientEventId: nextId },
    );

    expect(safe).not.toBeNull();
    expect(Object.keys(safe as object).sort()).toEqual(
      [
        'appVersion',
        'clientEventId',
        'contentVersion',
        'controlGroup',
        'experimentId',
        'interactionBucket',
        'locale',
        'type',
      ].sort(),
    );
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain('Li Ming');
    expect(serialized).not.toContain('student@example.com');
    expect(serialized).not.toContain('3.14159');
    expect(serialized).not.toContain('token=secret');
  });

  it.each([
    ['unknown type', { type: 'page_view' }],
    ['removed complete type', { type: 'experiment_complete' }],
    ['malformed experiment id', { experimentId: 'Math Functions' }],
    ['non-semver content version', { contentVersion: 'v1' }],
    ['unsupported locale', { locale: 'fr' }],
    ['control event without a bucket', { type: 'experiment_control_used', controlGroup: 'a' }],
    [
      'control event with a fullscreen group',
      { type: 'experiment_control_used', controlGroup: 'fullscreen_enter', interactionBucket: '1' },
    ],
    ['fullscreen without a direction', { type: 'experiment_fullscreen' }],
    ['error event without a whitelisted code', { type: 'client_error', errorCode: 'stack_trace' }],
  ])('rejects a %s', (_label, patch) => {
    expect(
      sanitizeEvent({ ...baseEvent, ...(patch as object) } as ExperimentEvent, {
        newClientEventId: nextId,
      }),
    ).toBeNull();
  });
});

describe('createAnalytics (semantics)', () => {
  it('emits first-interaction once, immediately before the first control category', () => {
    const sink = createMemorySink();
    const analytics = createAnalytics({ sink, appVersion: '0.1.0-m1', newClientEventId: nextId });

    analytics.track({ ...baseEvent, type: 'experiment_control_used', controlGroup: 'a', interactionBucket: '1' });
    analytics.track({ ...baseEvent, type: 'experiment_control_used', controlGroup: 'b', interactionBucket: '2-5' });
    analytics.track({ ...baseEvent, type: 'experiment_reset' });

    expect(sink.events.map((event) => event.type)).toEqual([
      'experiment_first_interaction',
      'experiment_control_used',
      'experiment_control_used',
      'experiment_reset',
    ]);
  });

  it('keeps one control_used per category but every reset and fullscreen', () => {
    const sink = createMemorySink();
    const analytics = createAnalytics({ sink, appVersion: '0.1.0-m1', newClientEventId: nextId });

    for (let index = 0; index < 5; index += 1) {
      analytics.track({ ...baseEvent, type: 'experiment_control_used', controlGroup: 'a', interactionBucket: '6-20' });
      analytics.track({ ...baseEvent, type: 'experiment_reset' });
      analytics.track({ ...baseEvent, type: 'experiment_fullscreen', controlGroup: 'fullscreen_enter' });
      analytics.track({ ...baseEvent, type: 'experiment_fullscreen', controlGroup: 'fullscreen_exit' });
    }

    const counts = sink.events.reduce<Record<string, number>>((accumulator, event) => {
      const key = `${event.type}:${event.controlGroup ?? ''}`;
      accumulator[key] = (accumulator[key] ?? 0) + 1;
      return accumulator;
    }, {});
    expect(counts['experiment_control_used:a']).toBe(1);
    expect(counts['experiment_reset:']).toBe(5);
    expect(counts['experiment_fullscreen:fullscreen_enter']).toBe(5);
    expect(counts['experiment_fullscreen:fullscreen_exit']).toBe(5);
    expect(counts['experiment_first_interaction:']).toBe(1);
  });

  it('is a true no-op when disabled: nothing recorded, nothing thrown', () => {
    const record = vi.fn();
    const sink: AnalyticsSink = { record };
    const analytics = createAnalytics({ sink, enabled: false, newClientEventId: nextId });

    expect(() => analytics.track({ ...baseEvent, type: 'experiment_open' })).not.toThrow();
    expect(analytics.enabled).toBe(false);
    expect(record).not.toHaveBeenCalled();
    expect(noopAnalytics.enabled).toBe(false);
  });
});

describe('createBatchingSink (transport)', () => {
  it('batches by size and sends on demand', async () => {
    const sent: SafeExperimentEvent[][] = [];
    const sink = createBatchingSink({
      maxBatch: 3,
      flushDelayMs: 10_000,
      schedule: () => undefined,
      send: async (events) => {
        sent.push([...events]);
      },
    });

    const event = (id: string): SafeExperimentEvent => ({ ...baseEvent, clientEventId: id });
    sink.record(event('ce-a'));
    sink.record(event('ce-b'));
    expect(sent).toHaveLength(0);
    sink.record(event('ce-c'));
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(3);

    sink.record(event('ce-d'));
    await sink.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.map((entry) => entry.clientEventId)).toEqual(['ce-d']);
    expect(sink.size).toBe(0);
  });

  it('retries once, then drops the batch without throwing', async () => {
    let attempts = 0;
    const sink = createBatchingSink({
      maxBatch: 10,
      flushDelayMs: 10_000,
      schedule: () => undefined,
      send: async () => {
        attempts += 1;
        throw new Error('offline');
      },
    });

    sink.record({ ...baseEvent, clientEventId: 'ce-x' });
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(sink.size).toBe(0);
  });

  it('survives a second batch after a failed one', async () => {
    let fail = true;
    const sent: number[] = [];
    const sink = createBatchingSink({
      maxBatch: 10,
      flushDelayMs: 10_000,
      schedule: () => undefined,
      send: async (events) => {
        if (fail) throw new Error('offline');
        sent.push(events.length);
      },
    });

    sink.record({ ...baseEvent, clientEventId: 'ce-1' });
    await sink.flush();
    fail = false;
    sink.record({ ...baseEvent, clientEventId: 'ce-2' });
    await sink.flush();

    expect(sent).toEqual([1]);
  });
});
