import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const LAST = "the repository's own cross-file checks did not run (npm run lint, check-changed)";

test("--files lints named files only and says so on its last line, clean or failing; no file, a missing or an uncovered one cannot run (#2583)", (t) => {
  const lint = (cwd, ...files) =>
    spawnSync(process.execPath, ["tools/oxlint/run.mjs", "--files", ...files], {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
    });
  // (a bare argument is still refused)
  assert.equal(
    spawnSync(process.execPath, [runner, "tools/oxlint/files.mjs"], { encoding: "utf8" }).status,
    2,
  );
  const clean = lint(repositoryRoot, "tools/oxlint/files.mjs");
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.equal(
    clean.stdout.trimEnd().split("\n").at(-1),
    `lint --files: 1 named files, oxlint and the evidence-comment check only; ${LAST}`,
  );
  for (const [files, message] of [
    [[], "names no file"],
    [["tools/oxlint/no-such-file.mjs"], "tools/oxlint/no-such-file.mjs does not exist"],
    [["README-FIRST.md"], "README-FIRST.md is outside what the lint covers"],
  ]) {
    const refused = lint(repositoryRoot, ...files);
    assert.equal(refused.status, 2, message);
    assert.equal(refused.stdout, "", message);
    assert.match(refused.stderr, new RegExp(message.replaceAll(".", "\\."), "u"));
  }
  // a failing file, in a copy of what the runner reads, so no other lint of this tree sees it
  const copy = mkdtempSync(join(tmpdir(), "oxlint-run-files-"));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  for (const file of [".oxlintrc.json", "tsconfig.json", "package.json"])
    cpSync(join(repositoryRoot, file), join(copy, file));
  cpSync(join(repositoryRoot, "tools"), join(copy, "tools"), { recursive: true });
  symlinkSync(join(repositoryRoot, "node_modules"), join(copy, "node_modules"));
  writeFileSync(join(copy, "tools/probe.mjs"), "debugger;\n");
  const failing = lint(copy, "tools/probe.mjs");
  assert.notEqual(failing.status, 0, failing.stdout + failing.stderr);
  assert.notEqual(failing.status, 2, failing.stdout + failing.stderr);
  assert.match(failing.stdout + failing.stderr, /no-debugger/u);
  assert.equal(
    failing.stdout.trimEnd().split("\n").at(-1),
    `lint --files: 1 named files, oxlint and the evidence-comment check only; ${LAST}`,
  );
});
