import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const tool = resolve("tests/families/stop-runs.mjs");

/** Held modes' names in an order that is neither `HELD_MODES`' nor the oracle's `MODES`' (#2342). */
const NAMES = ["reversed", "forward, unshared", "reversed, unshared", "forward"];

/**
 * A built tree's modules as the stop runs load them: a stop oracle that reports the source it ran and the held mode it
 * ran in, and its modes.
 */
const MODULES: Record<string, string> = {
  "tests/helpers/type-core-stop-oracle.js": `export const stopRuns = (files, globals, mode) =>
  ({ kind: "closed", ran: files[0].source, mode: mode(() => globalThis.heldMode) });\n`,
  "tests/helpers/type-core-held-host.js": `export const HELD_MODES = ${JSON.stringify(NAMES)}.map((name) => ({
  name,
  run: (f) => {
    globalThis.heldMode = name;
    try {
      return f();
    } finally {
      globalThis.heldMode = undefined;
    }
  },
}));\n`,
  "tests/helpers/type-core-oracles.js": `export const MODES = [{ reversed: false, unshared: false }];
export const inMode = (mode, make) => make();
`,
};

/** A unit's key as the baselines identify a source (`sourceKey`): the sha256 of its files' paths and texts and its globals. */
const keyOf = (source: string, globals = ["g"]) =>
  createHash("sha256")
    .update(JSON.stringify([[["main.tease", source]], globals]))
    .digest("hex");

test("the stop runs run the unit an item names by name and key, and never pick between units of one name (#2254)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-stop-runs-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const tree = join(folder, "tree");
  for (const [file, text] of Object.entries(MODULES)) {
    mkdirSync(join(tree, "dist", file, ".."), { recursive: true });
    writeFileSync(join(tree, "dist", file), text);
  }
  writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
  mkdirSync(join(tree, "tests", "families", "area"), { recursive: true });
  cpSync(resolve("tests/families/sources.mjs"), join(tree, "tests/families/sources.mjs"));
  // (two different units under one name, the later of which a lookup by name alone ran, and two identical ones)
  const cases = [
    ["twin", "twin first"],
    ["unique", "unique"],
    ["twin", "twin second"],
    ["copy", "copy"],
    ["copy", "copy"],
  ];
  writeFileSync(
    join(tree, "tests/families/area/cases.mjs"),
    `export const globals = ["g"];\nexport const cases = ${JSON.stringify(cases)};\n`,
  );
  const run = (name: string, items: object[]) => {
    const file = join(folder, `${name}.jsonl`);
    writeFileSync(file, items.map((item) => `${JSON.stringify(item)}\n`).join(""));
    const out = join(folder, name);
    const ran = spawnSync(process.execPath, [tool, tree, file, "--out", out], { encoding: "utf8" });
    const rows = readFileSync(join(out, "rows.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line): Record<string, unknown> => JSON.parse(line));
    return { ran, rows, summary: JSON.parse(readFileSync(join(out, "summary.json"), "utf8")) };
  };
  const item = (name: string, key?: string) => ({
    set: "area",
    name: `cases.mjs/${name}`,
    key,
    mode: 0,
    demand: 16,
  });
  const row = ({ ran, key, missing, ambiguous }: Record<string, unknown>) => ({
    ran,
    key,
    missing,
    ambiguous,
  });
  const unit = (source: string) => ({ ran: source, key: keyOf(source) });
  const missing = "0".repeat(64);
  const all = run("all", [
    item("unique"),
    item("twin"),
    item("twin", keyOf("twin first")),
    item("twin", keyOf("twin second")),
    item("copy"),
    item("twin", missing),
    { files: [{ path: "main.tease", source: "row" }], globals: ["h"], label: "src-on", demand: 16 },
  ]);
  assert.equal(all.ran.status, 1, all.ran.stderr);
  assert.deepEqual(
    all.rows.map(row),
    [
      unit("unique"),
      { ambiguous: [keyOf("twin first"), keyOf("twin second")] },
      unit("twin first"),
      unit("twin second"),
      unit("copy"),
      { missing: true },
      { ran: "row", key: keyOf("row", ["h"]) },
    ].map((expected) => ({
      ran: undefined,
      key: undefined,
      missing: undefined,
      ambiguous: undefined,
      ...expected,
    })),
  );
  assert.deepEqual(all.summary, {
    shard: "0/1",
    items: 7,
    kinds: { closed: 5 },
    missing: 1,
    ambiguous: 1,
    exceptions: 0,
  });
  // (an ambiguous item alone fails the census; with every unit resolved it passes)
  assert.equal(run("ambiguous", [item("twin")]).ran.status, 1);
  const resolved = run("resolved", [
    item("unique"),
    item("twin", keyOf("twin second")),
    item("copy"),
  ]);
  assert.equal(resolved.ran.status, 0, resolved.ran.stderr);
  // (a record's mode by its name runs the held mode of that name; a number, a record's from before #2342, the mode at
  // that index; an unknown name is the item's exception, never another mode)
  const moded = run("moded", [
    { ...item("unique"), mode: "forward, unshared" },
    { ...item("unique"), mode: "forward" },
    { ...item("unique"), mode: 2 },
    { ...item("unique"), mode: "sideways" },
  ]);
  assert.equal(moded.ran.status, 1, moded.ran.stderr);
  assert.deepEqual(
    moded.rows.map(({ mode, exception }) => ({
      mode,
      exception: typeof exception === "string" ? exception.split("\n")[0] : exception,
    })),
    [
      { mode: "forward, unshared", exception: undefined },
      { mode: "forward", exception: undefined },
      { mode: "reversed, unshared", exception: undefined },
      { mode: undefined, exception: 'Error: no held mode "sideways"' },
    ],
  );
});
