#!/usr/bin/env bash
# Install the Mistral Vibe provider into omp and/or pi: in-process provider +
# `/login` entry + `/vibe-quota`.
#
#   ./install.sh                 # every agent dir that exists
#   ./install.sh --omp           # only ~/.omp/agent
#   ./install.sh --pi            # only ~/.pi/agent
#   OMP_AGENT_DIR=… ./install.sh
#
# The extension registers the provider at load, so no models.yml block is
# needed — and the installer removes the one older versions appended.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../../install/lib.sh"

want_omp=1; want_pi=1; explicit=0
for a in "$@"; do
  case "$a" in
    --omp) want_pi=0; explicit=1 ;;
    --pi) want_omp=0; explicit=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $a" ;;
  esac
done

omp_dir="${OMP_AGENT_DIR:-$HOME/.omp/agent}"
pi_dir="${PI_AGENT_DIR:-$HOME/.pi/agent}"
installed=0

install_into() {
  local dir="$1" label="$2"
  [ -d "$dir" ] || { [ "$explicit" = 1 ] && die "$label agent dir not found: $dir"; return 1; }
  step "$label: $dir"
  install_file "$here/extensions/mistral-vibe-quota.ts" "$dir/extensions/mistral-vibe-quota.ts"
  ok "$dir/extensions/mistral-vibe-quota.ts"
  # Older installs appended a provider block to models.yml; the extension owns
  # the provider now, so a stale block would register it twice.
  local models="$dir/models.yml"
  if [ -f "$models" ] && grep -q '^  mistral-vibe:' "$models" && [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would remove the stale mistral-vibe block from $models"
  elif [ -f "$models" ] && grep -q '^  mistral-vibe:' "$models"; then
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
  fi
  installed=$((installed + 1))
}

if [ "$want_omp" = 1 ]; then
  [ -d "$omp_dir" ] && install_into "$omp_dir" omp || { [ "$explicit" = 1 ] && die "omp agent dir not found: $omp_dir"; true; }
fi
if [ "$want_pi" = 1 ]; then
  [ -d "$pi_dir" ] && install_into "$pi_dir" pi || { [ "$explicit" = 1 ] && die "pi agent dir not found: $pi_dir"; true; }
fi

[ "$installed" -gt 0 ] || die "no agent dir found (looked for $omp_dir and $pi_dir)"

if [ "$VIBE2API_DRY_RUN" != 1 ] && ! vibe_key >/dev/null 2>&1; then
  warn "no Vibe key found yet — /login (Mistral Vibe) or MISTRAL_VIBE_KEY will supply one"
fi

step "next"
cat <<'EOF'
    restart the agent, then:
      /login          pick "Mistral Vibe" and paste your mstrl_… key
      /model          pick a mistral-vibe/* model
      /vibe-quota     used %, $ left, reset date, cache hit rate
    The provider runs its own loopback server inside the agent (port 8790+):
    nothing else needs to be running.
EOF
