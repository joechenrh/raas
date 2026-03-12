#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: sync_repo_review_skills.sh --target <path>

Copies the repository-local AGENTS.md into the target checkout and installs a
repo-local forwarder script that points back to this helper.
USAGE
}

error() {
  echo "Error: $*" >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "${script_dir}/.." && pwd -P)"
source_agents="${repo_root}/AGENTS.md"

target=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ $# -ge 2 ]] || error "missing value for --target"
      target="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      error "unknown argument: $1"
      ;;
  esac
done

[[ -n "$target" ]] || error "--target is required"
[[ -d "$target" ]] || error "target does not exist: $target"
[[ -f "$source_agents" ]] || error "AGENTS.md not found: $source_agents"

target="$(cd "$target" && pwd -P)"
mkdir -p "${target}/scripts"
cp "$source_agents" "${target}/AGENTS.md"

cat > "${target}/scripts/sync_repo_review_skills.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail

exec bash "${repo_root}/scripts/sync_repo_review_skills.sh" "\$@"
EOF

chmod +x "${target}/scripts/sync_repo_review_skills.sh"
