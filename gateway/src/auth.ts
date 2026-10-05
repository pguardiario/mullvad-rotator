import { timingSafeEqual, createHash } from 'node:crypto';
import { config } from './config.js';
import type { Filter } from './relays.js';

export interface Route {
  filter: Filter;
  sessionId?: string;
}

export type AuthResult =
  | { ok: true; route: Route; username: string }
  | { ok: false; status: 407 }
  | { ok: false; status: 400; message: string };

const CODE = /^[a-z]{2,4}$/;
const SESSION = /^[A-Za-z0-9.-]{1,64}$/;

function sameSecret(a: string, b: string): boolean {
  // Hash first so lengths match and the comparison is constant-time.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function validRoute(country: string | undefined, city: string | undefined, sessionId: string | undefined): Route | string {
  if (country !== undefined && !CODE.test(country.toLowerCase())) return `invalid country code "${country}"`;
  if (city !== undefined && !CODE.test(city.toLowerCase())) return `invalid city code "${city}"`;
  if (sessionId !== undefined && !SESSION.test(sessionId)) {
    return 'session id must be 1-64 chars of [A-Za-z0-9.-]';
  }
  return {
    filter: { country: country?.toLowerCase(), city: city?.toLowerCase() },
    sessionId,
  };
}

/**
 * Keyed form: user_country_<cc>[_city_<city>][_<sid>]. Session ids cannot
 * contain "_", so this never collides with the plain user_<sid> form.
 */
function parseKeyed(parts: string[]): Route | string {
  if (parts[0] !== config.userPrefix) return `username must start with "${config.userPrefix}"`;
  let country: string | undefined;
  let city: string | undefined;
  let i = 1;
  while (parts[i] === 'country' || parts[i] === 'city') {
    const value = parts[i + 1];
    if (!value) return `missing value after "${parts[i]}_"`;
    if (parts[i] === 'country') country = value;
    else city = value;
    i += 2;
  }
  if (city !== undefined && country === undefined) return 'city needs a country too (user_country_<cc>_city_<city>)';
  const rest = parts.slice(i);
  if (rest.length > 1) return `unexpected "${rest.join('_')}" (expected a single session id at the end)`;
  return validRoute(country, city, rest[0]);
}

/**
 * Username grammar:
 *   user                                  rotating, any relay
 *   user_<sid>                            sticky
 *   user-<cc>[-<city>]                    rotating within country/city
 *   user-<cc>[-<city>]_<sid>              sticky within country/city
 *   user_country_<cc>[_city_<city>]       rotating, keyed form
 *   user_country_<cc>[_city_<city>]_<sid> sticky, keyed form
 */
export function parseUsername(username: string): Route | string {
  const parts = username.split('_');
  if (parts.length >= 3 && (parts[1] === 'country' || parts[1] === 'city')) return parseKeyed(parts);

  const us = username.indexOf('_');
  const base = us === -1 ? username : username.slice(0, us);
  const sessionId = us === -1 ? undefined : username.slice(us + 1);
  const [prefix, country, city, ...rest] = base.split('-');

  if (prefix !== config.userPrefix) return `username must start with "${config.userPrefix}"`;
  if (rest.length > 0) return 'too many "-" parts in username (expected user-<cc>-<city>)';
  return validRoute(country, city, sessionId);
}

export function checkAuth(header: string | undefined): AuthResult {
  if (!header) return { ok: false, status: 407 };
  const [scheme, encoded] = header.trim().split(/\s+/, 2);
  if (scheme?.toLowerCase() !== 'basic' || !encoded) return { ok: false, status: 407 };
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon === -1) return { ok: false, status: 407 };
  const username = decoded.slice(0, colon);
  const password = decoded.slice(colon + 1);
  if (!sameSecret(password, config.password)) return { ok: false, status: 407 };

  const route = parseUsername(username);
  if (typeof route === 'string') return { ok: false, status: 400, message: route };
  return { ok: true, route, username };
}
