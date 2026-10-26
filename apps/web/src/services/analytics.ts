/**
 * Replaceable, privacy-first analytics adapter.
 *
 * M1 default: no remote endpoint exists, so the only sink is an in-memory ring buffer
 * used for tests/debugging. Nothing is persisted and nothing is sent over the network.
 * Every event passes through a whitelist sanitiser: unknown keys, free text, page URLs,
 * raw slider values and identifiers never reach a sink.
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
const DEFAULT_INTERACT_THROTTLE_MS = 1500;

export interface AnalyticsSink {
  record(event: SafeExperimentEvent): void;
}

export interface AnalyticsOptions {
  /** Defaults to true. False means the adapter is a strict no-op. */
  enabled?: boolean;
  sink?: AnalyticsSink;
  /** Injectable clock (tests). */
  now?: () => number;
  interactThrottleMs?: number;
  appVersion?: string;
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

/**
 * Returns a whitelisted copy of the event, or null when the event is malformed.
 * Only fields relevant to the event type survive.
 */
export function sanitizeEvent(
  event: ExperimentEvent,
  appVersion?: string,
): SafeExperimentEvent | null {
  if (!event || !includes(EVENT_TYPES, event.type)) return null;
  if (!EXPERIMENT_ID.test(event.experimentId)) return null;
  if (!SEMVER.test(event.moduleVersion)) return null;

  const safe: {
    type: ExperimentEvent['type'];
    experimentId: string;
    moduleVersion: string;
    locale?: ExperimentEvent['locale'];
    controlGroup?: ExperimentEvent['controlGroup'];
    interactionBucket?: ExperimentEvent['interactionBucket'];
    enterOrExit?: ExperimentEvent['enterOrExit'];
    errorCode?: ExperimentEvent['errorCode'];
    appVersion?: string;
  } = {
    type: event.type,
    experimentId: event.experimentId,
    moduleVersion: event.moduleVersion,
  };

  if (event.locale !== undefined) {
    if (!includes(SUPPORTED_LOCALES, event.locale)) return null;
    safe.locale = event.locale;
  }

  if (event.type === 'experiment_interact') {
    if (event.controlGroup !== undefined) {
      if (!includes(CONTROL_GROUPS, event.controlGroup)) return null;
      safe.controlGroup = event.controlGroup;
    }
    if (event.interactionBucket !== undefined) {
      if (!includes(INTERACTION_BUCKETS, event.interactionBucket)) return null;
      safe.interactionBucket = event.interactionBucket;
    }
  }

  if (event.type === 'experiment_fullscreen') {
    if (event.enterOrExit !== 'enter' && event.enterOrExit !== 'exit') return null;
    safe.enterOrExit = event.enterOrExit;
  }

  if (event.type === 'experiment_error') {
    if (!includes(ERROR_CODES, event.errorCode)) return null;
    safe.errorCode = event.errorCode;
  }

  const version = event.appVersion ?? appVersion;
  if (version !== undefined) {
    if (!SEMVER.test(version)) return null;
    safe.appVersion = version;
  }

  return Object.freeze(safe);
}

export function createAnalytics(options: AnalyticsOptions = {}): AnalyticsAdapter {
  const enabled = options.enabled ?? true;
  const sink = options.sink;
  const now = options.now ?? Date.now;
  const throttleMs = options.interactThrottleMs ?? DEFAULT_INTERACT_THROTTLE_MS;
  let lastInteractAt = Number.NEGATIVE_INFINITY;

  return {
    enabled,
    track(event: ExperimentEvent): void {
      if (!enabled || !sink) return;
      const safe = sanitizeEvent(event, options.appVersion);
      if (!safe) return;

      if (safe.type === 'experiment_interact') {
        const timestamp = now();
        if (timestamp - lastInteractAt < throttleMs) return;
        lastInteractAt = timestamp;
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
