export interface Limit {
  count: number;
  windowMs: number;
}

/** Parses "20:1,100:120" (count:seconds pairs) into limits. */
export function parseLimits(spec: string): Limit[] {
  return spec
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [count, seconds] = part.split(':').map(Number);
      if (!count || !seconds || count <= 0 || seconds <= 0) {
        throw new Error(`Invalid rate limit "${part}", expected count:seconds`);
      }
      return { count, windowMs: seconds * 1000 };
    });
}

/**
 * Sliding-window limiter that satisfies several limits at once
 * (Riot enforces e.g. 20 req/1s AND 100 req/2min per routing value).
 * Calls are serialized so concurrent callers queue fairly.
 */
export class RateLimiter {
  private timestamps: number[] = [];
  private tail: Promise<void> = Promise.resolve();
  private readonly maxWindowMs: number;

  constructor(
    private readonly limits: Limit[],
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.maxWindowMs = Math.max(0, ...limits.map((l) => l.windowMs));
  }

  acquire(): Promise<void> {
    const next = this.tail.then(() => this.waitForSlot());
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.timestamps = this.timestamps.filter((ts) => t - ts < this.maxWindowMs);

      let waitMs = 0;
      for (const limit of this.limits) {
        const inWindow = this.timestamps.filter((ts) => t - ts < limit.windowMs);
        if (inWindow.length >= limit.count) {
          // This request must wait until enough old requests leave the window.
          const mustExpire = inWindow[inWindow.length - limit.count]!;
          waitMs = Math.max(waitMs, mustExpire + limit.windowMs - t);
        }
      }

      if (waitMs <= 0) {
        this.timestamps.push(t);
        return;
      }
      await this.sleep(waitMs + 5);
    }
  }
}
