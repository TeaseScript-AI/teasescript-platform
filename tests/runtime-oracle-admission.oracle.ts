import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { checkout, oracle, scratch, writeTree } from "./helpers/runtime-oracle.js";

/*
 * The runtime oracle's admission (docs/TESTING.md "Runtime pipeline oracle"), as an invariant over a generated input
 * family: every case is built from, and named by, its axis values, and its expected outcome comes from `expected`,
 * which decides from the axis values alone and imports nothing from `tools/runtime-oracle/admission.mjs`. A coverage
 * check proves every axis value and every pair of values outside the excluded pairs ran. The guarantee is Node-managed
 * module provenance of a trusted pipeline; the execution escapes outside it are named, never tested as refused.
 */

const AXES = {
  site: ["load", "certify", "seal"],
  origin: ["fixed", "discovered"],
  location: [
    "owned",
    "escape",
    "linked-out",
    "locked",
    "unlocked-top",
    "unlocked-nested",
    "unlocked-deep",
    "unlocked-under-dist",
  ],
  member: ["listed", "unlisted"],
  root: ["direct", "leaf-symlink"],
  deps: ["direct", "linked"],
} as const;

type Axes = typeof AXES;
type Axis = keyof Axes;
type Case = { readonly [A in Axis]: Axes[A][number] };

/** Pairs of axis values no case can have, each with its reason. */
const EXCLUDED: readonly { readonly pair: Partial<Case>; readonly reason: string }[] = [
  {
    pair: { site: "certify", member: "unlisted" },
    reason: "an omitted file is not a certification request",
  },
  {
    pair: { site: "seal", member: "unlisted" },
    reason: "an omitted file is not a certification request",
  },
  { pair: { site: "seal", origin: "fixed" }, reason: "a seal discovers its declarations" },
  { pair: { site: "seal", root: "leaf-symlink" }, reason: "a fresh acquisition replaces the root" },
  {
    pair: { site: "seal", deps: "linked" },
    reason: "a fresh npm ci makes the dependency directory",
  },
];

// The axes, in their declared order.
// EVIDENCE: validation: `AXES` is a literal whose keys are exactly `Axis`.
const AXIS_NAMES = Object.keys(AXES) as Axis[];

/** Whether `item` has every value of `pair`. */
const has = (item: Partial<Case>, pair: Partial<Case>) =>
  AXIS_NAMES.every((axis) => pair[axis] === undefined || item[axis] === pair[axis]);
const excluded = (item: Partial<Case>) => EXCLUDED.some(({ pair }) => has(item, pair));

/** Every case: the feasible Cartesian product of the axes. */
function family(): Case[] {
  let cases: Partial<Case>[] = [{}];
  for (const axis of AXIS_NAMES)
    cases = cases.flatMap((partial) =>
      AXES[axis].map((value): Partial<Case> => ({ ...partial, [axis]: value })),
    );
  // EVIDENCE: validation: the loop above set every axis of every case.
  return (cases as Case[]).filter((item) => !excluded(item));
}

const nameOf = (item: Case) =>
  `admission/${AXIS_NAMES.map((axis) => `${axis}=${item[axis]}`).join("/")}`;

/**
 * The independent oracle, from axis values only: a declaration is valid only for a file of the root's own; a load is
 * admitted for a valid root with the file declared, or for a locked package's file; a certification is admitted for
 * valid declarations. The root and dependency aliases never change it. A refusal comes at the declarations when they
 * are invalid, else at the resolution.
 */
function expected(item: Case): {
  readonly admitted: boolean;
  readonly boundary: "declaration" | "resolve";
} {
  const listed = item.member === "listed";
  const valid = !(listed && item.location !== "owned");
  const admitted =
    item.site === "load"
      ? valid && ((item.location === "owned" && listed) || item.location === "locked")
      : valid;
  return { admitted, boundary: valid ? "resolve" : "declaration" };
}

