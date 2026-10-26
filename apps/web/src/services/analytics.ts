/**
 * Privacy-first analytics adapter (design §6, D8; contract v2).
 *
 * Three layers, each with one job:
 * 1. `sanitizeEvent` — whitelist. Only known fields for the event type survive; free
 *    text, slider values, URLs and unknown keys never reach a sink.
 * 2. `createAnalytics` — semantics. It emits `experiment_first_interaction` once per visit
 *    (right before the first control category is used) and de-duplicates control
 *    categories, because "did they start?" and "which control?" are the product questions.
 * 3. `createRemoteSink` — transport. Batches, retries once, then drops. Diagnostics are
 *    best effort: a failure here must never surface in the experiment.
 */

import {
  CONTROL_GROUPS,
  ERROR_CODES,
  EVENT_TYPES,
  INTERACTION_BUCKETS,
  SUPPORTED_LOCALES,
  type ExperimentEvent,
  type SafeExperimentEvent,
} from '../experiment/contract';

const EXPERIMENT_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DEFAULT_FLUSH_DELAY_MS = 1500;
const DEFAULT_MAX_BATCH = 10;

export interface AnalyticsSink {
  record(event: SafeExperimentEvent): void;
}

export interface AnalyticsOptions {
  /** Defaults to true. False means the adapter is a strict no-op. */
  enabled?: boolean;
  sink?: AnalyticsSink;
  /** Injectable clock (tests). */
  now?: () => number;
  appVersion?: string;
  /** Injectable id generator (tests); defaults to a random UUID-shaped id. */
  newClientEventId?: () => string;
}

export interface AnalyticsAdapter {
  readonly enabled: boolean;
  track(event: ExperimentEvent): void;
}

export interface MemorySink extends AnalyticsSink {
  events: SafeExperimentEvent[];
  clear(): void;
}

function includes<T extends readonly string[]>(values: T, candidate: unknown): candidate is T[number] {
  return typeof candidate === 'string' && (values as readonly string[]).includes(candidate);
}

