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
- `plugins/` is gone. The three agent plugins live in their own repos —
  [mistral-vibe-pi](https://github.com/dumbzombies/mistral-vibe-pi),
  [mistral-vibe-opencode](https://github.com/dumbzombies/mistral-vibe-opencode),
  [mistral-vibe-hermes](https://github.com/dumbzombies/mistral-vibe-hermes) — and
  install with their host's own command. `install.sh` delegates to them and copies
  no plugin files, so a `git pull` here cannot half-update a plugin
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
- Each plugin owns a loopback OpenAI-compatible server inside its host process and
  calls `api.mistral.ai` with the Vibe UA plus `metadata.call_source`. None may
  depend on `src/server.js`, the Worker, or an external proxy; `MISTRAL_BASE` is
  the only upstream override. That contract, the picker naming and the daemon/port
  rules are documented in the plugin repos, not here.

