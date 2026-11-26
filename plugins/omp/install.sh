#!/usr/bin/env bash
# Install Mistral Vibe as a real omp/pi plugin package from its public repo —
# not a loose extension file: provider + `/login` entry + `/vibe-usage`.
#
#   ./install.sh                 # every agent whose plugin CLI exists
#   ./install.sh --omp           # only omp  (~/.omp/plugins)
#   ./install.sh --pi            # only pi   (~/.pi/agent, settings.json packages)
#   MISTRAL_VIBE_PI_SOURCE=…     # install something else (a local checkout, a fork)
#   OMP_AGENT_DIR=… PI_AGENT_DIR=…   # for the legacy loose-copy cleanup
#   PI_CODING_AGENT_DIR=…            # pi's own config-dir override
#
# The agent owns loading, updates and removal, so `omp plugin list` / `pi list`
# show the package. Copying the extension into `<agent>/extensions` is gone: a
# plugin plus an extension file registers `/vibe-usage` and the provider twice.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../../install/lib.sh"

# Single source of truth: https://github.com/dumbzombies/mistral-vibe-pi
src="${MISTRAL_VIBE_PI_SOURCE:-https://github.com/dumbzombies/mistral-vibe-pi}"

want_omp=1; want_pi=1; explicit=0
for a in "$@"; do
  case "$a" in
    --omp) want_pi=0; explicit=1 ;;
    --pi) want_omp=0; explicit=1 ;;
    --dry-run) VIBE2API_DRY_RUN=1; export VIBE2API_DRY_RUN ;;
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) die "unknown option: $a" ;;
  esac
done

omp_dir="${OMP_AGENT_DIR:-$HOME/.omp/agent}"
pi_dir="${PI_AGENT_DIR:-$HOME/.pi/agent}"
pi_agent_dir="${PI_CODING_AGENT_DIR:-$pi_dir}"

# pi's CLI is a `#!/usr/bin/env node` script; Termux has no /usr/bin/env, so run
# it through node when executing the file directly is impossible.
pi_cli() {
  local bin
  bin="$(command -v pi || true)"
  [ -n "$bin" ] || return 1
  if [ -x "$bin" ] && head -1 "$bin" 2>/dev/null | grep -qv "env node"; then
    printf '%s' "$bin"; return 0
  fi
  command -v node >/dev/null 2>&1 || return 1
  printf '%s %s' "$(command -v node)" "$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")"
}

# Older installs copied the extension into the agent dir. omp/pi still load
# every *.ts under <agent>/extensions, so a leftover copy would register the
# provider a second time beside this package.
cleanup_loose_copy() {
  local dir="$1" label="$2" f
  for f in "$dir/extensions/mistral-vibe-quota.ts" "$dir/extensions/mistral-vibe-quota.ts.bak-vibe2api"; do
    [ -e "$f" ] || continue
    if [ "$VIBE2API_DRY_RUN" = 1 ]; then
      note "would remove the loose extension copy $f ($label now loads the plugin package)"
      continue
    fi
    rm -f "$f"
    note "removed loose extension copy $f (the plugin package replaces it)"
  done
}

installed=0

if [ "$want_omp" = 1 ]; then
  if have omp; then
    step "omp: plugin install $src"
    do_run omp plugin install "$src"
    if [ "$VIBE2API_DRY_RUN" != 1 ] && ! omp plugin list --json | grep -q '"name": "mistral-vibe-pi"'; then
      die "omp installed the plugin but does not list it; run: omp plugin doctor"
    fi
    [ "$VIBE2API_DRY_RUN" = 1 ] || ok "omp plugin list: mistral-vibe-pi"
    cleanup_loose_copy "$omp_dir" omp
    installed=$((installed + 1))
  elif [ "$explicit" = 1 ]; then
    die "omp not found on PATH"
  else
    note "omp not found: skipping"
  fi
fi

if [ "$want_pi" = 1 ]; then
  if pi_cli >/dev/null; then
    step "pi: package install $src"
    if [ "$VIBE2API_DRY_RUN" = 1 ]; then
      note "would run: $(pi_cli) install $src"
    else
      # shellcheck disable=SC2046
      $(pi_cli) install "$src"
    fi
    if [ "$VIBE2API_DRY_RUN" != 1 ]; then
      # A git or npm source lists as its name; a local directory lists as its
      # resolved path, so match whichever this invocation used.
      case "$src" in
        http*|git:*|github:*|npm:*|file:*) marker=mistral-vibe-pi ;;
        *) marker="$(cd "$src" && pwd)" ;;
      esac
      list=$($(pi_cli) list 2>&1 || true)
      case "$list" in
        *"$marker"*) : ;;
        *) die "pi recorded the package but does not list it; run: $(pi_cli) list" ;;
      esac
    fi
    [ "$VIBE2API_DRY_RUN" = 1 ] || ok "pi list: mistral-vibe-pi"
    cleanup_loose_copy "$pi_dir" pi
    [ "$pi_agent_dir" = "$pi_dir" ] || cleanup_loose_copy "$pi_agent_dir" pi
    installed=$((installed + 1))
  elif [ "$explicit" = 1 ]; then
    die "pi not found on PATH"
  else
    note "pi not found: skipping"
  fi
fi

[ "$installed" -gt 0 ] || die "neither omp nor pi found on PATH"

# A stale provider block in models.yml would register the provider a second
# time next to the plugin.
for models in "$omp_dir/models.yml" "$pi_agent_dir/models.yml"; do
  [ -f "$models" ] || continue
  grep -q '^  mistral-vibe:' "$models" || continue
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would remove the stale mistral-vibe block from $models"
    continue
  fi
  cp "$models" "$models.bak-vibe2api"
  python3 - "$models" <<'PY'
import sys
path = sys.argv[1]
lines = open(path).read().splitlines(keepends=True)
start = next(i for i, l in enumerate(lines) if l.startswith("  mistral-vibe:"))
tail = [l for l in lines[start:] if l.strip()]
# Only truncate when nothing after the block is a new top-level provider entry.
if any(l.startswith("  ") and not l.startswith("    ") and l.rstrip().endswith(":") and l != "  mistral-vibe:\n" for l in tail):
    print("models.yml: mistral-vibe is not the last provider; remove it by hand")
    raise SystemExit(0)
while lines and not lines[-1].strip():
    lines.pop()
open(path, "w").writelines(lines[:start])
print("removed the stale mistral-vibe block from", path, "(backup: models.yml.bak-vibe2api)")
PY
done

if [ "$VIBE2API_DRY_RUN" != 1 ] && ! vibe_key >/dev/null 2>&1; then
  warn "no Vibe key found yet — /login (Mistral Vibe) or MISTRAL_VIBE_KEY will supply one"
fi

step "next"
cat <<'EOF'
    restart the agent, then:
      /login          pick "Mistral Vibe" and paste your mstrl_… key
      /model          pick a mistral-vibe/* model
      /vibe-usage     used %, $ left, reset date, cache hit rate
    The provider runs one daemon per user (port from
    ~/.mistral-vibe/omp-server.json, 8790 by default): nothing else needs to be
    running, and a second agent reuses the same daemon.
    Verify the registration:  omp plugin list   |   pi list
EOF
