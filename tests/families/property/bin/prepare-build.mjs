#!/usr/bin/env node
// Local source acquisition is read-only. Output is a NEW disposable directory, never a working branch.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { directoryHash } from "../lib/build.mjs";
import { writeJson } from "../lib/json.mjs";
const [repo, ref, out] = process.argv.slice(2);
function exec(command, args, options = {}) {
  const r = spawnSync(command, args, { maxBuffer: 128 * 1024 * 1024, ...options });
  if (r.status !== 0) throw new Error(`${command}: ${r.stderr?.toString()}`);
  return r.stdout;
}
try {
  if (!repo || !out || !/^(?:tree:)?[0-9a-f]{7,40}$/.test(ref ?? ""))
    throw new Error(
      "Usage: node bin/prepare-build.mjs /existing/repo HEX_REF_OR_tree:SHA /new/output",
    );
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
  symlinkSync(join(resolve(repo), "node_modules"), join(resolve(out), "node_modules"), "dir");
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
    distHash: directoryHash(join(resolve(out), "dist")),
    buildNode: process.versions.node,
    requiredNode: JSON.parse(readFileSync(join(resolve(out), "package.json"), "utf8")).engines.node,
    buildCommand: "node <locked local typescript>/lib/tsc.js",
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
