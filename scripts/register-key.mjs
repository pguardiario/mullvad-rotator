#!/usr/bin/env node
// Generate a WireGuard keypair and register the public key with a Mullvad
// account. Uses one of the account's 5 device slots. Prints .env lines.
//
//   MULLVAD_ACCOUNT=1234123412341234 node scripts/register-key.mjs >> .env
//   node --env-file=.env scripts/register-key.mjs >> .env   (account already in .env)
//
// The account number is read from the environment and never written anywhere.
import { generateKeyPairSync } from 'node:crypto';

const account = (process.env.MULLVAD_ACCOUNT ?? '').replace(/\s+/g, '');
if (!/^\d{16}$/.test(account)) {
  console.error('set MULLVAD_ACCOUNT to your 16-digit Mullvad account number');
  process.exit(1);
}

const { privateKey } = generateKeyPairSync('x25519');
const jwk = privateKey.export({ format: 'jwk' });
const b64 = (s) => Buffer.from(s, 'base64url').toString('base64');
const priv = b64(jwk.d);
const pub = b64(jwk.x);

const res = await fetch('https://api.mullvad.net/wg', {
  method: 'POST',
  body: new URLSearchParams({ account, pubkey: pub }),
});
const text = (await res.text()).trim();
if (!res.ok) {
  console.error(`Mullvad rejected the key (HTTP ${res.status}): ${text}`);
  process.exit(1);
}

// Response is "10.x.x.x/32,fc00:...:/128". gluetun only needs the IPv4 one.
const ipv4 = text.split(',').find((a) => a.includes('.'));
console.error(`registered public key ${pub} -> ${text}`);
console.log(`WIREGUARD_PRIVATE_KEY=${priv}`);
console.log(`WIREGUARD_ADDRESSES=${ipv4}`);
