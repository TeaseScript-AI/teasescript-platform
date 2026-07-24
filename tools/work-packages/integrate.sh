#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_NAME="$(basename "$0")"
RUNNER_VERSION="1.1.0"
PACKAGE_FILE_NAME="PACKAGE.json"
PATCH_FILE_NAME="CHANGE.patch"
CONTEXT_STATE_FORMAT="teasescript-work-package-context"
CONTEXT_STATE_VERSION=1

usage() {
  cat <<USAGE
Work-package integration runner v$RUNNER_VERSION

Usage:
  $SCRIPT_NAME context <work-package-directory>
  $SCRIPT_NAME bootstrap <work-package-directory>
  $SCRIPT_NAME apply <work-package-directory>

Commands:
  context    Report required authority files whose recorded blob is missing or stale.
  bootstrap  Record the current blobs after the listed authority files have been read.
  apply      Validate, test in a detached temporary worktree, commit, and fast-forward.
USAGE
}

fatal() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fatal "Required command not found on PATH: $1"
}

for command_name in git jq awk grep sed tail head base64 mktemp sort uniq cut cp mv rm ln rmdir; do
  require_command "$command_name"
done

[[ $# -eq 2 ]] || { usage >&2; exit 2; }
ACTION="$1"
PACKAGE_DIR_INPUT="$2"
case "$ACTION" in
  context|bootstrap|apply) ;;
  *) usage >&2; exit 2 ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fatal "Run this inside a Git working tree."
REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)"
GIT_COMMON_DIR="$(git -C "$REPO_ROOT" rev-parse --git-common-dir)"
if [[ "$GIT_COMMON_DIR" != /* ]]; then
  GIT_COMMON_DIR="$REPO_ROOT/$GIT_COMMON_DIR"
fi
GIT_COMMON_DIR="$(cd "$GIT_COMMON_DIR" && pwd -P)"
STATE_DIR="$GIT_COMMON_DIR/work-package-state"
LOG_ROOT="$GIT_COMMON_DIR/work-package-logs"
CONTEXT_STATE_FILE="$STATE_DIR/context.json"

[[ -d "$PACKAGE_DIR_INPUT" ]] || fatal "Work-package directory not found: $PACKAGE_DIR_INPUT"
PACKAGE_DIR="$(cd "$PACKAGE_DIR_INPUT" && pwd -P)"
PACKAGE_JSON="$PACKAGE_DIR/$PACKAGE_FILE_NAME"
PATCH_FILE="$PACKAGE_DIR/$PATCH_FILE_NAME"
[[ -f "$PACKAGE_JSON" ]] || fatal "Missing $PACKAGE_FILE_NAME in $PACKAGE_DIR"
jq -e . "$PACKAGE_JSON" >/dev/null || fatal "$PACKAGE_FILE_NAME is not valid JSON."

json_required_string() {
  local expression="$1"
  local value
  value="$(jq -er "$expression | select(type == \"string\" and length > 0)" "$PACKAGE_JSON")" \
    || fatal "Missing or invalid string in manifest: $expression"
  printf '%s' "$value"
}

PACKAGE_FORMAT="$(json_required_string '.format')"
[[ "$PACKAGE_FORMAT" == "teasescript-work-package" ]] || fatal "Unsupported package format: $PACKAGE_FORMAT"
PACKAGE_VERSION="$(jq -er '.version | select(type == "number" and . == 1)' "$PACKAGE_JSON")" \
  || fatal "Unsupported or missing package version."
PACKAGE_ID="$(json_required_string '.id')"
[[ "$PACKAGE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fatal "Invalid package id: $PACKAGE_ID"
PACKAGE_TITLE="$(json_required_string '.title')"
EXPECTED_REPOSITORY="$(json_required_string '.repository')"
TARGET_BRANCH="$(json_required_string '.targetBranch')"
BASE_SHA="$(json_required_string '.baseSha')"
[[ "$BASE_SHA" =~ ^[0-9a-fA-F]{40}$ ]] || fatal "baseSha must be a full 40-character commit SHA."
BASE_POLICY="$(jq -r '.basePolicy // "exact"' "$PACKAGE_JSON")"
[[ "$BASE_POLICY" == "exact" || "$BASE_POLICY" == "compatible-ancestor" ]] \
  || fatal "basePolicy must be exact or compatible-ancestor."
COMMIT_SUBJECT="$(json_required_string '.commit.subject')"
[[ "$COMMIT_SUBJECT" != *$'\n'* && "$COMMIT_SUBJECT" != *$'\r'* ]] \
  || fatal "commit.subject must be one line."

jq -e '.requiredContext | type == "array" and all(.[]; type == "string" and length > 0)' "$PACKAGE_JSON" >/dev/null \
  || fatal "requiredContext must be an array of non-empty strings."
jq -e '.allowedPaths | type == "array" and length > 0 and all(.[]; type == "string" and length > 0)' "$PACKAGE_JSON" >/dev/null \
  || fatal "allowedPaths must be a non-empty array of non-empty strings."
jq -e '.baseBlobs | type == "object"' "$PACKAGE_JSON" >/dev/null \
  || fatal "baseBlobs must be an object."
jq -e '.checks | type == "array" and length > 0 and all(.[]; (.id | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and (.argv | type == "array" and length > 0 and all(.[]; type == "string")))' "$PACKAGE_JSON" >/dev/null \
  || fatal "checks must be a non-empty array of {id, argv[]} objects with safe unique ids."
jq -e '.commit.body // [] | type == "array" and all(.[]; type == "string")' "$PACKAGE_JSON" >/dev/null \
  || fatal "commit.body must be an array of strings when supplied."

if [[ "$(jq -r '.checks[].id' "$PACKAGE_JSON" | sort | uniq -d | head -n 1)" != "" ]]; then
  fatal "checks contains duplicate ids."
fi
while IFS= read -r check_command; do
  case "$check_command" in
    npm|node|php|composer) ;;
    *) fatal "Unsupported check executable '$check_command'. Use a repository npm/composer script or node/php directly." ;;
  esac
done < <(jq -r '.checks[].argv[0]' "$PACKAGE_JSON")

mapfile -t REQUIRED_CONTEXT < <(jq -r '.requiredContext[]' "$PACKAGE_JSON")
mapfile -t ALLOWED_PATHS < <(jq -r '.allowedPaths[]' "$PACKAGE_JSON")

if [[ "$(printf '%s\n' "${REQUIRED_CONTEXT[@]}" | sort | uniq -d | head -n 1)" != "" ]]; then
  fatal "requiredContext contains duplicates."
fi

validate_relative_path() {
  local path="$1"
  [[ -n "$path" ]] || fatal "Empty repository path in manifest."
  [[ "$path" != /* ]] || fatal "Absolute paths are forbidden: $path"
  [[ "$path" != -* ]] || fatal "Paths beginning with '-' are forbidden: $path"
  [[ "$path" != *$'\n'* && "$path" != *$'\r'* ]] || fatal "Newlines are forbidden in paths."
  local component
  IFS='/' read -r -a path_components <<< "$path"
  for component in "${path_components[@]}"; do
    [[ -n "$component" && "$component" != "." && "$component" != ".." ]] \
      || fatal "Unsafe repository path: $path"
  done
}

for path in "${REQUIRED_CONTEXT[@]}" "${ALLOWED_PATHS[@]}"; do
  validate_relative_path "$path"
done

if [[ "$(printf '%s\n' "${ALLOWED_PATHS[@]}" | sort | uniq -d | head -n 1)" != "" ]]; then
  fatal "allowedPaths contains duplicates."
fi

mapfile -t BASE_BLOB_KEYS < <(jq -r '.baseBlobs | keys[]' "$PACKAGE_JSON")
if [[ "$(printf '%s\n' "${ALLOWED_PATHS[@]}" | sort)" != "$(printf '%s\n' "${BASE_BLOB_KEYS[@]}" | sort)" ]]; then
  fatal "baseBlobs keys must exactly match allowedPaths."
fi

normalize_repository_url() {
  local url="$1"
  url="${url%.git}"
  case "$url" in
    git@github.com:*) url="${url#git@github.com:}" ;;
    ssh://git@github.com/*) url="${url#ssh://git@github.com/}" ;;
    https://github.com/*) url="${url#https://github.com/}" ;;
    http://github.com/*) url="${url#http://github.com/}" ;;
  esac
  printf '%s' "$url"
}

ORIGIN_URL="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null)" || fatal "Repository has no origin remote."
ACTUAL_REPOSITORY="$(normalize_repository_url "$ORIGIN_URL")"
[[ "$ACTUAL_REPOSITORY" == "$EXPECTED_REPOSITORY" ]] \
  || fatal "Wrong repository. Expected $EXPECTED_REPOSITORY, found $ACTUAL_REPOSITORY."

CURRENT_BRANCH="$(git -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null)" \
  || fatal "Detached HEAD is not supported for integration."
CURRENT_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"

git check-ref-format --branch "$TARGET_BRANCH" >/dev/null 2>&1 \
  || fatal "targetBranch is not a valid branch name: $TARGET_BRANCH"
[[ "$CURRENT_BRANCH" == "$TARGET_BRANCH" ]] \
  || fatal "Wrong branch. Expected $TARGET_BRANCH, found $CURRENT_BRANCH."
git -C "$REPO_ROOT" cat-file -e "$BASE_SHA^{commit}" 2>/dev/null \
  || fatal "baseSha is not a known commit: $BASE_SHA"
if [[ "$BASE_POLICY" == "exact" ]]; then
  [[ "$CURRENT_HEAD" == "$BASE_SHA" ]] \
    || fatal "Exact base mismatch. Package expects $BASE_SHA, current HEAD is $CURRENT_HEAD."
else
  git -C "$REPO_ROOT" merge-base --is-ancestor "$BASE_SHA" "$CURRENT_HEAD" \
    || fatal "baseSha is not an ancestor of current HEAD."
fi

mkdir -p "$STATE_DIR" "$LOG_ROOT"

current_blob_for_path() {
  local path="$1"
  if git -C "$REPO_ROOT" cat-file -e "HEAD:$path" 2>/dev/null; then
    git -C "$REPO_ROOT" rev-parse "HEAD:$path"
  else
    printf 'null'
  fi
}

context_status_json() {
  local path="$1"
  local current_blob recorded_blob status
  current_blob="$(current_blob_for_path "$path")"
  if [[ "$current_blob" == "null" ]]; then
    jq -cn --arg path "$path" '{path:$path,status:"missing-file",currentBlob:null,recordedBlob:null}'
    return
  fi
  recorded_blob=""
  if [[ -f "$CONTEXT_STATE_FILE" ]] && jq -e '.format == "teasescript-work-package-context" and .version == 1 and (.files | type == "object")' "$CONTEXT_STATE_FILE" >/dev/null 2>&1; then
    recorded_blob="$(jq -r --arg path "$path" '.files[$path].blob // empty' "$CONTEXT_STATE_FILE")"
  fi
  if [[ -z "$recorded_blob" ]]; then
    status="unread"
  elif [[ "$recorded_blob" != "$current_blob" ]]; then
    status="stale"
  else
    status="current"
  fi
  jq -cn --arg path "$path" --arg status "$status" --arg current "$current_blob" --arg recorded "$recorded_blob" \
    '{path:$path,status:$status,currentBlob:$current,recordedBlob:(if $recorded == "" then null else $recorded end)}'
}

collect_context_statuses() {
  local path
  for path in "${REQUIRED_CONTEXT[@]}"; do
    context_status_json "$path"
  done
}

print_context_required() {
  local status_file="$1"
  printf '%s\n' '=== WORK PACKAGE CONTEXT REQUIRED ==='
  printf 'package: %s\n' "$PACKAGE_ID"
  printf 'branch: %s\n' "$CURRENT_BRANCH"
  printf '%s\n' 'read_or_reread:'
  jq -r 'select(.status != "current") | "- \(.path) [\(.status)]"' "$status_file"
  printf '%s\n' 'after_reading_run:'
  printf '  %q bootstrap %q\n' "$0" "$PACKAGE_DIR"
  printf '%s\n' '=== END WORK PACKAGE CONTEXT REQUIRED ==='
}

run_context_command() {
  local status_file
  status_file="$(mktemp "$STATE_DIR/context-status.XXXXXX")"
  collect_context_statuses > "$status_file"
  local missing_count
  missing_count="$(jq -s '[.[] | select(.status != "current")] | length' "$status_file")"
  if [[ "$missing_count" -eq 0 ]]; then
    printf 'CONTEXT CURRENT %s\n' "$PACKAGE_ID"
    rm -f "$status_file"
    return 0
  fi
  print_context_required "$status_file"
  rm -f "$status_file"
  return 3
}

run_bootstrap_command() {
  local state_tmp path blob
  if [[ -f "$CONTEXT_STATE_FILE" ]] && jq -e '.format == "teasescript-work-package-context" and .version == 1 and (.files | type == "object")' "$CONTEXT_STATE_FILE" >/dev/null 2>&1; then
    state_tmp="$(mktemp "$STATE_DIR/context.XXXXXX")"
    cp "$CONTEXT_STATE_FILE" "$state_tmp"
  else
    state_tmp="$(mktemp "$STATE_DIR/context.XXXXXX")"
    jq -n --arg format "$CONTEXT_STATE_FORMAT" --argjson version "$CONTEXT_STATE_VERSION" \
      '{format:$format,version:$version,files:{}}' > "$state_tmp"
  fi

  for path in "${REQUIRED_CONTEXT[@]}"; do
    blob="$(current_blob_for_path "$path")"
    [[ "$blob" != "null" ]] || { rm -f "$state_tmp"; fatal "Required context file is not tracked at HEAD: $path"; }
    local next_tmp
    next_tmp="$(mktemp "$STATE_DIR/context-next.XXXXXX")"
    jq --arg path "$path" --arg blob "$blob" --arg head "$CURRENT_HEAD" \
      '.files[$path] = {blob:$blob, recordedAtHead:$head}' "$state_tmp" > "$next_tmp"
    mv "$next_tmp" "$state_tmp"
  done
  mv "$state_tmp" "$CONTEXT_STATE_FILE"
  printf 'CONTEXT RECORDED %s\n' "$PACKAGE_ID"
  printf 'HEAD %s\n' "$CURRENT_HEAD"
  printf '%s\n' "${REQUIRED_CONTEXT[@]}" | sed 's/^/READ /'
}

if [[ "$ACTION" == "context" ]]; then
  run_context_command
  exit $?
fi

if [[ "$ACTION" == "bootstrap" ]]; then
  run_bootstrap_command
  exit 0
fi

# apply starts here
[[ -f "$PATCH_FILE" ]] || fatal "Missing $PATCH_FILE_NAME in $PACKAGE_DIR"
[[ -s "$PATCH_FILE" ]] || fatal "$PATCH_FILE_NAME is empty."

[[ -z "$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)" ]] \
  || fatal "Working tree is not clean. Keep work-package directories outside the repository."

# Context is checked after branch/base validation, so stale reports refer to the correct branch.
run_context_command || exit $?

for path in "${ALLOWED_PATHS[@]}"; do
  expected_type="$(jq -r --arg path "$path" '.baseBlobs[$path] | type' "$PACKAGE_JSON")"
  actual_blob="$(current_blob_for_path "$path")"
  if [[ "$expected_type" == "null" ]]; then
    [[ "$actual_blob" == "null" ]] \
      || fatal "Expected new path already exists at HEAD: $path"
  elif [[ "$expected_type" == "string" ]]; then
    expected_blob="$(jq -r --arg path "$path" '.baseBlobs[$path]' "$PACKAGE_JSON")"
    [[ "$expected_blob" =~ ^[0-9a-fA-F]{40}$ ]] || fatal "Invalid blob SHA for $path"
    [[ "$actual_blob" == "$expected_blob" ]] \
      || fatal "Preimage mismatch for $path. Expected $expected_blob, found $actual_blob."
  else
    fatal "baseBlobs[$path] must be a blob SHA string or null."
  fi
done

LOG_DIR="$LOG_ROOT/$PACKAGE_ID"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

CANDIDATE_ROOT=""
cleanup_candidate() {
  if [[ -n "$CANDIDATE_ROOT" && -d "$CANDIDATE_ROOT" ]]; then
    git -C "$REPO_ROOT" worktree remove --force "$CANDIDATE_ROOT" >/dev/null 2>&1 || true
  fi
}
trap cleanup_candidate EXIT

render_command() {
  local arg
  printf '%q ' "$@"
}

print_log_excerpt() {
  local log_file="$1"
  [[ -s "$log_file" ]] || { printf '%s\n' '<no output>'; return; }
  local marker_line start_line
  marker_line="$(grep -n -m 1 -E '(^|[^[:alpha:]])(not ok|FAIL|FAILED|AssertionError|Error:|error TS[0-9]+|npm ERR!)' "$log_file" 2>/dev/null | cut -d: -f1 || true)"
  if [[ -n "$marker_line" ]]; then
    start_line=$(( marker_line > 10 ? marker_line - 10 : 1 ))
  else
    local total_lines
    total_lines="$(awk 'END {print NR}' "$log_file")"
    start_line=$(( total_lines > 159 ? total_lines - 159 : 1 ))
  fi
  awk -v start="$start_line" -v max_lines=160 -v max_bytes=16384 '
    NR < start { next }
    lines >= max_lines { exit }
    {
      line = $0 ORS
      if (bytes + length(line) > max_bytes) {
        remaining = max_bytes - bytes
        if (remaining > 0) printf "%s", substr(line, 1, remaining)
        exit
      }
      printf "%s", line
      bytes += length(line)
      lines++
    }
  ' "$log_file"
}

print_final_summary() {
  local log_file="$1"
  [[ -s "$log_file" ]] || { printf '%s\n' '<no output>'; return; }
  tail -n 40 "$log_file" | awk -v max_bytes=8192 '
    {
      line = $0 ORS
      if (bytes + length(line) > max_bytes) {
        remaining = max_bytes - bytes
        if (remaining > 0) printf "%s", substr(line, 1, remaining)
        exit
      }
      printf "%s", line
      bytes += length(line)
    }
  '
}

emit_failure() {
  local step="$1" exit_code="$2" log_file="$3"
  shift 3
  printf '%s\n' '=== WORK PACKAGE FAILURE ==='
  printf 'package: %s\n' "$PACKAGE_ID"
  printf 'title: %s\n' "$PACKAGE_TITLE"
  printf 'step: %s\n' "$step"
  printf 'command: '
  render_command "$@"
  printf '\n'
  printf 'exit_code: %s\n' "$exit_code"
  printf 'branch: %s\n' "$CURRENT_BRANCH"
  printf 'head: %s\n' "$CURRENT_HEAD"
  printf 'base_sha: %s\n' "$BASE_SHA"
  printf '%s\n' 'candidate_git_status:'
  if [[ -n "$CANDIDATE_ROOT" && -d "$CANDIDATE_ROOT" ]]; then
    git -C "$CANDIDATE_ROOT" status --short --untracked-files=no || true
  else
    printf '%s\n' '<candidate not created>'
  fi
  printf '%s\n' 'failure_excerpt:'
  print_log_excerpt "$log_file"
  printf '%s\n' 'final_summary:'
  print_final_summary "$log_file"
  printf 'full_log: %s\n' "$log_file"
  printf '%s\n' '=== END WORK PACKAGE FAILURE ==='
}

run_logged() {
  local step="$1" workdir="$2"
  shift 2
  local log_file="$LOG_DIR/$step.log"
  if (cd "$workdir" && "$@") >"$log_file" 2>&1; then
    printf 'PASS %s\n' "$step"
    return 0
  else
    local exit_code=$?
    emit_failure "$step" "$exit_code" "$log_file" "$@"
    return "$exit_code"
  fi
}

CANDIDATE_PARENT="$GIT_COMMON_DIR/work-package-candidates"
mkdir -p "$CANDIDATE_PARENT"
CANDIDATE_ROOT="$(mktemp -d "$CANDIDATE_PARENT/${PACKAGE_ID}.XXXXXX")"
rmdir "$CANDIDATE_ROOT"

if ! run_logged "worktree-create" "$REPO_ROOT" git worktree add --detach "$CANDIDATE_ROOT" "$CURRENT_HEAD"; then
  exit 1
fi

if ! run_logged "patch-check" "$CANDIDATE_ROOT" git apply --check --index --whitespace=error-all "$PATCH_FILE"; then
  exit 1
fi
if ! run_logged "patch-apply" "$CANDIDATE_ROOT" git apply --index --whitespace=error-all "$PATCH_FILE"; then
  exit 1
fi

# Read the staged diff so newly added files are included in validation.
mapfile -d '' -t CHANGED_PATHS < <(git -C "$CANDIDATE_ROOT" diff --cached --name-only --no-renames -z HEAD --)
for path in "${CHANGED_PATHS[@]}"; do
  found=false
  for allowed in "${ALLOWED_PATHS[@]}"; do
    if [[ "$path" == "$allowed" ]]; then
      found=true
      break
    fi
  done
  [[ "$found" == true ]] || {
    printf 'Unexpected changed path: %s\n' "$path" > "$LOG_DIR/path-allowlist.log"
    emit_failure "path-allowlist" 1 "$LOG_DIR/path-allowlist.log" git diff --cached --name-only --no-renames HEAD
    exit 1
  }
done
[[ "${#CHANGED_PATHS[@]}" -gt 0 ]] || {
  printf '%s\n' 'Patch produced no changed files.' > "$LOG_DIR/path-allowlist.log"
  emit_failure "path-allowlist" 1 "$LOG_DIR/path-allowlist.log" git diff --cached --name-only --no-renames HEAD
  exit 1
}
printf 'PASS path-allowlist\n'

if ! run_logged "diff-check" "$CANDIDATE_ROOT" git diff --cached --check; then
  exit 1
fi

# Reuse the already-installed dependency tree only when package manifests are unchanged.
changes_dependencies=false
reused_node_modules=false
for path in "${CHANGED_PATHS[@]}"; do
  if [[ "$path" == "package.json" || "$path" == "package-lock.json" || "$path" == "npm-shrinkwrap.json" ]]; then
    changes_dependencies=true
    break
  fi
done
if [[ "$changes_dependencies" == false && -d "$REPO_ROOT/node_modules" && ! -e "$CANDIDATE_ROOT/node_modules" ]]; then
  ln -s "$REPO_ROOT/node_modules" "$CANDIDATE_ROOT/node_modules"
  reused_node_modules=true
fi

check_count="$(jq '.checks | length' "$PACKAGE_JSON")"
for ((index = 0; index < check_count; index++)); do
  check_id="$(jq -er ".checks[$index].id | select(test(\"^[A-Za-z0-9][A-Za-z0-9._-]*$\"))" "$PACKAGE_JSON")" \
    || fatal "Invalid check id at index $index"
  mapfile -t argv_b64 < <(jq -r ".checks[$index].argv[] | @base64" "$PACKAGE_JSON")
  argv=()
  for encoded_arg in "${argv_b64[@]}"; do
    argv+=("$(printf '%s' "$encoded_arg" | base64 --decode)")
  done
  if ! run_logged "$check_id" "$CANDIDATE_ROOT" "${argv[@]}"; then
    exit 1
  fi
done

# Remove the optional dependency symlink before checking repository hygiene.
if [[ "$reused_node_modules" == true && -L "$CANDIDATE_ROOT/node_modules" ]]; then
  rm "$CANDIDATE_ROOT/node_modules"
fi

# Tests may not modify tracked files or create non-ignored files that are absent
# from the staged package patch.
if ! git -C "$CANDIDATE_ROOT" diff --quiet --; then
  git -C "$CANDIDATE_ROOT" diff -- > "$LOG_DIR/post-check-hygiene.log" 2>&1 || true
  emit_failure "post-check-hygiene" 1 "$LOG_DIR/post-check-hygiene.log" git diff --
  exit 1
fi
mapfile -d '' -t UNTRACKED_PATHS < <(git -C "$CANDIDATE_ROOT" ls-files --others --exclude-standard -z --)
if [[ "${#UNTRACKED_PATHS[@]}" -gt 0 ]]; then
  printf '%s\n' "${UNTRACKED_PATHS[@]}" > "$LOG_DIR/post-check-hygiene.log"
  emit_failure "post-check-hygiene" 1 "$LOG_DIR/post-check-hygiene.log" git ls-files --others --exclude-standard
  exit 1
fi
printf 'PASS post-check-hygiene\n'

# Re-read the staged paths after tests and ensure they still match the allowlist.
mapfile -d '' -t STAGED_PATHS < <(git -C "$CANDIDATE_ROOT" diff --cached --name-only --no-renames -z HEAD --)
[[ "${#STAGED_PATHS[@]}" -gt 0 ]] || {
  printf '%s\n' 'Nothing is staged for commit.' > "$LOG_DIR/stage.log"
  emit_failure "stage" 1 "$LOG_DIR/stage.log" git diff --cached --name-only HEAD
  exit 1
}
for path in "${STAGED_PATHS[@]}"; do
  found=false
  for allowed in "${ALLOWED_PATHS[@]}"; do
    if [[ "$path" == "$allowed" ]]; then
      found=true
      break
    fi
  done
  [[ "$found" == true ]] || {
    printf 'Unexpected staged path after checks: %s\n' "$path" > "$LOG_DIR/stage.log"
    emit_failure "stage" 1 "$LOG_DIR/stage.log" git diff --cached --name-only HEAD
    exit 1
  }
done
printf 'PASS stage\n'

COMMIT_MESSAGE_FILE="$LOG_DIR/commit-message.txt"
printf '%s\n' "$COMMIT_SUBJECT" > "$COMMIT_MESSAGE_FILE"
mapfile -t COMMIT_BODY < <(jq -r '.commit.body // [] | .[]' "$PACKAGE_JSON")
if [[ "${#COMMIT_BODY[@]}" -gt 0 ]]; then
  printf '\n' >> "$COMMIT_MESSAGE_FILE"
  for body_line in "${COMMIT_BODY[@]}"; do
    printf -- '- %s\n' "$body_line" >> "$COMMIT_MESSAGE_FILE"
  done
fi

if ! run_logged "commit" "$CANDIDATE_ROOT" git commit -F "$COMMIT_MESSAGE_FILE"; then
  exit 1
fi
CANDIDATE_COMMIT="$(git -C "$CANDIDATE_ROOT" rev-parse HEAD)"
if [[ -n "$(git -C "$CANDIDATE_ROOT" status --porcelain=v1 --untracked-files=all)" ]]; then
  git -C "$CANDIDATE_ROOT" status --short --untracked-files=all > "$LOG_DIR/post-commit-hygiene.log" 2>&1 || true
  emit_failure "post-commit-hygiene" 1 "$LOG_DIR/post-commit-hygiene.log" git status --short --untracked-files=all
  exit 1
fi
printf 'PASS post-commit-hygiene\n'

# Recheck the live branch immediately before moving it.
LIVE_BRANCH="$(git -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
LIVE_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
[[ "$LIVE_BRANCH" == "$TARGET_BRANCH" ]] || fatal "Live branch changed during integration."
[[ "$LIVE_HEAD" == "$CURRENT_HEAD" ]] || fatal "Live HEAD changed during integration. Rerun the package from the new state."
[[ -z "$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)" ]] \
  || fatal "Live working tree changed during integration."

if ! run_logged "fast-forward" "$REPO_ROOT" git merge --ff-only "$CANDIDATE_COMMIT"; then
  exit 1
fi

printf 'COMMIT %s\n' "$CANDIDATE_COMMIT"
printf 'PACKAGE COMPLETE %s\n' "$PACKAGE_ID"
