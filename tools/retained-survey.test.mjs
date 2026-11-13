import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("./retained-survey.mjs", import.meta.url));

/** A checkout with the type-core test files `a`, `b`, the stop file `c` and `d` a folder down, `files` written in it, the count run there. */
function count(t, files) {
  const root = mkdtempSync(join(tmpdir(), "retained-survey-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, value] of Object.entries({
    "tests/type-core/a.test.ts": "",
    "tests/type-core/b.test.ts": "",
    "tests/type-core-stop/c.test.ts": "",
    "tests/type-core/messages/d.test.ts": "",
    ...files,
  })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof value === "string" ? value : JSON.stringify(value));
  }
  return spawnSync(process.execPath, [TOOL, "gathered"], { cwd: root, encoding: "utf8" });
}

const survey = (file, noted = {}, frozen = {}) => ({ file, switches: 3, noted, frozen });

test("every file surveyed with nothing noted passes, a gathered campaign's other JSON read past", (t) => {
  const run = count(t, {
    "gathered/campaign.json": { jobs: 2 },
    "gathered/1/out/survey/a.test-10.json": survey("a.test.js"),
    "gathered/2/out/survey/b.test-11.json": survey("b.test.js"),
    "gathered/2/out/survey/c.test-13.json": survey("c.test.js"),
    "gathered/2/out/survey/d.test-14.json": survey("d.test.js"),
  });
  assert.equal(run.stdout, "retained survey: 4 files, 0 refusals, 0 frozen writes\n");
  assert.equal(run.status, 0);
});

test("refusals and frozen writes are summed over the processes and listed; a file without a survey is named", (t) => {
  const run = count(t, {
    "gathered/1/a.test-10.json": survey(
      "a.test.js",
      { "a Map": 2 },
      { "read only property @ x": 1 },
    ),
    "gathered/1/a.test-12.json": survey("a.test.js", { "a Map": 1 }),
  });
  assert.equal(
    run.stdout,
    [
      "retained survey: 1 files, 3 refusals, 1 frozen writes",
      "  refused 3x: a Map",
      "  frozen write 1x: read only property @ x",
      "  not surveyed: b.test",
      "  not surveyed: c.test",
      "  not surveyed: d.test",
      "",
    ].join("\n"),
  );
  assert.equal(run.status, 1);
});
