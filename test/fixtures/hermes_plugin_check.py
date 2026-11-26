"""Hermes provider plugin checks: no network, no key, no Hermes install.

Stubs the `providers` / `agent.account_usage` modules Hermes supplies, points
`MISTRAL_BASE` at a local fake upstream, and drives the plugin's own server.
Exits non-zero on the first failed assertion.

Run directly (`python3 test/fixtures/hermes_plugin_check.py`) or via
`bun test` (`test/hermes-plugin.test.ts`).
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import sys
import threading
import types
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "plugins" / "hermes" / "model-providers" / "mistral-vibe" / "__init__.py"

failures: list[str] = []
seen_requests: list[dict] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(("PASS " if condition else "FAIL ") + label + (f"  [{detail}]" if detail and not condition else ""))
    if not condition:
        failures.append(label)


# ── fake upstream ────────────────────────────────────────────────────


class Upstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args, **_kwargs):
        return

    def do_GET(self):  # noqa: N802
        if self.path.endswith("/billing/budget"):
            body = json.dumps({
                "vibe_budget": {"usage_percentage": 12.5, "initial_budget": 300.0, "reset_at": "2026-12-01T00:00:00Z"},
                "api_budget": {"usage_percentage": 99.0, "initial_budget": 30.0},
                "usage_percentage": 99.0,
            }).encode()
        else:
            body = b'{"object":"list","data":[]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        request = json.loads(raw or b"{}")
        seen_requests.append({"body": request, "headers": dict(self.headers)})
        if request.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            # Reasoning + text deltas, then a coalesced content+finish chunk, which
            # is what Mistral actually sends.
            for chunk in (
                {"choices": [{"index": 0, "delta": {"content": [
                    {"type": "thinking", "thinking": [{"type": "text", "text": "why"}]}]}}]},
                {"choices": [{"index": 0, "delta": {"content": [{"type": "text", "text": "STREAM"}]}}]},
            ):
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(
                'data: {"choices":[{"index":0,"finish_reason":"stop","delta":{"content":[{"type":"text","text":"_OK"}]}}]}\n\n'.encode()
            )
            self.wfile.write(b"data: [DONE]\n\n")
            return
        body = json.dumps({
            "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": [
                {"type": "thinking", "thinking": [{"type": "text", "text": "why"}]},
                {"type": "text", "text": "NONSTREAM_OK"},
            ]}}]
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def load_plugin() -> types.ModuleType:
    providers = types.ModuleType("providers")
    base = types.ModuleType("providers.base")

    class ProviderProfile:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

        def create_client(self, **kwargs):
            return None

        def fetch_account_usage(self, **kwargs):
            return None

    base.ProviderProfile = ProviderProfile
    providers.base = base
    providers.register_provider = lambda profile: None
    sys.modules["providers"] = providers
    sys.modules["providers.base"] = base

    account = types.ModuleType("agent.account_usage")

    class AccountUsageWindow:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class AccountUsageSnapshot:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    account.AccountUsageWindow = AccountUsageWindow
    account.AccountUsageSnapshot = AccountUsageSnapshot
    sys.modules["agent.account_usage"] = account

    spec = importlib.util.spec_from_file_location("mistral_vibe_hermes", PLUGIN)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def post(url: str, payload: dict) -> tuple[int, str]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer mstrl_test", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


def main() -> int:
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    upstream.daemon_threads = True
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    os.environ["MISTRAL_BASE"] = f"http://127.0.0.1:{upstream.server_address[1]}"

    module = load_plugin()

    # -- request shaping --
    body = module.normalize_request({
        "model": "mistral-medium-latest",
        "store": True,
        "service_tier": "auto",
        "safety_identifier": "x",
        "max_completion_tokens": 42,
        "temperature": 0,
        "reasoning_effort": "low",
        "messages": [
            {"role": "developer", "content": "be terse"},
            {"role": "assistant", "content": "hi", "reasoning_content": "thought"},
        ],
    })
    check("call_source is set", body["metadata"]["call_source"] == "vibe_code")
    check("rejected fields dropped", not {"store", "service_tier", "safety_identifier"} & set(body))
    check("max_completion_tokens aliased", body["max_tokens"] == 42 and "max_completion_tokens" not in body)
    check("greedy sampling gets top_p 1", body["top_p"] == 1)
    # mistral-medium-latest accepts only none|high; low must not reach the wire.
    check("effort clamped to the model's set", body["reasoning_effort"] == "none", str(body.get("reasoning_effort")))
    check("developer role becomes system", body["messages"][0]["role"] == "system")
    check("replayed reasoning stripped", "reasoning_content" not in body["messages"][1])

    # -- response shaping --
    shaped = module.normalize_response({"choices": [{"message": {"content": [
        {"type": "thinking", "thinking": [{"type": "text", "text": "why"}]},
        {"type": "text", "text": "answer"},
    ]}}]})["choices"][0]["message"]
    check("typed parts split into text + reasoning", shaped["content"] == "answer" and shaped["reasoning_content"] == "why")

    chunks = module.split_finish_chunk({
        "choices": [{"finish_reason": "tool_calls", "delta": {"tool_calls": [{"index": 0}]}}],
        "usage": {"prompt_tokens": 1},
    })
    check(
        "coalesced finish chunk is split",
        len(chunks) == 2 and chunks[0]["choices"][0]["finish_reason"] is None
        and chunks[1]["choices"][0]["finish_reason"] == "tool_calls",
    )

    # -- the plugin's own server --
    url = module._Server.url()
    check("server binds loopback", url.startswith("http://127.0.0.1:"), url)
    check(
        "models listed",
        json.loads(urllib.request.urlopen(url.replace("/v1", "/healthz"), timeout=5).read())["ok"] is True,
    )

    status, raw = post(f"{url}/chat/completions", {
        "model": "mistral-medium-latest", "max_tokens": 8,
        "messages": [{"role": "user", "content": "hi"}],
    })
    payload = json.loads(raw)
    check("non-stream returns text", status == 200 and payload["choices"][0]["message"]["content"] == "NONSTREAM_OK", raw[:120])
    check(
        "reasoning surfaced on the non-stream message",
        payload["choices"][0]["message"].get("reasoning_content") == "why",
    )
    sent = seen_requests[-1]
    check("upstream got the Vibe user agent", "Mistral-Vibe/" in sent["headers"].get("User-Agent", ""))
    check("upstream got call_source on the wire", sent["body"]["metadata"]["call_source"] == "vibe_code")

    status, raw = post(f"{url}/chat/completions", {
        "model": "zai-glm-5-3-flash", "max_tokens": 8, "stream": True,
        "messages": [{"role": "user", "content": "hi"}],
    })
    text, done, reasoning = "", False, ""
    for line in raw.splitlines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            done = True
            break
        chunk = json.loads(data)
        for choice in chunk.get("choices") or []:
            delta = choice.get("delta") or {}
            text += delta.get("content") or ""
            reasoning += delta.get("reasoning_content") or ""
    check("stream concatenates to the answer", status == 200 and text == "STREAM_OK", repr(text))
    check("stream carries reasoning deltas", reasoning == "why", repr(reasoning))
    check("stream terminates with [DONE]", done)

    # -- picker rows: ids unchanged, human names alongside --
    rows = module.MistralVibeProfile.discover_models(module.MistralVibeProfile.__new__(module.MistralVibeProfile))
    by_id = {row["id"]: row for row in rows or []}
    check("picker lists every model", set(by_id) == set(module.MODELS), str(by_id))
    check(
        "labels match omp's names",
        by_id["zai-glm-5-3-flash"]["label"] == "GLM 5.3 Flash (Vibe)"
        and by_id["mistral-medium-latest"]["label"] == "Mistral Medium (Vibe)",
    )
    check("every row carries a note", all(row.get("note") for row in rows or []))
    profile = module.MistralVibeProfile(
        name="mistral-vibe", fallback_models=module.MODELS, default_max_tokens=8192,
        model_capabilities={}, model_aliases={},
    )
    check("per-model output cap", profile.get_max_tokens("zai-glm-5-3-flash") == 16384, str(profile.get_max_tokens("zai-glm-5-3-flash")))

    # -- usage hook reads the Vibe block, not the API one --
    usage = module.MistralVibeProfile.fetch_account_usage(
        types.SimpleNamespace(name="mistral-vibe"), api_key="mstrl_test"
    )
    check("usage reads vibe_budget", usage is not None and usage.windows[0].used_percent == 12.5, str(usage))
    check("usage labels the allowance", "$300" in (usage.windows[0].detail or ""), str(usage.windows[0].detail))

    upstream.shutdown()
    if failures:
        print(f"\n{len(failures)} failed: {', '.join(failures)}")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
