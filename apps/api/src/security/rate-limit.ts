/**
 * In-process fixed-window rate limiting (design §4.5, decision D14/Q6).
 *
 * Single instance only: the buckets live in this process and reset on restart. That is
 * an accepted limitation for the first release and must be replaced with shared storage
 * before the API runs as more than one instance.
 */

export interface RateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
}

export type RateLimitStatus =
  | { readonly blocked: false }
  | { readonly blocked: true; readonly retryAfterSeconds: number };

interface Bucket {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly maxBuckets: number;

  constructor(now: () => number, maxBuckets = 10_000) {
    this.now = now;
    this.maxBuckets = maxBuckets;
  }

  /** Reports whether the next call would be blocked, without spending budget. */
  status(key: string, rule: RateLimitRule): RateLimitStatus {
    const bucket = this.buckets.get(key);
    const now = this.now();
    if (bucket === undefined || bucket.resetAt <= now) {
      return { blocked: false };
    }
    if (bucket.count < rule.limit) {
      return { blocked: false };
    }
    return { blocked: true, retryAfterSeconds: retryAfterSeconds(bucket.resetAt, now) };
  }

  /**
   * Spends one unit of budget. The call that reaches the limit is still allowed (so a
   * user gets exactly `limit` attempts); every call after it is blocked.
   */
  consume(key: string, rule: RateLimitRule): RateLimitStatus {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
      this.prune(now);
      return { blocked: false };
    }
    if (bucket.count >= rule.limit) {
      return { blocked: true, retryAfterSeconds: retryAfterSeconds(bucket.resetAt, now) };
    }
    bucket.count += 1;
    return { blocked: false };
  }

  /** Forgets a key, e.g. after a successful login clears the failure streak. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  clear(): void {
    this.buckets.clear();
  }

  get size(): number {
    return this.buckets.size;
  }

  private prune(now: number): void {
    if (this.buckets.size <= this.maxBuckets) {
      return;
    }
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}

function retryAfterSeconds(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}
