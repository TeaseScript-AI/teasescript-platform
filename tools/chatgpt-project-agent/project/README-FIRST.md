# TeaseScript ChatGPT project agent

## Purpose and authority

This ChatGPT project folder is a compact startup, source-acquisition, and local
bootstrap layer. GitHub repository `TeaseScript-AI/teasescript-platform` is the
only editable source of truth for implementation, accepted decisions, current
status, workflow, and maintained project-agent sources.

The files installed here are controlled derivatives. Do not edit or merge them
as an independent workflow copy. After an exact checkout exists, repository
instructions override this startup layer.

## Project-folder inventory

The current project folder contains at most these five files:

1. `README-FIRST.md` — this compact startup and routing document;
2. `chatgpt-project-agent-tools-linux-x64.tar.zst` — frequently updated scripts,
   local-agent helpers, manifests, and small documentation;
3. `chatgpt-project-agent-runtime-linux-x64.tar.zst` — infrequently updated Node,
   npm cache, optional tools, and other large Linux x64 payloads;
4. `setup-chatgpt-project-agent.sh` — validates and atomically combines both
   archives into one usable local installation;
5. `TeaseScript-AI-Research-Archive.zip` — optional non-authoritative capability
   and historical research.

The ChatGPT project system prompt is maintained in GitHub but is copied manually
into the separate project settings field. It is not a project-folder file and is
not stored in either archive.

## Start a repository task

1. Identify the assigned issue or pull request and the exact source identity.
2. Use the GitHub connector to obtain one exact source artifact. When the current
   acquisition path is not already known, fetch only the canonical
   `docs/CHATGPT-GITHUB-WORKFLOW.md` from current `main` before requesting the
   artifact; detailed repository reading waits for the verified checkout.
3. Assemble or refresh the local installation when needed:

```bash
chmod +x /mnt/data/setup-chatgpt-project-agent.sh
/mnt/data/setup-chatgpt-project-agent.sh
```

4. Run the installed normal entry point:

```bash
/mnt/data/chatgpt-project-agent-linux-x64/bin/prepare-agent-workspace.sh \
  --artifact /mnt/data/source-bundle.zip \
  --artifact-sha256 <sha256> \
  --expected-head <40-character-head-sha> \
  --expected-merge-base <40-character-merge-base-sha> \
  --expected-repository TeaseScript-AI/teasescript-platform \
  --output /mnt/data/source-work
```

5. In the verified checkout, read applicable `AGENTS.md` files first, then the
   repository `README-FIRST.md`, the assigned issue or pull request, and only the
   controlling task documents, ADRs, code, and tests. Read `CURRENT-DESIGN.md`
   for architecture-affecting or broad cross-component work and
   `PHASE-STATUS.md` for milestone, gate, status, or capability work.

## Execution routes

Use direct shell/container execution for archives, files, Git, Bash, Node, npm,
and repository commands. Inspect and test source locally; reserve connector calls
for live GitHub state and permitted writes. Use normal Git publication when the
environment supports it. Otherwise use only the repository's verified Python
patch-publication route from the exact checkout.

For Codex delegation, read the installed
`docs/CODEX-MODEL-SELECTION.md`. Select the cheapest executor and configuration
likely to produce an accepted result, and split long work into coherent durable
milestones rather than retaining all progress until final completion.

## Long-running commands

Set an explicit extended tool timeout before aggregate verification, complete
repository checks, workspace preparation, or archive generation. Allow at least
120 seconds for `tools/local-agent/check-local-agent.sh` and comparable aggregate
commands. Choose a longer timeout for measured bootstrap or compression work.
Do not first rely on a short default timeout and then repeat identical work.

If an execution harness stops, check whether the underlying process or output is
still active before rerunning. Do not reinterpret a real process failure as a
harmless harness timeout.

## Stable project boundaries

- Backend: PHP 8, Laravel, and PostgreSQL; Laravel is the only public backend.
- Parser/runtime core: TypeScript compiled to JavaScript.
- Regular executable content uses `.tease`; advanced reusable code uses `.ts`.
- `main.tease` is the fixed package entry point.
- Keep one deterministic engine, state model, and checkpoint format.
- Runtime behavior that survives pause/resume uses validated JSON-safe plans and
  explicit state rather than a suspended JavaScript call stack.
- Player and package code run inside a sandboxed cross-origin iframe without
  main-site cookies or unrestricted external network access.
- Mobile starts as a responsive PWA. Do not introduce unnecessary services,
  Kubernetes, Redis, WebRTC, Electron, or native applications.

The research archive may inform capability research but cannot define current
syntax, architecture, implementation status, or accepted workflow.

## Synchronization

GitHub changes do not automatically update this project folder. The owner
manually replaces `README-FIRST.md`, the small tools archive, the setup script
when its contract changes, the runtime archive only when its payload changes,
and the research archive independently. The canonical system-prompt source is
copied separately into project settings.
