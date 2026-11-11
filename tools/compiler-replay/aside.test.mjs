import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { declarations, setAside } from "./aside.mjs";
import { tool } from "./test-fixtures.mjs";

test("aside: a declared pattern sets aside its own text only, and a declaration without a reason is refused", () => {
  const declared = declarations(
    JSON.stringify([{ pattern: " \\d+ checks? runs? while it plays instead\\.", reason: "#2081" }]),
  );
  const [base, head] = [
    "Too large. 60 checks run while it plays instead. Most",
    "Too large. 1 check runs while it plays instead. Most",
  ];
  assert.equal(setAside(base, declared), setAside(head, declared));
  assert.notEqual(setAside(`${base} x`, declared), setAside(`${head} y`, declared));
  for (const text of ["[]", '[{"pattern": "a"}]', '[{"pattern": "a", "reason": " "}]', "{}"])
    assert.throws(() => declarations(text), /declaration/u, text);
  const file = join(mkdtempSync(join(tmpdir(), "compiler-replay-declare-")), "declare.json");
  try {
    writeFileSync(file, '[{"pattern": "a"}]');
    const run = spawnSync(
      process.execPath,
      [tool, "aside", "p", "b", "h", "--owner", "o", "--declare", file],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 2);
    assert.match(run.stderr, /each declaration has a `pattern` and a `reason`/u);
  } finally {
    rmSync(dirname(file), { recursive: true, force: true });
  }
});

test("aside's job compares each row's plan byte for byte and its route with the declared text set aside, on two built trees", () => {
  // (two stand-in built trees: the base's route says "60 checks", the head's "1 check"; the row `plan` differs in its plan)
  const trees = mkdtempSync(join(tmpdir(), "compiler-replay-trees-"));
  const tree = (name, count) => {
    const helpers = join(trees, name, "dist", "tests", "helpers");
    mkdirSync(helpers, { recursive: true });
    writeFileSync(
      join(helpers, "type-core-oracles.js"),
      `export const inMode = (mode, run) => run();\nexport const jsonText = (value) => JSON.stringify(value);\n` +
        `export const publishedRoute = (files) => ({ plan: { typeCheck: files[0].source === "plan" ? "${name}" : "t" }, ` +
        `text: "Too large. ${count} while it plays instead. Most" });\n`,
    );
    writeFileSync(
      join(helpers, "plan-checks.js"),
      "export const planChecks = (plan) => Object.keys(plan).length;\n",
    );
    return join(trees, name);
  };
  const [base, head] = [tree("base", "60 checks run"), tree("head", "1 check runs")];
  const rows = join(trees, "rows.jsonl");
  writeFileSync(
    rows,
    [
      { source: "text", mode: "rev-on", files: [{ path: "main.tease", source: "text" }] },
      { source: "plan", mode: "rev-off", files: [{ path: "main.tease", source: "plan" }] },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const declare = join(trees, "declare.json");
  writeFileSync(
    declare,
    JSON.stringify([{ pattern: " \\d+ checks? runs? while it plays instead\\.", reason: "#2081" }]),
  );
  const out = join(trees, "aside.jsonl");
  try {
    const run = spawnSync(process.execPath, [tool, "aside-run", base, head, rows, declare, out], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const written = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      written.map(({ source, planEqual, textEqual, asideEqual, checks }) => ({
        source,
        planEqual,
        textEqual,
        asideEqual,
        checks,
      })),
      [
        { source: "text", planEqual: true, textEqual: false, asideEqual: true, checks: [1, 1] },
        { source: "plan", planEqual: false, textEqual: false, asideEqual: true, checks: [1, 1] },
      ],
    );
  } finally {
    rmSync(trees, { recursive: true, force: true });
  }
});

test("a declaration file the tool cannot read or parse is a usage error, exit 2", () => {
  const folder = mkdtempSync(join(tmpdir(), "compiler-replay-declare-"));
  writeFileSync(join(folder, "bad.json"), "not json");
  try {
    for (const file of [join(folder, "missing.json"), join(folder, "bad.json")]) {
      const run = spawnSync(
        process.execPath,
        [tool, "aside", "p", "b", "h", "--owner", "o", "--declare", file],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 2, file);
      assert.match(run.stderr, /the declaration file/u);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
