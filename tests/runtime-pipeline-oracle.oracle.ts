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
  commit: string;
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

// Where admission is decided (admission.mjs's one `admit`), by real location and origin: at a load in a root's process,
// at the certification of a root's files, and at the seal. Each row is a site, a kind of file or root, and whether it is
// admitted; a refused row names the reason it is refused for.
interface AdmissionRow {
  readonly site: "load" | "certify" | "seal";
  readonly kind: string;
  readonly admitted: boolean;
  readonly reason?: RegExp;
}

const OUTSIDE = /resolves outside the root's inventory/u;
const ADMISSION: readonly (AdmissionRow & {
  readonly index?: string;
  readonly tree?: Record<string, string>;
})[] = [
  { site: "load", kind: "a locked package", admitted: true, index: 'import "locked";\n' },
  {
    site: "load",
    kind: "a locked package's internal scope",
    admitted: true,
    index: 'import "locked/modules/inner.js";\n',
  },
  {
    site: "load",
    kind: "an unlocked package directly in a locked one's node_modules",
    admitted: false,
    reason: OUTSIDE,
    index: 'import "locked/nested.js";\n',
  },
  {
    site: "load",
    kind: "an unlocked package in a node_modules deeper inside a locked one",
    admitted: false,
    reason: OUTSIDE,
    index: 'import "locked/deeper.js";\n',
  },
  {
    site: "load",
    kind: "a data module",
    admitted: false,
    reason: OUTSIDE,
    index: 'import "data:text/javascript,export default 1";\n',
  },
  {
    site: "load",
    kind: "a file outside the root",
    admitted: false,
    reason: OUTSIDE,
    index: "import OUTSIDE_URL;\n",
  },
  {
    site: "load",
    kind: "a built file linked from outside the root",
    admitted: false,
    reason: OUTSIDE,
    index: "LINK",
  },
  {
    site: "load",
    kind: "a locked package at another version",
    admitted: false,
    reason: /installed at 2\.0\.0, locked at 1\.0\.0/u,
    index: 'import "locked";\n',
    tree: {
      "node_modules/locked/package.json":
        '{"name":"locked","version":"2.0.0","type":"module","main":"index.js"}',
    },
  },
  {
    site: "load",
    kind: "a locked package that is not installed",
    admitted: false,
    reason: /'node_modules\/missing' is not installed/u,
    index: "export {};\n",
    tree: { "package-lock.json": "MISSING" },
  },
  {
    site: "certify",
    kind: "a cached root whose build and packages link to the candidate's",
    admitted: false,
    reason: /is not inside the root/u,
  },
  {
    site: "seal",
    kind: "a cached root whose source was changed after it was built",
    admitted: false,
  },
];

/** A small root, as a run sees one: stub entries, one locked package with an internal scope, and unlocked nests. */
function fixtureRoot(root: string, row: (typeof ADMISSION)[number], outside: string): string[] {
  const stubs: Record<string, string> = {
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
    // A platform binding the lockfile marks optional, which this install lacks: every row admits its absence.
    "node_modules/binding": { version: "1.0.0", optional: true },
  };
  const index = (row.index ?? "").replace(
    "OUTSIDE_URL",
    JSON.stringify(pathToFileURL(outside).href),
  );
  writeTree(root, {
    ...stubs,
    "node_modules/locked/package.json":
      '{"name":"locked","version":"1.0.0","type":"module","main":"index.js"}',
    "node_modules/locked/index.js": "export const locked = 1;\n",
    "node_modules/locked/modules/package.json": '{"type":"module"}',
    "node_modules/locked/modules/inner.js": "export const inner = 1;\n",
    "node_modules/locked/node_modules/unlocked/index.js": "export const unlocked = 1;\n",
    "node_modules/locked/nested.js": 'export * from "./node_modules/unlocked/index.js";\n',
    "node_modules/locked/lib/node_modules/unlocked/index.js": "export const deeper = 1;\n",
    "node_modules/locked/deeper.js": 'export * from "./lib/node_modules/unlocked/index.js";\n',
    ...(index === "LINK" ? {} : { "dist/src/index.js": index }),
    "package-lock.json": lock(locked),
    ...row.tree,
    ...(row.tree?.["package-lock.json"] === "MISSING"
      ? { "package-lock.json": lock({ ...locked, "node_modules/missing": { version: "1.0.0" } }) }
      : {}),
  });
  if (index === "LINK") fs.symlinkSync(outside, path.join(root, "dist/src/index.js"));
  return ["dist/src/index.js", ...Object.keys(stubs)];
}

for (const [index, row] of ADMISSION.entries())
  test(`admission, at the ${row.site}: ${row.kind} is ${row.admitted ? "admitted" : "refused"}`, () => {
    const work = scratch();
    try {
      const outside = path.join(work.directory, "outside.js");
      fs.writeFileSync(outside, "export const outside = 1;\n");
      const root = path.join(work.directory, `row-${index}`);
      let status: number | null;
      let stderr: string;
      if (row.site === "load") {
        const files = path.join(work.directory, "files.json");
        fs.writeFileSync(files, JSON.stringify(fixtureRoot(root, row, outside)));
        ({ status, stderr } = oracle("run.mjs", ["--root", root, "--files", files], "[]"));
      } else if (row.site === "certify") {
        // The cached root's files are the candidate's own, linked: the same bytes, not the frozen root's.
        fs.mkdirSync(root);
        for (const entry of [
          "dist",
          "node_modules",
          "src",
          "tools",
          "package.json",
          "package-lock.json",
          "tsconfig.json",
          ".nvmrc",
        ])
          fs.symlinkSync(path.join(checkout, entry), path.join(root, entry));
        ({ status, stderr } = oracle("compare.mjs", ["--from", root, "--only", "project-rounds"]));
      } else {
        // A root in the oracle home with a receipt and a changed source: the seal must not use it.
        const sealed = manifest();
        const home = path.join(work.directory, "home");
        writeTree(path.join(home, sealed.commit), {
          "materialized.json": "{}",
          "src/compiler.ts": "// changed after the build\n",
        });
        const out = path.join(work.directory, "sealed.json");
        ({ status, stderr } = oracle(
          "materialize.mjs",
          ["--seal", sealed.commit, "--label", "provisional", "--out", out],
          "",
          { RUNTIME_ORACLE_HOME: home },
        ));
        assert.equal(status, 0, stderr);
        // EVIDENCE: validation: the seal writes a manifest of this shape, which the comparison checks completely.
        const resealed = JSON.parse(fs.readFileSync(out, "utf8")) as Manifest;
        // A fresh build of the commit: its source and its results are the sealed ones, not the changed root's.
        assert.equal(resealed.closure["src/compiler.ts"], sealed.closure["src/compiler.ts"]);
        assert.deepEqual(resealed.results, sealed.results);
        return;
      }
      if (row.admitted) assert.equal(status, 0, stderr);
      else {
        assert.notEqual(status, 0);
        if (row.reason !== undefined) assert.match(stderr, row.reason);
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
