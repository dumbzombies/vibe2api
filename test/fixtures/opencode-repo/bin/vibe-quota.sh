#!/usr/bin/env bash
# Mistral Vibe quota, plugin-first. Used by /vibe-quota and by hand.
#
# Three sources, in order:
#   1. `/api/state`  — the plugin's in-process server exposes it on 8810 and it
#                      carries the richest view.
#   2. `/dashboard/billing/*` — the caller-facing billing routes. The standalone
#                      proxy and the Worker keep `/api/state` session-only, so a
#                      script holding just an API key gets 403 there; these two
#                      routes accept the API credential by design.
#   3. Mistral directly, when neither answers.
#
# NOTE: the API's `usage_percentage` is already a percent (0.56 == 0.56%), not a
# fraction — dividing/multiplying by 100 again overstates spend by 100x.
#   vibe-quota          human-readable
#   vibe-quota --json   raw state (proxy) or raw billing (billing/direct)
set -u

STATE_FILE="${MISTRAL_VIBE_STATE_DIR:-$HOME/.mistral-vibe}/opencode-server.json"

# The opencode plugin publishes the port it bound, so an install on a
# non-default MISTRAL_VIBE_OC_PORT is still reachable without VIBE_PROXY.
# The file outlives a crashed or killed session, so the published port is only
# trusted when something actually answers there with our own service name.
oc_port="$(jq -r '.port // empty' "$STATE_FILE" 2>/dev/null || true)"
if [ -n "$oc_port" ]; then
  svc="$(curl -fsS --max-time 2 "http://127.0.0.1:$oc_port/health" 2>/dev/null | jq -r '.service // empty' 2>/dev/null || true)"
  [ "$svc" = "mistral-vibe-opencode" ] || oc_port=""
fi
PROXY="${VIBE_PROXY:-http://127.0.0.1:${oc_port:-8810}}"
KEYS="${VIBE_KEYS:-$HOME/.mistral-vibe/keys.json}"
VER_FILE="$HOME/.cache/mistral-vibe-version"
UA_VER="$(cat "$VER_FILE" 2>/dev/null || echo 3.1.5)"
UA="mistral-client-python/Mistral-Vibe/$UA_VER"
JSON=0
[ "${1:-}" = "--json" ] && JSON=1

key_hint="${MISTRAL_VIBE_KEY:-${VIBE_KEY:-${GATEWAY_KEY:-}}}"
if [ -z "$key_hint" ] && [ -f "$KEYS" ]; then
  key_hint="$(jq -r '.keys[0] // empty' "$KEYS" 2>/dev/null || true)"
fi
auth=()
if [ -n "$key_hint" ] && [ "$key_hint" != "local" ]; then auth=(-H "Authorization: Bearer $key_hint"); fi

state="$(curl -fsS --max-time 4 "${auth[@]}" "$PROXY/api/state" 2>/dev/null || true)"

if [ -n "$state" ]; then
  if [ "$JSON" = 1 ]; then printf '%s\n' "$state"; exit 0; fi
  printf '%s' "$state" | jq -r '
    .budget.vibe_budget as $v
    | "Mistral Vibe quota (\(.budget.vibe_budget.currency // "USD"))",
      "  used      \(($v.usage_percentage * 100 | round) / 100)% of $\(($v.initial_budget | floor))  ≈ $\(($v.initial_budget * $v.usage_percentage / 100 * 100 | round) / 100)",
      "  resets    \(($v.reset_at // "unknown") | split("T")[0])",
      "  keys      \(.keys.list | length) configured, \(.keys.list | map(select(.cooldown_s > 0)) | length) cooling",
      "  requests  \(.requests.total) total, \(.requests.errors) errors",
      "  source    proxy \(.version) (\(.user_agent))"'
  exit 0
fi

# Billing routes: accepted with an API credential on both the standalone proxy
# and the Worker, so quota keeps working when `/api/state` is session-only.
# A limit of 0 means the proxy had no usable budget (no key, or upstream down) —
# reporting that as "0% used" would claim the whole allowance is unspent.
usage="$(curl -fsS --max-time 5 "${auth[@]}" "$PROXY/dashboard/billing/usage" 2>/dev/null || true)"
if [ -n "$usage" ] && [ "$(printf '%s' "$usage" | jq -r '.limit_usd // 0')" = "0" ]; then
  usage=""
fi

if [ -n "$usage" ]; then
  if [ "$JSON" = 1 ]; then printf '%s\n' "$usage"; exit 0; fi
  printf '%s' "$usage" | jq -r '
    (.used_usd // 0) as $used
    | (.limit_usd // 0) as $limit
    | "Mistral Vibe quota (USD) [billing]",
      "  used      \(((.used_percent // 0) * 100 | round) / 100)% of $\($limit | floor)  ≈ $\((($used) * 100 | round) / 100)",
      "  left      ≈ $\(((.remaining_usd // 0) * 100 | round) / 100)",
      "  resets    \((.resets_at // "unknown") | split("T")[0])"'
  exit 0
fi

# Proxy down: ask Mistral directly with the same Vibe user agent.
key="$(jq -r '.keys[0] // empty' "$KEYS" 2>/dev/null || true)"
if [ -z "$key" ] && [ -n "$key_hint" ] && [ "$key_hint" != "local" ]; then key="$key_hint"; fi
if [ -z "$key" ]; then
  echo "Mistral Vibe quota: $PROXY did not answer and no key was found (checked MISTRAL_VIBE_KEY, VIBE_KEY, $KEYS)" >&2
  exit 1
fi
body="$(curl -fsS --max-time 8 -H "Authorization: Bearer $key" -H "User-Agent: $UA" \
  https://api.mistral.ai/v1/billing/budget 2>/dev/null || true)"
if [ -z "$body" ]; then
  echo "Mistral Vibe quota: $PROXY did not answer and Mistral rejected or failed the direct billing call" >&2
  exit 1
fi
if [ "$JSON" = 1 ]; then printf '%s\n' "$body"; exit 0; fi
printf '%s' "$body" | jq -r '
  .vibe_budget // . as $v
  | "Mistral Vibe quota (\($v.currency // "USD")) [direct]",
    "  used      \(($v.usage_percentage * 100 | round) / 100)% of $\(($v.initial_budget | floor)) ≈ $\(($v.initial_budget * $v.usage_percentage / 100 * 100 | round) / 100)",
    "  resets    \((($v.reset_at // "unknown") | split("T")[0]))"'