/** The entries `run.mjs` loads, which every fixture root stubs. */
const ENTRIES = [
  "src/index.ts",
  "src/compiler.ts",
  "src/type-inference/core/backend.ts",
  "src/type-inference/core/budget.ts",
  "src/runtime/snapshot/checkpoint-json.ts",
] as const;
const STUBS: Readonly<Record<string, string>> = {
  "src/compiler.ts": "export {};\n",
  "src/type-inference/core/backend.ts":
    "export class CandidateOutsideSlice extends Error {}\nexport const CORE_BACKEND = {};\n",
  "src/type-inference/core/budget.ts": "export const withTestAllowance = (_n, run) => run();\n",
  "src/runtime/snapshot/checkpoint-json.ts":
    "export const serializeValidatedRuntimeJson = JSON.stringify;\n",
};
const built = (source: string) => `dist/${source.replace(/\.ts$/u, ".js")}`;
const SENTINEL = "ADMISSION-SENTINEL";
const target = (label: string) =>
  `process.stderr.write(${JSON.stringify(`${SENTINEL} ${label}\n`)});\n`;

/** Each location's target: where it is (root-relative), how a file of the root imports it, and its declaration. */
const LOCATIONS: Readonly<
  Record<
    Case["location"],
    { readonly bare?: string; readonly file: string; readonly declared: string }
  >
> = {
  owned: { file: "dist/src/target.js", declared: "dist/src/target.js" },
  escape: { file: "../outside/target.js", declared: "../outside/target.js" },
  "linked-out": { file: "dist/src/target.js", declared: "dist/src/target.js" },
  locked: {
    bare: "locked",
    file: "node_modules/locked/index.js",
    declared: "node_modules/locked/index.js",
  },
  "unlocked-top": {
    bare: "unlocked",
    file: "node_modules/unlocked/index.js",
    declared: "node_modules/unlocked/index.js",
  },
  "unlocked-nested": {
    bare: "locked/nested.js",
    file: "node_modules/locked/node_modules/unlocked/index.js",
    declared: "node_modules/locked/node_modules/unlocked/index.js",
  },
  "unlocked-deep": {
    bare: "locked/deeper.js",
    file: "node_modules/locked/lib/node_modules/unlocked/index.js",
    declared: "node_modules/locked/lib/node_modules/unlocked/index.js",
  },
  "unlocked-under-dist": {
    file: "dist/src/lib/node_modules/unlocked/index.js",
    declared: "dist/src/lib/node_modules/unlocked/index.js",
  },
};

/** A specifier from `dist/src/index.js` to a root-relative path. */
const relativeFromEntry = (file: string) =>
  `./${path.posix.relative("dist/src", file)}`.replace(/^\.\/\.\.\//u, "../");

interface Fixture {
  /** The root as the tools are given it: the real directory, or a link to it. */
  readonly root: string;
  readonly real: string;
  readonly outside: string;
  /** The real path of the dependency directory. */
  readonly deps: string;
}

/** A small root built from a case's axis values, under `work`. */
function fixture(work: string, item: Case, index = ""): Fixture {
  const real = path.join(work, "real-root");
  const outside = path.join(work, "outside");
  writeTree(outside, { "target.js": target(item.location) });
  const location = LOCATIONS[item.location];
  // How the entry imports the target: literally for a declared or a fixed one (relatively when discovery must find
  // it), and by a computed specifier, which preprocessing cannot enumerate, for a discovered one that is not.
  const literal =
    item.origin === "discovered" || location.bare === undefined
      ? relativeFromEntry(location.file)
      : location.bare;
  const computed = location.bare ?? relativeFromEntry(location.file);
  const entry =
    index !== ""
      ? index
      : item.origin === "discovered" && item.member === "unlisted"
        ? `await import([${[...computed].map((character) => JSON.stringify(character)).join(", ")}].join(""));\n`
        : `import ${JSON.stringify(literal)};\n`;
  const sources: Record<string, string> = { ...STUBS, "src/index.ts": entry };
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "fixture", type: "module" }),
    ".nvmrc": "26.13.0\n",
    "tsconfig.json": "{}\n",
    "tools/clean-compiled-tests.mjs": "export {};\n",
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/locked": { version: "1.0.0" },
        // A platform binding the lockfile marks optional, which this install lacks.
        "node_modules/binding": { version: "1.0.0", optional: true },
      },
    }),
    ...sources,
    ...Object.fromEntries(Object.entries(sources).map(([file, text]) => [built(file), text])),
    "src/target.ts": target("owned"),
    "src/lib/node_modules/unlocked/index.ts": target("unlocked-under-dist"),
    "dist/src/lib/node_modules/unlocked/index.js": target("unlocked-under-dist"),
  };
  if (item.location !== "linked-out") files["dist/src/target.js"] = target("owned");
  writeTree(real, files);
  if (item.location === "linked-out")
    fs.symlinkSync(path.join(outside, "target.js"), path.join(real, "dist/src/target.js"));
  const deps = item.deps === "direct" ? path.join(real, "node_modules") : path.join(work, "deps");
  writeTree(deps, {
    "locked/package.json": '{"name":"locked","version":"1.0.0","type":"module","main":"index.js"}',
    "locked/index.js": target("locked"),
    // An internal scope of the locked package, which stays that package's.
    "locked/modules/package.json": '{"type":"module"}',
    "locked/modules/inner.js": target("internal-scope"),
    "locked/nested.js": 'import "./node_modules/unlocked/index.js";\n',
    "locked/node_modules/unlocked/index.js": target("unlocked-nested"),
    "locked/deeper.js": 'import "./lib/node_modules/unlocked/index.js";\n',
    "locked/lib/node_modules/unlocked/index.js": target("unlocked-deep"),
    "unlocked/package.json":
      '{"name":"unlocked","version":"1.0.0","type":"module","main":"index.js"}',
    "unlocked/index.js": target("unlocked-top"),
  });
  // Discovery reads the root's own TypeScript, never loaded by a run.
  fs.symlinkSync(path.join(checkout, "node_modules", "typescript"), path.join(deps, "typescript"));
  if (item.deps === "linked") fs.symlinkSync(deps, path.join(real, "node_modules"));
  const root = item.root === "direct" ? real : path.join(work, "root");
  if (item.root === "leaf-symlink") fs.symlinkSync(real, root);
  return {
    root,
    real: fs.realpathSync(real),
    outside: fs.realpathSync(outside),
    deps: fs.realpathSync(deps),
  };
}

