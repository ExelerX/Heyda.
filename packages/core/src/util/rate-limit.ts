/**
 * Sliding-window limiter: at most `max` hits per `windowMs` for each key.
 * Used against spam from contacts (urgent messages, SOS, where-requests) and runaway automations.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    /** Bounds memory when many keys appear; the oldest key is forgotten first. */
    private readonly maxKeys = 1000,
  ) {}

  /** Records a hit and returns whether it was within the limit. */
  allow(key: string, now: number): boolean {
    const recent = this.recent(key, now);
    if (recent.length >= this.max) return false;
    recent.push(now);
    this.hits.delete(key);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
    return true;
  }

  private recent(key: string, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs && t <= now);
  }
}

/** Remembers recently seen ids (bounded), e.g. to drop a message delivered twice. */
export class RecentIds {
  private readonly ids = new Set<string>();
  constructor(private readonly max = 5000) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** True when the id was new (and is now remembered). */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value!);
    return true;
  }
}
