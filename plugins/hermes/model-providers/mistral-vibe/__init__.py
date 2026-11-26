"""Mistral Vibe provider for Hermes Agent — self-contained.

Runs its own OpenAI-compatible server *inside the Hermes process* (a loopback
thread, ephemeral port) and forwards to `https://api.mistral.ai` with the Vibe
client user agent and `metadata.call_source`, so usage bills the $300/month Vibe
allowance instead of the $30 API budget.

No daemon, no external proxy, no Worker, no extra services: stdlib only.

Env:
  MISTRAL_VIBE_KEY   Vibe key (`mstrl_…`); also read from $HERMES_HOME/.env
  MISTRAL_BASE       upstream override (tests / a compatible gateway)

The vendor quirks Mistral needs (and OpenAI-compatible clients get wrong) are
normalised here, in one place:
  - `metadata.call_source` on every request (the UA alone no longer routes spend)
  - `reasoning_effort` clamped per model (unlisted levels are a hard 422)
  - `developer` role -> `system` (Mistral's enum has no `developer`)
  - replayed `reasoning_content` stripped (422 extra_forbidden)
  - typed content parts -> text + `reasoning_content`
also implements `fetch_account_usage`, so `hermes usage` shows the Vibe budget.
"""

from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from providers import register_provider
from providers.base import ProviderProfile

DEFAULT_UPSTREAM = "https://api.mistral.ai"
VIBE_VERSION = os.environ.get("MISTRAL_VIBE_VERSION", "3.1.5")
MODELS = (
    "zai-glm-5-3-flash",
    "zai-glm-5-3",
    "deepseek-v4-1-flash-1017",
    "mistral-large-4-0",
    "mistral-medium-latest",
)
CONTEXT_WINDOW = {
    "mistral-medium-latest": 262144,
}

# What each model accepts on the wire. Measured on the live endpoint: any level
# outside a model's set fails the whole turn with 422, so everything is mapped.
GLM_EFFORT = {
    "off": "none", "minimal": "none", "low": "low", "medium": "medium",
    "high": "high", "xhigh": "high", "max": "high",
}
DEEPSEEK_EFFORT = {
    "off": "none", "minimal": "none", "low": "low", "medium": "low",
    "high": "high", "xhigh": "xhigh", "max": "max",
}
LARGE_EFFORT = {
    "off": "low", "minimal": "low", "low": "low", "medium": "medium",
    "high": "high", "xhigh": "high", "max": "high",
}
NO_LOW = {
    "off": "none", "minimal": "none", "low": "none", "medium": "high",
    "high": "high", "xhigh": "high", "max": "high",
}
EFFORT_RANK = {"none": 0, "minimal": 1, "low": 2, "medium": 3, "high": 4, "xhigh": 5, "max": 6}
REASONING_EFFORTS = {
    "zai-glm-5-3": GLM_EFFORT,
    "zai-glm-5-3-flash": GLM_EFFORT,
    "deepseek-v4-1-flash-1017": DEEPSEEK_EFFORT,
    "mistral-large-4-0": LARGE_EFFORT,
    "mistral-medium-latest": NO_LOW,
}
OPENAI_REJECTED = ("store", "service_tier", "safety_identifier")


def _upstream() -> str:
    return (os.environ.get("MISTRAL_BASE") or DEFAULT_UPSTREAM).rstrip("/")


def _vibe_ua() -> str:
    return f"mistral-client-python/Mistral-Vibe/{VIBE_VERSION}"


def _env_file_value(name: str) -> str | None:
    """Read a var from $HERMES_HOME/.env; `hermes usage` runs without env exported."""
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    try:
        with open(os.path.join(home, ".env"), encoding="utf-8") as handle:
            for line in handle:
                if line.startswith(f"{name}="):
                    return line.split("=", 1)[1].strip() or None
    except OSError:
        return None
    return None


def _resolve_key(api_key: str | None) -> str | None:
    key = api_key or os.environ.get("MISTRAL_VIBE_KEY") or _env_file_value("MISTRAL_VIBE_KEY")
    if not key or key == "local":
        return None
    return key


# ── request normalisation ────────────────────────────────────────────


def _weakest(table: dict[str, str]) -> str:
    return sorted(set(table.values()), key=lambda v: EFFORT_RANK.get(v, 0))[0]


def _map_effort(effort: Any, model: Any) -> str | None:
    if effort is None or effort == "":
        return None
    table = REASONING_EFFORTS.get(str(model))
    if not table:
        return str(effort)
    return table.get(str(effort), _weakest(table))


def _text_parts(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    out = []
    for part in content:
        if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str):
            out.append(part["text"])
    return "".join(out)


def _reasoning_text(content: Any) -> str:
    if not isinstance(content, list):
        return ""
    out = []
    for part in content:
        if not isinstance(part, dict) or part.get("type") != "thinking":
            continue
        for inner in part.get("thinking") or ():
            if isinstance(inner, dict) and inner.get("type") == "text" and isinstance(inner.get("text"), str):
                out.append(inner["text"])
    return "".join(out)


