# Local agent bootstrap

## Purpose and authority

This is the canonical guide for the distributed Linux x86_64 agent bootstrap.
GitHub remains authoritative for repository code, scripts, tests, and workflow.
The bootstrap is trusted local tooling used to verify one downloaded source
artifact, create an exact clean checkout, and install the committed dependency
graph offline.

The shared-project derivative is named `LOCAL-AGENT-BOOTSTRAP.md`. Generate it
from this file through `tools/local-agent/prepare-shared-project.py`; do not
maintain a second editable copy.

## Stable distribution names

The shared project contains exactly one current archive named:

```text
teasescript-agent-bootstrap-linux-x64.tar.zst
```

The archive extracts exactly one directory named:

```text
teasescript-agent-bootstrap-linux-x64/
```

Release identity belongs in the extracted `MANIFEST.json`, not in either stable
name. Remove an older extracted directory before extracting a replacement; do
not overlay bootstrap releases.

## Normal connector-local route

Use a direct shell or container executor for archive, filesystem, Git, Bash,
Node, and npm operations. Do not wrap ordinary shell commands in a notebook or
Python execution tool merely to invoke the shell.

```bash
rm -rf /mnt/data/teasescript-agent-bootstrap-linux-x64
tar --zstd -xf /mnt/data/teasescript-agent-bootstrap-linux-x64.tar.zst \
  -C /mnt/data

/mnt/data/teasescript-agent-bootstrap-linux-x64/bin/prepare-agent-workspace.sh \
  --artifact /mnt/data/source-bundle.zip \
  --artifact-sha256 <github-artifact-sha256> \
  --expected-head <40-character-head-sha> \
  --expected-merge-base <40-character-merge-base-sha> \
  --expected-repository TeaseScript-AI/teasescript-platform \
  --output /mnt/data/source-work
```

`bin/prepare-agent-workspace.sh` is the sole normal bootstrap entry point. Do
not require or invent a separate bootstrap self-test before or after it.

The normal entry point performs the required boundary work in order:

```text
trusted bootstrap and artifact inputs
-> bootstrap critical-file verification
-> source-artifact digest, ZIP, manifest, history, identity, and Git checks
-> exact clean checkout
-> bundled runtime and npm-cache validation
-> npm ci --offline
-> usable workspace release
```

Optional flags:

- `--check`: run the repository's configured checks after setup;
- `--node 26`: select the bundled compatibility runtime instead of authoritative Node 24;
- `--with-ts-morph`: install the bundled optional codemod tool in Git-local state;
- `--with-tiktoken`: install the bundled optional CPython/TikToken toolchain for repository-owned patch-publication preparation.

After setup, run commands through:

```bash
.git/teasescript-agent/run npm run check
```

For an interactive shell, source `.git/teasescript-agent/activate.sh`. With
TikToken enabled, use `.git/teasescript-agent/run-python313` or source
`.git/teasescript-agent/activate-tiktoken.sh`.

## Failure classification

A generic tool-client failure before command output begins is not evidence that
the archive is corrupt. Retry the smallest direct-shell check, then identify the
actual failing layer:

- archive presence or extraction;
- bootstrap critical-file verification;
- source-artifact verification;
- exact checkout preparation;
- offline dependency installation;
- optional repository checks.

Do not bypass an available trusted bootstrap by attempting network Git, reading
the repository file by file through the connector, or executing the candidate
copy of a source-preparation helper from the artifact under review.

## Shared-project release preparation

From a verified repository checkout, stage the exact replacement files with:

```bash
python3 -B tools/local-agent/prepare-shared-project.py \
  --bootstrap-archive /path/to/current-bootstrap.tar.zst \
  --output-directory /tmp/teasescript-shared-project-replacement
```

The command validates the canonical shared routing sources, the archive layout,
`MANIFEST.json`, the normal entry point, executable help, and internal
`SHA256SUMS`. It emits only the stable replacement files and normalizes the
archive's top-level directory to the stable extracted name. It does not upload
or modify the ChatGPT project folder.
