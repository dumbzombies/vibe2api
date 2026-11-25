#!/usr/bin/env bash
# Install the Mistral Vibe provider + /vibe-quota into opencode.
#   1. plugin file into ~/.config/opencode/plugins/ — it starts its own loopback
#      server when opencode loads it (no proxy or Worker needed)
#   2. provider block merged into the active config (opencode.jsonc)
#   3. /vibe-quota command + the quota script on PATH
#
#   ./install.sh                      # ~/.config/opencode
#   OPENCODE_CONFIG_DIR=… ./install.sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../../install/lib.sh"

cfg="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
bin="${VIBE2API_BIN:-${VIBE_QUOTA_BIN:-$HOME/.local/bin}}"
[ -d "$cfg" ] || die "opencode config dir not found: $cfg"

step "plugin -> $cfg/plugins"
install_file "$here/plugins/mistral-vibe.ts" "$cfg/plugins/mistral-vibe.ts"
ok "$cfg/plugins/mistral-vibe.ts"

step "command -> $cfg/command"
install_file "$here/commands/vibe-quota.md" "$cfg/command/vibe-quota.md"
do_mkdir "$bin"
do_run cp "$here/../shared/vibe-quota.sh" "$bin/vibe-quota"
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
  python3 - "$conf" "$here/opencode.jsonc.example" <<'PY'
import json, shutil, sys
conf, example = sys.argv[1], sys.argv[2]
with open(conf) as f:
    data = json.load(f)
with open(example) as f:
    block = json.load(f)["provider"]["mistral-vibe"]
existing = data.get("provider", {}).get("mistral-vibe")
# The baseURL is ours by design (the plugin owns 8796); a stale remote endpoint
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

step "next"
cat <<'EOF'
    restart opencode, pick a mistral-vibe/* model, then run /vibe-quota.
    Key: MISTRAL_VIBE_KEY, or the provider's apiKey in opencode.jsonc.
    The plugin binds 127.0.0.1:8796 on load; nothing else needs to run.
EOF
