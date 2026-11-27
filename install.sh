#!/usr/bin/env bash
# vibe2api — one-shot installers.
#
#   ./install.sh                 # auto: install every surface whose runtime exists
#   ./install.sh local           # local proxy + launcher (bun or node)
#   ./install.sh worker          # Cloudflare Worker (wrangler deploy)
#   ./install.sh omp             # omp and/or pi provider plugin
#   ./install.sh opencode        # opencode provider plugin
#   ./install.sh hermes          # hermes provider plugin (its own repo, plugin-only)
#   ./install.sh plugins         # all three agent plugins
#   ./install.sh test            # run the full test suite (builds the Worker)
#
# The first non-flag word is the target; every other argument is forwarded to
# that target's installer, e.g. `./install.sh worker --key mstrl_… --kv`.
# Nothing is installed into the repo; every target lives under $HOME.
# Pass --dry-run to print the commands instead of running them.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
dry=0
target=""
forward=()
for a in "$@"; do
  case "$a" in
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    --dry-run) dry=1 ;;
    *)
      if [ -z "$target" ] && [ "${a#-}" = "$a" ]; then target="$a"; else forward+=("$a"); fi
      ;;
  esac
done
export VIBE2API_DRY_RUN="$dry"
export VIBE2API_ROOT="$here"

# shellcheck source=/dev/null
. "$here/install/lib.sh"

have() { command -v "$1" >/dev/null 2>&1; }

# Installers run as child processes so one failure cannot leave this shell in a
# half-changed state; output streams straight through.
run_local() { bash "$here/install/local.sh" "${forward[@]+"${forward[@]}"}"; }
run_worker() { bash "$here/install/worker.sh" "${forward[@]+"${forward[@]}"}"; }
# Each agent surfaces lives in its own repo, installed by that agent's native
# command. Nothing here copies plugin files, so `git pull` in this repo cannot
# half-update a plugin.
# pi's CLI is a `#!/usr/bin/env node` script, and Termux has no /usr/bin/env, so
# executing it directly fails. Print the command that works, or fail.
pi_cmd() {
  local bin
  bin="$(command -v pi || true)"
  [ -n "$bin" ] || return 1
  if [ -x "$bin" ] && head -1 "$bin" 2>/dev/null | grep -qv "env node"; then
    printf '%s' "$bin"; return 0
  fi
  command -v node >/dev/null 2>&1 || return 1
  printf '%s %s' "$(command -v node)" "$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")"
}

run_omp() {
  local src="${MISTRAL_VIBE_PI_SOURCE:-https://github.com/dumbzombies/mistral-vibe-pi}"
  local want_omp=1 want_pi=1 explicit=0 installed=0
  for a in "${forward[@]+"${forward[@]}"}"; do
    case "$a" in
      --omp) want_pi=0; explicit=1 ;;
      --pi) want_omp=0; explicit=1 ;;
      *) die "unknown option: $a" ;;
    esac
  done
  if [ "$want_omp" = 1 ]; then
    if have omp; then
      step "omp: plugin install $src"
      do_run omp plugin install "$src"
      if [ "$VIBE2API_DRY_RUN" != 1 ]; then
        omp plugin list --json | grep -q '"name": "mistral-vibe-pi"' \
          || die "omp installed the plugin but does not list it; run: omp plugin doctor"
        ok "omp plugin list: mistral-vibe-pi"
      fi
      installed=$((installed + 1))
    elif [ "$explicit" = 1 ]; then
      die "omp not found on PATH"
    else
      note "omp not found: skipping"
    fi
  fi
  if [ "$want_pi" = 1 ]; then
    if pi_cmd >/dev/null; then
      step "pi: package install $src"
      if [ "$VIBE2API_DRY_RUN" = 1 ]; then
        note "would run: $(pi_cmd) install $src"
      else
        # shellcheck disable=SC2046
        $(pi_cmd) install "$src"
      fi
      if [ "$VIBE2API_DRY_RUN" != 1 ]; then
        # A git or npm source lists as its name; a local directory lists as its
        # resolved path, so match whichever this invocation used.
        case "$src" in
          http*|git:*|github:*|npm:*|file:*) marker=mistral-vibe-pi ;;
          *) marker="$(cd "$src" && pwd)" ;;
        esac
        # shellcheck disable=SC2046
        list="$($(pi_cmd) list 2>&1 || true)"
        case "$list" in
          *"$marker"*) : ;;
          *) die "pi installed the package but does not list it; run: $(pi_cmd) list" ;;
        esac
        ok "pi list: mistral-vibe-pi"
      fi
      installed=$((installed + 1))
    elif [ "$explicit" = 1 ]; then
      die "pi not found on PATH"
    else
      note "pi not found: skipping"
    fi
  fi
  [ "$installed" -gt 0 ] || die "neither omp nor pi found on PATH"
  # A loose extension file plus the package registers the provider twice.
  local dir
  for dir in "${OMP_AGENT_DIR:-$HOME/.omp/agent}" "${PI_AGENT_DIR:-$HOME/.pi/agent}"; do
    local f
    for f in "$dir/extensions/mistral-vibe-quota.ts" "$dir/extensions/mistral-vibe-quota.ts.bak-vibe2api"; do
      [ -e "$f" ] || continue
      if [ "$VIBE2API_DRY_RUN" = 1 ]; then
        note "would remove the loose extension copy $f (the plugin package replaces it)"
        continue
      fi
      rm -f "$f"
      note "removed loose extension copy $f (the plugin package replaces it)"
    done
  done
}

