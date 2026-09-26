# cloudflare-admin-toolkit

English | [한국어](README.ko.md)

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-blue)

**A self-hosted toolkit for Cloudflare admins who manage many zones — change dozens or hundreds of domains from one screen instead of clicking through the dashboard zone by zone.**
It runs on your own Cloudflare Workers (free plan works). No external server, zero dependencies.

> **Note:** the UI and the in-app help are in Korean. Timestamps are shown in KST.

---

## Why

Once you manage tens or hundreds of zones, a server migration or an incident means opening each zone in the dashboard and flipping proxy / SSL / cache settings one by one.
This toolkit does that **per group, in one action**, with a **preview** of what will change and a **change log** of who changed what.

## Features

| Menu | What it does |
|---|---|
| **DNS · SSL/TLS** | Bulk-switch A/AAAA records pointing at your target server IP between Proxied ↔ DNS only, together with the SSL/TLS mode, per group (preview → apply · revert). Bulk enable/disable a static-asset cache rule, Tiered Cache and Smart Tiered Cache. Zone groups |
| **IP Rules** | Browse · search · classify (risky / unclear / safe — editable rules) · delete · change action on account IP Access Rules, in bulk. Optionally manages paired Allow exception rules on an asset zone |
| **Change log** | Who / when / what, across domains, IP rules, OTP and settings. Proxy · SSL changes can be reverted |
| **Settings** | Change the target IP, default group, cache TTL, asset zone, API-call budget and OTP issuer from the UI |
| **Help** | Step-by-step install guide (in Korean) |

Safeguards
- Records that do not point at the target IP (mail, other servers, …) are **protected** — the server refuses to change them even if selected in the UI
- The current state is **re-read from Cloudflare right before applying** — safe even if someone changed things in the dashboard meanwhile
- Calls are chunked to respect the Cloudflare API limit (1,200 requests / 5 min / user) and the Workers free-plan limit (50 subrequests / request)

