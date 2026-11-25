"""Mistral Vibe provider for Hermes Agent.

Routes inference through a vibe2api proxy (local `127.0.0.1:8788`, or your own
deployed Worker set via `MISTRAL_VIBE_BASE_URL`), which sends Mistral's Vibe
user agent, so usage bills the $300/month Vibe allowance.

Env:
  MISTRAL_VIBE_KEY       proxy key; `local` for a keyless local proxy, or the
                         `mv-…` key / your own key for a deployed Worker
  MISTRAL_VIBE_BASE_URL  optional endpoint override (…/v1)

The provider also implements `fetch_account_usage`, so `hermes usage` and
`/usage` show the live Vibe budget.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

import httpx

from providers import register_provider
from providers.base import ProviderProfile

DEFAULT_BASE_URL = "http://127.0.0.1:8788/v1"
VIBE_UA = "mistral-client-python/Mistral-Vibe/3.1.5"
MODELS = (
    "zai-glm-5-3-flash",
    "zai-glm-5-3",
    "deepseek-v4-1-flash-1017",
    "mistral-large-4-0",
    "mistral-medium-latest",
)


def _env_file_value(name: str) -> str | None:
    """Read a var from $HERMES_HOME/.env when the CLI did not export it."""
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    try:
        with open(os.path.join(home, ".env"), encoding="utf-8") as handle:
            for line in handle:
                if line.startswith(f"{name}="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        return None
    return None


def _resolve_access(api_key: str | None, base_url: str | None) -> tuple[str | None, str | None]:
    """`hermes usage` calls the hook with no credentials; fall back to env/.env.

    A `local` key means a keyless local proxy, so no Authorization header.
    """
    key = api_key or os.environ.get("MISTRAL_VIBE_KEY") or _env_file_value("MISTRAL_VIBE_KEY")
    base = base_url or os.environ.get("MISTRAL_VIBE_BASE_URL") or _env_file_value("MISTRAL_VIBE_BASE_URL")
    if key == "local":
        key = None
    return key or None, base


def _origin(base_url: str | None) -> str:
    """Proxy origin for the state endpoint; strips a trailing /v1."""
    base = (base_url or DEFAULT_BASE_URL).rstrip("/")
    return base[: -len("/v1")] if base.endswith("/v1") else base


class MistralVibeProfile(ProviderProfile):
    def fetch_account_usage(self, *, api_key: str | None = None, base_url: str | None = None):
        # Imported here: agent.account_usage pulls hermes_cli.runtime_provider, and a
        # module-level import makes provider discovery hit a circular import and drop
        # this plugin (which silently disables `hermes usage`).
        from agent.account_usage import AccountUsageSnapshot, AccountUsageWindow

        api_key, base_url = _resolve_access(api_key, base_url)
        headers = {"User-Agent": VIBE_UA}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        # `/api/state` is session-only on the standalone proxy and the Worker, so
        # an API key gets 403 there; the billing routes accept the API credential
        # by design. Uses dollars + percent, which need no re-scaling.
        try:
            response = httpx.get(
                f"{_origin(base_url)}/dashboard/billing/usage", headers=headers, timeout=5.0
            )
            response.raise_for_status()
            usage = response.json()
        except Exception:
            return None

        used = usage.get("used_percent")
        if not isinstance(used, (int, float)):
            return None
        total = usage.get("limit_usd")
        reset_at = None
        resets_at = usage.get("resets_at")
        if isinstance(resets_at, str):
            try:
                reset_at = datetime.fromisoformat(resets_at.replace("Z", "+00:00"))
            except ValueError:
                reset_at = None
        # `usage_percentage` is already a percent (0.56 == 0.56% of $300), so it
        # is not scaled again; scaling here reported 100x the real spend.
        window = AccountUsageWindow(
            label="Vibe month",
            used_percent=round(float(used), 2),
            reset_at=reset_at,
            detail=f"${total:.0f} allowance" if isinstance(total, (int, float)) else None,
        )
        return AccountUsageSnapshot(
            provider=self.name,
            source="mistral_vibe_proxy",
            fetched_at=datetime.now(timezone.utc),
            windows=(window,),
        )


register_provider(
    MistralVibeProfile(
        name="mistral-vibe",
        aliases=("mistral-vibe-proxy", "vibe"),
        display_name="Mistral Vibe",
        description="Mistral models on the Vibe allowance (proxy routes with the Vibe user agent)",
        signup_url="https://chat.mistral.ai/code",
        env_vars=("MISTRAL_VIBE_KEY", "MISTRAL_VIBE_BASE_URL"),
        base_url=DEFAULT_BASE_URL,
        auth_type="api_key",
        api_mode="chat_completions",
        default_aux_model="zai-glm-5-3-flash",
        fallback_models=MODELS,
        default_headers={"User-Agent": VIBE_UA},
        model_capabilities={
            model: {
                "supports_reasoning": False,
                "supports_vision": False,
                "supports_tools": True,
                "context_window": 131072,
                "model_family": "mistral",
            }
            for model in MODELS
        },
    )
)
