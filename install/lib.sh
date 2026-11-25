#!/usr/bin/env bash
# Shared helpers for the vibe2api installers. Sourced, never executed.
#
# VIBE2API_DRY_RUN=1 makes do_run print the command instead of running it, so
# every installer can be exercised on a machine where the side effects are not
# wanted.
set -eu

: "${VIBE2API_DRY_RUN:=0}"
: "${VIBE2API_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_dim=$'\033[2m'; c_ok=$'\033[32m'; c_warn=$'\033[33m'
else
  c_reset=''; c_bold=''; c_dim=''; c_ok=''; c_warn=''
fi

step() { printf '%s==>%s %s\n' "$c_bold" "$c_reset" "$*"; }
note() { printf '    %s%s%s\n' "$c_dim" "$*" "$c_reset"; }
ok()   { printf '%s ok %s %s\n' "$c_ok" "$c_reset" "$*"; }
warn() { printf '%s!!%s %s\n' "$c_warn" "$c_reset" "$*" >&2; }
die()  { printf '%s!!%s %s\n' "$c_warn" "$c_reset" "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# Repo paths: always absolute so installers work from any cwd.
repo() { printf "%s/%s" "$VIBE2API_ROOT" "${1:-}"; }

do_cd() {
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then note "cd $1"; else cd "$1"; fi
}

do_run() {
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then
    printf '    %swould run:%s %s\n' "$c_dim" "$c_reset" "$*"
    return 0
  fi
  "$@"
}

# Copy a file, creating its directory. Used by every plugin installer so they
# share one behaviour (backup-on-overwrite included).
install_file() {
  local src="$1" dest="$2"
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would install $dest"
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ] && ! cmp -s "$src" "$dest"; then
    cp "$dest" "$dest.bak-vibe2api"
    note "backed up existing $(basename "$dest") -> $(basename "$dest").bak-vibe2api"
  fi
  cp "$src" "$dest"
}

# mkdir that respects the dry run, so a rehearsal never creates a directory.
do_mkdir() {
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then note "would create $*"; else mkdir -p "$@"; fi
}

# First Vibe key we can find: env, then the local pool file.
vibe_key() {
  if [ -n "${MISTRAL_VIBE_KEY:-}" ] && [ "${MISTRAL_VIBE_KEY}" != "local" ]; then
    printf '%s' "$MISTRAL_VIBE_KEY"; return 0
  fi
  local f="${MISTRAL_VIBE_KEYS_FILE:-$HOME/.mistral-vibe/keys.json}"
  if [ -f "$f" ]; then
    local k
    k="$(python3 -c 'import json,sys;print((json.load(open(sys.argv[1])).get("keys") or [""])[0])' "$f" 2>/dev/null || true)"
    [ -n "$k" ] && { printf '%s' "$k"; return 0; }
  fi
  return 1
}

# Write a Vibe key into the shared pool file, mode 600, keeping other keys.
write_key_pool() {
  local key="$1"
  python3 - "$key" <<'PY'
import json, os, sys
key = sys.argv[1].strip()
path = os.path.expanduser(os.environ.get("MISTRAL_VIBE_KEYS_FILE") or "~/.mistral-vibe/keys.json")
os.makedirs(os.path.dirname(path), exist_ok=True)
try:
    data = json.load(open(path))
except Exception:
    data = {}
keys = [k for k in (data.get("keys") or []) if k]
if key not in keys:
    keys.append(key)
data["keys"] = keys
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.chmod(path, 0o600)
print(f"key pool: {len(keys)} key(s) in {path}")
PY
}
