# ChatGPT project-agent maintained files

This directory is the GitHub-canonical source for the small maintainable part of
the ChatGPT project-agent environment. Its relative layout should mirror the
installed environment wherever practical so a path under this directory maps to
the same path after installation.

Current Git-owned layout:

```text
bin/      maintained shell entrypoints and installers
docs/     task-oriented project-agent guidance
tools/    maintained local helper programs
```

The external tools `tar.gz` is made from this directory; no generated archive is
committed to Git. The large runtime `tar.zst` later supplies the heavy paths that
are intentionally absent here, such as bundled runtimes, caches, package
payloads, TikToken wheels, and tokenizer data.

This PR establishes the reviewable source layout only. Issue #210 remains open
for the simple setup script, final runtime split, archive assembly, and end-to-end
installation verification. Do not add strict per-file SHA inventories, frozen
full-tree manifests, or a relocation framework merely to package this local
tooling.
