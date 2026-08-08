# Local agent bootstrap

## Purpose

This document is the canonical source for the ChatGPT project-agent local-environment route. GitHub is canonical for
maintainable documentation, scripts, configuration, and helpers. Large runtimes, caches, dependency payloads, and
tokenizer data stay outside Git in the runtime archive.

## Project-folder files

Keep one current unsuffixed copy of each applicable file:

```text
README-FIRST.md
chatgpt-project-agent-tools-linux-x64.tar.gz
chatgpt-project-agent-runtime-linux-x64.tar.zst
setup-chatgpt-project-agent.sh
TeaseScript-AI-Research-Archive.zip   # optional, non-authoritative
```

Install or replace the reusable environment with:

```bash
bash setup-chatgpt-project-agent.sh
# Explicit replacement after a successful temporary assembly:
bash setup-chatgpt-project-agent.sh --replace
```

The default target is `/mnt/data/chatgpt-project-agent`. Use `--target DIRECTORY` only when a separate installation is
actually needed. The setup script refuses an existing target unless `--replace` is explicit, validates both archives,
extracts them into one temporary tree, checks the required entrypoints and basic runtime usability, and only then places
the completed directory. A failed assembly leaves an existing installation untouched.

A normal setup takes about 2–3 seconds in the target environment. It prints phase markers and a final `PASS`; it does
not run repository tests or bundled test scripts. The tools archive intentionally contains no test suite. Command
execution is synchronous unless the caller explicitly starts a separate/background action. Exact source-artifact
acquisition may be started concurrently where the agent environment supports that, but setup correctness must not
depend on parallel execution.

## Source and installed layout

`tools/chatgpt-project-agent/` mirrors the installed directory wherever practical. The tools archive contains that
Git-maintained directory under one `chatgpt-project-agent/` root. The runtime archive supplies non-conflicting heavy
files under the same root and final relative paths.

The tools archive contains the maintained `README.md`, manifest, shell entrypoints, dependency guidance, installed
guides, and `tools/prepare-source-review.py`. The runtime archive contains Node 24/26, npm cache seed, TikToken wheels
and tokenizer data, ts-morph tarballs, upstream runtime licenses/documentation, and runtime-owned metadata. It contains
no maintained `bin/`, `docs/`, or `tools/` files.

The installed directory intentionally has no `README-FIRST.md`; the project-folder wayfinder remains beside the
archives, while the repository-root `README-FIRST.md` becomes authoritative after checkout. Git maintains a ChatGPT
Project Settings prompt candidate at `docs/chatgpt-project/SYSTEM-PROMPT.txt`; it is not installed and does not prove
the live Project Settings state. Any synchronization is a separate deliberate owner action.

## Runtime workspace entrypoint

`bin/prepare-agent-workspace.sh` is the sole normal entrypoint. It verifies one exact source artifact, exposes a clean
Git checkout, installs the locked dependency graph offline, prepares Node 24 and Node 26 runners, and installs and
verifies mandatory ts-morph and TikToken tooling.

Example:

```bash
/mnt/data/chatgpt-project-agent/bin/prepare-agent-workspace.sh \
  --artifact /mnt/data/source-bundle.zip \
  --artifact-sha256 <sha256> \
  --expected-head <head-sha> \
  --expected-merge-base <merge-base-sha> \
  --output /mnt/data/source-work
```

Node 24 is the default. `--node 26` selects the compatibility runner. Both command runners are written under the
checkout's `.git/teasescript-agent/` state. Pass the command to execute after the runner; the runner is not itself a
Node executable alias:

```bash
.git/teasescript-agent/run-node24 node --version
.git/teasescript-agent/run-node26 npm test
```

TikToken uses the host CPython 3.13 interpreter, bundled `cp313` wheels, and a Git-local cache prepared from the
bundled `o200k_base` vocabulary; Python itself is not bundled. The normal
`tiktoken.get_encoding("o200k_base")` API therefore remains offline. An incompatible future host fails with the
detected interpreter and the runtime payload that must be refreshed. No network or source-build fallback is
attempted.

`--check` explicitly runs the repository's complete configured checks after preparation. The normal path does not run
that suite. `--debug-verify-bootstrap` adds complete npm-cache verification for troubleshooting and is not a routine
second verification step. Historical `--with-ts-morph` and `--with-tiktoken` flags remain accepted no-ops.

Use direct shell/container execution for archive, filesystem, Git, Bash, Node, npm, and repository-owned Python
helpers. A generic tool-client failure before a command starts is not evidence of archive corruption; identify the
actual failing layer before changing files or bypassing verification.
