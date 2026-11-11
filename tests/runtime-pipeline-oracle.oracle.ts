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
  type OracleReport,
  type OracleResult,
} from "./helpers/runtime-oracle.js";

// The runtime pipeline oracle (docs/TESTING.md "Runtime pipeline oracle", engine plan's F-oracle): a frozen build of
// a pinned commit, in a root and a process of its own, that a candidate pipeline is compared with. It runs outside the
// sharded suite (`npm run oracle:test`; CI's check-1). The provisional seal proves only that the oracle reproduces
// itself and equals this checkout's pipeline; the semantic freeze is the later seal at the released seam.

// EVIDENCE: validation: cases.json is the oracle's own case list, a JSON object whose `cases` have these fields.
const cases = JSON.parse(
  fs.readFileSync(path.join(checkout, "tools/runtime-oracle/cases.json"), "utf8"),
).cases as readonly { readonly name: string; readonly routes: readonly string[] }[];

/** The sealed manifest's fields this test changes. */
interface Manifest {
  commit: string;
  closure: Record<string, string>;
  output: Record<string, string>;
  cases: { sha256: string };
  results: Record<string, string>;
}
// EVIDENCE: validation: materialize.mjs exports `oracleHome`, the directory that holds a materialized root per commit.
const { oracleHome } = (await import(
  pathToFileURL(path.join(checkout, "tools/runtime-oracle/materialize.mjs")).href
)) as { readonly oracleHome: () => string };
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

// The admission family is tests/runtime-oracle-admission.oracle.ts. Its lifecycle companions, which need the real
// pin, are here: what a cached root may be before its use, and what a seal may use.
test("admission/lifecycle=linked-cache: a root whose certified files link to identical files outside it is refused", () => {
  const work = scratch();
  try {
    // A root whose entries link to the materialized oracle's own: the same bytes, but not files of this root.
    const cached = path.join(oracleHome(), manifest().commit);
    const root = path.join(work.directory, "root");
    fs.mkdirSync(root);
    for (const entry of fs.readdirSync(cached))
      fs.symlinkSync(path.join(cached, entry), path.join(root, entry));
    const { status, stderr } = oracle("compare.mjs", ["--from", root, "--only", "project-rounds"]);
    assert.equal(status, 2);
    assert.match(stderr, /the declared file '[^']+' is not a file of the root's own/u);
  } finally {
    work.done();
  }
});