/** The real path of a case's target file, as a resolution reaches it. */
function realTarget(item: Case, at: Fixture): string {
  const file = LOCATIONS[item.location].file;
  if (item.location === "escape" || item.location === "linked-out")
    return path.join(at.outside, "target.js");
  if (file.startsWith("node_modules/"))
    return path.join(at.deps, file.slice("node_modules/".length));
  return path.join(at.real, file);
}

interface Tools {
  readonly closure: (
    root: string,
    entries: readonly string[],
  ) => { output: Record<string, string>; sources: Record<string, string> };
  readonly verify: (root: string, manifest: unknown) => void;
  readonly sealedClosure: (
    root: string,
    entries: readonly string[],
  ) => { output: Record<string, string>; sources: Record<string, string> };
}
const tool = (name: string) =>
  pathToFileURL(path.join(checkout, "tools", "runtime-oracle", name)).href;
// EVIDENCE: validation: closure.mjs and materialize.mjs export these functions with these signatures.
const tools = {
  ...(await import(tool("closure.mjs"))),
  ...(await import(tool("materialize.mjs"))),
} as Tools;

const sha256 = (file: string) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** The declared output files of a case: the stub entries, and the target when it is declared. */
function declaredOutput(item: Case): string[] {
  return [
    ...ENTRIES.map(built),
    ...(item.member === "listed" ? [LOCATIONS[item.location].declared] : []),
  ];
}

/** A manifest of `fixtureRoot`'s declared files, hashed from their bytes, as `verify` reads one. */
function baselineManifest(item: Case, fixtureRoot: Fixture) {
  const hashes = (files: readonly string[]) =>
    Object.fromEntries(files.map((file) => [file, sha256(path.join(fixtureRoot.real, file))]));
  const declaredSources = [
    ...ENTRIES,
    ...(item.member === "listed" && item.location === "owned" ? ["src/target.ts"] : []),
  ];
  return {
    entries: ENTRIES,
    node: "26.13.0",
    output: hashes(declaredOutput(item)),
    closure: hashes([
      ...declaredSources,
      ...(item.member === "listed" && item.location !== "owned"
        ? [LOCATIONS[item.location].declared]
        : []),
      "package.json",
      "package-lock.json",
      ".nvmrc",
      "tsconfig.json",
      "tools/clean-compiled-tests.mjs",
    ]),
  };
}

