#!/usr/bin/env bash
# Install the local vibe2api proxy: a launcher on PATH, an optional key, and a
# live health check. No files are written inside the repo.
#
#   ./install/local.sh                      # launcher only
#   ./install/local.sh --key mstrl_…        # also store the Vibe key (chmod 600)
#   ./install/local.sh --port 8788 --bind 127.0.0.1
#
# The launcher is a thin wrapper: it runs this repo's src/server.js with the
# runtime that exists (bun, then node), so `git pull` upgrades it with nothing
# to reinstall.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
. "$here/install/lib.sh"

key=""; port="${PORT:-8788}"; bind="${BIND:-127.0.0.1}"
while [ $# -gt 0 ]; do
  case "$1" in
    --key) key="${2:?key}"; shift 2 ;;
    --port) port="${2:?port}"; shift 2 ;;
    --bind) bind="${2:?bind}"; shift 2 ;;
    --dry-run) VIBE2API_DRY_RUN=1; export VIBE2API_DRY_RUN; shift ;;
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

runtime=""
if have bun; then runtime="bun"
elif have node; then runtime="node"
else die "neither bun nor node is on PATH: install one of them first"; fi
note "runtime: $runtime ($(command -v "$runtime"))"

bin="${VIBE2API_BIN:-$HOME/.local/bin}"
launcher="$bin/vibe2api"
step "installing launcher $launcher"
if [ "$VIBE2API_DRY_RUN" = 1 ]; then
  note "would write $launcher -> $runtime $here/src/server.js"
else
  mkdir -p "$bin"
  cat > "$launcher" <<EOF
#!/usr/bin/env bash
# vibe2api launcher (generated). Runs the proxy from $here.
# Env: PORT (default $port), BIND (default $bind), VIBE_KEY, DASHBOARD_PASSWORD.
set -eu
export PORT="\${PORT:-$port}"
export BIND="\${BIND:-$bind}"
exec "$(command -v "$runtime")" "$here/src/server.js" "\$@"
EOF
  chmod +x "$launcher"
  ok "$launcher"
fi

if [ -n "$key" ]; then
  step "storing the Vibe key in the local pool"
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then note "would store a key in ~/.mistral-vibe/keys.json"
  else
    write_key_pool "$key"
    ok "key stored"
  fi
fi

# A key is optional at install time: the dashboard asks for one, and
# passthrough mode takes the caller's key instead.
if ! vibe_key >/dev/null 2>&1; then
  warn "no Vibe key found yet — the dashboard will ask on first visit"
fi

# Live proof the install works, not just that files landed.
if [ "$VIBE2API_DRY_RUN" != 1 ]; then
  step "starting the proxy once to verify it answers"
  # Any port-based readiness check lies when something else already holds the
  # port, so treat EADDRINUSE as "try another" rather than a failed install.
  log="$(mktemp)"
  answered=0
  for try in 0 1 2 3 4 5 6 7 8 9; do
    probe_port=$(( 25000 + RANDOM % 20000 ))
    PORT="$probe_port" "$runtime" "$here/src/server.js" >"$log" 2>&1 &
    pid=$!
    status=""
    for _ in $(seq 1 40); do
      status="$(curl -fsS --max-time 1 "http://127.0.0.1:$probe_port/health" 2>/dev/null || true)"
      [ -n "$status" ] && break
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    if [ -n "$status" ]; then answered=1; break; fi
    grep -q EADDRINUSE "$log" || break
    note "port $probe_port was taken; trying another"
  done
  if [ "$answered" = 1 ]; then
    ok "health: $status"
  else
    warn "the proxy did not answer; log follows"
    cat "$log" >&2
    rm -f "$log"
    die "local install did not verify"
  fi
  rm -f "$log"
fi

step "next"
cat <<EOF
    start        vibe2api                     # http://$bind:$port
    dashboard    open http://127.0.0.1:$port/ (pick a password on first visit)
    clients      base_url http://127.0.0.1:$port/v1
    Cloudflare   ./install.sh worker          # same API, no machine needed
EOF
