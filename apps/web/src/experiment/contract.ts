/**
 * Experiment contract v2 (see docs/architecture/impact-B5-event-contract.md).
 *
 * This module is intentionally dependency-free: no React import, no browser globals.
 * Experiments only ever see these types, never analytics vendors or other experiments.
 *
 * v2 changed the diagnostic vocabulary to what the product actually asks: "opened",
 * "started interacting", "used this control category", "reset", "fullscreen", "crashed".
 * `experiment_complete` was removed (an exploratory tool has no reliable completion) and
 * `experiment_interact` was split into first-interaction and control-category events.
 */

/** Host SDK version. Bump major on breaking contract changes. */
export const SDK_VERSION = '1.0.0';

export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Control *categories*, never a control value. Fullscreen direction reuses this field. */
export const CONTROL_GROUPS = ['mode', 'a', 'b', 'c', 'graph', 'fullscreen_enter', 'fullscreen_exit'] as const;
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
  'experiment_first_interaction',
  'experiment_control_used',
  'experiment_reset',
  'experiment_fullscreen',
  'client_error',
] as const;
export type ExperimentEventType = (typeof EVENT_TYPES)[number];

/** Events a page may emit. `feedback_submitted` is created by the server, not here. */
export interface ExperimentEvent {
  type: ExperimentEventType;
  experimentId: string;
  /** Content version from the manifest / API — what a regression would be grouped by. */
  contentVersion: string;
  locale?: Locale;
  controlGroup?: ControlGroup;
  interactionBucket?: InteractionBucket;
  errorCode?: ErrorCode;
  appVersion?: string;
}

/** Event after sanitisation: known fields only, plus a client id for retry idempotence. */
export type SafeExperimentEvent = Readonly<ExperimentEvent & { clientEventId: string }>;

export interface ExperimentManifest {
  id: string;
  slug: string;
  moduleVersion: string;
  /** Content version (design §10): what events, saved state and cached metadata key on. */
  contentVersion: string;
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
  /**
   * Parameters the host decided to apply (a snapshot the user asked to restore, design
   * §7.5). Absent means "use the documented defaults". The experiment must validate these
   * against its own schema before using them.
   */
  initialState?: Readonly<Record<string, number | string>>;
  /**
   * Mutable hand-off for explicit saving: the experiment assigns `read` so the host can ask
   * "what are the current parameters?" **only** when the user clicks save. Nothing is
   * polled, tracked or transmitted from this without that click.
   */
  stateBridge?: ExperimentStateBridge;
}

export interface ExperimentStateBridge {
  read?: () => unknown;
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
