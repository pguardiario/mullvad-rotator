function num(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  return n;
}

function str(name: string, def: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? def : raw;
}

export const config = {
  password: process.env.PROXY_PASSWORD ?? '',
  userPrefix: str('PROXY_USER', 'user'),
  listenHost: str('LISTEN_HOST', '0.0.0.0'),
  listenPort: num('LISTEN_PORT', 8899),

  relayApiUrl: str('RELAY_API_URL', 'https://api.mullvad.net/www/relays/wireguard/'),
  relayRefreshMs: num('RELAY_REFRESH_HOURS', 6) * 3600_000,
  dataDir: str('DATA_DIR', '/data'),

  stickyTtlMs: num('STICKY_TTL_MIN', 30) * 60_000,
  cooldownMs: num('RELAY_COOLDOWN_MIN', 10) * 60_000,
  connectTimeoutMs: num('CONNECT_TIMEOUT_MS', 10_000),
  idleTimeoutMs: num('IDLE_TIMEOUT_SEC', 300) * 1000,

  // Mullvad's resolver, reachable only inside the tunnel. Used for the relay
  // socks hostnames, which resolve to 10.124.x.x and get filtered by gluetun's
  // DNS rebinding protection.
  mullvadDns: str('MULLVAD_DNS', '10.64.0.1'),

  healthIntervalMs: num('HEALTHCHECK_INTERVAL_MIN', 15) * 60_000,
  healthSample: num('HEALTHCHECK_SAMPLE', 5),

  logLevel: str('LOG_LEVEL', 'info'),
};

export function assertConfig(): void {
  if (config.password.length < 8) {
    throw new Error('PROXY_PASSWORD must be set (at least 8 characters)');
  }
}
