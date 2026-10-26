import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { insertEvent } from '../db/event-repository.js';
import type { ContentIndex } from './content-index.js';

/**
 * Diagnostic event dictionary and ingestion rules (design §6.1, §7.6, D8).
 *
 * Three properties are enforced here rather than trusted from the client:
 * 1. Only whitelisted event types and whitelisted attribute values are stored.
 * 2. The account comes from the session; the timestamp comes from the server clock.
 * 3. One-time events get a server-generated `dedupe_key`, so a retry cannot double-count
 *    while "reset" and "fullscreen" stay repeatable.
 *
 * Nothing else is accepted: no free text, no slider values, no URL, no user agent, no IP
 * and no client-provided timestamp. A field the server does not know is not stored — the
 * event is *dropped*, which the client may see as a lower `accepted` count.
 */

export const EVENT_TYPES = [
  'experiment_open',
  'experiment_first_interaction',
  'experiment_control_used',
  'experiment_reset',
  'experiment_fullscreen',
  'client_error',
  'feedback_submitted',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const CONTROL_GROUPS = [
  'mode',
  'a',
  'b',
  'c',
  'graph',
  'fullscreen_enter',
  'fullscreen_exit',
] as const;

export const INTERACTION_BUCKETS = ['1', '2-5', '6-20', '21+'] as const;

export const CLIENT_ERROR_CODES = [
  'render_error',
  'model_error',
  'unknown_error',
  'incompatible_sdk',
  'manifest_invalid',
] as const;

export const FEEDBACK_CATEGORIES = ['bug', 'confusing', 'content', 'wrong_value', 'other'] as const;

export const CONTENT_LOCALES = ['zh-CN', 'en'] as const;

/** Events that may happen only once per visit, keyed by their distinguishing attribute. */
const ONE_SHOT: ReadonlySet<EventType> = new Set<EventType>([
  'experiment_open',
  'experiment_first_interaction',
  'experiment_control_used',
  'client_error',
  'feedback_submitted',
]);

// App versions may carry a pre-release suffix (the package is 0.1.0-m1).
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const VISIT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const CLIENT_EVENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface IncomingEvent {
  readonly clientEventId?: unknown;
  readonly type?: unknown;
  readonly experimentId?: unknown;
  readonly contentVersion?: unknown;
  readonly locale?: unknown;
  readonly controlGroup?: unknown;
  readonly interactionBucket?: unknown;
  readonly errorCode?: unknown;
}

export interface EventRow {
  readonly id: string;
  readonly accountId: string;
  readonly experimentId: string;
  readonly contentVersion: string;
  readonly appVersion: string;
  readonly locale: string;
  readonly eventType: EventType;
  readonly controlGroup: string;
  readonly interactionBucket: string;
  readonly errorCode: string;
  readonly issueCategory: string;
  readonly deviceClass: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  readonly visitId: string;
  readonly clientEventId: string;
  readonly dedupeKey: string | null;
  readonly occurredAtMin: number;
  readonly receivedAt: number;
}

export function deviceClassFrom(userAgent: string | undefined): EventRow['deviceClass'] {
  const ua = userAgent ?? '';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'mobile';
  if (ua.trim() === '') return 'unknown';
  return 'desktop';
}

function oneOf<T extends readonly string[]>(values: T, candidate: unknown): candidate is T[number] {
  return typeof candidate === 'string' && (values as readonly string[]).includes(candidate);
}

export interface NormalizeInput {
  readonly events: readonly IncomingEvent[];
  readonly appVersion: string;
  readonly visitId: string;
  readonly accountId: string;
  readonly deviceClass: EventRow['deviceClass'];
  readonly contentIndex: ContentIndex;
  readonly receivedAt: number;
}

export interface NormalizeResult {
  readonly rows: readonly EventRow[];
  readonly dropped: number;
}

/**
 * Validates each event independently: one bad entry must not discard the batch (a client
 * retry would resend it forever), so rejected entries are counted, not thrown.
 */
export function normalizeEvents(input: NormalizeInput): NormalizeResult {
  const occurredAtMin = Math.floor(input.receivedAt / 60_000) * 60_000;
  const rows: EventRow[] = [];
  let dropped = 0;

  for (const event of input.events) {
    const type = event.type;
    if (!oneOf(EVENT_TYPES, type)) {
      dropped += 1;
      continue;
    }
    if (!oneOf(CONTENT_LOCALES, event.locale)) {
      dropped += 1;
      continue;
    }
    if (typeof event.clientEventId !== 'string' || !CLIENT_EVENT_ID.test(event.clientEventId)) {
      dropped += 1;
      continue;
    }
    if (typeof event.experimentId !== 'string') {
      dropped += 1;
      continue;
    }
    const experiment = input.contentIndex.find(event.experimentId);
    if (experiment === undefined) {
      dropped += 1;
      continue;
    }
    if (event.contentVersion !== experiment.contentVersion) {
      // A mismatched version would poison per-version analysis; drop rather than guess.
      dropped += 1;
      continue;
    }

    let controlGroup = '';
    let interactionBucket = '';
    let errorCode = '';

    if (type === 'experiment_control_used') {
      if (!oneOf(CONTROL_GROUPS, event.controlGroup)) {
        dropped += 1;
        continue;
      }
      if (!oneOf(INTERACTION_BUCKETS, event.interactionBucket)) {
        dropped += 1;
        continue;
      }
      controlGroup = event.controlGroup;
      interactionBucket = event.interactionBucket;
    } else if (type === 'experiment_fullscreen') {
      if (event.controlGroup !== 'fullscreen_enter' && event.controlGroup !== 'fullscreen_exit') {
        dropped += 1;
        continue;
      }
      controlGroup = event.controlGroup;
    } else if (type === 'client_error') {
      if (!oneOf(CLIENT_ERROR_CODES, event.errorCode)) {
        dropped += 1;
        continue;
      }
      errorCode = event.errorCode;
    }

    const dedupeKey = ONE_SHOT.has(type)
      ? `${input.visitId}:${type}:${controlGroup}${errorCode}`
      : null;

    rows.push({
      id: randomUUID(),
      accountId: input.accountId,
      experimentId: experiment.id,
      contentVersion: experiment.contentVersion,
      appVersion: input.appVersion,
      locale: event.locale,
      eventType: type,
      controlGroup,
      interactionBucket,
      errorCode,
      issueCategory: '',
      deviceClass: input.deviceClass,
      visitId: input.visitId,
      clientEventId: event.clientEventId,
      dedupeKey,
      occurredAtMin,
      receivedAt: input.receivedAt,
    });
  }

  return { rows, dropped };
}

export interface IngestResult {
  readonly accepted: number;
  readonly dropped: number;
}

/**
 * Writes the accepted rows. A duplicate `client_event_id` or `dedupe_key` is a normal
 * outcome (a retried request), so it counts as `dropped`, not as an error.
 */
export function ingestEvents(db: DatabaseSync, rows: readonly EventRow[], droppedBefore: number): IngestResult {
  let accepted = 0;
  let dropped = droppedBefore;
  for (const row of rows) {
    if (insertEvent(db, row)) {
      accepted += 1;
    } else {
      dropped += 1;
    }
  }
  return { accepted, dropped };
}

export interface FeedbackInput {
  readonly experimentId?: unknown;
  readonly contentVersion?: unknown;
  readonly appVersion?: unknown;
  readonly category?: unknown;
  readonly message?: unknown;
}

export interface NormalizedFeedback {
  readonly experimentId: string;
  readonly contentVersion: string;
  readonly appVersion: string;
  readonly category: (typeof FEEDBACK_CATEGORIES)[number];
  readonly message: string | null;
}

export type FeedbackResult = { readonly ok: true; readonly value: NormalizedFeedback } | { readonly ok: false };

/** Strips control characters and truncates rather than rejecting a long report. */
export function cleanFeedbackMessage(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const trimmed = stripped.trim();
  if (trimmed === '') return null;
  return trimmed.length > 2000 ? `${trimmed.slice(0, 1997)}...` : trimmed;
}

export function normalizeFeedback(input: FeedbackInput, contentIndex: ContentIndex): FeedbackResult {
  if (typeof input.experimentId !== 'string') return { ok: false };
  const experiment = contentIndex.find(input.experimentId);
  if (experiment === undefined) return { ok: false };
  if (!oneOf(FEEDBACK_CATEGORIES, input.category)) return { ok: false };
  if (typeof input.contentVersion !== 'string' || input.contentVersion !== experiment.contentVersion) {
    return { ok: false };
  }
  if (typeof input.appVersion !== 'string' || !SEMVER.test(input.appVersion)) return { ok: false };
  if (input.message !== undefined && input.message !== null && typeof input.message !== 'string') {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      experimentId: experiment.id,
      contentVersion: experiment.contentVersion,
      appVersion: input.appVersion,
      category: input.category,
      message: cleanFeedbackMessage(input.message),
    },
  };
}

export { VISIT_ID, SEMVER };
