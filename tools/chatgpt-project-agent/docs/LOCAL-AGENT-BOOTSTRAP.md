# Local agent bootstrap

## Purpose

This document owns the ChatGPT project-agent local-environment route. GitHub is
canonical for maintainable documentation, scripts, configuration, and helpers.
Large runtimes, caches, dependency payloads, and tokenizer data stay outside Git.

## Source and installed layout

`tools/chatgpt-project-agent/` should mirror the installed directory structure
where practical. Files under its `bin/`, `docs/`, and `tools/` directories should
keep the same relative paths after installation. The external runtime archive
fills only the heavy paths absent from Git.

The tools archive is therefore a transport copy of this directory, not a second
independently designed layout. Avoid a large relocation table or unnecessary
manifest/checksum framework.

## Transition status

Issue #210 is intentionally split. The current structural PR places the
maintainable files under Git with stable descriptive names. A follow-up PR must:

- provide the small standalone setup script;
- extract the tools and runtime archives into one temporary combined tree;
- preserve the shared relative layout and add the heavy runtime-only paths;
- reject unsafe archive paths and missing required entrypoints;
- replace an existing installation safely only after successful assembly;
- verify the resulting workspace route end to end.

Until that follow-up lands and the ChatGPT project folder is manually refreshed,
use the currently distributed bootstrap route. Do not document or execute a
setup command that is not present in the active project files.

## Runtime workspace entrypoint

The maintained intended entrypoint is:

```text
bin/prepare-agent-workspace.sh
```

It prepares an exact clean checkout from one verified source artifact, installs
the committed dependency graph offline, and prepares required local tooling.
Repository scripts and checks remain authoritative after checkout.

Use direct shell/container execution for archive, filesystem, Git, Bash, Node,
npm, and repository-owned Python helpers. A generic tool-client failure before a
command starts is not evidence of archive corruption; identify the actual failing
layer before changing files or bypassing verification.
