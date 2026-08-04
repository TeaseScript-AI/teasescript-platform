# ChatGPT project agent tools

This directory is installed from the generated ChatGPT project-agent tools
archive and combined with the separately distributed Linux x64 runtime payload.
GitHub loose sources are canonical. The installed copy is a controlled
pre-checkout derivative and must not be edited as a second source.

## Normal use

After the top-level setup script has assembled the installation, prepare one
exact repository checkout with:

```bash
./bin/prepare-agent-workspace.sh \
  --artifact /mnt/data/source-bundle.zip \
  --artifact-sha256 <sha256> \
  --expected-head <head-sha> \
  --expected-merge-base <merge-base-sha> \
  --expected-repository TeaseScript-AI/teasescript-platform \
  --output /mnt/data/source-work
```

The command verifies the source artifact, creates the exact clean checkout, and
runs `npm ci --offline`. Optional flags select Node 26 compatibility, install the
bundled ts-morph or TikToken toolchain, or run the repository checks.

`tools/prepare-source-review.py`, its focused tests, and the compact unittest
helper are copied from their canonical `tools/local-agent/` sources when the
archive is generated. Repository-owned patch-publication scripts are used from
the verified checkout rather than copied into this pre-checkout bundle.
