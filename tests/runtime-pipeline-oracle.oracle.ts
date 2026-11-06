import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  checkout,
  oracle,
  scratch,
  sealedManifest,
  writeTree,
  type OracleResult,
} from "./helpers/runtime-oracle.js";

// The runtime pipeline oracle (docs/TESTING.md "Runtime pipeline oracle", engine plan §8 F-oracle): a frozen build of
// a pinned commit, in a root and a process of its own, that a candidate pipeline is compared with. It runs outside the
// sharded suite (`npm run oracle:test`; CI's check-1). The provisional seal proves only that the oracle reproduces
// itself and equals this checkout's pipeline; the semantic freeze is the later seal at the released seam.

// EVIDENCE: validation: cases.json is the oracle's own case list, a JSON object whose `cases` have these fields.
const cases = JSON.parse(
  fs.readFileSync(path.join(checkout, "tools/runtime-oracle/cases.json"), "utf8"),
).cases as readonly { readonly name: string; readonly routes: readonly string[] }[];

/** The sealed manifest's fields this test changes. */
interface Manifest {
  closure: Record<string, string>;
  output: Record<string, string>;
  cases: { sha256: string };
  results: Record<string, string>;
}
const manifest = () => sealedManifest<Manifest>();

test("the frozen pipeline reproduces its sealed results, and this checkout's build equals it on every case and route", () => {
  const { status, report, stderr } = oracle("compare.mjs", ["--details"]);
  assert.equal(status, 0, stderr);
  assert.ok(report !== null);
  assert.equal(report.reproduced, true);
  assert.equal(report.identical, true);
  assert.equal(
    report.count,
    cases.reduce((sum, testCase) => sum + testCase.routes.length, 0),
  );
  // The core route compiles its supported sources and refuses the others explicitly, never silently.
  const compiled = new Set(report.classifications["compiled"]);
  for (const name of [
    "core-store-parts",
    "core-object-presence",
    "core-stop-moved-check",
    "core-stop-unstopped",
  ])
    assert.ok(compiled.has(`${name}/core`), name);
  assert.ok((report.classifications["unsupported-core"] ?? []).length > 0);
  // The stop: its moved check's warning under the test allowance, none without it, and in both the whole number
  // reaches the effect while the fraction stops at the check.
  const codes = (key: string) => report.results?.[key]?.diagnostics?.map((item) => item.code) ?? [];
  assert.ok(codes("core-stop-moved-check/core").includes("TSV076"));
  assert.ok(!codes("core-stop-unstopped/core").includes("TSV076"));
  for (const name of ["core-stop-moved-check", "core-stop-unstopped"]) {
    const runs: NonNullable<OracleResult["runs"]> = report.results?.[`${name}/core`]?.runs ?? [];
    const whole = runs.find((run) => run.label === "whole");
    const fraction = runs.find((run) => run.label === "fraction");
    assert.equal(whole?.end, "halted", name);
    assert.equal(fraction?.end, "failed", name);
    assert.equal(fraction?.cuts.at(-1)?.failure, "TSR058", name);
  }
});

test("a root loads only its own build and the packages its lockfile installs", () => {
  const work = scratch();
  try {
    const outside = path.join(work.directory, "outside.js");
    fs.writeFileSync(outside, "export const outside = 1;\n");
    const stubs = {
      "dist/src/compiler.js": "export {};\n",
      "dist/src/type-inference/core/backend.js":
        "export class CandidateOutsideSlice extends Error {}\nexport const CORE_BACKEND = {};\n",
      "dist/src/type-inference/core/budget.js":
        "export const withTestAllowance = (_n, run) => run();\n",
      "dist/src/runtime/snapshot/checkpoint-json.js":
        "export const serializeValidatedRuntimeJson = JSON.stringify;\n",
    };
    const lock = (packages: Record<string, unknown>) =>
      JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...packages } });
    const locked = {
      "node_modules/locked": { version: "1.0.0" },
      // A platform binding the lockfile marks optional, which this install lacks.
      "node_modules/binding": { version: "1.0.0", optional: true },
    };
    const installed = {
      "node_modules/locked/package.json":
        '{"name":"locked","version":"1.0.0","type":"module","main":"index.js"}',
      "node_modules/locked/index.js": "export const locked = 1;\n",
      // A package's own internal scope stays that package's.
      "node_modules/locked/modules/package.json": '{"type":"module"}',
      "node_modules/locked/modules/inner.js": "export const inner = 1;\n",
      // An unlocked directory below a locked package's node_modules is another package, also without metadata.
      "node_modules/locked/node_modules/unlocked/index.js": "export const unlocked = 1;\n",
      "node_modules/locked/nested.js": 'export * from "./node_modules/unlocked/index.js";\n',
    };
    const controls: readonly {
      readonly name: string;
      readonly index: string;
      readonly lock?: string;
      readonly version?: string;
      readonly refused: RegExp | null;
    }[] = [
      { name: "a locked package", index: 'import "locked";\n', refused: null },
      {
        name: "a locked package's internal scope",
        index: 'import "locked/modules/inner.js";\n',
        refused: null,
      },
      {
        name: "an unlocked package nested in a locked one",
        index: 'import "locked/nested.js";\n',
        refused: /resolves outside the root's inventory/u,
      },
      {
        name: "a data module",
        index: 'import "data:text/javascript,export default 1";\n',
        refused: /resolves outside the root's inventory/u,
      },
      {
        name: "a file outside the root",
        index: `import ${JSON.stringify(pathToFileURL(outside).href)};\n`,
        refused: /resolves outside the root's inventory/u,
      },
      {
        name: "a locked package at another version",
        index: 'import "locked";\n',
        version: "2.0.0",
        refused: /installed at 2\.0\.0, locked at 1\.0\.0/u,
      },
      {
        name: "a locked package that is not installed",
        index: "export {};\n",
        lock: lock({ ...locked, "node_modules/missing": { version: "1.0.0" } }),
        refused: /'node_modules\/missing' is not installed/u,
      },
    ];
    for (const control of controls) {
      const root = path.join(work.directory, control.name.replaceAll(" ", "-").replaceAll("'", ""));
      writeTree(root, {
        ...stubs,
        ...installed,
        "dist/src/index.js": control.index,
        "package-lock.json": control.lock ?? lock(locked),
        ...(control.version === undefined
          ? {}
          : {
              "node_modules/locked/package.json": `{"name":"locked","version":"${control.version}","type":"module","main":"index.js"}`,
            }),
      });
      const files = path.join(root, "files.json");
      fs.writeFileSync(files, JSON.stringify(["dist/src/index.js", ...Object.keys(stubs)]));
      const { status, stderr } = oracle("run.mjs", ["--root", root, "--files", files], "[]");
      if (control.refused === null) assert.equal(status, 0, `${control.name}: ${stderr}`);
      else {
        assert.notEqual(status, 0, control.name);
        assert.match(stderr, control.refused, control.name);
      }
    }
  } finally {
    work.done();
  }
});

