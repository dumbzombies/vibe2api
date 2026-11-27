# vibe2api

**Mistral's $300/month Vibe allowance, usable from any OpenAI or Anthropic client.**

Mistral bills the same models twice against two different pots: the ordinary API
key draws on a $30/month API budget, while the Vibe coding agent draws on a
$300/month Vibe allowance. Two things on the wire route spend to the Vibe pot:

```
user-agent: mistral-client-python/Mistral-Vibe/3.1.5
…
{"metadata": {"call_source": "vibe_code"}}
```

The `User-Agent` was the only signal until 2026-11-24; on 2026-11-25 Mistral
stopped honouring it alone and now keys attribution on a non-empty
`metadata.call_source` (the value is not inspected — Vibe 3.x sends
`"vibe_code"`). vibe2api sends both. Mistral's announcement (effective
2026-12-01) says usage through third-party harnesses counts against the API
allowance; this metadata is what the endpoint actually does today.

vibe2api puts both in front of `api.mistral.ai`, so anything you point at
it — the OpenAI SDK, the Anthropic SDK, omp, opencode, hermes, Claude Code style
tooling — spends the allowance instead of the small budget. Verified end to end
against Mistral's own counters: one proxied call moved `vibe_budget` by
+0.000024% and `api_budget` by 0.000000%.

```
             ┌───────────────┐  UA: mistral-client-python/Mistral-Vibe/3.1.5
 OpenAI  ───►│               │──────────────────────────────────────────────► api.mistral.ai
 Anthropic ─►│   vibe2api     │                                               └─ $300/mo Vibe
 omp/pi  ───►│  (one core)   │◄──────────────────────────────────────────────
 opencode ──►│               │   typed parts flattened, effort clamped, SSE ASCII-safe
 hermes  ───►└───────────────┘
```

## Why it exists

1. **Billing attribution.** Without the Vibe UA the spend silently lands on the
   $30 API budget. Nothing in the response tells you which pot was billed.
2. **Shape translation.** Mistral's Vibe surface returns `content` as *typed
   parts* (`{"type":"thinking"}` interleaved with `{"type":"text"}`). OpenAI
   clients see garbage and opencode rejects the stream outright. The core
   flattens thinking into `reasoning_content`, keeps text in `content`, and
   strips `reasoning_content` from replayed turns (Mistral 422s it).
3. **Model quirks.** `reasoning_effort` is clamped per model to the subset each
   one accepts, `max_completion_tokens` is aliased, and `temperature: 0` is
   paired with `top_p: 1` because Mistral rejects greedy sampling otherwise.
4. **Transport safety.** SSE payloads are pure ASCII (`\uXXXX`), so a client
   that decodes each network chunk separately cannot mangle a multi-byte
   character split across chunks — the failure that garbles reasoning text
   through proxies and Cloudflare.
5. **One credential surface.** Optionally expose the thing to a team: the
   deployment holds the Vibe key and hands out revocable `mv-…` proxy keys,
   instead of copying your key around.

## What lives here

This repo is the proxy and the Worker. The agent plugins are separate repos, each
installed by its host's own command:

