#!/usr/bin/env bash
# Install the Mistral Vibe provider + /vibe-quota into opencode
#  1. plugin file into <config>/plugins/. It starts its own loopback server when
#     opencode loads it, so no proxy or Worker is needed
#  2. provider block merged into <config>/opencode.jsonc
#  3. /vibe-quota command + the quota script on PATH
#
# The files come from https://github.com/dumbzombies/mistral-vibe-opencode, either
# as a local checkout or fetched at install time.
#
#   ./install.sh                      # ~/.config/opencode
#   OPENCODE_CONFIG_DIR=… ./install.sh
#   VIBE2API_BIN=… ./install.sh       # where vibe-quota lands
#   MISTRAL_VIBE_OC_SOURCE=… ./install.sh   # local checkout or fork
#   ./install.sh --dry-run            # print the plan, write nothing
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../../install/lib.sh"

src="${MISTRAL_VIBE_OC_SOURCE:-https://github.com/dumbzombies/mistral-vibe-opencode}"
cfg="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
bin="${VIBE2API_BIN:-${VIBE_QUOTA_BIN:-$HOME/.local/bin}}"

for a in "$@"; do
  case "$a" in
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    --dry-run) VIBE2API_DRY_RUN=1; export VIBE2API_DRY_RUN ;;
    *) die "unknown option: $a" ;;
  esac
done
[ -d "$cfg" ] || die "opencode config dir not found: $cfg"

# A local checkout installs straight from its files. A remote source is fetched
# once into a scratch dir, so the plugin and its quota script always come from
# the same commit instead of two independent downloads.
stage="$src"
cleanup=""
if [ ! -d "$src" ]; then
  stage="$(mktemp -d)"
  cleanup="$stage"
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would fetch $src into $stage"
  else
    git clone --depth 1 "$src" "$stage/repo" >/dev/null 2>&1 || die "could not fetch $src"
    stage="$stage/repo"
  fi
fi

step "plugin -> $cfg/plugins"
install_file "$stage/plugins/mistral-vibe.ts" "$cfg/plugins/mistral-vibe.ts"
ok "$cfg/plugins/mistral-vibe.ts"

step "command -> $cfg/command"
install_file "$stage/commands/vibe-quota.md" "$cfg/command/vibe-quota.md"
install_file "$stage/bin/vibe-quota.sh" "$bin/vibe-quota"
do_run chmod +x "$bin/vibe-quota"
ok "$bin/vibe-quota"

step "provider block -> $cfg/opencode.jsonc"
conf="$cfg/opencode.jsonc"
if [ ! -f "$conf" ]; then
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then note "would create $conf"; else printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$conf"; fi
fi
if [ "$VIBE2API_DRY_RUN" = 1 ]; then
  note "would merge provider.mistral-vibe into $conf"
else
  python3 - "$conf" "$stage/opencode.jsonc.example" <<'PY'
import json, shutil, sys
conf, example = sys.argv[1], sys.argv[2]
with open(conf) as f:
    data = json.load(f)
with open(example) as f:
    block = json.load(f)["provider"]["mistral-vibe"]
existing = data.get("provider", {}).get("mistral-vibe")
# The baseURL is ours by design (the plugin owns 8810); a stale remote endpoint
# from an older install is replaced too.
if existing == block:
    print("provider already present in", conf)
    raise SystemExit
shutil.copy(conf, conf + ".bak-vibe2api")
data.setdefault("provider", {})["mistral-vibe"] = block
with open(conf, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print("merged mistral-vibe provider into", conf, "(backup: opencode.jsonc.bak-vibe2api)")
PY
fi

[ -n "$cleanup" ] && rm -rf "$cleanup"

step "next"
cat <<'EOF'
    restart opencode, pick a mistral-vibe/* model, then run /vibe-quota.
    Key: MISTRAL_VIBE_KEY, or the provider's apiKey in opencode.jsonc.
    The plugin binds 127.0.0.1:8810 on load; nothing else needs to run.
    Port taken? A second opencode process reuses a server that answers
    /health with service "mistral-vibe-opencode"; a foreign listener is
    reported instead. Set MISTRAL_VIBE_OC_PORT (and the provider baseURL).
    Bound port: ~/.mistral-vibe/opencode-server.json (vibe-quota reads it).
EOF
