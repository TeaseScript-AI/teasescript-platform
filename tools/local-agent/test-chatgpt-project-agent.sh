#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)
project_root="$repo_root/tools/chatgpt-project-agent"

if [[ -e "$repo_root/docs/agents/REVIEWER.md" ]]; then
  printf 'test-chatgpt-project-agent: FAIL: unexpected docs/agents/REVIEWER.md\n' >&2
  exit 1
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/test-chatgpt-project-agent.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT

python3 - \
  "$project_root/docs/PROJECT-INSTRUCTIONS.txt" \
  "$project_root/bin/setup-workspace.sh" \
  "$project_root/bin/install-tiktoken-offline.sh" \
  "$repo_root/README-FIRST.md" \
  "$repo_root/docs/agents/CONNECTOR-SOURCE-ACQUISITION.md" \
  "$repo_root/docs/DEVELOPMENT-WORKFLOW.md" \
  "$repo_root/docs/agents/README.md" \
  "$project_root/docs/DEVELOPMENT-WORKFLOW-CONTEXT.md" <<'PY'
from pathlib import Path
import sys

instructions = Path(sys.argv[1]).read_text()
setup = Path(sys.argv[2]).read_text()
installer = Path(sys.argv[3]).read_text()
readme_first = Path(sys.argv[4]).read_text()
connector_acquisition = Path(sys.argv[5]).read_text()
development_workflow = Path(sys.argv[6]).read_text()
capability_router = Path(sys.argv[7]).read_text()
installed_context = Path(sys.argv[8]).read_text()

installed_source_review = "/mnt/data/chatgpt-project-agent-linux-x64/tools/prepare-source-review.py"
if "tools/local-agent/prepare-source-review.py" in connector_acquisition:
    raise SystemExit("connector acquisition still references the deleted source-review helper")
if installed_source_review not in connector_acquisition:
    raise SystemExit("connector acquisition does not reference the installed source-review helper")
for name, guide in (
    ("development workflow", development_workflow),
    ("capability router", capability_router),
    ("installed workflow context", installed_context),
):
    if installed_source_review in guide or "tools/local-agent/prepare-source-review.py" in guide:
        raise SystemExit(f"{name} duplicates a connector-local helper path")

required_capability_links = (
    "DIRECT-REPOSITORY.md",
    "CONNECTOR-LOCAL.md",
    "PUBLICATION-CONSTRAINED.md",
)
for route in required_capability_links:
    if route not in capability_router:
        raise SystemExit(f"capability router does not route {route}")

route_names = []
in_route_summary = False
for line in capability_router.splitlines():
    if line == "## Route summary":
        in_route_summary = True
        continue
    if in_route_summary and line.startswith("## "):
        break
    if not in_route_summary or not line.startswith("|"):
        continue
    cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
    if cells and cells[0] not in ("Route", "---"):
        route_names.append(cells[0])
expected_route_names = [
    "Direct repository",
    "Connector-local",
    "Publication-constrained",
]
if route_names != expected_route_names:
    raise SystemExit(f"unexpected capability route table: {route_names!r}")

if "ORCHESTRATOR.md" not in capability_router or "| Orchestrator |" in capability_router:
    raise SystemExit("orchestrator is not routed as separate task guidance")
for task_guide in (
    "docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md",
    "docs/review-and-audit/AUDIT.md",
):
    if task_guide not in readme_first:
        raise SystemExit(f"README-FIRST.md does not route {task_guide}")
if "README-FIRST.md" not in capability_router or "README-FIRST.md" not in installed_context:
    raise SystemExit("capability or installed routing does not return to README-FIRST.md")
if "docs/agents/CONNECTOR-SOURCE-ACQUISITION.md" not in installed_context:
    raise SystemExit("installed context does not route to current connector acquisition")
for moving_detail in ("/artifact source ", "source-bundle-request/", "90-second", "#235"):
    if moving_detail in development_workflow or moving_detail in installed_context:
        raise SystemExit(f"moving acquisition detail escaped its canonical owner: {moving_detail}")

required_route = (
    "1. Read applicable `AGENTS.md` files first.\n"
    "2. Read the repository `README-FIRST.md` and the assigned issue or pull request."
)
if required_route not in instructions:
    raise SystemExit("project instructions do not preserve the accepted startup order")
if (
    "Read `CURRENT-DESIGN.md` for" not in instructions
    or "architecture-affecting or broad cross-component work" not in instructions
):
    raise SystemExit("project instructions do not use the progressive CURRENT-DESIGN route")
for obsolete in ("docs/references/", "source-examples/"):
    if obsolete in instructions:
        raise SystemExit(f"project instructions still reference nonexistent path: {obsolete}")
if 'fs.readFileSync(process.argv[1],"utf8")' not in setup or '"$repo/node_modules/ts-morph/package.json"' not in setup:
    raise SystemExit("ts-morph detection is not anchored to the target repository")
if "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d" not in installer:
    raise SystemExit("installer lacks the official o200k_base vocabulary digest")
if "load_tiktoken_bpe(str(path), expected_hash=expected_hash)" not in installer:
    raise SystemExit("installer does not pass the expected vocabulary hash to TikToken")
PY

bundle="$tmp/chatgpt-project-agent"
mkdir -p \
  "$bundle/bin" \
  "$bundle/dependencies/tiktoken-cp313-linux-x86_64/wheels" \
  "$bundle/dependencies/tiktoken-cp313-linux-x86_64/tokenizer" \
  "$tmp/repository"
cp "$project_root/bin/install-tiktoken-offline.sh" "$bundle/bin/"
printf 'altered vocabulary fixture\n' > \
  "$bundle/dependencies/tiktoken-cp313-linux-x86_64/tokenizer/o200k_base.tiktoken"
cat > "$tmp/python3.13" <<'PYTHON'
#!/usr/bin/env bash
set -euo pipefail
if [[ $# == 1 && $1 == - ]]; then
  cat >/dev/null
  exit 0
fi
exec python3 "$@"
PYTHON
chmod +x "$tmp/python3.13"
git init -q "$tmp/repository"

set +e
PYTHON_BIN="$tmp/python3.13" bash "$bundle/bin/install-tiktoken-offline.sh" \
  "$tmp/repository" >"$tmp/stdout" 2>"$tmp/stderr"
status=$?
set -e
if [[ $status == 0 ]]; then
  printf 'test-chatgpt-project-agent: FAIL: altered o200k_base vocabulary was accepted\n' >&2
  exit 1
fi
grep -F 'o200k_base tokenizer SHA-256 mismatch' "$tmp/stderr" >/dev/null || {
  cat "$tmp/stderr" >&2
  printf 'test-chatgpt-project-agent: FAIL: altered vocabulary did not reach the focused digest check\n' >&2
  exit 1
}

bash -n "$project_root/bin/install-tiktoken-offline.sh"
bash -n "$project_root/bin/setup-workspace.sh"
printf 'test-chatgpt-project-agent: PASS\n'