# opencode owns its own installer; this delegates so `./install.sh plugins` stays
# one command.
# Hermes' plugin repo holds no installer: `hermes plugins install` scans
# third-party sources, and a script in the repo touching $HOME reads as a
# destructive finding that blocks the install it wraps. The key is written here.
run_hermes() {
  local src="${MISTRAL_VIBE_HERMES_SOURCE:-dumbzombies/mistral-vibe-hermes}"
  local dir="${HERMES_HOME:-$HOME/.hermes}"
  step "hermes: plugins install $src"
  if [ "$VIBE2API_DRY_RUN" != 1 ]; then have hermes || die "hermes not found on PATH"; fi
  do_run hermes plugins install "$src" --yes-deps --enable
  if [ "$VIBE2API_DRY_RUN" != 1 ]; then
    hermes plugins list 2>/dev/null | grep -q mistral-vibe \
      || die "hermes did not list mistral-vibe; run: hermes plugins doctor mistral-vibe"
    ok "hermes plugins list: mistral-vibe"
  fi
  if [ -d "$dir/plugins/model-providers/mistral-vibe" ]; then
    if [ "$VIBE2API_DRY_RUN" = 1 ]; then
      note "would remove the loose copy $dir/plugins/model-providers/mistral-vibe"
    else
      rm -rf "$dir/plugins/model-providers/mistral-vibe"
      note "removed loose copy $dir/plugins/model-providers/mistral-vibe (the plugin package replaces it)"
    fi
  fi
  local key
  key="$(vibe_key || true)"
  if [ -z "$key" ]; then
    warn "no Vibe key found: export MISTRAL_VIBE_KEY or add it to $dir/.env"
  elif [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would write MISTRAL_VIBE_KEY to $dir/.env"
  else
    VIBE_KEY="$key" python3 - "$dir" <<'PY2'
import os, sys
home = os.path.expanduser(sys.argv[1])
os.makedirs(home, exist_ok=True)
path = os.path.join(home, ".env")
lines = [l for l in (open(path).read().splitlines() if os.path.exists(path) else [])
         if not l.startswith("MISTRAL_VIBE_KEY=")]
lines.append(f"MISTRAL_VIBE_KEY={os.environ['VIBE_KEY']}")
open(path, "w").write("\n".join(lines) + "\n")
os.chmod(path, 0o600)
print("wrote MISTRAL_VIBE_KEY to", path)
PY2
  fi
}

run_opencode() {
  local src="${MISTRAL_VIBE_OC_SOURCE:-https://github.com/dumbzombies/mistral-vibe-opencode}"
  local tmp=""
  if [ -d "$src" ]; then
    step "opencode: $src/install.sh"
    do_run bash "$src/install.sh" "${forward[@]+"${forward[@]}"}"
    return
  fi
  have git || die "git not found: clone $src and run its install.sh"
  tmp="$(mktemp -d)"
  step "opencode: fetch $src"
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would run: git clone --depth 1 $src $tmp"
    note "would run: bash $tmp/repo/install.sh"
    rm -rf "$tmp"
    return
  fi
  git clone --depth 1 "$src" "$tmp/repo" >/dev/null 2>&1 || { rm -rf "$tmp"; die "could not fetch $src"; }
  # shellcheck disable=SC2068
  bash "$tmp/repo/install.sh" ${forward[@]+"${forward[@]}"}
  local rc=$?
  rm -rf "$tmp"
  return "$rc"
}

run_test() {
  have bun || die "bun not found: install Bun, then 'npm run test:all'"
  step "building the Worker bundle and running every suite"
  do_cd "$here"
  do_run npm run test:all
}

if [ -z "$target" ]; then
  step "auto-detecting install targets"
  rc=0
  if have bun || have node; then run_local || rc=1; fi
  if have npx; then run_worker --dry-run || rc=1
  else note "npx not found: skipping the Worker build (./install.sh worker later)"
  fi
  run_plugins || rc=1
  [ "$rc" -eq 0 ] && step "done: ./install.sh test to verify end to end"
  exit "$rc"
fi

rc=0
case "$target" in
  local) run_local || rc=$? ;;
  worker|cf|cloudflare) run_worker || rc=$? ;;
  omp|pi) run_omp || rc=$? ;;
  opencode) run_opencode || rc=$? ;;
  hermes) run_hermes || rc=$? ;;
  plugins) run_plugins || rc=$? ;;
  test|verify) run_test || rc=$? ;;
  *) echo "unknown target: $target (try --help)" >&2; rc=1 ;;
esac
exit "$rc"