def normalize_request(body: dict[str, Any]) -> dict[str, Any]:
    out = dict(body)
    for field in OPENAI_REJECTED:
        out.pop(field, None)

    # Spend attribution: a non-empty call_source is what routes the request to
    # the Vibe allowance now (the value itself is not inspected).
    meta = out.get("metadata") if isinstance(out.get("metadata"), dict) else {}
    out["metadata"] = {**meta, "call_source": "vibe_code"}

    if "max_completion_tokens" in out:
        out.setdefault("max_tokens", out["max_completion_tokens"])
        out.pop("max_completion_tokens", None)

    # Mistral rejects greedy sampling unless top_p is exactly 1.
    if out.get("temperature") == 0 and out.get("top_p") != 1:
        out["top_p"] = 1

    if "reasoning_effort" in out:
        mapped = _map_effort(out["reasoning_effort"], out.get("model"))
        if mapped is None:
            out.pop("reasoning_effort", None)
        else:
            out["reasoning_effort"] = mapped

    messages = out.get("messages")
    if isinstance(messages, list):
        cleaned = []
        for message in messages:
            if not isinstance(message, dict):
                cleaned.append(message)
                continue
            msg = dict(message)
            # Reasoning is output-only upstream; echoing it back is a 422.
            msg.pop("reasoning_content", None)
            msg.pop("reasoning", None)
            if msg.get("role") == "developer":
                msg["role"] = "system"
            cleaned.append(msg)
        out["messages"] = cleaned
    return out


def _normalize_message(message: dict[str, Any]) -> None:
    content = message.get("content")
    if isinstance(content, list):
        reasoning = _reasoning_text(content)
        message["content"] = _text_parts(content)
        if reasoning:
            message["reasoning_content"] = reasoning


def normalize_response(payload: Any) -> Any:
    if not isinstance(payload, dict):
        return payload
    for choice in payload.get("choices") or ():
        if not isinstance(choice, dict):
            continue
        if isinstance(choice.get("message"), dict):
            _normalize_message(choice["message"])
        if isinstance(choice.get("delta"), dict):
            _normalize_message(choice["delta"])
    return payload