/** Runs one case at its site; returns whether it was admitted and, when refused, what refused it. */
function attempt(item: Case, at: Fixture): { admitted: boolean; message: string; ran: boolean } {
  if (item.site === "load") {
    const files = path.join(path.dirname(at.real), "files.json");
    const declared =
      item.origin === "fixed"
        ? declaredOutput(item)
        : Object.keys(tools.closure(at.root, ENTRIES).output);
    fs.writeFileSync(files, JSON.stringify(declared));
    const { status, stderr } = oracle("run.mjs", ["--root", at.root, "--files", files], "[]");
    return { admitted: status === 0, message: stderr, ran: stderr.includes(SENTINEL) };
  }
  try {
    if (item.site === "certify") tools.verify(at.root, baselineManifest(item, at));
    else tools.sealedClosure(at.root, ENTRIES);
    return { admitted: true, message: "", ran: false };
  } catch (error) {
    return {
      admitted: false,
      message: error instanceof Error ? error.message : String(error),
      ran: false,
    };
  }
}

const completed: Case[] = [];

for (const item of family())
  test(nameOf(item), () => {
    const work = scratch();
    try {
      const at = fixture(work.directory, item);
      const result = attempt(item, at);
      const want = expected(item);
      assert.equal(result.admitted, want.admitted, result.message);
      if (want.admitted) {
        if (item.site === "load") assert.ok(result.ran, "the admitted target ran");
      } else {
        // The refusal names its boundary and its target, and nothing of the target ran.
        assert.ok(!result.ran, "the refused target did not run");
        const location = LOCATIONS[item.location];
        if (want.boundary === "declaration")
          assert.ok(result.message.includes(`'${location.declared}'`), result.message);
        else {
          assert.match(result.message, /resolves outside the root's inventory/u);
          assert.ok(
            result.message.includes(pathToFileURL(realTarget(item, at)).href),
            result.message,
          );
        }
      }
      completed.push(item);
    } finally {
      work.done();
    }
  });

test("the admission family covers every axis value and every pair outside the excluded pairs", () => {
  for (const axis of AXIS_NAMES)
    for (const value of AXES[axis])
      assert.ok(
        completed.some((item) => item[axis] === value),
        `${axis}=${value} ran`,
      );
  for (const [i, first] of AXIS_NAMES.entries())
    for (const second of AXIS_NAMES.slice(i + 1))
      for (const a of AXES[first])
        for (const b of AXES[second]) {
          const pair: Partial<Case> = { [first]: a, [second]: b };
          if (excluded(pair)) continue;
          assert.ok(
            completed.some((item) => has(item, pair)),
            `${first}=${a} with ${second}=${b} ran`,
          );
        }
  assert.equal(completed.length, 200);
});

// Companion families, each generated from its own axis.

/**
 * A declaration is the root's when (a) its spelling is a root path, not absolute, without `..` and without a
 * `node_modules` segment, and (b) its real path is the root's own. Each row's `link` (root-relative link to target) is
 * made first; the last two rows are refused by one condition each.
 */
const SPELLINGS: Readonly<
  Record<
    string,
    { readonly file: string; readonly admitted: boolean; readonly link?: readonly [string, string] }
  >
> = {
  relative: { file: "dist/src/target.js", admitted: true },
  absolute: { file: "ABSOLUTE", admitted: false },
  "dot-dot": { file: "dist/../dist/src/target.js", admitted: false },
  "node-modules": { file: "dist/src/lib/node_modules/unlocked/index.js", admitted: false },
  // Only (a) refuses it: the declared path has a `node_modules` segment, its real path is an owned file.
  "alias-named-node_modules": {
    file: "dist/src/node_modules/target.js",
    admitted: false,
    link: ["dist/src/node_modules", "dist/src/owned"],
  },
  // Only (b) refuses it: the declared path is a plain root path, its real path is under a `node_modules` directory.
  "link-into-node_modules": {
    file: "dist/src/vendored/index.js",
    admitted: false,
    link: ["dist/src/vendored", "dist/src/lib/node_modules/unlocked"],
  },
};

for (const [spelling, { file, admitted, link }] of Object.entries(SPELLINGS))
  test(`admission/declaration=${spelling}`, () => {
    const work = scratch();
    try {
      const item: Case = {
        site: "certify",
        origin: "fixed",
        location: "owned",
        member: "listed",
        root: "direct",
        deps: "direct",
      };
      const at = fixture(work.directory, item);
      writeTree(at.real, { "dist/src/owned/target.js": target("owned") });
      if (link !== undefined)
        fs.symlinkSync(path.join(at.real, link[1]), path.join(at.real, link[0]));
      const declared = file === "ABSOLUTE" ? path.join(at.real, "dist/src/target.js") : file;
      const manifest = baselineManifest(item, at);
      const output = { ...manifest.output, [declared]: "0" };
      delete output["dist/src/target.js"];
      try {
        tools.verify(at.root, { ...manifest, output: admitted ? manifest.output : output });
        assert.ok(admitted, `${declared} was admitted`);
      } catch (error) {
        assert.ok(!admitted, String(error));
        assert.ok(String(error).includes(`'${declared}'`), String(error));
      }
    } finally {
      work.done();
    }
  });

// A dependency directory that is a link to a directory inside the root, not named node_modules: its files are a
// package's, never the root's own, however a declaration names them.
test("admission/declaration=dependency-directory-inside-root", () => {
  const work = scratch();
  try {
    const item: Case = {
      site: "certify",
      origin: "fixed",
      location: "owned",
      member: "listed",
      root: "direct",
      deps: "direct",
    };
    const at = fixture(work.directory, item);
    fs.renameSync(path.join(at.real, "node_modules"), path.join(at.real, "vendor"));
    fs.symlinkSync(path.join(at.real, "vendor"), path.join(at.real, "node_modules"));
    const declared = "vendor/locked/index.js";
    const manifest = baselineManifest(item, at);
    assert.throws(
      () => tools.verify(at.root, { ...manifest, output: { ...manifest.output, [declared]: "0" } }),
      (error: Error) => error.message.includes(`'${declared}' is not a file of the root's own`),
    );
  } finally {
    work.done();
  }
});

const INSTALLATIONS = {
  exact: { lock: {}, entry: 'import "locked";\n', refusal: null },
  "wrong-version": {
    lock: { "node_modules/locked": { version: "2.0.0" } },
    entry: 'import "locked";\n',
    refusal: /'node_modules\/locked' is installed at 1\.0\.0, locked at 2\.0\.0/u,
  },
  "missing-required": {
    lock: { "node_modules/missing": { version: "1.0.0" } },
    entry: "export {};\n",
    refusal: /the locked package 'node_modules\/missing' is not installed/u,
  },
  // Optional absence admits the inventory; importing the absent package still fails.
  "missing-optional": { lock: {}, entry: 'import "binding";\n', refusal: /binding/u },
} as const;

for (const [installation, { lock, entry, refusal }] of Object.entries(INSTALLATIONS))
  test(`admission/installation=${installation}`, () => {
    const work = scratch();
    try {
      const item: Case = {
        site: "load",
        origin: "fixed",
        location: "locked",
        member: "unlisted",
        root: "direct",
        deps: "direct",
      };
      const at = fixture(work.directory, item, entry);
      const lockfile = path.join(at.real, "package-lock.json");
      // EVIDENCE: validation: the fixture wrote this lockfile of version 3 above.
      const written = JSON.parse(fs.readFileSync(lockfile, "utf8")) as { packages: object };
      fs.writeFileSync(
        lockfile,
        JSON.stringify({ ...written, packages: { ...written.packages, ...lock } }),
      );
      const result = attempt(item, at);
      if (refusal === null) assert.ok(result.admitted && result.ran, result.message);
      else {
        assert.ok(!result.admitted && !result.ran, result.message);
        assert.match(result.message, refusal);
      }
    } finally {
      work.done();
    }
  });

/** A `data:` module that would say the sentinel; the sentinel's text never appears in the URL itself. */
const DATA_MODULE = `data:text/javascript,${encodeURIComponent(
  `process.stderr.write(${JSON.stringify(SENTINEL.slice(0, 5))} + ${JSON.stringify(`${SENTINEL.slice(5)} data\n`)});`,
)}`;

/**
 * Each loading mechanism: how `dist/src/index.js` uses it on its target, whether it executes the target, and what the
 * target is (`owned`, a file of the root's own, by default; `package`, a locked package's internal scope; `data`, a
 * `data:` module). Only an owned target can be declared.
 */
const MECHANISMS: Readonly<
  Record<
    string,
    {
      readonly entry: string;
      readonly executes: boolean;
      readonly file: string;
      readonly target?: "owned" | "package" | "data";
    }
  >
> = {
  "internal-scope": {
    entry: 'import "locked/modules/inner.js";\n',
    executes: true,
    file: "node_modules/locked/modules/inner.js",
    target: "package",
  },
  "data-url": {
    entry: `import ${JSON.stringify(DATA_MODULE)};\n`,
    executes: true,
    file: DATA_MODULE,
    target: "data",
  },
  "static-import": { entry: 'import "./target.js";\n', executes: true, file: "dist/src/target.js" },
  "dynamic-import": {
    entry: 'await import("./target.js");\n',
    executes: true,
    file: "dist/src/target.js",
  },
  "create-require": {
    entry:
      'import { createRequire } from "node:module";\ncreateRequire(import.meta.url)("./target.cjs");\n',
    executes: true,
    file: "dist/src/target.cjs",
  },
  "require-resolve": {
    entry:
      'import { createRequire } from "node:module";\ncreateRequire(import.meta.url).resolve("./target.cjs");\n',
    executes: false,
    file: "dist/src/target.cjs",
  },
  "import-meta-resolve": {
    entry: 'import.meta.resolve("./target.js");\n',
    executes: false,
    file: "dist/src/target.js",
  },
  "self-reference": {
    entry: 'import "fixture/target";\n',
    executes: true,
    file: "dist/src/target.js",
  },
  "package-imports": { entry: 'import "#target";\n', executes: true, file: "dist/src/target.js" },
  json: {
    entry:
      'import data from "./target.json" with { type: "json" };\nif (data.ok) process.stderr.write("' +
      SENTINEL +
      ' json\\n");\n',
    executes: true,
    file: "dist/src/target.json",
  },
};

/** Whether a mechanism's load is admitted, from what its target is and whether it is declared alone. */
const mechanismAdmitted = (target: "owned" | "package" | "data", member: "listed" | "unlisted") =>
  target === "package" || (target === "owned" && member === "listed");

for (const [mechanism, { entry, executes, file, target: kind = "owned" }] of Object.entries(
  MECHANISMS,
))
  for (const member of kind === "owned"
    ? (["listed", "unlisted"] as const)
    : (["unlisted"] as const))
    test(`admission/mechanism=${mechanism}/member=${member}`, () => {
      const work = scratch();
      try {
        const item: Case = {
          site: "load",
          origin: "fixed",
          location: "owned",
          member: "unlisted",
          root: "direct",
          deps: "direct",
        };
        const at = fixture(work.directory, item, entry);
        writeTree(at.real, {
          "dist/src/target.cjs": target("cjs"),
          "dist/src/target.json": '{"ok":true}\n',
          "package.json": JSON.stringify({
            name: "fixture",
            type: "module",
            exports: { "./target": "./dist/src/target.js" },
            imports: { "#target": "./dist/src/target.js" },
          }),
        });
        const files = path.join(work.directory, "files.json");
        fs.writeFileSync(
          files,
          JSON.stringify([...ENTRIES.map(built), ...(member === "listed" ? [file] : [])]),
        );
        const { status, stderr } = oracle("run.mjs", ["--root", at.root, "--files", files], "[]");
        // An undeclared owned target, or a `data:` module, is refused however it is reached; an admitted one runs only
        // where the mechanism runs it.
        if (mechanismAdmitted(kind, member)) {
          assert.equal(status, 0, stderr);
          assert.equal(stderr.includes(SENTINEL), executes, stderr);
        } else {
          assert.notEqual(status, 0);
          assert.ok(!stderr.includes(SENTINEL), stderr);
          assert.match(stderr, /resolves outside the root's inventory/u);
        }
      } finally {
        work.done();
      }
    });

// Outside the guarantee (D3), each named here and in docs/TESTING.md: the resolve hook never sees what these execute.
const ESCAPES = [
  "Worker",
  "child process",
  "`vm` source",
  "hook the root registers",
  "addon",
] as const;

test("the execution escapes outside the guarantee are each named in the documentation", () => {
  const testing = fs.readFileSync(path.join(checkout, "docs/TESTING.md"), "utf8");
  const section = testing.slice(testing.indexOf("## Runtime pipeline oracle"));
  for (const escape of ESCAPES)
    assert.ok(section.includes(escape), `docs/TESTING.md names ${escape}`);
});
