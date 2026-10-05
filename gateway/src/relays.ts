import { lookup, Resolver } from 'node:dns/promises';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { errMsg, log } from './log.js';

export interface Relay {
  hostname: string;
  socksName: string;
  socksPort: number;
  countryCode: string;
  countryName: string;
  cityCode: string;
  cityName: string;
}

export interface Filter {
  country?: string;
  city?: string;
}

/** Thrown for a country/city filter that matches no relay; maps to HTTP 400. */
export class FilterError extends Error {}

interface ApiRelay {
  hostname?: string;
  active?: boolean;
  country_code?: string;
  country_name?: string;
  city_code?: string;
  city_name?: string;
  socks_name?: string | null;
  socks_port?: number | null;
}

const CACHE_FILE = 'relays.json';
const DNS_TTL_MS = 3600_000;

export function filterLabel(f: Filter): string {
  return [f.country, f.city].filter(Boolean).join('-') || 'any';
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class RelayPool {
  private relays: Relay[] = [];
  private byName = new Map<string, Relay>();
  private badUntil = new Map<string, number>();
  private lastExit = new Map<string, { ip: string; country?: string; city?: string; at: string }>();
  private dnsCache = new Map<string, { ip: string; expires: number }>();
  private resolver = new Resolver({ timeout: 2000, tries: 2 });
  private loadedAt: Date | null = null;
  private source: 'api' | 'cache' | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.resolver.setServers([config.mullvadDns]);
  }

  get size(): number {
    return this.relays.length;
  }

  get(socksName: string): Relay | undefined {
    return this.byName.get(socksName);
  }

  /** Load the disk cache (fast start), then the live API, then refresh on a timer. */
  async start(): Promise<void> {
    await this.loadCache();
    const ok = await this.refresh();
    if (!ok && this.relays.length === 0) {
      log.error('no relay list available (API failed, no cache); retrying every minute');
    }
    this.scheduleRefresh(ok || this.relays.length > 0 ? config.relayRefreshMs : 60_000);
  }

  stop(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  private scheduleRefresh(ms: number): void {
    this.refreshTimer = setTimeout(async () => {
      const ok = await this.refresh();
      this.scheduleRefresh(ok || this.relays.length > 0 ? config.relayRefreshMs : 60_000);
    }, ms);
    this.refreshTimer.unref();
  }

  async refresh(): Promise<boolean> {
    try {
      const res = await fetch(config.relayApiUrl, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) throw new Error('relay API did not return an array');
      const relays = RelayPool.parse(body as ApiRelay[]);
      if (relays.length === 0) throw new Error('relay API returned no usable relays');
      this.set(relays, 'api');
      await this.saveCache(body);
      const skipped = body.length - relays.length;
      log.info('relay list loaded', { source: 'api', relays: relays.length, skipped });
      return true;
    } catch (err) {
      log.warn('relay list refresh failed', { error: errMsg(err), keeping: this.relays.length });
      return false;
    }
  }

  private static parse(raw: ApiRelay[]): Relay[] {
    const out: Relay[] = [];
    for (const r of raw) {
      if (!r.active || !r.socks_name || !r.country_code || !r.city_code || !r.hostname) continue;
      out.push({
        hostname: r.hostname,
        socksName: r.socks_name,
        socksPort: r.socks_port || 1080,
        countryCode: r.country_code.toLowerCase(),
        countryName: r.country_name ?? r.country_code,
        cityCode: r.city_code.toLowerCase(),
        cityName: r.city_name ?? r.city_code,
      });
    }
    return out;
  }

  private set(relays: Relay[], source: 'api' | 'cache'): void {
    this.relays = relays;
    this.byName = new Map(relays.map((r) => [r.socksName, r]));
    this.loadedAt = new Date();
    this.source = source;
  }

  private async loadCache(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(join(config.dataDir, CACHE_FILE), 'utf8')) as ApiRelay[];
      const relays = RelayPool.parse(raw);
      if (relays.length > 0) {
        this.set(relays, 'cache');
        log.info('relay list loaded', { source: 'cache', relays: relays.length });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('relay cache unreadable', { error: errMsg(err) });
      }
    }
  }

  private async saveCache(raw: unknown): Promise<void> {
    try {
      await mkdir(config.dataDir, { recursive: true });
      const file = join(config.dataDir, CACHE_FILE);
      await writeFile(file + '.tmp', JSON.stringify(raw));
      await rename(file + '.tmp', file);
    } catch (err) {
      log.warn('relay cache write failed', { error: errMsg(err) });
    }
  }

  /** All relays matching the filter. Throws FilterError if the filter is unknown. */
  matching(f: Filter): Relay[] {
    if (this.relays.length === 0) throw new Error('relay list not loaded yet');
    let list = this.relays;
    if (f.country) {
      list = list.filter((r) => r.countryCode === f.country);
      if (list.length === 0) throw new FilterError(`unknown country code "${f.country}"`);
    }
    if (f.city) {
      list = list.filter((r) => r.cityCode === f.city);
      if (list.length === 0) {
        const cities = [...new Set(this.relays.filter((r) => r.countryCode === f.country).map((r) => r.cityCode))];
        throw new FilterError(`unknown city code "${f.city}" for country "${f.country}" (known: ${cities.join(', ')})`);
      }
    }
    return list;
  }

  isHealthy(r: Relay, now = Date.now()): boolean {
    const until = this.badUntil.get(r.socksName);
    return until === undefined || until <= now;
  }

  /**
   * Random healthy relay matching the filter, skipping `exclude`. If every
   * candidate is cooling down, fall back to the one whose cooldown ends first
   * rather than failing outright.
   */
  pick(f: Filter, exclude: Set<string> = new Set()): Relay {
    const now = Date.now();
    const candidates = this.matching(f).filter((r) => !exclude.has(r.socksName));
    if (candidates.length === 0) throw new Error(`no relays left to try for ${filterLabel(f)}`);
    const healthy = candidates.filter((r) => this.isHealthy(r, now));
    if (healthy.length > 0) return healthy[Math.floor(Math.random() * healthy.length)];
    log.warn('all matching relays cooling down, using least-recent failure', { filter: filterLabel(f) });
    return candidates.reduce((a, b) => (this.badUntil.get(a.socksName)! <= this.badUntil.get(b.socksName)! ? a : b));
  }

  markBad(r: Relay, reason: string): void {
    this.badUntil.set(r.socksName, Date.now() + config.cooldownMs);
    log.warn('relay marked bad', { relay: r.socksName, reason, cooldownMin: config.cooldownMs / 60_000 });
  }

  markGood(r: Relay): void {
    this.badUntil.delete(r.socksName);
  }

  recordExit(r: Relay, exit: { ip: string; country?: string; city?: string }): void {
    this.lastExit.set(r.socksName, { ...exit, at: new Date().toISOString() });
  }

  sample(n: number): Relay[] {
    return shuffle([...this.relays]).slice(0, n);
  }

  /**
   * Resolve a relay's socks hostname via Mullvad's in-tunnel DNS, falling back
   * to the system resolver. Cached for an hour.
   */
  async resolve(r: Relay): Promise<string> {
    const hit = this.dnsCache.get(r.socksName);
    if (hit && hit.expires > Date.now()) return hit.ip;
    let ip: string;
    try {
      [ip] = await this.resolver.resolve4(r.socksName);
    } catch (err) {
      log.debug('mullvad dns failed, using system resolver', { relay: r.socksName, error: errMsg(err) });
      ({ address: ip } = await lookup(r.socksName, { family: 4 }));
    }
    this.dnsCache.set(r.socksName, { ip, expires: Date.now() + DNS_TTL_MS });
    return ip;
  }

  forgetDns(r: Relay): void {
    this.dnsCache.delete(r.socksName);
  }

  status() {
    const now = Date.now();
    const healthy = this.relays.filter((r) => this.isHealthy(r, now)).length;
    const countries: Record<string, number> = {};
    for (const r of this.relays) countries[r.countryCode] = (countries[r.countryCode] ?? 0) + 1;
    const coolingDown = [...this.badUntil.entries()]
      .filter(([, until]) => until > now)
      .map(([relay, until]) => ({ relay, untilSec: Math.round((until - now) / 1000) }));
    return {
      relays: this.relays.length,
      healthy,
      source: this.source,
      loadedAt: this.loadedAt?.toISOString() ?? null,
      countries,
      coolingDown,
      recentExits: Object.fromEntries(this.lastExit),
    };
  }
}
