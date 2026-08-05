#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: setup-workspace.sh [--node 24|26] [--with-ts-morph] [--with-tiktoken] [--check] REPOSITORY

Prepare an existing TeaseScript checkout using the installed Node runtime and npm
cache. TikToken is mandatory and is always installed and verified in Git-local
state. --with-tiktoken remains accepted as a compatibility no-op.
USAGE
}

node_major=24
run_check=0
with_ts_morph=0
repo=
while (($#)); do
  case "$1" in
    --node)
      (($# >= 2)) || { printf 'setup-workspace: FAIL: --node needs 24 or 26\n' >&2; exit 2; }
      node_major=$2
      shift 2
      ;;
    --with-ts-morph) with_ts_morph=1; shift ;;
    --with-tiktoken) shift ;;
    --check) run_check=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) printf 'setup-workspace: FAIL: unknown option: %s\n' "$1" >&2; exit 2 ;;
    *)
      [[ -z "$repo" ]] || { printf 'setup-workspace: FAIL: only one repository path is allowed\n' >&2; exit 2; }
      repo=$1
      shift
      ;;
  esac
done

[[ "$node_major" == 24 || "$node_major" == 26 ]] || {
  printf 'setup-workspace: FAIL: --node must be 24 or 26\n' >&2
  exit 2
}
[[ -n "$repo" ]] || { usage >&2; exit 2; }

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bundle_dir=$(cd -- "$script_dir/.." && pwd)
repo=$(cd -- "$repo" && pwd)

[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  printf 'setup-workspace: FAIL: this environment supports Linux x86_64 only\n' >&2
  exit 1
}
[[ -f "$repo/package.json" && -f "$repo/package-lock.json" ]] || {
  printf 'setup-workspace: FAIL: repository lacks package.json or package-lock.json\n' >&2
  exit 1
}
git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  printf 'setup-workspace: FAIL: repository is not a Git worktree\n' >&2
  exit 1
}

case "$node_major" in
  24) node_version=24.18.0 ;;
  26) node_version=26.5.0 ;;
esac
node_dir="$bundle_dir/runtime/node-v${node_version}-linux-x64"
cache_seed="$bundle_dir/npm-cache-seed"
[[ -x "$node_dir/bin/node" && -x "$node_dir/bin/npm" ]] || {
  printf 'setup-workspace: FAIL: installed Node runtime is incomplete: %s\n' "$node_dir" >&2
  exit 1
}
[[ -d "$cache_seed/_cacache" && -f "$bundle_dir/CACHE-SEED-ID" ]] || {
  printf 'setup-workspace: FAIL: installed npm cache seed is incomplete\n' >&2
  exit 1
}
actual=$($node_dir/bin/node --version)
[[ "$actual" == "v${node_version}" ]] || {
  printf 'setup-workspace: FAIL: installed Node version mismatch: %s\n' "$actual" >&2
  exit 1
}

git_dir=$(git -C "$repo" rev-parse --absolute-git-dir)
state_dir="$git_dir/teasescript-agent"
cache_dir="$state_dir/npm-cache"
seed_id=$(cat "$bundle_dir/CACHE-SEED-ID")
mkdir -p "$state_dir"

if [[ ! -f "$cache_dir/.teasescript-seed-id" ]] || [[ "$(cat "$cache_dir/.teasescript-seed-id" 2>/dev/null || true)" != "$seed_id" ]]; then
  temp_cache=$(mktemp -d "$state_dir/.npm-cache.tmp-XXXXXX")
  trap 'rm -rf -- "${temp_cache:-}"' EXIT
  cp -a --reflink=auto "$cache_seed/." "$temp_cache/"
  printf '%s\n' "$seed_id" > "$temp_cache/.teasescript-seed-id"
  rm -rf -- "$cache_dir"
  mv -- "$temp_cache" "$cache_dir"
  temp_cache=
  trap - EXIT
fi

write_runner() {
  local major=$1 version=$2
  local runtime="$bundle_dir/runtime/node-v${version}-linux-x64"
  local runner="$state_dir/run-node${major}"
  cat > "$runner" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail
export PATH=$(printf '%q' "$runtime/bin"):\$PATH
export npm_config_cache=$(printf '%q' "$cache_dir")
export npm_config_audit=false
export npm_config_fund=false
export npm_config_update_notifier=false
exec "\$@"
RUNNER
  chmod +x "$runner"
  cat > "$state_dir/activate-node${major}.sh" <<ACTIVATE
export PATH=$(printf '%q' "$runtime/bin"):\$PATH
export npm_config_cache=$(printf '%q' "$cache_dir")
export npm_config_audit=false
export npm_config_fund=false
export npm_config_update_notifier=false
ACTIVATE
}
write_runner 24 24.18.0
write_runner 26 26.5.0
ln -sfn "run-node${node_major}" "$state_dir/run"
ln -sfn "activate-node${node_major}.sh" "$state_dir/activate.sh"
runner="$state_dir/run-node${node_major}"

if [[ "$node_major" == 26 ]]; then
  printf 'setup-workspace: INFO: Node 26 compatibility run; npm EBADENGINE warning is expected\n' >&2
fi
"$runner" npm cache verify >/dev/null
(
  cd "$repo"
  "$runner" npm ci --offline --no-audit --no-fund
)

if ((with_ts_morph)); then
  installed_version=$(
    "$runner" node -e 'const fs=require("fs"); try { const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(p.version||""); } catch { process.stdout.write(""); }' \
      "$repo/node_modules/ts-morph/package.json" 2>/dev/null || true
  )
  if [[ "$installed_version" != "28.0.0" ]]; then
    "$runner" bash "$script_dir/install-ts-morph-offline.sh" "$repo"
  fi
fi

"$script_dir/install-tiktoken-offline.sh" "$repo"

if ((run_check)); then
  (
    cd "$repo"
    "$runner" bash -c 'npm run check && git diff --check'
  )
fi

printf 'setup-workspace: PASS repo=%s node=%s tiktoken=required check=%d\n' \
  "$repo" "$node_version" "$run_check"
