import type { Socket } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { SocksClient } from 'socks';
import { config } from './config.js';
import { errMsg, log } from './log.js';
import { Sessions } from './sessions.js';
import type { Route } from './auth.js';
import type { Relay, RelayPool } from './relays.js';

/** The relay answered but refused the target (refused, unreachable, ...). Not the relay's fault. */
export class TargetError extends Error {}

/** Could not get a working relay for this request. */
export class RelayError extends Error {}

/** Open a TCP stream to host:port through one relay's SOCKS5 proxy. */
export async function connectVia(pool: RelayPool, relay: Relay, host: string, port: number): Promise<Socket> {
  const ip = await pool.resolve(relay);
  try {
    const { socket } = await SocksClient.createConnection({
      proxy: { host: ip, port: relay.socksPort, type: 5 },
      // Pass the hostname through so the relay resolves it: no local DNS for targets.
      destination: { host, port },
      command: 'connect',
      timeout: config.connectTimeoutMs,
    });
    return socket;
  } catch (err) {
    const msg = errMsg(err);
    if (msg.startsWith('Socks5 proxy rejected connection')) throw new TargetError(msg);
    throw new RelayError(msg);
  }
}

export interface Upstream {
  socket: Socket;
  relay: Relay;
}

/**
 * Pick a relay for the route and connect. Sticky routes reuse their relay;
 * if it fails it is cooled down, the session is reassigned and we retry once.
 * Rotating routes also get one retry on a different relay.
 */
export async function openUpstream(
  pool: RelayPool,
  sessions: Sessions,
  route: Route,
  host: string,
  port: number,
): Promise<Upstream> {
  const key = route.sessionId !== undefined ? Sessions.key(route.filter, route.sessionId) : undefined;
  const tried = new Set<string>();

  let relay: Relay | undefined;
  if (key) {
    const name = sessions.get(key);
    const current = name ? pool.get(name) : undefined;
    if (current && pool.isHealthy(current)) relay = current;
  }
  if (!relay) {
    relay = pool.pick(route.filter);
    if (key) sessions.set(key, relay.socksName);
  }

  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      const socket = await connectVia(pool, relay, host, port);
      log.debug('upstream connected', { relay: relay.socksName, ms: Date.now() - started });
      return { socket, relay };
    } catch (err) {
      if (err instanceof TargetError) throw err;
      pool.markBad(relay, errMsg(err));
      pool.forgetDns(relay);
      tried.add(relay.socksName);
      if (attempt >= 1) throw new RelayError(`relay ${relay.socksName} failed after retry: ${errMsg(err)}`);
      const next = pool.pick(route.filter, tried);
      log.info('retrying on another relay', { failed: relay.socksName, next: next.socksName, session: key });
      relay = next;
      if (key) sessions.set(key, relay.socksName);
    }
  }
}

export interface ExitInfo {
  ip: string;
  country?: string;
  city?: string;
  mullvad_exit_ip_hostname?: string;
}

/** GET https://am.i.mullvad.net/json through a specific relay. */
export async function exitInfoVia(pool: RelayPool, relay: Relay): Promise<ExitInfo> {
  const host = 'am.i.mullvad.net';
  const raw = await connectVia(pool, relay, host, 443);
  return new Promise<ExitInfo>((resolve, reject) => {
    const req = httpsRequest(
      {
        host,
        path: '/json',
        createConnection: () => tlsConnect({ socket: raw, servername: host }),
        headers: { connection: 'close' },
        timeout: config.connectTimeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as ExitInfo);
          } catch {
            reject(new Error(`bad JSON from ${host} (HTTP ${res.statusCode})`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('exit check timed out')));
    req.on('error', reject);
    req.end();
  });
}
