# vibe2api

Public repo: `dumbzombies/vibe2api`.

Proxy to `api.mistral.ai` that sends the Vibe client `User-Agent`
(`mistral-client-python/Mistral-Vibe/<version>`) and a
`metadata.call_source: "vibe_code"` on every request, so usage counts against the
$300/month Vibe allowance instead of the $30 API allowance. Exposes both
OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) endpoints,
streaming and non-streaming.

## Layout

- `src/core.js` — all shared logic (Web-standard only; imported by both runtimes)
- `src/server.js` — local entry, `node:http`, runs on Bun and Node; 127.0.0.1:8788; loads `~/.mistral-vibe/keys.json`
- `src/ui.html` — dashboard (both runtimes serve it)
- `cfwork/worker.js` + `cfwork/wrangler.jsonc` — Cloudflare Worker entry; no secrets, the caller's Vibe key is passed through
- `test/core.test.ts` — mock-upstream suite (`bun test`)
- `test/worker.test.ts` — runs the wrangler-built Worker bundle (`npm run test:all`)
- `test/install.test.ts` — runs each installer against a scratch HOME
- `plugins/` — opencode and hermes provider plugins, plus the omp/pi installer
  that installs [dumbzombies/mistral-vibe-pi](https://github.com/dumbzombies/mistral-vibe-pi)
  from GitHub (`plugins/README.md`); the extension source and its tests live in
  that repo, not here
- `install.sh` + `install/` — one-shot installers (`./install.sh --help`)

## Commands

- `./install.sh [local|worker|omp|opencode|hermes|plugins|test]` — one-shot installers; `--dry-run` writes nothing
- `bun src/server.js` or `node src/server.js` — start local proxy
- `bun test` — run tests
- `cd cfwork && npx wrangler deploy` — no secrets; clients send `Authorization: Bearer <mstrl_…>`
- `npm run test:all` — build Worker bundle + run all tests

## Conventions

- Keys never live in the repo (`~/.mistral-vibe/keys.json`, chmod 600; `.gitignore` covers `keys.json`).
- Nothing in the repo may hardcode a machine path, a private domain, or a KV id:
  installers and configs are copied by strangers. Use `$HOME`, `import.meta.url`
  and `wrangler.jsonc` placeholders.
- `/api/*` is session-only. Anything a caller must poll with just an API key has
  to use `/dashboard/billing/*` — `vibe-quota` and the hermes hook depend on it.
- Installers must stay dry-run safe and idempotent, and back up every file they
  overwrite (`*.bak-vibe2api`). `test/install.test.ts` enforces both.
- Two deployment modes, chosen by a secret and never by code: `VIBE_KEY` set means
  **server** mode (the deployment spends its own key, callers present an `mv-…`
  proxy key); absent means **passthrough** (the caller's `mstrl_…` goes upstream).
  `GATEWAY_KEY` is a legacy name kept only as a quota-script fallback.
- GLM/deepseek models return `content` as typed-part arrays: `text` parts become
  `content`, `thinking` parts become `reasoning_content` (stream and non-stream).
- `reasoning_effort` is clamped per model in `src/core.js` (`REASONING_EFFORTS`)
  to what the Vibe endpoint accepts; `/v1/models` carries context and capability
  metadata. Clients set the level themselves: omp `--thinking`, opencode
  per-model `options.reasoningEffort`, hermes provider defaults.
- The hermes plugin keeps `agent.account_usage` imports inside
  `fetch_account_usage`; a top-level import breaks provider discovery.
- hermes on Hostinger runs in the `hermes` container (`docker exec`), and
  `hermes usage` passes no credentials to the hook, so the plugin resolves
  `MISTRAL_VIBE_KEY`/`MISTRAL_VIBE_BASE_URL` from env or `$HERMES_HOME/.env`.
- The omp plugin lives in its own repo (`mistral-vibe-pi`) and the opencode
  plugin here; both are self-contained: each owns a loopback OpenAI-compatible
  server and calls `api.mistral.ai` with the Vibe UA directly.
  The omp plugin runs it as one daemon per user
  (`~/.mistral-vibe/omp-server.json` + `/healthz` `service: "mistral-vibe-omp"`,
  detached spawn); `install.sh omp` installs that repo, it does not copy files. Clients never
  probe: the daemon picks the port and publishes it, and a port answering with a
  different `service` is never adopted. The daemon is spawned with a resolved
  `bun`/`node` (`MISTRAL_VIBE_RUNTIME` overrides), never with
  `process.execPath`: under Termux's omp launcher that is `omp.bin`, and
  spawning it starts an agent session that loads the extension and spawns
  another, unbounded. The opencode plugin binds inside the
  agent on 8796. They must not depend on `src/server.js`, the Worker, or any env
  endpoint; `MISTRAL_BASE` is the only override (tests).
  `MISTRAL_VIBE_NO_DAEMON=1` keeps the omp plugin in-process for tests.
- The opencode plugin starts its server at module load: this build evaluates
  plugin modules but never calls the exported `server` hook. opencode also
  skips `.mjs` files and single-file `plugin` entries (directories only), and
  slash commands live in `~/.config/opencode/command/` (singular).
