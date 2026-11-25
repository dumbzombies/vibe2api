#!/usr/bin/env bash
# Deploy the Cloudflare Worker.
#
#   ./install/worker.sh                       # passthrough mode (callers send their own key)
#   ./install/worker.sh --key mstrl_…         # server mode (the Worker spends that key)
#   ./install/worker.sh --password '…'        # set the dashboard password as a secret
#   ./install/worker.sh --kv                  # create the KV namespace and wire it in
#   ./install/worker.sh --build-only           # build the bundle, no deploy
#
# Modes are chosen by secrets, never by code:
#   wrangler secret put VIBE_KEY      -> server      (callers send mv-… proxy keys)
#   wrangler secret delete VIBE_KEY   -> passthrough (callers send their own key)
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
. "$here/install/lib.sh"

key=""; password=""; do_kv=0; do_deploy=1; name=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key) key="${2:?key}"; shift 2 ;;
    --password) password="${2:?password}"; shift 2 ;;
    --name) name="${2:?name}"; shift 2 ;;
    --kv) do_kv=1; shift ;;
    --dry-run) VIBE2API_DRY_RUN=1; export VIBE2API_DRY_RUN; shift ;;
    --build-only|--dry-run) do_deploy=0; shift ;;
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

have npx || die "npx not found: install Node.js first"
if ! npx --yes wrangler --version >/dev/null 2>&1; then
  die "wrangler is not usable (npx wrangler --version failed)"
fi
step "wrangler $(npx --yes wrangler --version 2>/dev/null | tail -1)"

# workerd is glibc-only, so `wrangler dev` cannot run on Termux/Android. Say it
# here rather than letting the operator discover it as a mystery error later.
if [ -d /system/bin ] && [ -d /data/data/com.termux ]; then
  warn "Android/Termux: 'wrangler dev' will NOT run (workerd needs glibc)."
  warn "Build + deploy, then verify against the live URL instead."
fi

if [ -n "$name" ]; then
  step "naming the Worker $name"
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would set \"name\": \"$name\" in cfwork/wrangler.jsonc"
  else
    python3 - "$here/cfwork/wrangler.jsonc" "$name" <<'PY'
import re, sys
path, name = sys.argv[1], sys.argv[2]
src = open(path).read()
src = re.sub(r'"name"\s*:\s*"[^"]*"', f'"name": "{name}"', src, count=1)
open(path, "w").write(src)
print(f'name -> {name}')
PY
  fi
fi

if [ "$do_kv" = 1 ]; then
  step "creating the KV namespace (persists the password hash and minted keys)"
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would run: wrangler kv namespace create MV_CONFIG"
  else
    do_cd "$(repo cfwork)"
    out="$(npx --yes wrangler kv namespace create MV_CONFIG 2>&1 || true)"
    printf '%s\n' "$out"
    id="$(printf '%s' "$out" | sed -n 's/.*id = "\([0-9a-f]\{32\}\)".*/\1/p' | head -1)"
    [ -n "$id" ] || id="$(printf '%s' "$out" | sed -n 's/.*"id": *"\([0-9a-f]\{32\}\)".*/\1/p' | head -1)"
    [ -n "$id" ] || die "could not read the namespace id from wrangler's output; paste it into cfwork/wrangler.jsonc by hand"
    python3 - "$(repo cfwork/wrangler.jsonc)" "$id" <<'PY'
import re, sys
path, ns_id = sys.argv[1], sys.argv[2]
src = open(path).read()
block = f'"kv_namespaces": [{{ "binding": "KV", "id": "{ns_id}" }}]'
if re.search(r'"kv_namespaces"', src):
    src = re.sub(r'"kv_namespaces"\s*:\s*\[[^\]]*\]', block, src, count=1)
else:
    src = src.replace('"observability"', block + ',\n  "observability"', 1) if '"observability"' in src \
        else src.replace('{', '{\n  ' + block + ',', 1)
open(path, "w").write(src)
print(f'KV namespace {ns_id} wired as binding KV')
PY
    ok "KV wired"
  fi
fi

if [ -n "$password" ]; then
  step "setting DASHBOARD_PASSWORD"
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would run: wrangler secret put DASHBOARD_PASSWORD"
  else
    do_cd "$(repo cfwork)"
    printf '%s' "$password" | npx --yes wrangler secret put DASHBOARD_PASSWORD
    ok "dashboard password set"
  fi
fi

if [ "$do_deploy" = 0 ] || [ "$VIBE2API_DRY_RUN" = 1 ]; then
  step "building only (no deploy)"
  do_cd "$here"
  do_run npm run build:worker
  [ "$VIBE2API_DRY_RUN" = 1 ] || ok "bundle built into .wbuild/"
  [ "$VIBE2API_DRY_RUN" = 1 ] && note "dry run: nothing was built or deployed"
  exit 0
fi

step "deploying"
do_cd "$(repo cfwork)"
do_run npx --yes wrangler deploy

if [ -n "$key" ] && [ "$VIBE2API_DRY_RUN" != 1 ]; then
  step "server mode: storing VIBE_KEY"
  printf '%s' "$key" | npx --yes wrangler secret put VIBE_KEY
  ok "mode: server (callers need an mv-… proxy key)"
elif [ "$VIBE2API_DRY_RUN" != 1 ]; then
  note "no --key given: passthrough mode (callers send their own mstrl_… key)"
  note "later: wrangler secret put VIBE_KEY   -> server mode"
fi

step "verify"
cat <<EOF
    health       curl -s https://<your-worker>.workers.dev/health
    dashboard    open  https://<your-worker>.workers.dev/
    wrangler dev is glibc-only — verify against the deployed URL, not locally.
EOF
