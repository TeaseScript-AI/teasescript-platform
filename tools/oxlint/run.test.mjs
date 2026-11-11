import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { OXLINT_OPTIONS, repositoryRoot } from "./files.mjs";

const runner = fileURLToPath(new URL("./run.mjs", import.meta.url));

test("the lint runner refuses an argument, before linting anything, and names oxlint's command for files", () => {
  for (const argument of ["tools/oxlint/run.mjs", "--fix"]) {
    const result = spawnSync(process.execPath, [runner, argument], {
      cwd: repositoryRoot,
      encoding: "utf8",
      // a refusal that linted first would take minutes
      timeout: 30_000,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "oxlint/run.mjs takes no arguments: it lints the whole repository, its own checks and then oxlint over every file, " +
        "as `npm run lint` does, which takes minutes.\n" +
        `oxlint alone on named files, without the repository's own checks: node node_modules/oxlint/bin/oxlint ${OXLINT_OPTIONS.join(" ")} <files>\n`,
    );
  }
});