| repo | host | install |
|---|---|---|
| **vibe2api** (here) | OpenAI/Anthropic clients, any HTTP client | `./install.sh local` or `./install.sh worker` |
| [mistral-vibe-pi](https://github.com/dumbzombies/mistral-vibe-pi) | omp, pi, pi-bolt | `omp plugin install github:dumbzombies/mistral-vibe-pi` |
| [mistral-vibe-opencode](https://github.com/dumbzombies/mistral-vibe-opencode) | opencode | `curl -fsSL …/install.sh \| bash` |
| [mistral-vibe-hermes](https://github.com/dumbzombies/mistral-vibe-hermes) | hermes | `hermes plugins install dumbzombies/mistral-vibe-hermes` |

They share the translation logic: the server and the Worker run `src/core.js`,
and each plugin carries an equivalent in-process copy so it needs no daemon and
no proxy. Point a plugin at a Worker with `MISTRAL_BASE` if you want the proxy in
the path too.

## Install

```bash
git clone https://github.com/dumbzombies/vibe2api && cd vibe2api
./install.sh                    # installs every surface whose runtime exists
./install.sh --help             # or pick: local | worker | omp | opencode | hermes | plugins | test
```

Every installer is idempotent, backs up any file it overwrites
(`*.bak-vibe2api`), and prints what to do next. Nothing is installed inside the
repo except the Worker build output.

### 1. Local proxy

```bash
./install.sh local                       # launcher at ~/.local/bin/vibe2api
./install.sh local --key mstrl_…         # also store the key (chmod 600)
vibe2api                                 # http://127.0.0.1:8788
```

The installer starts the proxy once and prints `/health`, so a broken install
fails immediately instead of on first use.

| env | default | meaning |
|---|---|---|
| `PORT` / `BIND` | `8788` / `127.0.0.1` | listen address. `BIND=0.0.0.0` exposes it to your LAN |
| `VIBE_KEY` | — | one key; switches the proxy into **server mode** |
| `VIBE_KEYS` | `~/.mistral-vibe/keys.json` | key pool file, round-robin with a 10 minute cooldown per 401/403/429 |
| `DASHBOARD_PASSWORD` | — | dashboard password; otherwise set on first visit |
| `DASHBOARD=0` | — | serve the API only (`?dash=1` overrides per visit) |
| `PROXY_KEY` | — | a preset proxy key instead of minting one in the UI |
| `MISTRAL_BASE` | `https://api.mistral.ai` | upstream override (tests, mirrors) |
| `MV_CRASH_LOG` | `.crash.log` next to `src/` | crash/exit log path |

Use it from the OpenAI SDK:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8788/v1", api_key="anything")
client.chat.completions.create(model="mistral-medium-latest",
                               messages=[{"role": "user", "content": "hi"}])
```

The dashboard at <http://127.0.0.1:8788/> shows the Vibe budget, the model
catalog, request stats, cache hit rate, key pool, and copy-paste snippets.

### 2. Cloudflare Worker

```bash
./install.sh worker                      # passthrough: callers bring their own key
./install.sh worker --kv                 # create + wire the KV namespace (recommended)
./install.sh worker --key mstrl_…        # server mode: the Worker spends this key
./install.sh worker --password '…'       # dashboard password as a secret
```

`--kv` matters on a deployment: KV persists the dashboard password hash and the
minted `mv-…` keys across isolate recycling. Without it the dashboard falls back
to first-run setup per isolate.

`wrangler dev` does **not** run on Termux/Android (`workerd` ships glibc-only).
Build, deploy, then verify against the live URL:

```bash
npm run test:all                          # builds the bundle, then tests it
curl -s https://<your-worker>.workers.dev/health
```

**Redeploying an existing deployment.** The script name is what receives the
upload, so a name that drifted from production deploys a brand-new Worker that
serves no traffic while the old one keeps answering. Check what the live
hostname is actually bound to, and deploy with a local overlay that pins the
production `name`, `routes` and `kv_namespaces` (`wrangler.deploy.jsonc`, which
stays out of git because it holds a hostname and a KV id):

```bash
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" \
  | grep -o '"hostname"[^}]*' | grep <your-subdomain>
cd cfwork && npx wrangler deploy -c wrangler.deploy.jsonc
```

A deploy that silently drops `env.KV` loses the dashboard password hash and
every minted `mv-…` key, so confirm the binding line appears in the upload
output.

### 3. Agent plugins

Each plugin lives in its own repo and installs with its host's native command, so
the host owns loading, updates and removal:

```bash
omp plugin install github:dumbzombies/mistral-vibe-pi      # omp
pi  install       git:github.com/dumbzombies/mistral-vibe-pi   # pi
curl -fsSL https://raw.githubusercontent.com/dumbzombies/mistral-vibe-opencode/main/install.sh | bash
hermes plugins install dumbzombies/mistral-vibe-hermes
```

`./install.sh omp|opencode|hermes` runs those same commands, and
`./install.sh plugins` does all three, for the case where you want one entry
point. Each is documented in its own repo: what the provider registers, the
daemon or loopback port it owns, and how to remove it.

## Endpoints

| method | path | credential | purpose |
|---|---|---|---|
| POST | `/v1/chat/completions` | API | OpenAI chat completions, stream and non-stream |
| POST | `/v1/messages` | API | Anthropic messages, stream and non-stream |
| GET | `/v1/models` | API | model catalog with context limits and capabilities |
| GET | `/dashboard/billing/subscription` · `/v1/dashboard/billing/subscription` | API | one-api/NewAPI/LiteLLM-compatible quota (dollars) |
| GET | `/dashboard/billing/usage` · `/v1/dashboard/billing/usage` | API | same, `total_usage` in **cents**, plus `used_percent` |
| GET | `/health` | none | mode, UA, keys configured, password set |
| GET | `/` | session | dashboard (login screen when no session) |
| GET | `/api/state` | session | dashboard data: budget, stats, key hints |
| POST | `/api/login` · `/api/logout` | — | session cookie |
| POST | `/api/keys` | session | add/remove pool keys (local only) |
| POST | `/api/proxy-keys` | session | mint/revoke `mv-…` proxy keys |
| POST | `/api/refresh` | session | drop caches, re-read catalog/budget/UA |

Unknown paths answer **404 before any auth check** — a 401 there would tell a
caller their key is wrong when the route simply does not exist.

## Authentication

Two independent credentials for two different surfaces. Conflating them is the
main bug class in this project.

| surface | credential |
|---|---|
| `/` and `/api/*` | session cookie from the dashboard password (7 days, `HttpOnly; SameSite=Lax; Secure`) |
| `/v1/*`, `/dashboard/billing/*` | API credential — a proxy key, or the caller's own Vibe key |

The dashboard password is **mandatory**: an anonymous visitor gets the login
screen, never dashboard markup. On a fresh deployment the first visit asks you
to choose one (stored as a SHA-256 hash in KV / `~/.mistral-vibe/keys.json`).

Two API modes, chosen by whether the deployment holds a Vibe key — a secret
flip, never a code change:

| mode | when | caller sends | notes |
|---|---|---|---|
| `server` | `VIBE_KEY` set | an `mv-…` proxy key (`PROXY_KEY`, or minted in the dashboard) | the deployment spends its own key; a caller-supplied `mstrl_…` is rejected, or anyone with the URL could spend your allowance |
| `passthrough` | no `VIBE_KEY` | their own `mstrl_…` | forwarded upstream unchanged; requiring a second key here would make the mode unusable |

```bash
npx wrangler secret put VIBE_KEY      # -> server
npx wrangler secret delete VIBE_KEY   # -> passthrough
```

Minted keys are `mv-<40 chars>`, shown **once**; the store keeps `{id, hash,
hint, created_at, name}`. Revoke from the Keys tab.

## Behaviour details worth knowing

- **Reasoning.** `reasoning_effort` is clamped per model
  (`REASONING_EFFORTS` in `src/core.js`); clients may offer every level without
  risking a 400. Deepseek/GLM use their own vocabularies, so the mapping is per
  model, not global.
- **Starvation recovery.** When a model's budget for a reasoning level runs dry
  mid-stream, the proxy retries one level lower rather than returning an empty
  completion. The ladder is per model.
- **Prompt caching.** Mistral prefix-caches automatically (1024-token
  granularity, measured 1.11 s → 0.85 s on a repeated 1053-token prompt). Keep
  system prompt, tool list and message order byte-identical between turns;
  `prompt_cache_key` and `metadata` are forwarded. `/api/state` and
  `/vibe-usage` report the hit rate.
- **Billing numbers.** `usage_percentage` is already a percent (`0.56` means
  0.56%), not a fraction — do not scale it again.
- **Stats are per process/isolate.** The 24 h chart, token totals and the
  request log reset on restart or isolate recycling. Budget figures always come
  from Mistral.
- **Aborted streams** cannot take the server down: writes, `writeHead` and
  `end` are inside a guard, and the backpressure wait resolves on `drain`,
  `close` *or* `error`. Crash and exit reasons go to `.crash.log`, because Bun
  buffers redirected stdout and would otherwise swallow a crash's last words.

## Limitations

- Anthropic `image` / `document` blocks are dropped (text and tool blocks only).
- Anthropic `thinking` is dropped and reasoning is not translated back into
  Anthropic thinking blocks; use the OpenAI surface for reasoning.
- A stop-sequence hit reports `end_turn` — Mistral does not say which sequence
  matched.
- Anthropic `message_start` carries `input_tokens: 0`; final counts arrive in
  `message_delta`, as OpenAI usage arrives with the last chunk.
- Not implemented: `embeddings`, `fim/completions`, `ocr`,
  `audio/transcriptions`.
- Cloudflare's bot rules answer **403** to the bare `Python-urllib` UA. Send a
  real SDK UA from scripts; a 403 there is the WAF, not this proxy.

## Tests

```bash
npm run test:all        # wipes .wbuild, rebuilds the Worker bundle, runs everything
bun test                # skips the 23 Worker-bundle tests when .wbuild/ is absent
python3 test/sdk_e2e.py # official openai + anthropic SDKs against a live server
```

94 tests: the shared core against a mock upstream, the *built* Worker bundle (so
the deployed code path is what runs, not a source copy), the real `src/server.js`
as a child process (aborted streams, port conflicts, crash logging), and the
installers against scratch directories, including the plugin legs, which run the
hosts' own CLIs against local fixture packages so no test needs the network.

## Getting a Vibe-scoped key

<https://chat.mistral.ai/code/extensions> → expand **Advanced** on the Vibe CLI
card → copy the **Vibe API Key** (`mstrl_…`). A key from
`console.mistral.ai → API Keys` draws on the $30 budget instead, *even with the
Vibe User-Agent and billing metadata* — it will work and report no `vibe_budget`.
The dashboard's setup wizard checks for exactly that.

## Layout

```
src/core.js       all shared logic: routing, auth, translation, billing (Web-standard only)
src/server.js     local entry — node:http, runs on Bun and Node
src/ui.html       dashboard (served by both the local server and the Worker)
cfwork/           Worker entry + wrangler config
install/          local + Worker installers behind ./install.sh
test/             bun test suites, fixtures, the Python SDK e2e script
```

The agent plugins are separate repos: [mistral-vibe-pi](https://github.com/dumbzombies/mistral-vibe-pi),
[mistral-vibe-opencode](https://github.com/dumbzombies/mistral-vibe-opencode),
[mistral-vibe-hermes](https://github.com/dumbzombies/mistral-vibe-hermes).

## Licence

MIT. Not affiliated with Mistral AI. It relies on the Vibe client's User-Agent
and `metadata.call_source` being the billing signal, which is Mistral's
implementation detail and may change (it did: UA alone stopped routing on
2026-11-25, and Mistral's 2026-12-01 policy drops Vibe allowance for third-party
harnesses entirely).
