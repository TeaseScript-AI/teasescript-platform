# ts-morph offline runtime payload

The matching runtime archive supplies `ts-morph` 28.0.0 and its nine runtime/transitive package tarballs under
`packages/`. The supported environment treats ts-morph as available tooling rather than an optional archive add-on.

Normal workspace preparation first installs the repository lockfile from the bundled npm cache. If ts-morph 28.0.0 is
not present afterward, `bin/install-ts-morph-offline.sh` creates an isolated temporary npm project, resolves only the
bundled tarballs with `--offline`, and copies the ten package directories into the checkout's `node_modules`.

The target `package.json` and root `package-lock.json` remain unchanged. Do not invoke a dependency-local installer;
the canonical entrypoint is `bin/install-ts-morph-offline.sh`.
