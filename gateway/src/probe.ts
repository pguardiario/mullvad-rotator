// Diagnostics, run inside the gateway container (so it is inside the tunnel):
//   node dist/probe.js sweep [--exit] [--parallel 32]   SOCKS handshake against every active relay
//   node dist/probe.js conns <socks-hostname> [--n 200] concurrent connections held open on one relay
import type { Socket } from 'node:net';
import { errMsg } from './log.js';
import { RelayPool, type Relay } from './relays.js';
import { connectVia, exitInfoVia } from './upstream.js';

const args = process.argv.slice(2);
const flag = (name: string, def: number) => {
  const i = args.indexOf(name);
  return i === -1 ? def : Number(args[i + 1]);
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function loadPool(): Promise<RelayPool> {
  const pool = new RelayPool();
  if (!(await pool.refresh())) throw new Error('could not load relay list from API');
  pool.stop();
  return pool;
}

async function sweep(): Promise<void> {
  const pool = await loadPool();
  const withExit = args.includes('--exit');
  const relays = pool.matching({});
  console.log(`probing ${relays.length} active relays with socks_name${withExit ? ' (with exit check)' : ''}...`);

  const results = await mapLimit(relays, flag('--parallel', 32), async (r: Relay) => {
    const t = Date.now();
    try {
      if (withExit) {
        const exit = await exitInfoVia(pool, r);
        // am.i.mullvad.net names the socks host (e.g. "se-sto-wg-socks5-001") as the exit.
        const mismatch = !r.socksName.startsWith(`${exit.mullvad_exit_ip_hostname}.`);
        return { relay: r.socksName, ok: true, ms: Date.now() - t, ip: exit.ip, exitHost: exit.mullvad_exit_ip_hostname, mismatch };
      }
      const s = await connectVia(pool, r, 'am.i.mullvad.net', 443);
      s.destroy();
      return { relay: r.socksName, ok: true, ms: Date.now() - t };
    } catch (err) {
      return { relay: r.socksName, ok: false, ms: Date.now() - t, error: errMsg(err) };
    }
  });

  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))];
  console.log(`ok ${ok.length}/${results.length}  connect ms p50=${pct(50)} p90=${pct(90)} max=${ms.at(-1)}`);
  for (const b of bad) console.log(`FAIL ${b.relay}  ${b.error}`);
  if (withExit) {
    const ips = new Set(ok.map((r) => (r as { ip?: string }).ip));
    console.log(`distinct exit IPs: ${ips.size}`);
    for (const r of ok) if ((r as { mismatch?: boolean }).mismatch) console.log(`EXIT-MISMATCH`, r);
  }
}

async function conns(): Promise<void> {
  const name = args[1];
  const n = flag('--n', 200);
  const pool = await loadPool();
  const relay = name ? pool.get(name) : undefined;
  if (!relay) throw new Error(`usage: probe conns <socks-hostname> [--n 200]  (unknown relay "${name}")`);

  console.log(`opening ${n} concurrent SOCKS connections via ${relay.socksName}...`);
  const held: Socket[] = [];
  const errors = new Map<string, number>();
  await mapLimit(Array.from({ length: n }, (_, i) => i), 50, async () => {
    try {
      held.push(await connectVia(pool, relay, 'am.i.mullvad.net', 443));
    } catch (err) {
      const m = errMsg(err);
      errors.set(m, (errors.get(m) ?? 0) + 1);
    }
  });
  console.log(`held open simultaneously: ${held.length}/${n}`);
  for (const [m, c] of errors) console.log(`  ${c}x ${m}`);

  // Do the held connections still carry data? Use TLS to check the last few.
  const { connect } = await import('node:tls');
  const sample = held.slice(-5);
  const alive = await Promise.all(
    sample.map(
      (s) =>
        new Promise<boolean>((res) => {
          const t = connect({ socket: s, servername: 'am.i.mullvad.net' }, () => res(true));
          t.on('error', () => res(false));
          setTimeout(() => res(false), 10_000);
        }),
    ),
  );
  console.log(`TLS handshake on last ${sample.length} held sockets: ${alive.filter(Boolean).length} ok`);
  for (const s of held) s.destroy();
}

const cmd = args[0];
try {
  if (cmd === 'sweep') await sweep();
  else if (cmd === 'conns') await conns();
  else console.log('usage: probe sweep [--exit] [--parallel 32] | probe conns <socks-hostname> [--n 200]');
} catch (err) {
  console.error(errMsg(err));
  process.exitCode = 1;
}
process.exit();
