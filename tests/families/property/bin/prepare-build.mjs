#!/usr/bin/env node
// node bin/prepare-build.mjs /existing/repo HEX_REF_OR_tree:SHA /new/output [--library REF]
// Local source acquisition is read-only. Output is a NEW disposable directory, never a working branch. `--library REF`
// adds the corpus runner's oracle library (`tests/helpers/type-core-oracles.ts`) from REF to a tree that has none (one
// before #1427), so that `tests/families/run.mjs` can compare it; the seal records the file and where it came from.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { directoryHash } from "../lib/build.mjs";
import { hash, writeJson } from "../lib/json.mjs";
const LIBRARY = "tests/helpers/type-core-oracles.ts";
const args = process.argv.slice(2);
const at = args.indexOf("--library");
const library = at === -1 ? undefined : args[at + 1];
const [repo, ref, out, ...extra] = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
function exec(command, args, options = {}) {
  const r = spawnSync(command, args, { maxBuffer: 128 * 1024 * 1024, ...options });
  if (r.status !== 0) throw new Error(`${command}: ${r.stderr?.toString()}`);
  return r.stdout;
}
try {
  if (
    !repo ||
    !out ||
    extra.length > 0 ||
    !/^(?:tree:)?[0-9a-f]{7,40}$/.test(ref ?? "") ||
    (at !== -1 && !/^[0-9a-f]{7,40}$/.test(library ?? ""))
  )
    throw new Error(
      "Usage: node bin/prepare-build.mjs /existing/repo HEX_REF_OR_tree:SHA /new/output [--library HEX_REF]",
    );
  const prepareStart = performance.now();
  const isTree = ref.startsWith("tree:");
  const commit = isTree
    ? null
    : exec("git", ["-C", resolve(repo), "rev-parse", `${ref}^{commit}`])
        .toString()
        .trim();
  const tree = exec("git", [
    "-C",
    resolve(repo),
    "rev-parse",
    `${isTree ? ref.slice(5) : commit}^{tree}`,
  ])
    .toString()
    .trim();
  mkdirSync(resolve(out), { recursive: false });
  const archive = exec("git", ["-C", resolve(repo), "archive", "--format=tar", tree]);
  exec("tar", ["-xf", "-", "-C", resolve(out)], { input: archive });
  const sourceHash = directoryHash(resolve(out));
  let overlay = null;
  if (library !== undefined && !existsSync(join(resolve(out), LIBRARY))) {
    const from = exec("git", ["-C", resolve(repo), "rev-parse", `${library}^{commit}`])
      .toString()
      .trim();
    const text = exec("git", ["-C", resolve(repo), "show", `${from}:${LIBRARY}`]);
    writeFileSync(join(resolve(out), LIBRARY), text);
    overlay = { path: LIBRARY, commit: from, sha256: hash(text.toString("base64")) };
  }
  symlinkSync(join(resolve(repo), "node_modules"), join(resolve(out), "node_modules"), "dir");
  const prepareMs = performance.now() - prepareStart;
  const start = performance.now();
  const built = spawnSync(
    process.execPath,
    [join(resolve(repo), "node_modules/typescript/lib/tsc.js")],
    { cwd: resolve(out), encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180000 },
  );
  writeFileSync(
    join(resolve(out), "pilot-build.log"),
    `${built.stdout ?? ""}${built.stderr ?? ""}`,
  );
  if (built.status !== 0)
    throw new Error(
      `TypeScript build failed (${built.status}, ${built.signal}); inspect pilot-build.log`,
    );
  const stamp = {
    schemaVersion: 1,
    commit,
    tree,
    sourceHash,
    overlay,
    distHash: directoryHash(join(resolve(out), "dist")),
    buildNode: process.versions.node,
    requiredNode: JSON.parse(readFileSync(join(resolve(out), "package.json"), "utf8")).engines.node,
    buildCommand: "node <locked local typescript>/lib/tsc.js",
    prepareMs,
    buildMs: performance.now() - start,
    sourceOrigin: "git archive from verified local repository",
    dependencyPolicy: "existing offline-installed node_modules; no install/network",
  };
  writeJson(join(resolve(out), "pilot-build.json"), stamp);
  console.log(JSON.stringify(stamp));
} catch (error) {
  console.error(error.stack);
  process.exitCode = 2;
}
