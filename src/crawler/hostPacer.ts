/**
 * Per-host rate limiter.
 *
 * Tracks the timestamp of the last request to each host and enforces
 * a minimum delay between requests to the same host.
 *
 * This is an in-memory limiter suitable for a single worker process.
 * A distributed crawler would need a shared lock (e.g. Redis).
 */

export class HostPacer {
  private lastRequestTime = new Map<string, number>();

  constructor(private readonly minDelayMs: number) {}

  /**
   * Wait if needed to respect the per-host pacing delay,
   * then record this request time.
   */
  async pace(host: string): Promise<void> {
    const last = this.lastRequestTime.get(host);
    if (last !== undefined) {
      const elapsed = Date.now() - last;
      if (elapsed < this.minDelayMs) {
        await sleep(this.minDelayMs - elapsed);
      }
    }
    this.lastRequestTime.set(host, Date.now());
  }

  /** Override the minimum delay for a specific host (e.g., from robots.txt). */
  setHostDelay(host: string, delayMs: number): void {
    // We track per-host minimum dynamically so robots.txt crawl delays are honoured
    this._hostDelays.set(host, delayMs);
  }

  private _hostDelays = new Map<string, number>();

  getDelayFor(host: string): number {
    return Math.max(this.minDelayMs, this._hostDelays.get(host) ?? 0);
  }

  async paceWithHostDelay(host: string): Promise<void> {
    const delay = this.getDelayFor(host);
    const last = this.lastRequestTime.get(host);
    if (last !== undefined) {
      const elapsed = Date.now() - last;
      if (elapsed < delay) {
        await sleep(delay - elapsed);
      }
    }
    this.lastRequestTime.set(host, Date.now());
  }

  clear(): void {
    this.lastRequestTime.clear();
    this._hostDelays.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