test("admission/lifecycle=stale-cache: a seal never uses a cached root, so a source changed in one is not sealed", () => {
  const work = scratch();
  try {
    // A root in the oracle home with a receipt and a changed source: the seal must not use it.
    const sealed = manifest();
    const home = path.join(work.directory, "home");
    writeTree(path.join(home, sealed.commit), {
      "materialized.json": "{}",
      "src/compiler.ts": "// changed after the build\n",
    });
    const out = path.join(work.directory, "sealed.json");
    const { status, stderr } = oracle(
      "materialize.mjs",
      ["--seal", sealed.commit, "--label", "provisional", "--out", out],
      "",
      { RUNTIME_ORACLE_HOME: home },
    );
    assert.equal(status, 0, stderr);
    // EVIDENCE: validation: the seal writes a manifest of this shape, which the comparison checks completely.
    const resealed = JSON.parse(fs.readFileSync(out, "utf8")) as Manifest;
    // A fresh build of the commit: its source and its results are the sealed ones, not the changed root's.
    assert.equal(resealed.closure["src/compiler.ts"], sealed.closure["src/compiler.ts"]);
    assert.deepEqual(resealed.results, sealed.results);
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

/** Runs `body` with a candidate module beside its original, `edit` applied to its text; removes it after. */
function withMutant(
  original: string,
  edit: (text: string) => string,
  body: (mutant: string) => void,
) {
  const file = path.join(checkout, original);
  const mutant = file.replace(/\.js$/u, ".oracle-mutant.js");
  const text = fs.readFileSync(file, "utf8");
  const edited = edit(text);
  assert.notEqual(edited, text, `the mutation of ${original} applies`);
  fs.writeFileSync(mutant, edited);
  try {
    body(mutant);
  } finally {
    fs.rmSync(mutant, { force: true });
  }
}

test("a candidate that runs otherwise uninterrupted than restored at every cut is not the oracle", () => {
  // A session that fails at its second step of a run: a restored run, a new session at every cut, never sees it.
  withMutant(
    "dist/src/runtime/session.js",
    (text) =>
      text.replace(
        "stepToEvent(options = {}) {",
        'stepToEvent(options = {}) {\n        if ((this.oracleMutantSteps = (this.oracleMutantSteps ?? 0) + 1) > 1) throw new Error("mutant");',
      ),
    (mutant) => {
      const { status, report, stderr } = oracle("compare.mjs", [
        "--only",
        "project-rounds",
        "--replace-candidate",
        `dist/src/runtime/session.js=${mutant}`,
      ]);
      assert.equal(status, 1, stderr);
      assert.ok(report !== null);
      assert.equal(report.reproduced, true);
      assert.ok(!report.restoreAgrees || !report.identical);
    },
  );
});

/** `compare.mjs` on `project-rounds` with the candidate's `deserializeRuntimeSession` changed for a halted session. */
function haltedRestoreMutant(change: string, check: (report: OracleReport) => void) {
  withMutant(
    "dist/src/runtime/session.js",
    (text) =>
      text.replace(
        "return adoptCheckpoint(deserializeCheckpoint(json), capabilities, randomControl);",
        "const read = deserializeCheckpoint(json);\n" +
          '    if (read.snapshot.status === "halted") ' +
          change +
          "\n    return adoptCheckpoint(read, capabilities, randomControl);",
      ),
    (mutant) => {
      const { status, report, stderr } = oracle("compare.mjs", [
        "--only",
        "project-rounds",
        "--replace-candidate",
        `dist/src/runtime/session.js=${mutant}`,
      ]);
      assert.equal(status, 1, stderr);
      assert.ok(report !== null);
      assert.equal(report.reproduced, true);
      assert.equal(report.restoreAgrees, false);
      check(report);
    },
  );
}

// Only the last cut's restore changes anything, and nothing runs after it: the restored state itself must be seen.
test("a candidate that restores a halted session with another RNG disagrees with its uninterrupted run", () => {
  haltedRestoreMutant(
    "return adoptCheckpoint({ ...read, snapshot: { ...read.snapshot, rng: { ...read.snapshot.rng, state: read.snapshot.rng.state === 1 ? 2 : 1 } } }, capabilities, randomControl);",
    (report) =>
      assert.deepEqual(
        new Set(report.restore.map((item) => `${item.side} ${item.kind}`)),
        new Set(["candidate disagrees"]),
      ),
  );
});

test("a candidate whose restore throws fails as a restore that threw, never as a skipped run", () => {
  haltedRestoreMutant('throw new Error("restore mutant");', (report) =>
    assert.deepEqual(
      new Set(report.restore.map((item) => `${item.side} ${item.kind}`)),
      new Set(["candidate restore-threw"]),
    ),
  );
});

test("a candidate that names another file in its diagnostics differs from the oracle", () => {
  withMutant(
    "dist/src/compiler.js",
    (text) => text.replace("path: file.path", 'path: "wrong-file.tease"'),
    (mutant) => {
      const { status, report, stderr } = oracle("compare.mjs", [
        "--only",
        "project-rounds",
        "--replace-candidate",
        `dist/src/compiler.js=${mutant}`,
      ]);
      assert.equal(status, 1, stderr);
      assert.ok(report !== null);
      assert.equal(report.identical, false);
      assert.ok(report.mismatches.some((item) => item.path.endsWith("/path")));
    },
  );
});

test("every timed sample gives its build's untimed transcript; its CPU only describes", () => {
  const { status, report, stderr } = oracle("compare.mjs", [
    "--only",
    "project-rounds",
    "--timed",
    "2",
  ]);
  assert.equal(status, 0, stderr);
  assert.ok(report?.timing !== undefined);
  // Two routes, each one run, two samples, in both builds; the core refuses this project.
  assert.ok(report.timing.samples > 0);
  assert.equal(report.timing.matched, true);
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
