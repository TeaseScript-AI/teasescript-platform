# ChatGPT project-agent maintained files

This directory is the GitHub-canonical source for the small maintainable part of the ChatGPT project-agent
environment. Its relative layout mirrors the installed environment so the same path is used in Git, the tools
`tar.gz`, and `/mnt/data/chatgpt-project-agent`.

```text
MANIFEST.json   small tools/runtime contract and required entrypoints
bin/            maintained workspace entrypoints and offline installers
dependencies/   maintained guidance beside runtime-owned dependency payloads
docs/           task-oriented project-agent guidance
tools/          the single installed Python helper
```

The external `chatgpt-project-agent-tools-linux-x64.tar.gz` is built from this directory by
`tools/local-agent/build-chatgpt-project-agent-release.sh`. Generated archives are not committed. The separately
maintained runtime archive overlays only heavy or rarely changed files at their final paths:
Node 24/26, the npm cache seed, TikToken wheels/tokenizer data, ts-morph package tarballs, and runtime-owned metadata.

`tools/setup-chatgpt-project-agent.sh` is deliberately outside this directory because it is uploaded as a separate
project-folder file. It validates and combines both archives before replacing an installation. A repository-maintained
ChatGPT Project Settings prompt candidate lives separately at `docs/chatgpt-project/SYSTEM-PROMPT.txt`; it does not
represent live Project Settings unless the owner deliberately applies it, and it must not enter this directory or either
archive.

Do not add a frozen full-tree inventory, per-file tools digest list, or exact tools/runtime release lock. The shared
contract is limited to the archive format, platform, installation root, required entrypoints, and runtime contract
version. Exact source-artifact verification remains a separate stricter boundary.
