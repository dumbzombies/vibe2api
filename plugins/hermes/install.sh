#!/usr/bin/env bash
# Install the Mistral Vibe model-provider plugin into Hermes.
#
#   ./install.sh                         # current host ($HERMES_HOME or ~/.hermes)
#   ./install.sh --remote user@host      # over ssh; writes the key there
#   ./install.sh --container NAME        # docker container; reads its HERMES_HOME
#   ./install.sh --key mstrl_…           # key to write instead of the local pool
#   MISTRAL_VIBE_HERMES_SOURCE=…         # install another source (fork, pin, local dir)
#
# The plugin is a real Hermes plugin package from
# https://github.com/dumbzombies/mistral-vibe-hermes: `hermes plugins install`
# owns cloning, updates and removal, and the plugin runs its own loopback server
# inside the Hermes process. No proxy, no Worker, no daemon.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../../install/lib.sh"

src="${MISTRAL_VIBE_HERMES_SOURCE:-dumbzombies/mistral-vibe-hermes}"

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

# `hermes plugins remove` leaves nothing behind, but an older copy of this repo's
# installer wrote the provider straight into model-providers/. Both locations load,
# so the provider would register twice and the picker would show it twice.
drop_loose_copy() {
  local dir="$1" label="$2"
  [ -e "$dir/model-providers/mistral-vibe" ] || return 0
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would remove the loose copy $dir/model-providers/mistral-vibe ($label uses the plugin package)"
    return 0
  fi
  rm -rf "$dir/model-providers/mistral-vibe"
  note "removed loose copy $dir/model-providers/mistral-vibe (the plugin package replaces it)"
}

if [ -n "$container" ]; then
  step "installing into container $container"
  target_home=""
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would read HERMES_HOME from $container (default /opt/data)"
    target_home="/opt/data"
  else
    target_home="$(docker exec "$container" printenv HERMES_HOME 2>/dev/null || true)"
    [ -n "$target_home" ] || target_home="/opt/data"
  fi
  do_run docker exec "$container" bash -lc "cd '$target_home' && hermes plugins install '$src' --yes-deps --enable"
  drop_loose_copy "$target_home/plugins" "$container"
  if [ -z "$key" ]; then
    warn "no Vibe key found; set MISTRAL_VIBE_KEY in $target_home/.env in $container"
  elif [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would write MISTRAL_VIBE_KEY into $target_home/.env in $container"
  else
    write_env_py | docker exec -i "$container" python3 - "$target_home" "$key"
  fi
  step "verify: docker exec $container hermes plugins doctor mistral-vibe"
  exit 0
fi

if [ -n "$remote" ]; then
  step "installing on $remote"
  do_run ssh "$remote" "hermes plugins install '$src' --yes-deps --enable"
  if [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would remove ~/.hermes/plugins/model-providers/mistral-vibe on $remote if present"
  else
    ssh "$remote" 'rm -rf ~/.hermes/plugins/model-providers/mistral-vibe' 2>/dev/null || true
  fi
  if [ -z "$key" ]; then
    warn "no Vibe key found; set MISTRAL_VIBE_KEY in ~/.hermes/.env on $remote"
  elif [ "$VIBE2API_DRY_RUN" = 1 ]; then
    note "would write MISTRAL_VIBE_KEY into ~/.hermes/.env on $remote"
  else
    # The key travels as one argv element (%q-quoted), never through a heredoc
    # or stdin, so shell quoting cannot mangle it.
    write_env_py | ssh "$remote" "python3 - ~/.hermes $(printf '%q' "$key")"
  fi
  step "verify: ssh $remote 'hermes plugins doctor mistral-vibe'"
  exit 0
fi

step "plugin -> hermes plugins install $src"
have hermes || die "hermes not found on PATH"
do_run hermes plugins install "$src" --yes-deps --enable
if [ "$VIBE2API_DRY_RUN" != 1 ]; then
  list="$(hermes plugins list 2>&1 || true)"
  case "$list" in
    *mistral-vibe*) : ;;
    *) die "hermes installed the plugin but does not list it; run: hermes plugins doctor mistral-vibe" ;;
  esac
  ok "hermes plugins list: mistral-vibe"
fi
drop_loose_copy "$home_dir/plugins" hermes

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
    hermes plugins list                            # mistral-vibe @ 2.0.0
    hermes usage --provider mistral-vibe           # Vibe month gauge
    hermes -m glm-flash "reply OK"                 # alias for zai-glm-5-3-flash
EOF
