import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { assertConfig, config } from './config.js';
import { checkAuth, type Route } from './auth.js';
import { errMsg, log } from './log.js';
import { FilterError, filterLabel, RelayPool } from './relays.js';
import { Sessions } from './sessions.js';
import { exitInfoVia, openUpstream, RelayError, TargetError, type Upstream } from './upstream.js';

assertConfig();

const pool = new RelayPool();
const sessions = new Sessions();
const startedAt = Date.now();
let openTunnels = 0;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function stripHopByHop(headers: IncomingMessage['headers']): Record<string, string | string[]> {
  const listed = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || listed.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Map an upstream failure to an HTTP status + message for the client. */
function failure(err: unknown): { status: number; message: string } {
  if (err instanceof FilterError) return { status: 400, message: err.message };
  if (err instanceof TargetError) return { status: 502, message: `target unreachable via relay: ${err.message}` };
  if (err instanceof RelayError) return { status: 502, message: err.message };
  return { status: 503, message: errMsg(err) };
}

function routeLabel(route: Route): Record<string, unknown> {
  return { filter: filterLabel(route.filter), session: route.sessionId ?? null };
}

// ---------------------------------------------------------------------------
// CONNECT (HTTPS and any other TCP)

function rawReply(sock: Duplex, status: number, reason: string, extra: string[] = [], body = ''): void {
  const lines = [`HTTP/1.1 ${status} ${reason}`, ...extra, 'Connection: close', `Content-Length: ${Buffer.byteLength(body)}`];
  sock.end(lines.join('\r\n') + '\r\n\r\n' + body);
}

function parseConnectTarget(target: string | undefined): { host: string; port: number } | null {
  if (!target) return null;
  try {
    const u = new URL(`http://${target}`);
    const port = Number(u.port);
    if (!u.hostname || !port) return null;
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port };
  } catch {
    return null;
  }
}

async function handleConnect(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
  const auth = checkAuth(req.headers['proxy-authorization']);
  if (!auth.ok) {
    if (auth.status === 407) {
      rawReply(client, 407, 'Proxy Authentication Required', ['Proxy-Authenticate: Basic realm="mullvad-gateway"']);
    } else {
      rawReply(client, 400, 'Bad Request', ['Content-Type: text/plain'], auth.message + '\n');
    }
    return;
  }
  const target = parseConnectTarget(req.url);
  if (!target) {
    rawReply(client, 400, 'Bad Request', ['Content-Type: text/plain'], 'CONNECT target must be host:port\n');
    return;
  }

  let clientGone = false;
  client.on('error', () => {});
  client.once('close', () => (clientGone = true));

  const started = Date.now();
  let up: Upstream;
  try {
    up = await openUpstream(pool, sessions, auth.route, target.host, target.port);
  } catch (err) {
    const f = failure(err);
    log.warn('connect failed', { target: `${target.host}:${target.port}`, ...routeLabel(auth.route), status: f.status, error: f.message });
    if (!clientGone) rawReply(client, f.status, f.status === 400 ? 'Bad Request' : 'Bad Gateway', ['Content-Type: text/plain'], f.message + '\n');
    return;
  }

  const { socket: upstream, relay } = up;
  if (clientGone) {
    upstream.destroy();
    return;
  }

  log.info('connect', {
    target: `${target.host}:${target.port}`,
    exit: relay.socksName,
    ...routeLabel(auth.route),
    connectMs: Date.now() - started,
  });

  openTunnels++;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openTunnels--;
    upstream.destroy();
    client.destroy();
  };
  upstream.on('error', close);
  upstream.on('close', close);
  client.on('close', close);
  upstream.setTimeout(config.idleTimeoutMs, close);
  (client as Socket).setTimeout(config.idleTimeoutMs, close);

  client.write(`HTTP/1.1 200 Connection Established\r\nX-Proxy-Exit: ${relay.socksName}\r\n\r\n`);
  if (head.length > 0) upstream.write(head);
  upstream.pipe(client);
  client.pipe(upstream);
}

// ---------------------------------------------------------------------------
// Plain HTTP (absolute-URI requests) and the local admin endpoints

function textReply(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body + '\n');
}