def split_finish_chunk(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Mistral coalesces a content/tool delta with finish_reason into one chunk.

    OpenAI clients flush tool-call state only on a dedicated finish chunk, so a
    coalesced one loses the call.
    """
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return [payload]
    choice = choices[0]
    if not isinstance(choice, dict) or not choice.get("finish_reason"):
        return [payload]
    delta = choice.get("delta") or {}
    has_payload = bool(delta.get("tool_calls")) or bool(delta.get("content"))
    if not has_payload:
        return [payload]
    rest = {k: v for k, v in payload.items() if k != "usage"}
    return [
        {**rest, "choices": [{**choice, "delta": delta, "finish_reason": None}]},
        {**rest, "choices": [{**choice, "delta": {}, "finish_reason": choice["finish_reason"]}],
         "usage": payload.get("usage")},
    ]


# ── in-process server ────────────────────────────────────────────────


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "mistral-vibe-hermes"

    def log_message(self, *_args: Any, **_kwargs: Any) -> None:  # silence per-request stderr
        return

    # -- helpers --

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _key(self) -> str | None:
        auth = self.headers.get("Authorization") or ""
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        if token and token not in {"local", "missing"}:
            return token
        return _resolve_key(None)

    def _read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            parsed = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}

    # -- routes --

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        if self.path.rstrip("/") in ("/healthz", "/health"):
            self._json(200, {"ok": True, "service": "mistral-vibe-hermes", "models": len(MODELS)})
            return
        if self.path.rstrip("/").endswith("/models"):
            self._json(200, {
                "object": "list",
                "data": [
                    {
                        "id": model,
                        "object": "model",
                        "owned_by": "mistralai",
                        "capabilities": {"completion_chat": True, "function_calling": True, "reasoning": True},
                    }
                    for model in MODELS
                ],
            })
            return
        self._json(404, {"error": {"message": f"no route {self.path}"}})

    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._json(404, {"error": {"message": f"no route {self.path}"}})
            return
        body = normalize_request(self._read_body())
        key = self._key()
        if not key:
            self._json(401, {"error": {"message": "no Mistral Vibe key: set MISTRAL_VIBE_KEY or run `hermes auth add mistral-vibe`"}})
            return
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if body.get("stream") else "application/json",
            "User-Agent": _vibe_ua(),
        }
        request = urllib.request.Request(
            f"{_upstream()}/v1/chat/completions",
            data=json.dumps(body).encode(),
            headers=headers,
            method="POST",
        )
        try:
            response = urllib.request.urlopen(request, timeout=120)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            self._json(exc.code, {"error": {"message": detail or exc.reason, "type": "upstream_error"}})
            return
        except Exception as exc:  # noqa: BLE001 - network failure surfaces as a 502
            self._json(502, {"error": {"message": f"upstream unreachable: {exc}"}})
            return

        if not body.get("stream"):
            with response:
                raw = response.read()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                self._json(502, {"error": {"message": "upstream sent a non-JSON body"}})
                return
            self._json(200, normalize_response(payload))
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            with response:
                for raw in response:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        self.wfile.write(b"data: [DONE]\n\n")
                        break
                    try:
                        payload = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    for chunk in split_finish_chunk(normalize_response(payload)):
                        self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        except Exception as exc:  # noqa: BLE001 - client-facing stream error
            self.wfile.write(f"data: {json.dumps({'error': {'message': str(exc)}})}\n\n".encode())
        finally:
            try:
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except Exception:  # noqa: BLE001 - the client may already be gone
                pass


class _Server:
    """Lazily started loopback server, one per Hermes process."""

    _lock = threading.Lock()
    _httpd: ThreadingHTTPServer | None = None

    @classmethod
    def url(cls) -> str:
        with cls._lock:
            if cls._httpd is None:
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
                httpd.daemon_threads = True
                thread = threading.Thread(target=httpd.serve_forever, name="mistral-vibe", daemon=True)
                thread.start()
                cls._httpd = httpd
            port = cls._httpd.server_address[1]
        return f"http://127.0.0.1:{port}/v1"


# ── profile ──────────────────────────────────────────────────────────


class MistralVibeProfile(ProviderProfile):
    def create_client(self, **client_kwargs: Any) -> Any:
        """Point the shared OpenAI client at this process's own loopback server.

        Returning a client here is the supported way for an out-of-tree provider
        to own its transport; everything else (retries, streaming, tool parsing)
        stays Hermes' stock OpenAI path.
        """
        try:
            import openai
        except ImportError:
            return None
        kwargs = {
            key: value
            for key, value in client_kwargs.items()
            if key in {"api_key", "timeout", "max_retries", "http_client", "default_headers"}
        }
        kwargs["api_key"] = client_kwargs.get("api_key") or _resolve_key(None) or "local"
        kwargs["base_url"] = _Server.url()
        headers = dict(kwargs.pop("default_headers", None) or {})
        headers["User-Agent"] = _vibe_ua()
        kwargs["default_headers"] = headers
        return openai.OpenAI(**kwargs)

    def fetch_account_usage(self, *, api_key: str | None = None, base_url: str | None = None):
        # Imported here: agent.account_usage pulls hermes_cli.runtime_provider, and a
        # module-level import breaks provider discovery with a circular import
        # (which silently disables `hermes usage`).
        from agent.account_usage import AccountUsageSnapshot, AccountUsageWindow

        key = _resolve_key(api_key)
        if not key:
            return None
        request = urllib.request.Request(
            f"{_upstream()}/v1/billing/budget",
            headers={"Authorization": f"Bearer {key}", "User-Agent": _vibe_ua()},
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                payload = json.loads(response.read().decode())
        except Exception:  # noqa: BLE001 - usage is best-effort, never fatal
            return None

        # `/v1/billing/budget` reports both allowances; top-level fields are the
        # API one, so read the vibe one explicitly.
        vibe = payload.get("vibe_budget") or payload
        used = vibe.get("usage_percentage")
        if not isinstance(used, (int, float)):
            return None
        reset_at = None
        resets_at = vibe.get("reset_at")
        if isinstance(resets_at, str):
            try:
                reset_at = datetime.fromisoformat(resets_at.replace("Z", "+00:00"))
            except ValueError:
                reset_at = None
        total = vibe.get("initial_budget")
        window = AccountUsageWindow(
            label="Vibe month",
            used_percent=round(float(used), 2),
            reset_at=reset_at,
            detail=f"${total:.0f} allowance" if isinstance(total, (int, float)) else None,
        )
        return AccountUsageSnapshot(
            provider=self.name,
            source="mistral_vibe_direct",
            fetched_at=datetime.now(timezone.utc),
            windows=(window,),
        )


register_provider(
    MistralVibeProfile(
        name="mistral-vibe",
        aliases=("mistral-vibe-direct", "vibe"),
        display_name="Mistral Vibe",
        description="Mistral models on the Vibe allowance (Vibe user agent + call_source, in-process)",
        signup_url="https://chat.mistral.ai/code",
        env_vars=("MISTRAL_VIBE_KEY",),
        base_url=f"{DEFAULT_UPSTREAM}/v1",
        auth_type="api_key",
        api_mode="chat_completions",
        default_aux_model="zai-glm-5-3-flash",
        fallback_models=MODELS,
        default_headers={"User-Agent": _vibe_ua()},
        model_capabilities={
            model: {
                "supports_reasoning": True,
                "supports_vision": model != "zai-glm-5-3",
                "supports_tools": True,
                "context_window": CONTEXT_WINDOW.get(model, 1048576),
                "model_family": "mistral",
            }
            for model in MODELS
        },
    )
)
