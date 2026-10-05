# mullvad-gateway

One Mullvad WireGuard tunnel, one local HTTP proxy port, ~535 exit IPs in ~50
countries, with rotating or sticky exits chosen per request by the username.

Every Mullvad WireGuard relay runs a SOCKS5 proxy on a private `10.124.x.x:1080`
address that is reachable from inside any Mullvad tunnel. This stack holds a
single tunnel (gluetun, using one of your account's 5 device slots) and runs a
small Node gateway inside the tunnel's network namespace. The gateway sends each
request out through a chosen relay's SOCKS5 proxy, so you get every exit
location from one device.

```
client --HTTP proxy--> 127.0.0.1:8899 [gateway] --SOCKS5 in tunnel--> relay X --> internet
                                         |
                                    gluetun (WireGuard + kill switch)
```

Contents:

1. [Requirements](#1-requirements)
2. [Install Docker on Linux](#2-install-docker-on-linux)
3. [Clone the repo](#3-clone-the-repo)
4. [Create a WireGuard key](#4-create-a-wireguard-key)
5. [Configure .env](#5-configure-env)
6. [Start the stack](#6-start-the-stack)
7. [Test it](#7-test-it)
8. [Using the proxy](#8-using-the-proxy)
9. [Day-to-day operations](#9-day-to-day-operations)
10. [Remote access](#10-remote-access)
11. [Configuration reference](#11-configuration-reference)
12. [How it works](#12-how-it-works)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Requirements

- A Linux host (x86_64 or arm64) with a kernel that has WireGuard (any kernel
  5.6+, which is every current distro).
- Docker Engine with the Compose v2 plugin (section 2).
- `git`.
- A Mullvad account with a free device slot (5 max per account).
- Optional: Node.js 22+ on the host. Only used to register the WireGuard key,
  and section 4 shows a way to do it through Docker instead.

You do **not** need the Mullvad app installed on the host. If it is installed
and connected, that is fine too; the containers bring their own tunnel.

---

## 2. Install Docker on Linux

Install Docker Engine from **Docker's own apt/dnf repository**. Avoid:

- the distro package `docker.io` (Ubuntu/Debian): it lags behind, and ships
  without the `buildx` plugin, so Compose prints
  `Docker Compose is configured to build using Bake, but buildx isn't installed`;
- the `snap` package: its confinement breaks bind mounts outside `$HOME` and
  causes hard-to-debug permission errors;
- Docker Desktop for Linux: it runs containers in a VM, which is unnecessary
  for a server and changes how `127.0.0.1` port bindings behave.

### Already have Docker?

```bash
docker version
docker compose version
docker buildx version
```

If all three print a version, skip to section 3. If only `buildx` is missing,
you can keep your install and add it:

```bash
sudo apt-get install -y docker-buildx
```

### Ubuntu

```bash
# 1. Remove conflicting packages (fine if none are installed)
for pkg in docker.io docker-doc docker-compose docker-compose-v2 \
  podman-docker containerd runc; do
  sudo apt-get remove -y $pkg
done

# 2. Add Docker's signing key
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# 3. Add the repository
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF

# 4. Install Engine, CLI, containerd, buildx and compose
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
```

Removing `docker.io` does not delete existing images, containers or volumes
(they live in `/var/lib/docker`), but stop your running stacks first.

### Debian

Same as Ubuntu, with `debian` in the two URLs and the Debian codename:

```bash
for pkg in docker.io docker-doc docker-compose podman-docker containerd runc; do
  sudo apt-get remove -y $pkg
done

sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
```

### Fedora

```bash
sudo dnf remove -y docker docker-client docker-common docker-latest \
  docker-engine podman-docker
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager addrepo \
  --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
```

RHEL, Rocky and Alma use the older `dnf config-manager` syntax and the `rhel`
repo; the remove and install lines are the same:

```bash
sudo dnf config-manager \
  --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
```

### After installing (all distros)

Start Docker now and on every boot:

```bash
sudo systemctl enable --now docker
```

Let your user run `docker` without `sudo`, then log out and back in (or run
`newgrp docker` in the current shell):

```bash
sudo usermod -aG docker "$USER"
```

Membership of the `docker` group is equivalent to root on that machine. Only
add users you would give `sudo` to.

Check it works:

```bash
docker run --rm hello-world
docker compose version
```

---

## 3. Clone the repo

Replace `<REPO_URL>` with this repository's clone URL:

```bash
git clone <REPO_URL> mullvad-gateway
cd mullvad-gateway
```

All commands from here on run from this directory.

---

## 4. Create a WireGuard key

The tunnel needs a WireGuard key registered to your Mullvad account. Each key
uses one of the account's 5 device slots, so register **one key per
installation** and run this once.

If you have the Mullvad app on this machine, you can see how many slots are
used:

```bash
mullvad account list-devices
```

Do **not** reuse a key from another running tunnel (another machine, another
container): two tunnels fighting over one key break each other.

### Option A: script, with Node.js 22+ on the host

```bash
MULLVAD_ACCOUNT=YOUR_16_DIGIT_ACCOUNT_NUMBER \
  node scripts/register-key.mjs >> .env
```

### Option B: script, through Docker (no Node needed)

```bash
docker run --rm \
  -e MULLVAD_ACCOUNT=YOUR_16_DIGIT_ACCOUNT_NUMBER \
  -v "$PWD/scripts:/scripts:ro" \
  node:24-alpine node /scripts/register-key.mjs >> .env
```

Either way the script generates a keypair locally, uploads only the public key
to Mullvad, prints `registered public key ... -> 10.x.x.x/32,...` and appends
two lines to `.env`:

```
WIREGUARD_PRIVATE_KEY=...
WIREGUARD_ADDRESSES=10.x.x.x/32
```

The account number is only read from the command line; it is not saved.

### Option C: Mullvad website

Log in at mullvad.net, open *WireGuard configuration*, click *Generate key*,
pick any server and download the `.conf` file. From it, put `PrivateKey` into
`WIREGUARD_PRIVATE_KEY` and the IPv4 part of `Address` (e.g. `10.66.12.34/32`)
into `WIREGUARD_ADDRESSES` in `.env`.

To remove a key later, revoke the device on mullvad.net (*Devices*) or with
`mullvad account revoke-device "<device name>"`.

---

## 5. Configure .env

Add the proxy password (a random one is generated here):

```bash
echo "PROXY_PASSWORD=$(openssl rand -hex 24)" >> .env
```

Optionally pick the tunnel's **entry** relay country. Every request passes
through the entry relay first and then hops to the exit relay, so an entry
close to you saves a round trip on every request. Use gluetun's English
country names:

```bash
echo "ENTRY_COUNTRY=Singapore" >> .env
```

Check the result has the three required keys (this prints only the names):

```bash
cut -d= -f1 .env
```

You should see at least `WIREGUARD_PRIVATE_KEY`, `WIREGUARD_ADDRESSES` and
`PROXY_PASSWORD`. Every other setting is optional; see `.env.example` and
section 11.

`.env` holds secrets and is listed in `.gitignore`. Never commit it.

---

## 6. Start the stack

```bash
docker compose up -d --build
```

The first run pulls gluetun, builds the gateway and connects the tunnel. Watch
it come up (Ctrl-C stops following, the stack keeps running):

```bash
docker compose logs -f
```

Ready when the gateway logs `listening` and `relay list loaded`, and both
containers show `healthy`:

```bash
docker compose ps
```

---

## 7. Test it

Load the password into your shell:

```bash
PW=$(grep '^PROXY_PASSWORD=' .env | cut -d= -f2)
```

**Rotating**, a different exit each time:

```bash
for i in 1 2 3 4 5; do
  curl -s -x "http://user:$PW@127.0.0.1:8899" https://am.i.mullvad.net/json
  echo
done
```

**Sticky**, the same exit twice:

```bash
curl -x "http://user_test1:$PW@127.0.0.1:8899" https://am.i.mullvad.net/json
curl -x "http://user_test1:$PW@127.0.0.1:8899" https://am.i.mullvad.net/json
```

**Country**, sticky per session id:

```bash
for u in user_country_us_1 user_country_us_1 user_country_us_2 \
  user_country_de_1 user_country_jp_1; do
  printf '%-20s ' "$u"
  curl -s -x "http://$u:$PW@127.0.0.1:8899" https://am.i.mullvad.net/json \
    | grep -o '"ip":"[^"]*","country":"[^"]*"'
done
```

Expected: the two `us_1` lines share an IP, `us_2` is a different US IP, then
Germany and Japan.

**Which relay served a request** (also in the logs):

```bash
curl -sv -o /dev/null -x "http://user_test1:$PW@127.0.0.1:8899" \
  https://am.i.mullvad.net/json 2>&1 | grep -i x-proxy-exit
```

**Status**: relay count, healthy count, active sessions, cooldowns:

```bash
curl -s -u "user:$PW" http://127.0.0.1:8899/status
```

**Kill switch**: with the tunnel stopped, requests must fail instead of leaking
out through your normal connection:

```bash
docker compose stop vpn
curl -m 10 -x "http://user:$PW@127.0.0.1:8899" https://am.i.mullvad.net/json
docker compose start vpn
docker compose restart gateway
```

---

## 8. Using the proxy

```
http://<username>:<PROXY_PASSWORD>@127.0.0.1:8899
```

Works with anything that speaks HTTP proxies: `curl -x`, browsers, Playwright
and Puppeteer (`--proxy-server` plus credentials), Python `requests`
(`proxies=`), Node `undici` `ProxyAgent`, and so on. HTTPS goes through
`CONNECT` and is not intercepted or decrypted.

### Usernames

The username picks the exit. Two equivalent spellings are accepted.

Keyed form:

| username                              | exit                                         |
|---------------------------------------|----------------------------------------------|
| `user`                                | random relay, new one per connection         |
| `user_<sid>`                          | sticky: same relay for that session id       |
| `user_country_<cc>`                   | random relay in that country                 |
| `user_country_<cc>_<sid>`             | sticky within that country                   |
| `user_country_<cc>_city_<city>`       | random relay in that city                    |
| `user_country_<cc>_city_<city>_<sid>` | sticky within that city                      |

Dash form:

| username                 | same as                               |
|--------------------------|---------------------------------------|
| `user-<cc>`              | `user_country_<cc>`                   |
| `user-<cc>_<sid>`        | `user_country_<cc>_<sid>`             |
| `user-<cc>-<city>`       | `user_country_<cc>_city_<city>`       |
| `user-<cc>-<city>_<sid>` | `user_country_<cc>_city_<city>_<sid>` |

Examples: `user_country_us_1`, `user_country_gb_city_lon_job7`, `user-de_abc`,
`user-us-nyc_abc123`.

- **Codes** are Mullvad's lowercase country and city codes: `us`, `de`, `gb`,
  `jp`, `us`+`nyc`, `gb`+`lon`, `jp`+`tyo`... `/status` lists every country
  with its relay count, and `mullvad relay list` (Mullvad app) lists cities.
  An unknown code returns **400** with the valid cities for that country.
- **Session ids** are any 1-64 chars of `[A-Za-z0-9.-]`. Different ids get
  different relays (random, so two ids can occasionally share one in a small
  country). A session expires after 30 idle minutes (`STICKY_TTL_MIN`); each
  use extends it. `user_country_us_1` and `user-us_1` are the same session.
- **Wrong or missing password**: **407**.
- **`X-Proxy-Exit`** names the relay used: as a response header for plain
  HTTP, and on the `200 Connection Established` reply for HTTPS (visible with
  `curl -v`).
- **DNS** for the sites you visit is resolved by the exit relay, not locally.

### Errors

| status | meaning                                                        |
|--------|----------------------------------------------------------------|
| 400    | bad username format, or unknown country/city code              |
| 407    | wrong or missing password                                      |
| 502    | relay unreachable after one retry, or target refused/unknown   |
| 503    | relay list not loaded yet (first seconds after a cold start)   |

The response body says which.

---

## 9. Day-to-day operations

All from the repo directory.

Status and logs:

```bash
docker compose ps
docker compose logs -f gateway
docker compose logs -f vpn
```

After changing gateway code (`gateway/`), rebuild just the gateway; the tunnel
stays up:

```bash
docker compose up -d --build gateway
```

After changing `.env` or `docker-compose.yml`:

```bash
docker compose up -d --build
```

After restarting the VPN container on its own, also restart the gateway: it
shares the VPN container's network namespace, which is recreated on restart.

```bash
docker compose restart vpn
docker compose restart gateway
```

Update to new code:

```bash
git pull
docker compose up -d --build
```

Stop everything:

```bash
docker compose down
```

Stop and also delete the cached relay list volume:

```bash
docker compose down -v
```

Both containers use `restart: unless-stopped`, so they come back after a
reboot as long as the Docker service is enabled (section 2).

---

## 10. Remote access

The proxy port is bound to `127.0.0.1` only, so nothing on your network or the
internet can reach it. Keep it that way. To use it from another machine,
forward it over SSH from that machine:

```bash
ssh -N -L 8899:127.0.0.1:8899 you@proxy-host
```

then point clients there at `127.0.0.1:8899`.

Note: Docker publishes ports by writing its own iptables rules, which bypass
`ufw`. If you ever change the binding to `0.0.0.0`, `ufw` will **not** protect
it.

---

## 11. Configuration reference

Set in `.env`. Only the first three are required.

| variable                   | default  | meaning                                             |
|----------------------------|----------|-----------------------------------------------------|
| `WIREGUARD_PRIVATE_KEY`    |          | WireGuard private key (section 4)                   |
| `WIREGUARD_ADDRESSES`      |          | address Mullvad assigned to the key, e.g. `10.x.x.x/32` |
| `PROXY_PASSWORD`           |          | shared proxy password, at least 8 chars             |
| `ENTRY_COUNTRY`            | `Sweden` | country of the tunnel's own entry relay (gluetun name) |
| `PROXY_PORT`               | `8899`   | host port, always bound to `127.0.0.1`              |
| `PROXY_USER`               | `user`   | the fixed username prefix                           |
| `STICKY_TTL_MIN`           | `30`     | idle minutes before a sticky session expires        |
| `RELAY_COOLDOWN_MIN`       | `10`     | minutes a failed relay is skipped                   |
| `HEALTHCHECK_INTERVAL_MIN` | `15`     | background exit check interval, `0` disables        |
| `LOG_LEVEL`                | `info`   | `debug`, `info`, `warn` or `error`                  |
| `TZ`                       | `UTC`    | timezone for gluetun's logs                         |

---

## 12. How it works

- **Two containers.** `vpn` is gluetun: it holds the WireGuard tunnel and a
  firewall that only lets traffic out through the tunnel. `gateway` runs with
  `network_mode: service:vpn`, so it has no network of its own: if the tunnel
  is down it cannot reach anything.
- **Relay pool.** Loaded from `https://api.mullvad.net/www/relays/wireguard/`
  at start and every 6 hours, keeping active relays that have a SOCKS proxy.
  The last good list is cached in the `gateway-data` volume, so the gateway
  still starts when the API is down.
- **Relay DNS.** The relays' SOCKS hostnames resolve to private `10.124.x.x`
  addresses. gluetun's DNS drops private answers (rebinding protection), so the
  gateway resolves them with Mullvad's in-tunnel resolver `10.64.0.1` and falls
  back to the system resolver.
- **Failures.** A relay that cannot be reached gets a cooldown
  (`RELAY_COOLDOWN_MIN`). A sticky session on a failed relay is moved to a new
  relay with the same country/city and the request is retried once; rotating
  requests also retry once on another relay. When the relay works but the
  site refuses or does not exist, you get a 502 and the relay is not penalised.
- **Background check.** Every `HEALTHCHECK_INTERVAL_MIN`, 5 random relays fetch
  `am.i.mullvad.net/json`; results show under `recentExits` in `/status`.
- **Timeouts.** 10s to connect upstream, 5 min idle. A client disconnect tears
  down its upstream connection.
- **Logs.** JSON lines: method, host, relay, session, status and timings. No
  request or response bodies, no credentials.
- **Measured (Oct 2026):** 534 of 535 relays answered, each with its own exit
  IP; one relay held 1,500 concurrent connections without errors (Mullvad
  publishes no per-relay limit); the extra hop added roughly 0.6-1.3s per
  HTTPS request compared with going straight out of the tunnel.

### Diagnostics

Run inside the gateway, so inside the tunnel:

```bash
# SOCKS handshake and exit lookup against every relay (takes ~1 min)
docker compose exec gateway node dist/probe.js sweep --exit

# Hold N concurrent connections open on one relay
docker compose exec gateway node dist/probe.js conns \
  de-fra-wg-socks5-001.relays.mullvad.net --n 300
```

### Layout

```
docker-compose.yml        gluetun (vpn) + gateway
.env.example              template for .env
scripts/register-key.mjs  generate and register a WireGuard key
gateway/Dockerfile
gateway/src/server.ts     HTTP proxy, CONNECT, /status
gateway/src/upstream.ts   relay selection, SOCKS connect, retry
gateway/src/relays.ts     relay pool, cache, cooldowns, DNS
gateway/src/sessions.ts   sticky session map
gateway/src/auth.ts       Proxy-Authorization and username parsing
gateway/src/probe.ts      diagnostics CLI
```

---

## 13. Troubleshooting

**`permission denied while trying to connect to the Docker daemon socket`**
Your user is not in the `docker` group yet, or you have not logged out and
back in since adding it:

```bash
sudo usermod -aG docker "$USER"
newgrp docker
```

**`docker: 'compose' is not a docker command`**
The Compose v2 plugin is missing. Install `docker-compose-plugin` from
Docker's repository (section 2). On Ubuntu's own packages the equivalent is:

```bash
sudo apt-get install -y docker-compose-v2
```

The legacy standalone `docker-compose` (v1) is end-of-life and untested here.

**`set WIREGUARD_PRIVATE_KEY in .env`** (or the same for another variable)
`.env` is missing that line or you are not in the repo directory. Check the
key names:

```bash
cut -d= -f1 .env
```

**`vpn` never becomes healthy; logs show `i/o timeout` and VPN restarts**
The key is not registered or is in use by another tunnel. Check the device
exists on your account (mullvad.net, *Devices*), confirm `WIREGUARD_ADDRESSES`
matches what Mullvad returned for that key, or register a fresh key
(section 4). Also check outbound UDP to port 51820 is not blocked by your
network.

**`Bind for 127.0.0.1:8899 failed: port is already allocated`**
Something else uses the port. Pick another one:

```bash
echo "PROXY_PORT=8898" >> .env
docker compose up -d
```

**Every request returns 502 after the VPN restarted**
The gateway lost its network namespace:

```bash
docker compose restart gateway
```

**`503 relay list not loaded yet`**
On a very first start with the Mullvad API unreachable there is no cached
list yet. Check the tunnel is up and look for `relay list refresh failed` in:

```bash
docker compose logs gateway
```

**Slow requests**
Every request crosses two relays: your entry relay, then the exit. Set
`ENTRY_COUNTRY` to a country near you (section 5), then:

```bash
docker compose up -d
```
