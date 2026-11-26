# vibe2api plugins

Provider integrations for coding agents. Each one makes the agent bill Mistral's
$300/month Vibe allowance instead of the $30 API budget.

| plugin | target | self-contained? | gives you |
|---|---|---|---|
| `omp/` | omp **and** pi | yes — one daemon per user on loopback | provider, `/login` entry, `/vibe-usage` |
| `opencode/` | opencode | yes — binds `127.0.0.1:8810` on load | provider block, `/vibe-quota` command |
| `hermes/` | hermes | no — its own loopback server, straight to `api.mistral.ai` | provider, `hermes usage` gauge |

`omp/` and `opencode/` are installers only: their plugin sources live in
[mistral-vibe-pi](https://github.com/dumbzombies/mistral-vibe-pi) and
[mistral-vibe-opencode](https://github.com/dumbzombies/mistral-vibe-opencode).
Only the hermes plugin is sourced from this repo.

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

The omp/pi integration lives in its own repo,
[`dumbzombies/mistral-vibe-pi`](https://github.com/dumbzombies/mistral-vibe-pi),
as a **plugin package** (`package.json` declares `omp.extensions` and
`pi.extensions`). The agent's plugin registry owns installation, updates and
removal; this repo only wraps the install with the key and cleanup steps below.

## omp / pi

```bash
./install.sh omp            # or: ./plugins/omp/install.sh [--omp] [--pi]
```

- Runs `omp plugin install https://github.com/dumbzombies/mistral-vibe-pi` and
  `pi install https://github.com/dumbzombies/mistral-vibe-pi`. Verify with
  `omp plugin list` / `pi list`; the installer fails if the package is not
  listed afterwards. `MISTRAL_VIBE_PI_SOURCE` overrides the source (a fork, a
  pinned tag, or a local checkout).
- Removes any `mistral-vibe-quota.ts` an older version copied into
  `~/.omp/agent/extensions` or `~/.pi/agent/extensions`: a loose extension and
  the package would register the provider and `/vibe-usage` twice.
- The extension owns one daemon per user, preferring `127.0.0.1:8790`. It reads
  `~/.mistral-vibe/omp-server.json`, verifies `GET /healthz` reports
  `service: "mistral-vibe-omp"`, and reuses it; with nothing there it spawns the
  extension file detached (`MISTRAL_VIBE_DAEMON=1 bun <file>`) and waits for the
  handshake. Clients never probe: the daemon picks a free port in
  `8790..8799` when something else owns the preferred one and publishes it in
  the state file, and a port answering with a different `service` is never
  adopted. The daemon is launched by `bun` (or `node
  --experimental-strip-types`), found on `PATH` or set via
  `MISTRAL_VIBE_RUNTIME` — never by `process.execPath`, which under Termux's omp
  launcher is the agent binary itself. `/healthz` is liveness only and does no network I/O — hosts poll it
  with a 0.8–1.5 s budget, so its `models` field is the cached catalog size or
  `null` until the catalog is warm. The daemon outlives the agent, so quitting
  omp leaves it running; `kill $(jq .pid ~/.mistral-vibe/omp-server.json)` stops it.
  `MISTRAL_VIBE_NO_DAEMON=1` restores the old in-process bind on
  `MISTRAL_VIBE_PORT` (tests and smoke probes).
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
- Uninstall: `omp plugin uninstall mistral-vibe-pi` and `pi remove <dir>`. Nothing
  is left in the agent dirs.

## opencode

```bash
./install.sh opencode
```

Source: [dumbzombies/mistral-vibe-opencode](https://github.com/dumbzombies/mistral-vibe-opencode).
The installer fetches it (or installs from a local checkout via
`MISTRAL_VIBE_OC_SOURCE`), then merges the provider block into `opencode.jsonc`.

- The plugin starts an OpenAI-compatible server on
  `127.0.0.1:8810` when opencode loads it. opencode evaluates plugin modules
  even for `opencode models`, so the bind happens at module load.
- Port 8810 is fixed, because the provider block's `baseURL` is a constant: a
  second opencode process reuses a listener that answers `/health` with
  `service: "mistral-vibe-opencode"`, and a foreign listener is reported instead
  of taken over (`MISTRAL_VIBE_OC_PORT` moves both the bind and the baseURL).
- The bound port is published to `~/.mistral-vibe/opencode-server.json`
  (`MISTRAL_VIBE_STATE_DIR` overrides) as `{service, port, pid, startedAt}`.
  `vibe-quota` reads it, but only after `/health` confirms the service.
- The provider block is merged into `opencode.jsonc` (backup
  `.bak-vibe2api`) with `baseURL: http://127.0.0.1:8810/v1`.
- Recovery, per the omp/pi extension: a `finish_reason: "length"` turn with no
  visible text (the budget went to reasoning) and a tool call cut off
  mid-JSON are both retried at the next lower `reasoning_effort` the model
  accepts, non-stream and stream. Streaming holds back only the finish chunk
  and tool-call deltas, so a retry is invisible unless text was already shown.
- Failure surfacing: `no-key` 401, rejected key 401 (that key only, 10 min
  cooldown), capacity 429 + `Retry-After: 60` (never disables the key),
  transient 5xx 502 (also appended to `~/.mistral-vibe/opencode-errors.log`),
  unreachable upstream 502.
- Hardening copied from the omp/pi extension: a stream with no `data:` line for
  `MV_STREAM_IDLE_MS` (default 300 s) is abandoned instead of pinned to the 1 h
  request timeout; an oversized body is drained so the 413 can actually be read;
  an unrecognised `reasoning_effort` is floored to the model's weakest wire
  level instead of 422-ing the turn; browser Origins outside the loopback
  dashboard are refused and no response carries a wildcard CORS origin;
  `/api/state` exposes one-way key fingerprints, never key material.
- Per-model `options.reasoningEffort` is forwarded as `reasoning_effort`.
- `/vibe-quota` is a TUI command that shells out to `~/.local/bin/vibe-quota`.
  (`opencode run "/vibe-quota"` is just a prompt — it does not run the command.)

## hermes

```bash
./install.sh hermes                        # $HERMES_HOME (default ~/.hermes)
./install.sh hermes --remote user@host     # over ssh; writes the key there
./install.sh hermes --container hermes     # docker container; reads its HERMES_HOME
```

- Runs `hermes plugins install dumbzombies/mistral-vibe-hermes`, so Hermes owns
  cloning, updates and removal (`hermes plugins update`, `remove`). The plugin is
  a real package with `kind: model-provider`, which is what makes the flat
  `$HERMES_HOME/plugins/<name>` install discoverable. Source override:
  `MISTRAL_VIBE_HERMES_SOURCE`.
- Writes `MISTRAL_VIBE_KEY` into `$HERMES_HOME/.env` (mode 600). In a Docker
  setup `$HERMES_HOME` is the mounted volume (usually `/opt/data`), which is why
  the container path asks the container for it instead of assuming `~/.hermes`.
- Removes a `plugins/model-providers/mistral-vibe` copy left by the old
  file-copy installer: both directories load, so the provider would register
  twice and the picker would show two rows.
- **Self-contained**: the plugin starts its own loopback OpenAI-compatible server
  on an ephemeral port inside the Hermes process (stdlib `http.server`, daemon
  thread) and calls `api.mistral.ai` directly with the Vibe user agent and
  `metadata.call_source`. No proxy, no Worker, no daemon, no open port to
  publish. `create_client()` is the supported hook for this — it hands Hermes a
  stock `openai.OpenAI` pointed at that server, so retries, streaming and tool
  parsing stay upstream's.
- Request shaping happens in one place (`normalize_request`) and covers what
  Mistral rejects: `store`/`service_tier`/`safety_identifier`, `reasoning_effort`
  outside the model's set, `developer` role, replayed `reasoning_content`,
  `max_completion_tokens`, and `temperature: 0` without `top_p: 1`.
- `hermes usage --provider mistral-vibe` reads `vibe_budget` from
  `/v1/billing/budget`. The payload's top-level fields describe the *API*
  allowance, so reading them reports the wrong budget.
- Model rows are normalised like omp's picker: the wire id stays selectable and
  `discover_models()` supplies the human name plus specs as the row note, so
  `zai-glm-5-3-flash · GLM 5.3 Flash (Vibe) · 1M ctx, reasoning, vision`.
  Renaming the id itself would change what reaches the API. `model_aliases`
  adds `glm`, `glm-flash`, `deepseek`, `large`, `medium` for `/model` and
  `-m`.
- `agent.account_usage` is imported *inside* `fetch_account_usage`: a
  module-level import makes provider discovery hit a circular import and silently
  drop the plugin.
- Tests: `test/fixtures/hermes_plugin_check.py` (run from `bun test`) stubs the
  Hermes imports, points `MISTRAL_BASE` at a local fake upstream, and drives the
  plugin's own server — no key, no network.

## Quota reporting

The quota script ships with the opencode repo
([`bin/vibe-quota.sh`](https://github.com/dumbzombies/mistral-vibe-opencode)) and
is what `/vibe-quota` runs. Three sources, in order:

1. `$VIBE_PROXY/api/state` — richest view (pool status, cache rate, counters).
   Only the in-process plugin servers expose it unauthenticated.
2. `$VIBE_PROXY/dashboard/billing/usage` — the caller-facing billing route, which
   accepts an API credential on both the local proxy and the Worker.
3. Mistral directly (`/v1/billing/budget`) when no proxy answers.

`VIBE_PROXY` overrides everything; unset, the script reads the opencode plugin's
published port and falls back to `http://127.0.0.1:8810`. Point it at
`http://127.0.0.1:8788` for the standalone proxy or at your Worker URL.

## Note on prompt caching

Mistral prefix-caches automatically — no `cache_control`, no opt-in. Never
reorder or rewrite the prefix between turns: system prompt, tool list and
message order must stay byte-identical, or the whole cache is busted. The
`reasoning_content` strip is deterministic, so it does not break caching.