function defaultClientEventId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID !== undefined) return cryptoApi.randomUUID();
  return `ce-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Returns a whitelisted copy of the event, or null when it is malformed. Only fields
 * relevant to the event type survive.
 */
export function sanitizeEvent(
  event: ExperimentEvent,
  options: { appVersion?: string; newClientEventId?: () => string } = {},
): SafeExperimentEvent | null {
  if (!event || !includes(EVENT_TYPES, event.type)) return null;
  if (!EXPERIMENT_ID.test(event.experimentId)) return null;
  if (!SEMVER.test(event.contentVersion ?? '')) return null;

  const safe: {
    type: ExperimentEvent['type'];
    experimentId: string;
    contentVersion: string;
    clientEventId: string;
    locale?: ExperimentEvent['locale'];
    controlGroup?: ExperimentEvent['controlGroup'];
    interactionBucket?: ExperimentEvent['interactionBucket'];
    errorCode?: ExperimentEvent['errorCode'];
    appVersion?: string;
  } = {
    type: event.type,
    experimentId: event.experimentId,
    contentVersion: event.contentVersion,
    clientEventId: (options.newClientEventId ?? defaultClientEventId)(),
  };

  if (event.locale !== undefined) {
    if (!includes(SUPPORTED_LOCALES, event.locale)) return null;
    safe.locale = event.locale;
  }

  if (event.type === 'experiment_control_used') {
    if (!includes(CONTROL_GROUPS, event.controlGroup)) return null;
    if (event.controlGroup === 'fullscreen_enter' || event.controlGroup === 'fullscreen_exit') {
      return null; // direction belongs to experiment_fullscreen only
    }
    if (!includes(INTERACTION_BUCKETS, event.interactionBucket)) return null;
    safe.controlGroup = event.controlGroup;
    safe.interactionBucket = event.interactionBucket;
  }

  if (event.type === 'experiment_fullscreen') {
    if (event.controlGroup !== 'fullscreen_enter' && event.controlGroup !== 'fullscreen_exit') {
      return null;
    }
    safe.controlGroup = event.controlGroup;
  }

  if (event.type === 'client_error') {
    if (!includes(ERROR_CODES, event.errorCode)) return null;
    safe.errorCode = event.errorCode;
  }

  const version = event.appVersion ?? options.appVersion;
  if (version !== undefined) {
    if (!SEMVER.test(version)) return null;
    safe.appVersion = version;
  }

  return Object.freeze(safe);
}

/**
 * Emits the derived `experiment_first_interaction` event and de-duplicates control
 * categories per session. An experiment calls `track` freely; this is where "once per
 * visit" is enforced, so a slider drag cannot become a per-frame stream.
 */
export function createAnalytics(options: AnalyticsOptions = {}): AnalyticsAdapter {
  const enabled = options.enabled ?? true;
  const sink = options.sink;
  const newClientEventId = options.newClientEventId ?? defaultClientEventId;
  let firstInteractionSent = false;
  const usedControls = new Set<string>();

  return {
    enabled,
    track(event: ExperimentEvent): void {
      if (!enabled || !sink) return;
      const safe = sanitizeEvent(event, {
        ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
        newClientEventId,
      });
      if (safe === null) return;

      if (safe.type === 'experiment_control_used' && safe.controlGroup !== undefined) {
        const key = `${safe.experimentId}:${safe.controlGroup}`;
        if (usedControls.has(key)) return;
        usedControls.add(key);

        if (!firstInteractionSent) {
          firstInteractionSent = true;
          sink.record(
            Object.freeze({
              type: 'experiment_first_interaction',
              experimentId: safe.experimentId,
              contentVersion: safe.contentVersion,
              ...(safe.locale === undefined ? {} : { locale: safe.locale }),
              ...(safe.appVersion === undefined ? {} : { appVersion: safe.appVersion }),
              clientEventId: newClientEventId(),
            }) as SafeExperimentEvent,
          );
        }
      }

      sink.record(safe);
    },
  };
}

export function createMemorySink(): MemorySink {
  const events: SafeExperimentEvent[] = [];
  return {
    events,
    record(event: SafeExperimentEvent): void {
      events.push(event);
    },
    clear(): void {
      events.length = 0;
    },
  };
}

/** Analytics disabled: experiments must behave identically. */
export const noopAnalytics: AnalyticsAdapter = Object.freeze({
  enabled: false,
  track(): void {
    /* intentionally empty */
  },
});

export interface BatchingSinkOptions {
  readonly send: (events: readonly SafeExperimentEvent[]) => Promise<void>;
  readonly maxBatch?: number;
  readonly flushDelayMs?: number;
  /** Injectable timer (tests). Returns anything; only the call is used. */
  readonly schedule?: (run: () => void, delayMs: number) => unknown;
}

export interface BatchingSink extends AnalyticsSink {
  /** Sends everything queued now. Safe to call concurrently. */
  flush(): Promise<void>;
  readonly size: number;
}

/**
 * Buffers events and sends them in small batches. `send` is attempted twice, then the
 * batch is dropped: diagnostic loss is acceptable, a retry storm is not.
 */
export function createBatchingSink(options: BatchingSinkOptions): BatchingSink {
  const maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH;
  const flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
  const schedule =
    options.schedule ?? ((run: () => void, delayMs: number) => setTimeout(run, delayMs));
  let queue: SafeExperimentEvent[] = [];
  let scheduled = false;
  let sending: Promise<void> = Promise.resolve();

  const attempt = async (batch: readonly SafeExperimentEvent[]): Promise<void> => {
    for (let tryIndex = 0; tryIndex < 2; tryIndex += 1) {
      try {
        await options.send(batch);
        return;
      } catch {
        // fall through to the single retry
      }
    }
  };

  const flush = async (): Promise<void> => {
    scheduled = false;
    if (queue.length === 0) {
      await sending;
      return;
    }
    const batch = queue;
    queue = [];
    sending = sending.then(() => attempt(batch));
    await sending;
  };

  const scheduleFlush = (): void => {
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      void flush();
    }, flushDelayMs);
  };

  return {
    get size() {
      return queue.length;
    },
    record(event: SafeExperimentEvent): void {
      queue.push(event);
      if (queue.length >= maxBatch) {
        void flush();
        return;
      }
      scheduleFlush();
    },
    flush,
  };
}

export interface RemoteSinkOptions extends Omit<BatchingSinkOptions, 'send'> {
  readonly send: (events: readonly SafeExperimentEvent[]) => Promise<unknown>;
}

/** Same batching behaviour, but the first failure is retried once and then forgotten. */
export function createRemoteSink(options: RemoteSinkOptions): BatchingSink {
  return createBatchingSink({
    ...options,
    send: async (events) => {
      await options.send(events);
    },
  });
}
