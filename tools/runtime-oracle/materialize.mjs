// Acquires, builds and checks the runtime oracle's frozen root (docs/TESTING.md "Runtime pipeline oracle").
//
//   node tools/runtime-oracle/materialize.mjs [--manifest FILE] [--from DIR]   materializes the manifest's root, or
//       adopts DIR (a built tree of the same commit, such as sx-tree's) after the same checks; prints the root
//   node tools/runtime-oracle/materialize.mjs --seal COMMIT --label provisional|final [--seam SHA] [--out FILE]
//       writes tools/runtime-oracle/manifest.json (or FILE) for COMMIT, from a root acquired and built afresh, with that
//       root's own results; a root already in the oracle home is never sealed
//
// The root is $RUNTIME_ORACLE_HOME/<commit>, by default ~/.cache/teasescript/runtime-oracle/<commit>: outside the
// checkout, so no tool of the checkout reads it. It is the commit's tree (`git archive`, no `.git`), installed from its
// own lockfile and built with its own `build:typescript`. A root is used only after its closure, build output and
// installed packages match the manifest, whatever its receipt says.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../benchmark-runtime.mjs";
import { inventory } from "./admission.mjs";
import { closure, ENTRIES, sha256 } from "./closure.mjs";

export const checkout = fileURLToPath(new URL("../..", import.meta.url));
export const defaultManifest = path.join(checkout, "tools", "runtime-oracle", "manifest.json");
const runner = fileURLToPath(new URL("run.mjs", import.meta.url));

/** The checkout's files whose bytes decide the oracle's results besides the root: its tooling and its cases. */
export const TOOLING = [
  "tools/runtime-oracle/admission.mjs",
  "tools/runtime-oracle/closure.mjs",
  "tools/runtime-oracle/compare.mjs",
  "tools/runtime-oracle/materialize.mjs",
  "tools/runtime-oracle/run.mjs",
  "tools/benchmark-runtime.mjs",
];

export function oracleHome() {
  if (process.env.RUNTIME_ORACLE_HOME) return path.resolve(process.env.RUNTIME_ORACLE_HOME);
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cache, "teasescript", "runtime-oracle");
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();

/** The files the cases name, with their bytes, in the order `cases.json` lists them. */
export function caseInputs(casesFile) {
  const cases = JSON.parse(fs.readFileSync(casesFile, "utf8")).cases;
  const files = {};
  for (const testCase of cases)
    for (const file of testCase.files)
      if (file.file !== undefined)
        files[file.file] = sha256(fs.readFileSync(path.join(checkout, file.file)));
  return files;
}

/** The hashes of the oracle's tooling and inputs in this checkout, as a manifest records them. */
export function checkoutHashes(casesFile) {
  return {
    tooling: Object.fromEntries(
      TOOLING.map((file) => [file, sha256(fs.readFileSync(path.join(checkout, file)))]),
    ),
    cases: { file: path.relative(checkout, casesFile), sha256: sha256(fs.readFileSync(casesFile)) },
    inputs: caseInputs(casesFile),
  };
}

/** The cases of `casesFile` (those `only` names, when given) with every named file's text, as the runner takes them. */
function casesWithText(casesFile, only = null) {
  const cases = JSON.parse(fs.readFileSync(casesFile, "utf8")).cases;
  for (const name of only ?? [])
    if (!cases.some((testCase) => testCase.name === name)) throw new Error(`no case '${name}'`);
  return cases
    .filter((testCase) => only === null || only.includes(testCase.name))
    .map((testCase) => ({
      ...testCase,
      sources: testCase.files.map((file) => ({
        path: file.path,
        source: file.source ?? fs.readFileSync(path.join(checkout, file.file), "utf8"),
      })),
    }));
}

/**
 * Runs every case of `casesFile` through `root`'s pipeline in a process of its own that may load only `builtFiles`
 * and the root's locked packages. Returns the runner's report and each result's digest.
 */
export function runRoot(
  root,
  builtFiles,
  casesFile,
  { replace = [], only = null, timed = 0 } = {},
) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-oracle-"));
  try {
    const files = path.join(scratch, "files.json");
    fs.writeFileSync(files, JSON.stringify(builtFiles));
    const child = spawnSync(
      process.execPath,
      [
        runner,
        "--root",
        root,
        "--files",
        files,
        ...(timed > 0 ? ["--timed", String(timed)] : []),
        ...replace.flatMap((item) => ["--replace", item]),
      ],
      {
        input: JSON.stringify(casesWithText(casesFile, only)),
        encoding: "utf8",
        maxBuffer: 1 << 28,
      },
    );
    if (child.status !== 0)
      throw new Error(
        `the run of ${root} failed (${child.status}): ${child.stderr.trim().slice(0, 2000)}`,
      );
    const report = JSON.parse(child.stdout);
    const digests = Object.fromEntries(
      Object.entries(report.results).map(([key, value]) => [key, sha256(canonicalJson(value))]),
    );
    return { ...report, digests };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** What a root's build tools are, as its receipt records them. */
function toolIdentity(root) {
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  return {
    node: process.version,
    npm: run("npm", ["--version"], { cwd: root }),
    typescript: JSON.parse(
      fs.readFileSync(path.join(root, "node_modules", "typescript", "package.json"), "utf8"),
    ).version,
    tscShowConfigSha256: sha256(run(process.execPath, [tsc, "--showConfig"], { cwd: root })),
  };
}

/**
 * The closure a seal certifies: discovered from `entries` in the freshly built `root`, and admitted only when every
 * discovered declaration is the root's own (admission.mjs's `inventory`): discovery proposes, it never authorizes.
 */
export function sealedClosure(root, entries) {
  const found = closure(root, entries);
  inventory(root, [...Object.keys(found.output), ...Object.keys(found.sources)]);
  return found;
}

/**
 * Checks `root` against `manifest`: its closure's sources and build inputs, its built output, and its installed
 * packages. Throws naming the first difference.
 */
export function verify(root, manifest) {
  // Every file the manifest declares must be the root's own, really where it says, before its bytes count; its locked
  // packages are checked with the same inventory (admission.mjs). Then the root's discovered closure must equal them.
  inventory(root, [...Object.keys(manifest.output), ...Object.keys(manifest.closure)]);
  const found = closure(root, manifest.entries);
  for (const [kind, expected, actual] of [
    ["closure", manifest.closure, found.sources],
    ["output", manifest.output, found.output],
  ]) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys)
      if (expected[key] !== actual[key])
        throw new Error(
          `${root}: ${kind} file ${key} is ${actual[key] ?? "missing"}, the manifest has ${expected[key] ?? "none"}`,
        );
  }
  const nvmrc = fs.readFileSync(path.join(root, ".nvmrc"), "utf8").trim();
  if (nvmrc !== manifest.node)
    throw new Error(`${root}: .nvmrc says ${nvmrc}, the manifest ${manifest.node}`);
}

