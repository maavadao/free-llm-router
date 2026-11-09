/**
 * Token and request ledger behind the free-tier budget meter: what each
 * provider (and each quota pool) has served today (UTC) and this month, set
 * against the free allowance in the config. In memory, like the rate counters,
 * so a restart starts the day's count again; providers still say no (429) at
 * their real limit and the router fails over.
 */

export type Tally = { requests: number; tokens: number };

type Window = { period: string; tally: Tally };

export class Ledger {
  private days = new Map<string, Window>();
  private months = new Map<string, Window>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private stamp() {
    const iso = new Date(this.now()).toISOString();
    return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
  }

  private read(map: Map<string, Window>, key: string, period: string): Tally {
    const w = map.get(key);
    return w && w.period === period ? w.tally : { requests: 0, tokens: 0 };
  }

  private bump(map: Map<string, Window>, key: string, period: string, requests: number, tokens: number) {
    const t = this.read(map, key, period);
    map.set(key, { period, tally: { requests: t.requests + requests, tokens: t.tokens + tokens } });
  }

  /** Records a finished reply (or a request, with `tokens` 0, when the reply's size isn't known yet). */
  add(key: string, requests: number, tokens: number) {
    const { day, month } = this.stamp();
    this.bump(this.days, key, day, requests, tokens);
    this.bump(this.months, key, month, requests, tokens);
  }

  today(key: string): Tally {
    return this.read(this.days, key, this.stamp().day);
  }

  month(key: string): Tally {
    return this.read(this.months, key, this.stamp().month);
  }

  /** The day this ledger is counting, and the month. */
  period() {
    return this.stamp();
  }

  sweep() {
    const { day, month } = this.stamp();
    for (const [k, w] of this.days) if (w.period !== day) this.days.delete(k);
    for (const [k, w] of this.months) if (w.period !== month) this.months.delete(k);
  }
}

/**
 * Reads a provider's reply as it passes through and works out how many tokens
 * it used: the provider's own `usage` when it sends one, otherwise an estimate
 * from the length of the text (about 3.5 characters a token). Handles both
 * streamed (SSE) and plain JSON replies, and keeps only a line's worth of text.
 */
export class UsageTap {
  private decoder = new TextDecoder();
  private buffer = "";
  private chars = 0;
  private reported: number | null = null;
  private whole = "";
  private stream: boolean;

  constructor(stream: boolean) {
    this.stream = stream;
  }

  push(chunk: Uint8Array) {
    const text = this.decoder.decode(chunk, { stream: true });
    if (!this.stream) {
      // A non-streamed reply is one JSON object; keep it (replies are capped by max_tokens).
      if (this.whole.length < 4_000_000) this.whole += text;
      return;
    }
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      this.line(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
    }
  }

  private line(raw: string) {
    const line = raw.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      this.read(JSON.parse(data));
    } catch {
      // Not JSON (a keep-alive or a provider quirk): ignore it.
    }
  }

  private read(body: {
    usage?: { completion_tokens?: number; total_tokens?: number } | null;
    choices?: { delta?: Record<string, unknown>; message?: Record<string, unknown> }[];
  }) {
    const total = body.usage?.total_tokens;
    if (typeof total === "number" && total > 0) this.reported = total;
    for (const c of body.choices ?? []) {
      const part = c.delta ?? c.message ?? {};
      for (const field of ["content", "reasoning_content", "reasoning"]) {
        const v = part[field];
        if (typeof v === "string") this.chars += v.length;
      }
    }
  }

  /**
   * Total tokens for the request: the provider's figure if it gave one,
   * otherwise `promptTokens` (estimated before sending) plus the reply's estimate.
   */
  finish(promptTokens: number) {
    if (this.stream) {
      if (this.buffer) this.line(this.buffer);
      this.buffer = "";
    } else {
      this.whole += this.decoder.decode();
      try {
        this.read(JSON.parse(this.whole));
      } catch {
        // Not JSON; count nothing for the reply.
      }
      this.whole = "";
    }
    return { tokens: this.reported ?? promptTokens + Math.ceil(this.chars / 3.5), reported: this.reported !== null };
  }
}
