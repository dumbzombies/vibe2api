# mistral-vibe (Hermes model provider plugin)

Hermes picks this up from `$HERMES_HOME/plugins/model-providers/mistral-vibe/`
without a restart after the next provider lookup.

- Default endpoint: `http://127.0.0.1:8788/v1` (the local proxy).
  Point it at a deployed Worker with
  `MISTRAL_VIBE_BASE_URL=https://your-worker.workers.dev/v1`.
- `MISTRAL_VIBE_KEY` is the credential: `local` for a keyless local proxy, an
  `mv-…` proxy key for a Worker in server mode, or your own `mstrl_…` Vibe key
  for a Worker in passthrough mode.
- `hermes usage` / `/usage` reads the live `vibe_budget` via
  `fetch_account_usage`.

Verify:

```bash
hermes doctor                       # provider appears, /models probe passes
hermes -z "reply OK" --provider mistral-vibe -m zai-glm-5-3-flash
```
