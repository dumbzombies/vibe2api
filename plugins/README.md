# vibe2api plugins

Provider integrations for coding agents. Each one makes the agent bill Mistral's
$300/month Vibe allowance instead of the $30 API budget.

| plugin | target | self-contained? | gives you |
|---|---|---|---|
| `omp/` | omp **and** pi | yes — binds a loopback server inside the agent | provider, `/login` entry, `/vibe-quota` |
| `opencode/` | opencode | yes — binds `127.0.0.1:8796` on load | provider block, `/vibe-quota` command |
| `hermes/` | hermes | no — talks to the proxy/Worker | provider, `hermes usage` gauge |
| `shared/` | anything | — | `vibe-quota` script |

```bash
./install.sh plugins        # from the repo root: every agent dir that exists
```

## Why a server and not just a `baseURL`

Mistral's Vibe surface returns typed content parts:

```json
{"content": [{"type": "thinking", "thinking": [...]}, {"type": "text", "text": "42"}]}
```

OpenAI-compatible clients either render that as garbage or reject it (opencode:
`Invalid stream event`). Each in-process plugin server rewrites it into the
shape clients expect:

- `{"type":"text"}` → `content`
- `{"type":"thinking"}` → `reasoning_content`
- `reasoning_content` is stripped from replayed assistant turns (Mistral 422s it)
- `reasoning_effort` is clamped to what the model accepts
- `max_completion_tokens` is aliased, `temperature: 0` forces `top_p: 1`
- SSE is ASCII-escaped so a chunk-splitting transport cannot corrupt it

## omp / pi

```bash
./install.sh omp            # or: ./plugins/omp/install.sh [--omp] [--pi]
```

- Installs `extensions/mistral-vibe-quota.ts` into `~/.omp/agent` and/or
  `~/.pi/agent` (`OMP_AGENT_DIR` / `PI_AGENT_DIR` override).
- The extension binds `127.0.0.1:8790` (probing upward) at load and points the
  provider at it. Quit the agent and the server is gone.
- Registers the provider with an `oauth` block, so `/login` lists **Mistral
  Vibe** and validates the key against `/v1/billing/budget` before storing it.
- Models carry real limits (1M context, `mistral-medium-latest` 262144),
  `reasoning: true` with a per-model `thinkingLevelMap` (`--thinking low|medium|high`),
  and image input where the model sees images.
- Key order: the `/login` key (per request) → `MISTRAL_VIBE_KEY` →
  `~/.mistral-vibe/keys.json`.
- The installer removes a stale provider block from `models.yml` that older
  versions appended (backup `models.yml.bak-vibe2api`); registering the provider
  twice breaks `/model`.

## opencode

```bash
./install.sh opencode
```

- `plugins/mistral-vibe.ts` starts an OpenAI-compatible server on
  `127.0.0.1:8796` when opencode loads it. opencode evaluates plugin modules
  even for `opencode models`, so the bind happens at module load; a second
  opencode process fails to bind and uses the first one's server.
- The provider block is merged into `opencode.jsonc` (backup
  `.bak-vibe2api`) with `baseURL: http://127.0.0.1:8796/v1`.
- Per-model `options.reasoningEffort` is forwarded as `reasoning_effort`.
- `/vibe-quota` is a TUI command that shells out to `~/.local/bin/vibe-quota`.
  (`opencode run "/vibe-quota"` is just a prompt — it does not run the command.)

## hermes

```bash
./install.sh hermes                        # $HERMES_HOME (default ~/.hermes)
./install.sh hermes --remote user@host     # copy over ssh and write the key there
```

- Installs a provider plugin at
  `$HERMES_HOME/plugins/model-providers/mistral-vibe/` and writes
  `MISTRAL_VIBE_KEY` into `$HERMES_HOME/.env` (mode 600). In a Docker setup,
  `$HERMES_HOME` is the mounted volume.
- `hermes usage --provider mistral-vibe` reads
  `/dashboard/billing/usage` — the caller-facing route — so it works with an API
  key. `/api/state` is session-only and would answer 403.
- `agent.account_usage` is imported *inside* `fetch_account_usage`: a
  module-level import makes provider discovery hit a circular import and silently
  drop the plugin.
- Default endpoint is the local proxy (`http://127.0.0.1:8788/v1`); set
  `MISTRAL_VIBE_BASE_URL=https://your-worker.workers.dev/v1` for a Worker.

## Quota reporting

`shared/vibe-quota.sh` is what every plugin and `/vibe-quota` uses. Three
sources, in order:

1. `$VIBE_PROXY/api/state` — richest view (pool status, cache rate, counters).
   Only the in-process plugin servers expose it unauthenticated.
2. `$VIBE_PROXY/dashboard/billing/usage` — the caller-facing billing route, which
   accepts an API credential on both the local proxy and the Worker.
3. Mistral directly (`/v1/billing/budget`) when no proxy answers.

`VIBE_PROXY` defaults to `http://127.0.0.1:8796` (the opencode loopback); point
it at `http://127.0.0.1:8788` for the standalone proxy or at your Worker URL.

## Note on prompt caching

Mistral prefix-caches automatically — no `cache_control`, no opt-in. Never
reorder or rewrite the prefix between turns: system prompt, tool list and
message order must stay byte-identical, or the whole cache is busted. The
`reasoning_content` strip is deterministic, so it does not break caching.