Login
- Password + **per-user TOTP** (Google Authenticator or any RFC 6238 app). The first person to register becomes the owner — only the owner can add, disable or delete others (disabling kills that person's sessions immediately)
- 12-hour sessions; 10 failures per IP within 10 minutes gets blocked for a while

## Quick start — one command

**Prerequisites**: a Cloudflare account (free plan is fine), [Node.js](https://nodejs.org) 18+

### 1. Create API tokens

Cloudflare dashboard → profile (top right) → **My Profile → API Tokens → Create Token → Custom token**

| Token | Permissions |
|---|---|
| Domains → `CF_API_TOKEN` | `Zone · Zone · Read` / `Zone · DNS · Edit` / `Zone · Zone Settings · Edit` / `Zone · Cache Rules · Edit`<br>Zone Resources: `Include · All zones from an account` |
| IP Rules → `CF_IP_TOKEN` (optional) | `Account · Account Firewall Access Rules · Edit` / `Zone · Firewall Services · Edit` / `Zone · Zone · Read` |

Leave Client IP Filtering empty (Workers egress IPs change).

### 2. Clone and create the config file

```bash
git clone https://github.com/real21c/cloudflare-admin-toolkit.git
cd cloudflare-admin-toolkit
node setup.mjs --init
```

Fill in the blanks in the generated `setup.env`. Four keys are required:

| Key | Value |
|---|---|
| `WORKER_NAME` | Worker name (lowercase letters · digits · `-`). The URL becomes `<name>.<subdomain>.workers.dev` |
| `CF_API_TOKEN` | The domain token from step 1 |
| `PASSWORD_PREFIX` | The first part of the login password (see below) |
| `SERVER_IP` | The target server IP for bulk changes |

If wrangler is connected to more than one Cloudflare account, also set `ACCOUNT_ID`. Everything else can stay blank (defaults apply).

### 3. Install

```bash
node setup.mjs --dry-run     # check only — validates values, tokens, login and build; creates nothing
node setup.mjs               # install
```

The script handles wrangler login (browser) → KV creation → deploy (secrets included), then prints the URL and how to log in for the first time.

- Uploaded secrets are wiped from `setup.env` afterwards (`setup.env` is git-ignored)
- If a Worker with the same name already exists in the account, the script stops instead of overwriting it
- The manual step-by-step install and every variable / secret are documented in the in-app **Help** menu (`public/help.html`, Korean)

### 4. First login · register TOTP (do this right away)

- Password = `PASSWORD_PREFIX` + `!` + today's day of month, two digits (**KST**). E.g. prefix `abc` on the 5th → `abc!05`
- Log in and register TOTP under **2단계 인증** (two-factor auth) immediately. Until someone registers, anyone who knows the password can log in — and the date part is guessable, so pick a long prefix

## Update · uninstall

```bash
git pull
node setup.mjs               # re-run with the same setup.env to update (blank secrets are kept as-is)
```

To change settings later, edit `setup.env` and re-run — or use the in-app **Settings** menu.

To uninstall:

```bash
npx wrangler delete --config wrangler.setup.jsonc
npx wrangler kv namespace delete --namespace-id <KV id> --config wrangler.setup.jsonc   # the KV id is in .setup-state.json
```

## Cost and limits

Everything fits in the free plan.

| Item | Free limit | This toolkit |
|---|---|---|
| Workers requests | 100k / day | 1 per page view / API call |
| KV writes | 1,000 / day | changes, log entries, status cache |
| Cloudflare API | 1,200 / 5 min / user (no fee) | one status refresh ≈ zone count × 2; the IP Rules screen throttles itself to 900 / 5 min |

## Good to know

- **The UI is Korean-only** and timestamps use KST
- Do **not** attach a Worker route to a zone you manage with this tool — the moment you switch that zone to DNS only, the tool cuts itself off. Use the `workers.dev` URL or a Custom Domain
- **IP Rules** splits the rule notes into time / URL / user-agent columns when the notes follow the `time | URL | User-Agent` format; otherwise the whole note is shown in one column. The asset-zone pairing only activates when `IP_PAIR_ZONE_NAME` is set (only Allow rules whose notes contain `404 guard` are treated as pairs)
- **The default IP classification rules assume an ASP/IIS origin** (e.g. requests for PHP extensions are classified as risky). On other stacks, adjust them under `⚙ 규칙` in the IP Rules screen
- The cache rule finds itself by its description string `static-assets (cloudflare-admin-toolkit)` (`CACHE_RULE_DESC` in `src/core.js`). If you change it after rules were deployed, old rules will no longer be found
- Switching a record to `DNS only` bypasses cache, WAF and Workers routes and exposes the origin IP. `Flexible` causes a redirect loop if the origin forces HTTPS

## Local run (optional)

As a fallback when Workers is unavailable, the same UI can run on your PC. Binds to `127.0.0.1` only, no login.

```bash
cp config.example.json config.json   # fill in the token etc.
node server.mjs                       # → http://127.0.0.1:8790
```

Local data is stored separately in `data/` and is not shared with the Workers deployment.

## Layout

```
setup.mjs            install / update script
server.mjs           local server (Node built-ins only)
wrangler.jsonc       config template for manual deploys
src/worker.js        Workers entry — login · sessions · TOTP · static files
src/api.js           API (shared by local and Workers)
src/core.js          Cloudflare API calls · scope calculation · cache rule
src/ip-api.js        IP Rules API
src/settings.js      settings schema · validation
public/              UI (index · ip · settings · help)
```

Zero dependencies (the bundled QR generator `src/vendor/qrcode.mjs` is MIT-licensed).

## Feedback

Bugs and suggestions → [Issues](https://github.com/real21c/cloudflare-admin-toolkit/issues).
Other questions → real21c@gmail.com

## License

MIT — [LICENSE](LICENSE)
