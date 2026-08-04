# ChatGPT project-agent release sources

This directory owns the reviewable sources and deterministic release tooling for
the compact ChatGPT project-agent environment defined by issue #210.

## Ownership

GitHub loose files are the only editable sources. The generated tools archive is
committed so a ChatGPT project agent can use the bootstrap before obtaining a
repository checkout. The owner manually synchronizes that controlled derivative
into the ChatGPT project folder. Do not edit the installed or archived copy as a
second source.

Existing generic Python helpers remain canonically owned by `tools/local-agent/`.
`prepare-release.py` intentionally copies the required helpers into the generated
tools archive. ChatGPT-specific shell scripts and project sources live here.

## Files

- `project/README-FIRST.md`: compact project-folder startup document;
- `project/CODEX-MODEL-SELECTION.md`: stable model-routing source copied into the
  tools archive;
- `project/SYSTEM-PROMPT.md`: canonical source for the separate ChatGPT project
  settings field; never included in project-folder files or archives;
- `bootstrap/`: canonical shell and small documentation sources for the installed
  pre-checkout toolset;
- `contract.json`: stable filenames, installation root, platform, and tools/runtime
  compatibility contract;
- `prepare-release.py`: deterministic tools/runtime builder and project-folder
  staging command;
- `setup-chatgpt-project-agent.sh`: standalone safe atomic installer;
- `generated/chatgpt-project-agent-tools-linux-x64.tar.zst`: committed generated
  derivative of the small canonical sources.

The large `chatgpt-project-agent-runtime-linux-x64.tar.zst` remains outside Git.
It changes only when Node, caches, optional tools, or other runtime payloads
change.

## Build and verify

```bash
python3 -B tools/chatgpt-project-agent/prepare-release.py tools
python3 -B tools/chatgpt-project-agent/test-chatgpt-project-agent.py
```

Split the current legacy bootstrap only when the runtime payload must be replaced:

```bash
python3 -B tools/chatgpt-project-agent/prepare-release.py runtime \
  --legacy-bootstrap /path/to/current-bootstrap.tar.zst \
  --output /path/to/chatgpt-project-agent-runtime-linux-x64.tar.zst
```

Runtime compression defaults to zstd level 10. This remains high compression but
completed the current 105 MB split within the execution harness, unlike the
previous ultra-compression attempt. The small tools archive uses deterministic
zstd level 22 because its input is small.

Stage the exact project-folder replacement after both archives are available:

```bash
python3 -B tools/chatgpt-project-agent/prepare-release.py project \
  --runtime-archive /path/to/chatgpt-project-agent-runtime-linux-x64.tar.zst \
  --research-archive /path/to/TeaseScript-AI-Research-Archive.zip \
  --output-directory /tmp/chatgpt-project-agent-project
```

Archive generation uses sorted normalized tar metadata and single-threaded zstd.
Repeated generation from identical inputs and the selected toolchain must be
byte-identical.
