#!/usr/bin/env bash
# Install the Mistral Vibe model-provider plugin into a Hermes home.
#
#   ./install.sh                         # current host ($HERMES_HOME or ~/.hermes)
#   ./install.sh --remote user@host      # copy over ssh and write the key there
#   ./install.sh --key mstrl_…           # use this key instead of the local pool
#   ./install.sh --container NAME        # docker container whose HERMES_HOME it writes
#
# The plugin is self-contained: it runs its own loopback server inside the
# Hermes process and calls api.mistral.ai directly, so there is no proxy, no
# Worker and no extra daemon to deploy. Only a Vibe key is needed.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../../install/lib.sh"

home_dir="${HERMES_HOME:-$HOME/.hermes}"
remote=""; container=""; key=""
while [ $# -gt 0 ]; do
  case "$1" in
    --remote) remote="${2:?host}"; shift 2 ;;
    --container) container="${2:?name}"; shift 2 ;;
    --key) key="${2:?key}"; shift 2 ;;
    --dry-run) VIBE2API_DRY_RUN=1; export VIBE2API_DRY_RUN; shift ;;
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
[ -n "$key" ] || key="$(vibe_key || true)"

# Replace MISTRAL_VIBE_KEY in <home>/.env, keeping every other line, mode 600.
# Local, remote and container paths run this exact program, so they cannot drift.
write_env_py() {
  cat <<'PY'
import os, sys
home, key = os.path.expanduser(sys.argv[1]), sys.argv[2]
os.makedirs(home, exist_ok=True)
path = os.path.join(home, ".env")
lines = [l for l in (open(path).read().splitlines() if os.path.exists(path) else [])
         if not l.startswith("MISTRAL_VIBE_KEY=")]
lines.append(f"MISTRAL_VIBE_KEY={key}")
open(path, "w").write("\n".join(lines) + "\n")
os.chmod(path, 0o600)
print("wrote MISTRAL_VIBE_KEY to", path)
PY
}
write_env() { write_env_py | python3 - "$1" "$2"; }

files=(__init__.py plugin.yaml README.md)

if [ -n "$container" ]; then
  step "installing into container $container"
  # HERMES_HOME inside the image is /opt/data, not the caller's home.
  target_home=""
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would read HERMES_HOME from $container (default /opt/data)"
    target_home="/opt/data"
  else
    target_home="$(docker exec "$container" printenv HERMES_HOME 2>/dev/null || true)"
    [ -n "$target_home" ] || target_home="/opt/data"
  fi
  plugdir="$target_home/plugins/model-providers/mistral-vibe"
  do_run docker exec "$container" mkdir -p "$plugdir"
  for f in "${files[@]}"; do
    if [ "$VIBE2API_DRY_RUN" = 1 ]; then
      note "would copy $f -> $container:$plugdir/$f"
    else
      docker exec -i "$container" sh -c "cat > '$plugdir/$f'" < "$here/model-providers/mistral-vibe/$f"
    fi
  done
  if [ -z "$key" ]; then
    warn "no Vibe key found; set MISTRAL_VIBE_KEY in $target_home/.env in $container"
  elif [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would write MISTRAL_VIBE_KEY into $target_home/.env in $container"
  else
    write_env_py | docker exec -i "$container" python3 - "$target_home" "$key"
  fi
  step "verify: docker exec $container hermes doctor"
  exit 0
fi

if [ -n "$remote" ]; then
  step "installing on $remote"
  do_run ssh "$remote" 'mkdir -p ~/.hermes/plugins/model-providers/mistral-vibe'
  for f in "${files[@]}"; do
    do_run scp -q "$here/model-providers/mistral-vibe/$f" \
      "$remote:~/.hermes/plugins/model-providers/mistral-vibe/$f"
  done
  if [ -z "$key" ]; then
    warn "no Vibe key found; set MISTRAL_VIBE_KEY in ~/.hermes/.env on $remote"
  elif [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would write MISTRAL_VIBE_KEY into ~/.hermes/.env on $remote"
  else
    # The key travels as one argv element (%q-quoted), never through a heredoc
    # or stdin, so shell quoting cannot mangle it.
    write_env_py | ssh "$remote" "python3 - ~/.hermes $(printf '%q' "$key")"
  fi
  step "verify: ssh $remote 'hermes doctor'"
  exit 0
fi

step "plugin -> $home_dir/plugins/model-providers/mistral-vibe"
for f in "${files[@]}"; do
  install_file "$here/model-providers/mistral-vibe/$f" "$home_dir/plugins/model-providers/mistral-vibe/$f"
done
ok "$home_dir/plugins/model-providers/mistral-vibe"

if [ -n "$key" ]; then
  step "credential -> $home_dir/.env"
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would write MISTRAL_VIBE_KEY to $home_dir/.env"
  else
    write_env "$home_dir" "$key"
  fi
else
  warn "no Vibe key found: export MISTRAL_VIBE_KEY or add it to $home_dir/.env"
fi

step "next"
cat <<'EOF'
    hermes doctor                                  # provider appears, /models probe passes
    hermes usage --provider mistral-vibe           # Vibe month gauge
    hermes -z "reply OK" --provider mistral-vibe -m zai-glm-5-3-flash
EOF
