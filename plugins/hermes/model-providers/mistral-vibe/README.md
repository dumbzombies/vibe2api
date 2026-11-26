# mistral-vibe (Hermes model provider plugin)

Self-contained: the plugin starts its own loopback OpenAI-compatible server inside
the Hermes process and calls `api.mistral.ai` directly with the Vibe user agent and
`metadata.call_source`. There is nothing to deploy and nothing else to run — not a
proxy, not a Worker, not a daemon.

Hermes picks it up from `$HERMES_HOME/plugins/model-providers/mistral-vibe/` on the
next provider lookup; no restart needed.

| env | default | meaning |
|---|---|---|
| `MISTRAL_VIBE_KEY` | unset | your `mstrl_…` key (also read from `$HERMES_HOME/.env`) |
| `MISTRAL_VIBE_VERSION` | `3.1.5` | version in the Vibe `User-Agent` |
| `MISTRAL_BASE` | `https://api.mistral.ai` | upstream override |

`hermes usage` and `/usage` show the Vibe month through `fetch_account_usage`, read
from `/v1/billing/budget` (the `vibe_budget` block, not the API one).

Models: `zai-glm-5-3-flash`, `zai-glm-5-3`, `deepseek-v4-1-flash-1017`,
`mistral-large-4-0`, `mistral-medium-latest`.

Verify:

```bash
hermes doctor                                            # provider appears, probe passes
hermes usage --provider mistral-vibe                     # Vibe month gauge
hermes -z "reply OK" --provider mistral-vibe -m zai-glm-5-3-flash
```