test("the frozen root refuses an import of this checkout's build", () => {
  const work = scratch();
  try {
    const module = path.join(work.directory, "index.js");
    fs.writeFileSync(
      module,
      `export * from ${JSON.stringify(pathToFileURL(path.join(checkout, "dist/src/index.js")).href)};\n`,
    );
    const { status, stderr } = oracle("compare.mjs", [
      "--only",
      "project-rounds",
      "--replace-oracle",
      `dist/src/index.js=${module}`,
    ]);
    assert.equal(status, 2);
    assert.match(stderr, /resolves outside the root's inventory/u);
  } finally {
    work.done();
  }
});

test("a changed source, build output, lockfile or case list is refused before anything runs", () => {
  const work = scratch();
  try {
    const zero = "0".repeat(64);
    const changes: readonly (readonly [string, (changed: Manifest) => void, RegExp])[] = [
      ["source", (m) => (m.closure["src/compiler.ts"] = zero), /closure file src\/compiler\.ts/u],
      [
        "output",
        (m) => (m.output["dist/src/index.js"] = zero),
        /output file dist\/src\/index\.js/u,
      ],
      [
        "lockfile",
        (m) => (m.closure["package-lock.json"] = zero),
        /closure file package-lock\.json/u,
      ],
      ["cases", (m) => (m.cases.sha256 = zero), /cases changed since the seal/u],
    ];
    for (const [name, change, refused] of changes) {
      const changed = manifest();
      change(changed);
      const file = path.join(work.directory, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(changed));
      const { status, stderr } = oracle("compare.mjs", [
        "--manifest",
        file,
        "--only",
        "project-rounds",
      ]);
      assert.equal(status, 2, name);
      assert.match(stderr, refused, name);
    }
  } finally {
    work.done();
  }
});

test("a candidate whose lowering emits otherwise differs from the oracle, whose own results stay", () => {
  const original = path.join(checkout, "dist/src/compiler/lowering/say.js");
  const mutant = path.join(checkout, "dist/src/compiler/lowering/say.oracle-mutant.js");
  const text = fs.readFileSync(original, "utf8");
  assert.ok(text.includes("span: planSpan(say.span)"));
  fs.writeFileSync(
    mutant,
    text.replaceAll("span: planSpan(say.span)", "span: planSpan(say.value.span)"),
  );
  try {
    const { status, report, stderr } = oracle("compare.mjs", [
      "--only",
      "project-rounds",
      "--replace-candidate",
      `dist/src/compiler/lowering/say.js=${mutant}`,
    ]);
    assert.equal(status, 1, stderr);
    assert.ok(report !== null);
    assert.equal(report.reproduced, true);
    assert.equal(report.identical, false);
    assert.ok(report.mismatches.some((item) => item.path === "/plan/sha256"));
  } finally {
    fs.rmSync(mutant, { force: true });
  }
});

test("an oracle that no longer gives its sealed result fails as such, though it equals the candidate", () => {
  const work = scratch();
  try {
    const changed = manifest();
    changed.results["project-rounds/legacy"] = "0".repeat(64);
    const file = path.join(work.directory, "results.json");
    fs.writeFileSync(file, JSON.stringify(changed));
    const { status, report, stderr } = oracle("compare.mjs", [
      "--manifest",
      file,
      "--only",
      "project-rounds",
    ]);
    assert.equal(status, 1, stderr);
    assert.ok(report !== null);
    assert.equal(report.reproduced, false);
    assert.deepEqual(
      report.reproduction.map((item) => item.key),
      ["project-rounds/legacy"],
    );
    assert.equal(report.identical, true);
  } finally {
    work.done();
  }
});
