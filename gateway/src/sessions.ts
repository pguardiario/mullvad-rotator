import { config } from './config.js';
import type { Filter } from './relays.js';

interface Entry {
  relay: string; // socks hostname
  expires: number;
}

/** Sticky sessions: sessionKey -> relay socks hostname, sliding idle TTL. */
export class Sessions {
  private map = new Map<string, Entry>();
  private sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  static key(f: Filter, sessionId: string): string {
    return `${f.country ?? '*'}|${f.city ?? '*'}|${sessionId}`;
  }

  /** Current relay for the session, extending its TTL. */
  get(key: string): string | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    e.expires = Date.now() + config.stickyTtlMs;
    return e.relay;
  }

  set(key: string, relay: string): void {
    this.map.set(key, { relay, expires: Date.now() + config.stickyTtlMs });
  }

  get size(): number {
    this.sweep();
    return this.map.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.map) if (e.expires <= now) this.map.delete(k);
  }

  stop(): void {
    clearInterval(this.sweeper);
  }
}
