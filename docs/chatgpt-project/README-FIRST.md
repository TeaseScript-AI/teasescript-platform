# ChatGPT project-agent start

GitHub is authoritative. Follow this route; do not invent alternatives.

## Project files

```text
README-FIRST.md
chatgpt-project-agent-tools-linux-x64.tar.gz
chatgpt-project-agent-runtime-linux-x64.tar.zst
setup-chatgpt-project-agent.sh
TeaseScript-AI-Research-Archive.zip   # optional, non-authoritative
```

## 1. Start setup in the background

Call `container.exec` exactly:

```json
{
  "cmd": [
    "bash",
    "-lc",
    "nohup bash /mnt/data/setup-chatgpt-project-agent.sh > /mnt/data/chatgpt-project-agent-setup.log 2>&1 </dev/null &"
  ]
}
```

Setup normally takes 2–3 seconds and atomically creates `/mnt/data/chatgpt-project-agent`. Start source acquisition
immediately; do not idle while setup runs.

## 2. Select and resolve the exact source

Issue, pull-request, review, and CI state are live GitHub data; they are not inside the project files or source artifact.
Fetch an assigned issue and its owner corrections immediately:

```text
GitHub.fetch_issue
{"repository_full_name":"TeaseScript-AI/teasescript-platform","issue_number":<number>}
GitHub.fetch_issue_comments
{"repo_full_name":"TeaseScript-AI/teasescript-platform","issue_number":<number>}
```

Use the matching selector:

```text
issue without PR/SHA    main
pull-request task       pr:<number>
exact-commit task       sha:<40 lowercase hex>
```

Resolve it with the matching call:

```text
main
GitHub.fetch
{"url":"https://api.github.com/repos/TeaseScript-AI/teasescript-platform/commits/main"}

pr:<number>
GitHub.get_pr_info
{"repository_full_name":"TeaseScript-AI/teasescript-platform","pr_number":<number>}
GitHub.compare_commits
{"repo_full_name":"TeaseScript-AI/teasescript-platform","base":"<base_sha>","head":"<head_sha>"}

sha:<sha>
GitHub.fetch_commit
{"repo_full_name":"TeaseScript-AI/teasescript-platform","commit_sha":"<sha>"}
```

For a PR, retain its head SHA, base SHA, head repository/ref, and returned merge-base SHA. Never substitute another
commit.

## 3. Use the fixed artifact index first

```text
GitHub.get_commit_combined_status
{"repo_full_name":"TeaseScript-AI/teasescript-platform","commit_sha":"<source_sha>"}
```

Accept only a successful `source-bundle/artifact-v1` status bound to that SHA. Its description is
`artifact <id> sha256:<digest>` and its target must be this repository's exact run/artifact URL.

On a valid hit, download immediately:

```text
GitHub.download_workflow_artifact
{
  "repo_full_name":"TeaseScript-AI/teasescript-platform",
  "artifact_id":<id>,
  "file_name":"teasescript-source-<source_sha>.zip"
}
```

Do not comment or wait on a valid hit.

## 4. On a confirmed miss, use mailbox issue #235

Post exactly one command:

```text
GitHub.add_comment_to_issue
{"repo_full_name":"TeaseScript-AI/teasescript-platform","pr_number":235,"comment":"/artifact source <selector>"}
```

Save the returned comment `id` as `request_id`. After 10 seconds, then every 10 seconds, call:

```text
GitHub.fetch_issue_comments
{"repo_full_name":"TeaseScript-AI/teasescript-platform","issue_number":235}
```

Use only the single registry comment from `github-actions[bot]` user ID `41898282`. Find the entry containing exact
`request <request_id>` or `requests ..., <request_id>, ...`. Stop on `ready` or `failed`, or after two minutes.

For `ready`, use the registry's `GitHub.download_workflow_artifact` JSON and preparation command verbatim. Do not infer,
rename, or combine values from another request. The command comment may be deleted after the registry entry is stored;
the numeric `request_id` remains the correlation key.

## 5. Confirm setup and prepare the workspace

After artifact acquisition, call:

```json
{
  "cmd": [
    "bash",
    "-lc",
    "for i in {1..20}; do test -d /mnt/data/chatgpt-project-agent && break; sleep 0.25; done; cat /mnt/data/chatgpt-project-agent-setup.log; test -d /mnt/data/chatgpt-project-agent"
  ]
}
```

For a fixed-index hit, run:

```shell
/mnt/data/chatgpt-project-agent/bin/prepare-agent-workspace.sh \
  --artifact /mnt/data/teasescript-source-<source_sha>.zip \
  --artifact-sha256 <digest> \
  --expected-head <source_sha> \
  [--expected-merge-base <merge_base_sha>] \
  --output /mnt/data/teasescript-workspace
```

Omit `--expected-merge-base` unless the selector is a PR. For a mailbox result, run its exact returned command instead.

## 6. Mandatory reading before substantive work

Read completely and apply in this order:

1. **After setup:** installed `/mnt/data/chatgpt-project-agent/docs/PROJECT-INSTRUCTIONS.txt` and
   `DEVELOPMENT-WORKFLOW-CONTEXT.md`.
2. **After artifact preparation:** checkout `README-FIRST.md`, `CURRENT-DESIGN.md`, `PHASE-STATUS.md`, root
   `AGENTS.md`, and `docs/agents/README.md`.
3. Every nested checkout `AGENTS.md` governing files you may touch, then every task document and accepted ADR required
   by those routers.
4. **From GitHub:** the assigned issue or pull request, its owner corrections, reviews, and current CI state.

These rules apply to the agent; they are not optional background material. Read installed `LOCAL-AGENT-BOOTSTRAP.md`
when setup or preparation fails, and `CODEX-MODEL-SELECTION.md` before selecting Codex or writing a Codex prompt. Work
locally after checkout; reserve the GitHub connector for live state and permitted writes.
