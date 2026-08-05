# ChatGPT project-agent quick start

This file is the compact wayfinder stored directly in the ChatGPT project
folder. GitHub remains the source of truth for implementation, accepted
specifications, ADRs, current status, and repository workflow.

## Project files

Keep one current unsuffixed copy of each applicable file:

```text
README-FIRST.md
chatgpt-project-agent-tools-linux-x64.tar.gz
chatgpt-project-agent-runtime-linux-x64.tar.zst
setup-chatgpt-project-agent.sh
TeaseScript-AI-Research-Archive.zip
```

The tools archive contains maintainable documentation, scripts, configuration,
and the source-review helper. The runtime archive contains the large runtime,
cache, dependency, and tokenizer payloads that are intentionally not stored in
Git. The research archive is non-authoritative.

Issue #210 is migrating this layout in stages. Until its follow-up installer and
runtime work is merged and the ChatGPT project folder is manually synchronized,
do not assume every listed distribution file already exists or invent missing
commands.

## Startup route

1. Use the current supported project bootstrap/setup route documented in
   `docs/LOCAL-AGENT-BOOTSTRAP.md` after the tools are available locally.
2. Follow `docs/DEVELOPMENT-WORKFLOW-CONTEXT.md` to obtain one exact source
   artifact through the current canonical connector-local acquisition route.
3. Use local shell/container tools for extraction, Git inspection, editing, and
   tests; use the connector for live GitHub state and permitted GitHub writes.
4. In the verified checkout, read applicable `AGENTS.md`, repository
   `README-FIRST.md`, the assigned issue or pull request, and select the route in
   `docs/agents/README.md` before loading task-specific sources or writing.

Installed task guides are deliberately separate and use descriptive names:

- `docs/PROJECT-INSTRUCTIONS.txt`: stable product and architecture boundaries;
- `docs/DEVELOPMENT-WORKFLOW-CONTEXT.md`: stable connector-local startup and
  capability-routing context;
- `docs/LOCAL-AGENT-BOOTSTRAP.md`: local environment and workspace preparation;
- `docs/CODEX-MODEL-SELECTION.md`: read before selecting Codex or writing a Codex prompt.

Read or re-read the guides relevant to the current task whenever the task,
branch/head, implementation/review phase, or publication route changes.

## Always-applicable working guidance

Use KISS and small verifiable changes. Do not invent product or architecture
decisions when owner input is needed; present the realistic options and their
consequences compactly. Keep answers proportional to the question. Prefer
regular commits and normal Git publication over accumulating one large
connector transfer. Do not claim success until the exact current head and its
required checks are verified.
