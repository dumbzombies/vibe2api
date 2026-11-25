# vibe2api

Public repo: `dumbzombies/vibe2api`.

Proxy to `api.mistral.ai` that sends the Vibe User-Agent
(`mistral-client-python/Mistral-Vibe/<version>`) so usage counts against the
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
- `plugins/` — omp/pi, opencode and hermes provider plugins (`plugins/README.md`)
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
- The Worker is pass-through: no `VIBE_KEY`/`GATEWAY_KEY` secrets, and the Bearer
  token on each request is the upstream Mistral key.
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
- The omp and opencode plugins are self-contained: each binds its own loopback
  OpenAI-compatible server inside its agent (omp 8790, opencode 8796) and calls
  `api.mistral.ai` with the Vibe UA directly. They must not depend on
  `src/server.js`, the Worker, or any env endpoint; `MISTRAL_BASE` is the only
  override (tests).
- The opencode plugin starts its server at module load: this build evaluates
  plugin modules but never calls the exported `server` hook. opencode also
  skips `.mjs` files and single-file `plugin` entries (directories only), and
  slash commands live in `~/.config/opencode/command/` (singular).
