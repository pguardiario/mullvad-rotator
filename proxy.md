# Using the mullvad-rotator proxy (for agents)

A local HTTP proxy that sends traffic out through Mullvad VPN exits in ~50
countries (~535 exit IPs). You choose the exit by the **username**. It is
already running; you do not need to start or configure anything.

- Proxy: `http://127.0.0.1:8899` (HTTP and HTTPS; HTTPS is tunnelled with
  CONNECT and never decrypted)
- Password: the `PROXY_PASSWORD=` line in this repo's `.env`
- Username: `user`, plus optional country, city and session parts (below)

## Get the password

From the repo root:

```bash
PW=$(grep '^PROXY_PASSWORD=' .env | cut -d= -f2)
```

From code, read the same line out of `.env` (or `process.loadEnvFile()` in
Node 22+, `python-dotenv` in Python). Never print the password, put it in
logs, commit it, or send it anywhere other than this proxy.

## Pick a username

| username                              | exit                                         |
|---------------------------------------|----------------------------------------------|
| `user`                                | random relay, new one per connection         |
| `user_<sid>`                          | sticky: same relay for that session id       |
| `user_country_<cc>`                   | random relay in that country                 |
| `user_country_<cc>_<sid>`             | sticky within that country                   |
| `user_country_<cc>_city_<city>`       | random relay in that city                    |
| `user_country_<cc>_city_<city>_<sid>` | sticky within that city                      |

- `<cc>` is a lowercase 2-letter country code: `us`, `gb`, `de`, `au`, `jp`,
  `nl`, `se`, `ca`, `fr`, `sg`... `<city>` is Mullvad's 3-letter city code:
  `nyc`, `lax`, `lon`, `fra`, `syd`, `tyo`...
- `<sid>` is any 1-64 chars of `[A-Za-z0-9.-]` (no `_`). Choose it yourself.
  Different ids normally get different exits.
- A dash form also works and means the same thing: `user-us`, `user-us_1`,
  `user-us-nyc_1`.

### Which mode to use

- **Multi-step flows (log in, add to cart, fill a form, anything with cookies
  or a CSRF token): use a sticky session.** Sites often invalidate a session
  when the IP changes mid-flow.
- **Independent one-off fetches, where you want spread: use rotating
  (`user` or `user_country_<cc>`).**
- **Rotating means per connection, not per request.** HTTP clients and
  browsers reuse connections, so several requests can share an exit, and a
  browser page can load from several exits at once. If you need one
  consistent identity, use a sticky session.
- **Need a fresh IP?** Use a new session id (`..._2`, `..._3`). There is no
  "rotate this session" command.
- Sticky sessions expire after 30 idle minutes; every use resets the timer.
  After expiry the same id may land on a different exit.

## Examples

All examples use session `job1` in the US. Swap the username as needed.

### curl

```bash
curl -x "http://user_country_us_job1:$PW@127.0.0.1:8899" https://example.com/
```

### Node.js (fetch via undici)

```js
import { ProxyAgent, fetch } from 'undici'; // npm install undici

process.loadEnvFile('.env');
const dispatcher = (username) =>
  new ProxyAgent({
    uri: 'http://127.0.0.1:8899',
    token: 'Basic ' + Buffer.from(`${username}:${process.env.PROXY_PASSWORD}`).toString('base64'),
  });

const res = await fetch('https://am.i.mullvad.net/json', {
  dispatcher: dispatcher('user_country_us_job1'),
});
console.log(await res.json());
```

Reuse one `ProxyAgent` per session id rather than creating one per request.

### Python (requests)

```python
import requests
from dotenv import dotenv_values  # pip install python-dotenv

pw = dotenv_values(".env")["PROXY_PASSWORD"]
proxy = f"http://user_country_us_job1:{pw}@127.0.0.1:8899"
r = requests.get("https://am.i.mullvad.net/json",
                 proxies={"http": proxy, "https": proxy}, timeout=30)
print(r.json())
```

httpx: `httpx.Client(proxy=proxy)`.

### Playwright

```js
const context = await browser.newContext({
  proxy: {
    server: 'http://127.0.0.1:8899',
    username: 'user_country_us_job1',
    password: process.env.PROXY_PASSWORD,
  },
});
```

Use one browser context per session id: every request from a context goes
through the same username. For a browser, always use a sticky username; a
rotating one spreads a single page across several exits.

### Puppeteer

```js
const browser = await puppeteer.launch({ args: ['--proxy-server=http://127.0.0.1:8899'] });
const page = await browser.newPage();
await page.authenticate({ username: 'user_country_us_job1', password: process.env.PROXY_PASSWORD });
```

## Check which exit you got

```bash
curl -s -x "http://user_country_us_job1:$PW@127.0.0.1:8899" \
  https://am.i.mullvad.net/json
```

This returns the exit's `ip`, `country` and `city`. The relay is also named in
the `X-Proxy-Exit` header: on the response for plain `http://` URLs, and on the
proxy's `200 Connection Established` reply for `https://` (see it with
`curl -v`).

## Errors

| status | meaning                                       | what to do                                   |
|--------|-----------------------------------------------|----------------------------------------------|
| 407    | wrong or missing password                     | re-read `PROXY_PASSWORD` from `.env`         |
| 400    | bad username or unknown country/city code     | the body names the problem and lists valid cities |
| 502 `target unreachable via relay: ...` | the site refused or does not exist (e.g. `HostUnreachable`, `ConnectionRefused`, `TTLExpired`) | usually the site, not the proxy; check the URL, or retry once with a new session id |
| 502 `relay ... failed after retry`      | two relays failed in a row      | retry with a new session id; if many fail, see below |
| 503    | proxy starting up, relay list not loaded      | wait a few seconds and retry                 |
| connection refused on 8899 | the stack is not running  | tell the user; do not try to start it        |

For `https://` URLs some clients hide the proxy's status code: Node's undici
reports a 407 as `Request was cancelled`, and Python `requests` raises
`ProxyError ... 407`. Treat those as a password problem.

The proxy already retries a failed relay once on another relay before
returning an error, and failed relays are skipped for 10 minutes.

If every request fails, the VPN tunnel is probably down. Check:

```bash
curl -s -u "user:$PW" http://127.0.0.1:8899/status
```

`relays` and `healthy` should both be in the hundreds. Report the problem to
the user rather than trying to fix it; operating the stack is covered in
`README.md`.

## Rules of thumb

- Keep the password out of output, logs, files and commits.
- Pick a session id per task or per identity, and reuse it for the whole task.
- Don't hammer one target from many session ids at once; it looks like abuse
  and gets the exits blocked for everyone using Mullvad.
- Country codes that exist: see `countries` in `/status`. Cities per country:
  an unknown city returns 400 listing the valid ones.