function handleLocal(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/healthz') {
    textReply(res, pool.size > 0 ? 200 : 503, pool.size > 0 ? 'ok' : 'no relays loaded');
    return;
  }
  if (path === '/status') {
    const auth = checkAuth(req.headers['authorization'] ?? req.headers['proxy-authorization']);
    // A bad username format is still the right password, which is all /status needs.
    if (!auth.ok && auth.status === 407) {
      textReply(res, 401, 'unauthorized', { 'www-authenticate': 'Basic realm="mullvad-gateway"' });
      return;
    }
    const body = {
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      activeSessions: sessions.size,
      openTunnels,
      ...pool.status(),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, null, 2) + '\n');
    return;
  }
  textReply(res, 404, 'not found (this is a proxy; local paths are /status and /healthz)');
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url?.startsWith('/')) {
    handleLocal(req, res);
    return;
  }

  const auth = checkAuth(req.headers['proxy-authorization']);
  if (!auth.ok) {
    if (auth.status === 407) {
      textReply(res, 407, 'proxy authentication required', { 'proxy-authenticate': 'Basic realm="mullvad-gateway"' });
    } else textReply(res, 400, auth.message);
    return;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? '');
  } catch {
    textReply(res, 400, 'request target must be an absolute http:// URL');
    return;
  }
  if (url.protocol !== 'http:') {
    textReply(res, 400, `only http:// is proxied directly; use CONNECT for ${url.protocol}`);
    return;
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port) || 80;
  let clientGone = false;
  res.once('close', () => (clientGone = true));

  const started = Date.now();
  let up: Upstream;
  try {
    up = await openUpstream(pool, sessions, auth.route, host, port);
  } catch (err) {
    const f = failure(err);
    log.warn('http failed', { host: `${host}:${port}`, ...routeLabel(auth.route), status: f.status, error: f.message });
    if (!clientGone) textReply(res, f.status, f.message);
    return;
  }
  const { socket, relay } = up;
  if (clientGone) {
    socket.destroy();
    return;
  }

  const headers = stripHopByHop(req.headers);
  headers.host = url.host;
  headers.connection = 'close';

  const upReq = httpRequest(
    {
      method: req.method,
      path: url.pathname + url.search,
      headers,
      createConnection: () => socket,
    },
    (upRes) => {
      log.info('http', {
        method: req.method,
        host: url.host,
        status: upRes.statusCode,
        exit: relay.socksName,
        ...routeLabel(auth.route),
        ms: Date.now() - started,
      });
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, {
        ...stripHopByHop(upRes.headers),
        'x-proxy-exit': relay.socksName,
      });
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    },
  );
  socket.setTimeout(config.idleTimeoutMs, () => upReq.destroy(new Error('upstream idle timeout')));
  upReq.on('error', (err) => {
    log.warn('http upstream error', { host: url.host, exit: relay.socksName, error: errMsg(err) });
    if (!res.headersSent) textReply(res, 502, `upstream error: ${errMsg(err)}`);
    else res.destroy();
  });
  res.once('close', () => {
    if (!res.writableFinished) upReq.destroy();
  });
  req.pipe(upReq);
}

// ---------------------------------------------------------------------------
// Optional background exit check

function startHealthLoop(): void {
  if (config.healthIntervalMs <= 0 || config.healthSample <= 0) return;
  const run = async () => {
    if (pool.size === 0) return;
    const results = await Promise.allSettled(
      pool.sample(config.healthSample).map(async (relay) => {
        try {
          const exit = await exitInfoVia(pool, relay);
          pool.recordExit(relay, exit);
          pool.markGood(relay);
          return { relay: relay.socksName, ip: exit.ip, country: exit.country };
        } catch (err) {
          if (!(err instanceof TargetError)) pool.markBad(relay, `health check: ${errMsg(err)}`);
          throw err;
        }
      }),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    log.info('health check', {
      checked: results.length,
      ok,
      exits: results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])),
    });
  };
  setTimeout(run, 30_000).unref();
  setInterval(run, config.healthIntervalMs).unref();
}

// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    log.error('unhandled http error', { error: errMsg(err) });
    if (!res.headersSent) textReply(res, 500, 'internal error');
    else res.destroy();
  });
});
server.on('connect', (req, socket, head) => {
  handleConnect(req, socket, head).catch((err) => {
    log.error('unhandled connect error', { error: errMsg(err) });
    socket.destroy();
  });
});
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  log.debug('client error', { error: errMsg(err) });
});
// Plain-HTTP keep-alive from the client side is fine; each request gets its own upstream.
server.keepAliveTimeout = 30_000;
server.headersTimeout = 30_000;

// Listen first so a slow relay API answers 503 "not loaded yet" instead of refusing connections.
server.listen(config.listenPort, config.listenHost, () => {
  log.info('listening', {
    addr: `${config.listenHost}:${config.listenPort}`,
    stickyTtlMin: config.stickyTtlMs / 60_000,
    cooldownMin: config.cooldownMs / 60_000,
  });
});
await pool.start();
startHealthLoop();

function shutdown(signal: string): void {
  log.info('shutting down', { signal });
  pool.stop();
  sessions.stop();
  server.close();
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
