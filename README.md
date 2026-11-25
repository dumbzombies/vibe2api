# vibe2api

**Mistral's $300/month Vibe allowance, usable from any OpenAI or Anthropic client.**

Mistral bills the same models twice against two different pots: the ordinary API
key draws on a $30/month API budget, while the Vibe coding agent draws on a
$300/month Vibe allowance. The only difference on the wire is the `User-Agent`:

```
user-agent: mistral-client-python/Mistral-Vibe/3.1.5
```

vibe2api puts that header in front of `api.mistral.ai`, so anything you point at
it — the OpenAI SDK, the Anthropic SDK, omp, opencode, hermes, Claude Code style
tooling — spends the allowance instead of the small budget. Verified end to end
against Mistral's own counters: one proxied call moved `vibe_budget` by
+0.000483% and `api_budget` by 0.000000%.

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

## Four ways to run it

| target | what it is | needs | picks up |
|---|---|---|---|
| **local proxy** | `src/server.js`, `node:http`, Bun or Node | Bun or Node 20+ | OpenAI + Anthropic SDKs, any HTTP client, a dashboard |
| **Cloudflare Worker** | `cfwork/worker.js` importing the same core | a Cloudflare account | the same API from anywhere, no machine to keep on |
| **omp / pi extension** | self-contained plugin, binds its own loopback server inside the agent | omp or pi | `/login` entry, `/model mistral-vibe/*`, `/vibe-quota` |
| **opencode / hermes plugin** | same idea, different host layout | opencode or hermes | provider + `/vibe-quota` / `hermes usage` |

All four share one implementation of the translation logic (`src/core.js` for
the server and the Worker; the plugins carry an equivalent in-process copy so
they need no daemon).

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

### 3. omp and pi

```bash
./install.sh omp                          # every agent dir that exists
./install.sh omp --omp                    # only ~/.omp/agent
```

The extension starts an OpenAI-compatible server on `127.0.0.1:8790+` **inside
the agent process** and registers the provider against it. Nothing else needs to
run; quitting the agent stops it.

```bash
# restart the agent, then:
/login          # pick "Mistral Vibe", paste your mstrl_… key (validated before storing)
/model          # pick a mistral-vibe/* model
/vibe-quota     # used %, $ left, reset date, cache hit rate
```

The `/login` entry is registered through the extension's `oauth` block, the same
mechanism pi's bundled providers use, so the key lands in `auth.json` and is
picked up mid-session.

### 4. opencode and hermes

```bash
./install.sh opencode                     # plugin + provider block + /vibe-quota
./install.sh hermes                       # provider plugin + quota skill + MISTRAL_VIBE_KEY
./install.sh hermes --remote user@host    # install it on another machine
```

opencode needs a server rather than a plain `baseURL`: its OpenAI-compatible
client rejects Mistral's typed content parts (`Invalid stream event`), which is
exactly what the plugin's loopback server rewrites. hermes points at the local
proxy by default; set `MISTRAL_VIBE_BASE_URL=https://…/v1` for a Worker.

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
  `/vibe-quota` report the hit rate.
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

140 tests: the shared core against a mock upstream, the *built* Worker bundle
(so the deployed code path is what runs, not a source copy), both plugin
implementations, the real `src/server.js` as a child process (aborted streams,
port conflicts, crash logging), and the installers against scratch directories.

## Getting a Vibe-scoped key

<https://chat.mistral.ai/code/extensions> → expand **Advanced** on the Vibe CLI
card → copy the **Vibe API Key** (`mstrl_…`). A key from
`console.mistral.ai → API Keys` draws on the $30 budget instead, *even with the
Vibe User-Agent* — it will work and report no `vibe_budget`. The dashboard's
setup wizard checks for exactly that.

## Layout

```
src/core.js       all shared logic: routing, auth, translation, billing (Web-standard only)
src/server.js     local entry — node:http, runs on Bun and Node
src/ui.html       dashboard (served by both the local server and the Worker)
cfwork/           Worker entry + wrangler config
plugins/omp/      omp/pi extension (in-process server + /login + /vibe-quota)
plugins/opencode/ opencode plugin + command
plugins/hermes/   hermes model-provider plugin
plugins/shared/   vibe-quota.sh (proxy, then billing, then Mistral direct)
install/          one-shot installers behind ./install.sh
test/             bun test suites + the Python SDK e2e script
```

## Licence

MIT. Not affiliated with Mistral AI. It relies on the Vibe client's User-Agent
being the billing signal, which is Mistral's implementation detail and may
change.