/** Acquires and builds `commit` into a new root under `home`; returns its path. */
/**
 * The full SHA of `commit`, fetched first when this checkout does not have it, such as CI's shallow checkout. A commit
 * to fetch is given by its full SHA, since a remote does not resolve an abbreviated one.
 */
function present(commit) {
  try {
    run("git", ["-C", checkout, "cat-file", "-e", `${commit}^{commit}`]);
  } catch {
    run("git", ["-C", checkout, "fetch", "--no-tags", "--depth=1", "origin", commit]);
  }
  return run("git", ["-C", checkout, "rev-parse", `${commit}^{commit}`]);
}

function acquire(commit, home, expectedTree) {
  const root = path.join(home, commit);
  present(commit);
  const tree = run("git", ["-C", checkout, "rev-parse", `${commit}^{tree}`]);
  if (expectedTree !== null && tree !== expectedTree)
    throw new Error(`${commit} has tree ${tree}, the manifest ${expectedTree}`);
  fs.mkdirSync(home, { recursive: true });
  const building = fs.mkdtempSync(path.join(home, `${commit}.building-`));
  execFileSync(
    "bash",
    ["-c", 'git -C "$0" archive "$1" | tar -x -C "$2"', checkout, commit, building],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: building });
  run("npm", ["run", "build:typescript"], {
    cwd: building,
    env: { ...process.env, BUILD_SOURCEMAPS: "0" },
  });
  fs.rmSync(root, { recursive: true, force: true });
  fs.renameSync(building, root);
  return { root, tree };
}

/** The verified root of `manifest`: materialized under the oracle home, or `from` when given. */
export function materialize(manifest, { from = null } = {}) {
  const root = from === null ? path.join(oracleHome(), manifest.commit) : path.resolve(from);
  const receipt = path.join(root, "materialized.json");
  if (from === null && !fs.existsSync(receipt))
    acquire(manifest.commit, oracleHome(), manifest.tree);
  verify(root, manifest);
  if (!fs.existsSync(receipt))
    fs.writeFileSync(
      receipt,
      `${JSON.stringify({ commit: manifest.commit, tools: toolIdentity(root) }, null, 2)}\n`,
    );
  return root;
}

function parse(argv) {
  const options = {
    manifest: defaultManifest,
    from: null,
    seal: null,
    label: null,
    seam: null,
    out: defaultManifest,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new Error(`${name} needs a value`);
    if (name === "--manifest") options.manifest = path.resolve(value);
    else if (name === "--from") options.from = value;
    else if (name === "--seal") options.seal = value;
    else if (name === "--label") options.label = value;
    else if (name === "--seam") options.seam = value;
    else if (name === "--out") options.out = path.resolve(value);
    else throw new Error(`unknown option ${name}`);
  }
  return options;
}

/**
 * Writes the manifest of `commit` to `out`: the closure, output and packages of a root acquired and built afresh for it,
 * never one found in the oracle home, and that root's own results.
 */
async function seal({ seal: commit, label, seam, out }) {
  if (label !== "provisional" && label !== "final")
    throw new Error("--label is provisional or final");
  if (label === "final" && seam === null) throw new Error("a final seal names its --seam");
  const full = present(commit);
  const { root, tree } = acquire(full, oracleHome(), null);
  const found = sealedClosure(root, ENTRIES);
  const casesFile = path.join(checkout, "tools", "runtime-oracle", "cases.json");
  const lockfile = fs.readFileSync(path.join(root, "package-lock.json"));
  const manifest = {
    schema: 1,
    seal: label,
    commit: full,
    tree,
    seam,
    hostClosure: "deferred to the final seal",
    node: fs.readFileSync(path.join(root, ".nvmrc"), "utf8").trim(),
    lockfile: { path: "package-lock.json", sha256: sha256(lockfile) },
    build: { command: ["npm", "run", "build:typescript"], env: { BUILD_SOURCEMAPS: "0" } },
    entries: ENTRIES,
    closure: found.sources,
    output: found.output,
    ...checkoutHashes(casesFile),
    formats: null,
    results: {},
  };
  const ran = runRoot(root, Object.keys(found.output), casesFile);
  manifest.formats = ran.formats;
  manifest.results = ran.digests;
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  materialize(manifest);
  return out;
}

if (import.meta.main) {
  try {
    const options = parse(process.argv.slice(2));
    if (options.seal !== null) console.log(await seal(options));
    else console.log(materialize(JSON.parse(fs.readFileSync(options.manifest, "utf8")), options));
  } catch (error) {
    console.error(`runtime oracle: ${error.message}`);
    process.exit(2);
  }
}
