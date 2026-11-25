#!/usr/bin/env bash
# vibe2api — one-shot installers.
#
#   ./install.sh                 # auto: install every surface whose runtime exists
#   ./install.sh local           # local proxy + launcher (bun or node)
#   ./install.sh worker          # Cloudflare Worker (wrangler deploy)
#   ./install.sh omp             # omp and/or pi provider plugin
#   ./install.sh opencode        # opencode provider plugin
#   ./install.sh hermes          # hermes provider plugin
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
run_omp() { bash "$here/plugins/omp/install.sh" "${forward[@]+"${forward[@]}"}"; }
run_opencode() { bash "$here/plugins/opencode/install.sh" "${forward[@]+"${forward[@]}"}"; }
run_hermes() { bash "$here/plugins/hermes/install.sh" "${forward[@]+"${forward[@]}"}"; }

run_plugins() {
  local rc=0 found=0
  if [ -d "${OMP_AGENT_DIR:-$HOME/.omp/agent}" ] || [ -d "${PI_AGENT_DIR:-$HOME/.pi/agent}" ]; then
    run_omp || rc=1; found=1
  fi
  if [ -d "${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}" ]; then
    run_opencode || rc=1; found=1
  fi
  if [ -d "${HERMES_HOME:-$HOME/.hermes}" ]; then
    run_hermes || rc=1; found=1
  fi
  [ "$found" = 1 ] || note "no agent dirs found: skipping plugins"
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
