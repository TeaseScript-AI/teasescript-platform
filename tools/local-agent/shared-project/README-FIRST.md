# TeaseScript AI shared project context

Start here when a new connector-local agent has no prior project context. This
shared folder provides stable routing, trusted offline tooling, and separate
research context. It is not the source of truth for current implementation,
accepted syntax, ADRs, or runtime behavior.

## Reading and startup route

1. Read `PROJECT-INSTRUCTIONS.txt` for stable product and architecture boundaries.
2. Read `TEASESCRIPT-AI-DEVELOPMENT-WORKFLOW-CONTEXT.md` for the applicable GitHub and publication route.
3. For substantial Linux x86_64 implementation, review, debugging, or verification, read `LOCAL-AGENT-BOOTSTRAP.md` and use `teasescript-agent-bootstrap-linux-x64.tar.zst` immediately after obtaining one exact source artifact.
4. In the verified local checkout, read the repository's `README-FIRST.md`, applicable `AGENTS.md`, assigned issue or pull request, and only the controlling task documents and ADRs.

When the trusted local bootstrap is present, do not start with network Git,
repeated connector file reads, or the candidate repository copy of the source
preparation helper. The connector is the GitHub control plane; local shell and
the bootstrap are the repository inspection and execution route.

Use `codex-model-reasoning-selection-v13.md` only when selecting a Codex model or
writing a Codex execution prompt. Use `TeaseScript-AI-Research-Archive.zip` only
for explicitly non-authoritative capability or historical research.

## Source of truth

The GitHub repository `TeaseScript-AI/teasescript-platform` owns:

- current implementation and tests;
- exact architecture and implementation status;
- accepted specifications and ADRs;
- current topic documents and unresolved decisions;
- active planning and `WISHES.xml`;
- executable tested examples and repository workflow.

Do not infer current implementation from an older shared-project file, audit,
research archive, or repository snapshot.

## Stable shared files

Keep one current unsuffixed copy of each routing/bootstrap file:

```text
README-FIRST.md
TEASESCRIPT-AI-DEVELOPMENT-WORKFLOW-CONTEXT.md
LOCAL-AGENT-BOOTSTRAP.md
teasescript-agent-bootstrap-linux-x64.tar.zst
```

The archive must extract to
`teasescript-agent-bootstrap-linux-x64/`. Internal release identity belongs in
its `MANIFEST.json`.

Before installing a replacement set, remove the older copies that the project
UI renamed with suffixes such as `(1)` or `(2)`, and remove any archive or
extracted-directory name carrying an internal revision. Do not overlay or
manually merge generated shared files.

GitHub's `tools/local-agent/prepare-shared-project.py` stages this exact set from
canonical repository sources plus the current bootstrap archive. A repository
merge does not prove the project folder was updated; record the manual
replacement separately.

## Local execution tool

Use the direct shell/container facility for extraction, filesystem inspection,
Git, Bash, Node, and npm. Python execution remains appropriate when the task is
the repository-owned Python helper itself.

A generic client/service error before command output starts is not proof of
archive corruption. Retry a minimal direct-shell check and report the actual
failing layer.
