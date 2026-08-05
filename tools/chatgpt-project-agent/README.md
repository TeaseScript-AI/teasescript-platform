# ChatGPT project-agent tools

This directory is the canonical, reviewable content of the small ChatGPT
project-agent tools bundle. Download this directory and compress the directory
itself as `chatgpt-project-agent-tools-linux-x64.tar.gz`. No generated tools
archive is stored in Git.

The bundle contains the maintained documentation, shell scripts, manifests,
configuration, and the single Python tool needed by the installed environment.
Large runtimes, caches, package payloads, TikToken wheels, and tokenizer data
belong to the separate runtime `tar.zst`.

The standalone `tools/setup-chatgpt-project-agent.sh` is outside this directory.
It validates and combines the tools and runtime archives into
`/mnt/data/chatgpt-project-agent-linux-x64`.

Normal use after installation:

```bash
/mnt/data/chatgpt-project-agent-linux-x64/bin/prepare-agent-workspace.sh \
  --artifact /mnt/data/source-bundle.zip \
  --artifact-sha256 <sha256> \
  --expected-head <head-sha> \
  --expected-merge-base <merge-base-sha> \
  --expected-repository TeaseScript-AI/teasescript-platform \
  --output /mnt/data/source-work
```

TikToken is installed and verified for every prepared workspace. The historical
`--with-tiktoken` option remains accepted only as a compatibility no-op.
