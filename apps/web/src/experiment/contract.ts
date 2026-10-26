/**
 * Experiment contract v1 (see docs/architecture/ADR-001-experiment-contract.md).
 *
 * This module is intentionally dependency-free: no React import, no browser globals.
 * Experiments only ever see these types, never analytics vendors or other experiments.
 */

/** Host SDK version. Bump major on breaking contract changes. */
export const SDK_VERSION = '1.0.0';

export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const CONTROL_GROUPS = ['mode', 'a', 'b', 'c', 'graph'] as const;
export type ControlGroup = (typeof CONTROL_GROUPS)[number];

export const INTERACTION_BUCKETS = ['1', '2-5', '6-20', '21+'] as const;
export type InteractionBucket = (typeof INTERACTION_BUCKETS)[number];

export const ERROR_CODES = [
  'render_error',
  'model_error',
  'unknown_error',
  'incompatible_sdk',
  'manifest_invalid',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const EVENT_TYPES = [
  'experiment_open',
  'experiment_interact',
  'experiment_reset',
  'experiment_fullscreen',
  'experiment_error',
  'experiment_complete',
] as const;
export type ExperimentEventType = (typeof EVENT_TYPES)[number];

export type FullscreenDirection = 'enter' | 'exit';

/**
 * Whitelisted, aggregate-only product events. No free text, no exact slider values,
 * no identifiers of people or devices. Unknown extra properties are dropped by the
 * analytics adapter before they can reach a sink.
 */
export interface ExperimentEvent {
  type: ExperimentEventType;
  experimentId: string;
  moduleVersion: string;
  locale?: Locale;
  controlGroup?: ControlGroup;
  interactionBucket?: InteractionBucket;
  enterOrExit?: FullscreenDirection;
  errorCode?: ErrorCode;
  appVersion?: string;
}

/** Event after sanitisation: only known fields, still aggregate-only. */
export type SafeExperimentEvent = Readonly<ExperimentEvent>;

export interface ExperimentManifest {
  id: string;
  slug: string;
  moduleVersion: string;
  /** Content version (design §10): what events, saved state and cached metadata key on. */
  contentVersion?: string;
  /** Caret range, e.g. "^1.0.0". The host accepts only matching major versions. */
  sdkVersionRange: string;
  titleKey: string;
  descriptionKey: string;
  subjects: string[];
  grades: string[];
  concepts: string[];
  languages: Locale[];
  offlineSupport: boolean;
  reviewedStatus: 'draft' | 'verified';
}

export interface ExperimentServices {
  analytics: {
    track(event: ExperimentEvent): void;
  };
  errors: {
    report(input: { code: ErrorCode; error?: unknown }): void;
  };
}

export interface ExperimentProps {
  locale: Locale;
  /** Host increments this to ask the experiment to restore its documented defaults. */
  resetToken: number;
  services: ExperimentServices;
}

/** Returns a stable bucket so raw interaction counts never leave the browser. */
export function interactionBucketFor(count: number): InteractionBucket {
  if (!Number.isFinite(count) || count <= 1) return '1';
  if (count <= 5) return '2-5';
  if (count <= 20) return '6-20';
  return '21+';
}

/** Parse the major version from a caret range. Returns null for unsupported formats. */
export function caretRangeMajor(range: string): number | null {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!match) return null;
  return Number(match[1]);
}

/** A module is compatible when its range covers the host major version. */
export function isSdkCompatible(range: string, hostVersion = SDK_VERSION): boolean {
  const major = caretRangeMajor(range);
  const hostMajor = Number(hostVersion.split('.')[0]);
  return major !== null && major === hostMajor;
}
