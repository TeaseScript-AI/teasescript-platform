# Local agent bootstrap

## Purpose and authority

This is the canonical guide for the Linux x86_64 ChatGPT project-agent
environment. GitHub remains authoritative for repository code, scripts, tests,
and workflow. The environment is assembled from one small tools archive and one
large runtime archive. It is trusted local tooling used to verify one downloaded
source artifact, create an exact clean checkout, install the committed dependency
graph offline, and install and verify mandatory TikToken.

The combined project-folder `README-FIRST.md` includes this complete file through
`tools/prepare-chatgpt-project-agent.py refresh`; do not maintain a second
editable copy.

## Stable distribution names

The project folder contains exactly one current copy of each distribution file:

```text
chatgpt-project-agent-tools-linux-x64.tar.gz
chatgpt-project-agent-runtime-linux-x64.tar.zst
setup-chatgpt-project-agent.sh
```

The tools archive is made externally from GitHub's
`tools/chatgpt-project-agent/` directory. No generated tools archive is committed
to Git. The runtime archive remains outside Git because it contains the large or
rarely changed Node runtimes, npm cache, TikToken dependencies and tokenizer
data, ts-morph package payloads, and machine-readable runtime metadata.

The standalone setup script is outside both archives. It validates and extracts
them, rejects unsafe or conflicting entries, and atomically assembles exactly
one installed directory:

```text
/mnt/data/chatgpt-project-agent-linux-x64/
```

Internal release identity belongs in archive metadata, not in stable filenames.
Remove an older project-file copy carrying a UI suffix before replacement; do
not overlay or manually merge generated project files.

## Normal connector-local route

Use a direct shell or container executor for archive, filesystem, Git, Bash,
Node, npm, and Python operations. Do not wrap ordinary shell commands in a
notebook or Python execution tool merely to invoke the shell.

```bash
/mnt/data/setup-chatgpt-project-agent.sh

/mnt/data/chatgpt-project-agent-linux-x64/bin/prepare-agent-workspace.sh \
  --artifact /mnt/data/source-bundle.zip \
  --artifact-sha256 <github-artifact-sha256> \
  --expected-head <40-character-head-sha> \
  --expected-merge-base <40-character-merge-base-sha> \
  --expected-repository TeaseScript-AI/teasescript-platform \
  --output /mnt/data/source-work
```

Use `setup-chatgpt-project-agent.sh --verify-only` to validate and assemble both
archives temporarily without replacing an existing valid installation. The
installed layout may differ from both archive source layouts.

`bin/prepare-agent-workspace.sh` is the sole normal workspace entry point. Do
not require or invent a separate bootstrap self-test before or after it.

The normal entry point performs the required boundary work in order:

```text
trusted installed environment and artifact inputs
-> installed tools/runtime checksum and contract verification
-> source-artifact digest, ZIP, manifest, history, identity, and Git checks
-> exact clean checkout
-> bundled runtime and npm-cache validation
-> npm ci --offline
-> mandatory TikToken installation and verification
-> usable workspace release
```

Optional flags:

- `--check`: run the repository's configured checks after setup;
- `--node 26`: select the bundled compatibility runtime instead of authoritative Node 24;
- `--with-ts-morph`: install the bundled optional codemod tool in Git-local state;
- `--with-tiktoken`: accepted only as a compatibility no-op because TikToken is mandatory.

After setup, run commands through:

```bash
.git/teasescript-agent/run npm run check
```

For an interactive shell, source `.git/teasescript-agent/activate.sh`. Use
`.git/teasescript-agent/run-python313` or source
`.git/teasescript-agent/activate-tiktoken.sh` for repository-owned Python tooling
that requires TikToken.

## Failure classification

A generic tool-client failure before command output begins is not evidence that
an archive is corrupt. Retry the smallest direct-shell check, then identify the
actual failing layer:

- project-file or archive presence;
- tools or runtime archive extraction;
- manifest, inventory, checksum, platform, or compatibility validation;
- atomic installation;
- source-artifact verification;
- exact checkout preparation;
- offline dependency installation;
- mandatory TikToken installation and verification;
- optional repository checks.

Do not bypass an available trusted environment by attempting network Git,
reading the repository file by file through the connector, or executing the
candidate copy of a source-preparation helper from the artifact under review.
Do not continue from a rejected archive, partially assembled installation, or
partially prepared source checkout.

## Release preparation

From a verified repository checkout, refresh the exact tools metadata and
combined project README with:

```bash
python3 -B tools/prepare-chatgpt-project-agent.py refresh
python3 -B tools/test-prepare-chatgpt-project-agent.py
```

`refresh` concatenates every configured source file completely and unchanged in
the fixed configured order. It does not create or commit a tools archive.

Create a replacement runtime archive only when the large payload changes:

```bash
python3 -B tools/prepare-chatgpt-project-agent.py runtime \
  --legacy-bootstrap /path/to/current-bootstrap.tar.zst \
  --output /path/to/chatgpt-project-agent-runtime-linux-x64.tar.zst
```

The runtime command validates the legacy archive before extracting only the
large or rarely changed payload and required machine-readable metadata. It does
not upload or modify the ChatGPT project folder.
