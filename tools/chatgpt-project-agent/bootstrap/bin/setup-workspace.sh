#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: setup-workspace.sh [--node 24|26] [--with-ts-morph] [--with-tiktoken] [--check] REPOSITORY

Prepare an existing TeaseScript checkout using the bundled Node runtime and
npm cache. Runs npm ci fully offline. Full repository checks run only with
--check. --with-ts-morph adds the optional local ts-morph tool when the
repository does not already install ts-morph 28.0.0 itself. --with-tiktoken
installs the optional CPython 3.13 patch-sizing toolchain in Git-local state.
USAGE
}

node_major=24
run_check=0
with_ts_morph=0
with_tiktoken=0
repo=
while (($#)); do
  case "$1" in
    --node)
      (($# >= 2)) || { echo "setup-workspace: FAIL: --node needs 24 or 26" >&2; exit 2; }
      node_major=$2; shift 2 ;;
    --with-ts-morph) with_ts_morph=1; shift ;;
    --with-tiktoken) with_tiktoken=1; shift ;;
    --check) run_check=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "setup-workspace: FAIL: unknown option: $1" >&2; exit 2 ;;
    *)
      [[ -z "$repo" ]] || { echo "setup-workspace: FAIL: only one repository path is allowed" >&2; exit 2; }
      repo=$1; shift ;;
  esac
done

[[ "$node_major" == 24 || "$node_major" == 26 ]] || {
  echo "setup-workspace: FAIL: --node must be 24 or 26" >&2; exit 2;
}
[[ -n "$repo" ]] || { usage >&2; exit 2; }

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bundle_dir=$(cd -- "$script_dir/.." && pwd)
repo=$(cd -- "$repo" && pwd)

[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  echo "setup-workspace: FAIL: this bundle supports Linux x86_64 only" >&2; exit 1;
}
[[ -f "$repo/package.json" && -f "$repo/package-lock.json" ]] || {
  echo "setup-workspace: FAIL: repository lacks package.json or package-lock.json" >&2; exit 1;
}
git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "setup-workspace: FAIL: repository is not a Git worktree" >&2; exit 1;
}
for checksum_file in TOOLS-SHA256SUMS RUNTIME-SHA256SUMS; do
  (
    cd "$bundle_dir"
    sha256sum --check --quiet "$checksum_file"
  ) || {
    echo "setup-workspace: FAIL: bootstrap verification failed: $checksum_file" >&2
    exit 1
  }
done

case "$node_major" in
  24) node_version=24.18.0 ;;
  26) node_version=26.5.0 ;;
esac
node_dir="$bundle_dir/runtime/node-v${node_version}-linux-x64"
cache_seed="$bundle_dir/npm-cache-seed"
[[ -x "$node_dir/bin/node" && -x "$node_dir/bin/npm" ]] || {
  echo "setup-workspace: FAIL: bundled Node runtime is incomplete: $node_dir" >&2; exit 1;
}
[[ -d "$cache_seed/_cacache" && -f "$bundle_dir/CACHE-SEED-ID" ]] || {
  echo "setup-workspace: FAIL: bundled npm cache seed is incomplete" >&2; exit 1;
}
actual=$($node_dir/bin/node --version)
[[ "$actual" == "v${node_version}" ]] || {
  echo "setup-workspace: FAIL: bundled Node version mismatch: $actual" >&2; exit 1;
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
  echo "setup-workspace: INFO: Node 26 compatibility run; npm EBADENGINE warning is expected" >&2
fi
"$runner" npm cache verify >/dev/null
(
  cd "$repo"
  "$runner" npm ci --offline --no-audit --no-fund
)

if ((with_ts_morph)); then
  installed_version=$(
    "$runner" node -e 'const fs=require("fs"); try { const p=JSON.parse(fs.readFileSync("node_modules/ts-morph/package.json","utf8")); process.stdout.write(p.version||""); } catch { process.stdout.write(""); }' \
      2>/dev/null || true
  )
  if [[ "$installed_version" != "28.0.0" ]]; then
    "$runner" bash "$script_dir/install-ts-morph-offline.sh" "$repo"
  fi
fi

if ((with_tiktoken)); then
  "$script_dir/install-tiktoken-offline.sh" "$repo"
fi

if ((run_check)); then
  (
    cd "$repo"
    "$runner" bash -c 'npm run check && git diff --check'
  )
fi

printf 'setup-workspace: PASS repo=%s node=%s check=%s ts_morph=%s tiktoken=%s run=%s activate=%s\n' \
  "$repo" "$actual" "$run_check" "$with_ts_morph" "$with_tiktoken" "$state_dir/run" "$state_dir/activate.sh"
