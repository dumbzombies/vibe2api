#!/usr/bin/env bash
# Fixture stand-in for the opencode repo's installer: it must prove the vibe2api
# dispatcher delegates to the child repo rather than copying files itself.
set -eu
cfg="${OPENCODE_CONFIG_DIR:?}"
bin="${VIBE2API_BIN:?}"
step() { printf '==> %s\n' "$*"; }
step "fixture opencode installer -> $cfg"
mkdir -p "$cfg/plugins" "$cfg/command" "$bin"
cp "$(dirname "$0")/plugins/mistral-vibe.ts" "$cfg/plugins/mistral-vibe.ts"
cp "$(dirname "$0")/commands/vibe-quota.md" "$cfg/command/vibe-quota.md"
cp "$(dirname "$0")/bin/vibe-quota.sh" "$bin/vibe-quota"
chmod +x "$bin/vibe-quota"
conf="$cfg/opencode.jsonc"
[ -f "$conf" ] || printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$conf"
python3 - "$conf" "$(dirname "$0")/opencode.jsonc.example" <<'PY'
import json, shutil, sys
conf, example = sys.argv[1], sys.argv[2]
data = json.load(open(conf))
block = json.load(open(example))["provider"]["mistral-vibe"]
if data.get("provider", {}).get("mistral-vibe") != block:
    shutil.copy(conf, conf + ".bak-vibe2api")
    data.setdefault("provider", {})["mistral-vibe"] = block
    json.dump(data, open(conf, "w"), indent=2)
    open(conf, "a").write("\n")
print("fixture: provider merged into", conf)
PY
