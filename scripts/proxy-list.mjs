#!/usr/bin/env node
// Print one proxy URL per Mullvad exit relay, each pinned to that relay with
// the user_relay_<name> username. Reads PROXY_PASSWORD (and PROXY_PORT,
// PROXY_USER) from .env and the relay list from the running gateway.
//
//   node --env-file=.env scripts/proxy-list.mjs > mullvad-proxies.txt
//   node --env-file=.env scripts/proxy-list.mjs --host 127.0.0.1 --country us
//
// The output contains the proxy password. Keep it out of git.
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    host: { type: 'string', default: 'localhost' },
    country: { type: 'string' },
  },
});

const password = process.env.PROXY_PASSWORD;
if (!password) {
  console.error('PROXY_PASSWORD not set (run with node --env-file=.env)');
  process.exit(1);
}
const port = process.env.PROXY_PORT || '8899';
const user = process.env.PROXY_USER || 'user';

const auth = Buffer.from(`${user}:${password}`).toString('base64');
let res;
try {
  res = await fetch(`http://127.0.0.1:${port}/relays`, { headers: { authorization: `Basic ${auth}` } });
} catch (err) {
  console.error(`cannot reach the gateway on 127.0.0.1:${port}: ${err.cause?.message ?? err.message}`);
  process.exit(1);
}
if (!res.ok) {
  console.error(`gateway answered HTTP ${res.status}: ${(await res.text()).trim()}`);
  process.exit(1);
}

let relays = await res.json();
if (opts.country) relays = relays.filter((r) => r.country === opts.country.toLowerCase());

const pw = encodeURIComponent(password);
for (const r of relays) {
  console.log(`http://${user}_relay_${r.name}:${pw}@${opts.host}:${port}`);
}
console.error(`${relays.length} proxies`);
