/**
 * In-memory request counters: a one-minute sliding window and a per-UTC-day
 * count per key. Run one instance (Cloud Run max-instances=1) so the counts
 * match what each provider sees; several instances would each count alone.
 */
export class Counter {
  private minute = new Map<string, number[]>();
  private day = new Map<string, { day: string; count: number }>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private today() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private recent(key: string) {
    const cutoff = this.now() - 60_000;
    const hits = (this.minute.get(key) ?? []).filter((t) => t > cutoff);
    this.minute.set(key, hits);
    return hits;
  }

  /** Whether one more request fits under `rpm` and `rpd` (either may be undefined for no limit). */
  allows(key: string, rpm?: number, rpd?: number) {
    if (rpm !== undefined && this.recent(key).length >= rpm) return false;
    if (rpd !== undefined) {
      const d = this.day.get(key);
      if (d && d.day === this.today() && d.count >= rpd) return false;
    }
    return true;
  }

  /** Records one request. */
  hit(key: string) {
    this.recent(key).push(this.now());
    const today = this.today();
    const d = this.day.get(key);
    this.day.set(key, d && d.day === today ? { day: today, count: d.count + 1 } : { day: today, count: 1 });
  }

  /** Drops stale entries so long-running instances don't grow without bound. */
  sweep() {
    const today = this.today();
    for (const [k, d] of this.day) if (d.day !== today) this.day.delete(k);
    for (const k of this.minute.keys()) if (this.recent(k).length === 0) this.minute.delete(k);
  }
}

/** Providers or models told to wait (after a 429, an outage, or a bad key), until a time. */
export class Cooldowns {
  private until = new Map<string, number>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  set(key: string, ms: number) {
    this.until.set(key, Math.max(this.until.get(key) ?? 0, this.now() + ms));
  }

  active(key: string) {
    const t = this.until.get(key);
    if (t === undefined) return false;
    if (t <= this.now()) {
      this.until.delete(key);
      return false;
    }
    return true;
  }
}
