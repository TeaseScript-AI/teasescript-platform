// The build closure of a runtime-oracle root (docs/TESTING.md "Runtime pipeline oracle"): the built modules its entries
// import, statically or with `import()`, read with the root's own TypeScript, and the sources and build inputs they come
// from, each hashed.

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * What the oracle loads from a root: authoring, playback, both type backends, the core's test allowance, and the
 * runtime's JSON writer for plans.
 */
export const ENTRIES = [
  "src/index.ts",
  "src/playback.ts",
  "src/compiler.ts",
  "src/type-inference/legacy-rounds.ts",
  "src/type-inference/core/backend.ts",
  "src/type-inference/core/budget.ts",
  "src/runtime/snapshot/checkpoint-json.ts",
];

/** The files besides the sources that decide what a root's build emits. */
export const BUILD_INPUTS = [
  "package.json",
  "package-lock.json",
  ".nvmrc",
  "tsconfig.json",
  "tools/clean-compiled-tests.mjs",
];

export const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const hashFile = (file) => sha256(fs.readFileSync(file));

/** The built file of a source path, as `tsc` emits it into `dist/`. */
export const builtPath = (source) => `dist/${source.replace(/\.(m?)ts$/u, ".$1js")}`;

/** The source path of a built file, `null` when the root has none for it. */
function sourceOf(root, built) {
  const relative = built.replace(/^dist\//u, "");
  for (const candidate of [relative.replace(/\.(m?)js$/u, ".$1ts"), relative])
    if (fs.existsSync(path.join(root, candidate))) return candidate;
  return null;
}

/**
 * The closure of `entries` (source paths) in `root`'s build: the built files (relative to `root`, in the order they
 * were reached), the sources they come from, and the build inputs, each with its SHA-256. Bare specifiers name packages,
 * which the lockfile vouches for (`admission.mjs`); every relative import is followed.
 */
export function closure(root, entries = ENTRIES) {
  const ts = createRequire(path.join(root, "package.json"))("typescript");
  const built = [];
  const seen = new Set();
  const pending = entries.map(builtPath);
  while (pending.length > 0) {
    const file = pending.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) throw new Error(`${root}: the build has no ${file}`);
    built.push(file);
    if (!/\.(m?)js$/u.test(file)) continue;
    const imports = ts.preProcessFile(fs.readFileSync(absolute, "utf8"), true, true).importedFiles;
    for (const { fileName } of imports) {
      if (!fileName.startsWith(".")) continue;
      pending.push(
        path
          .relative(root, path.resolve(path.dirname(absolute), fileName))
          .split(path.sep)
          .join("/"),
      );
    }
  }
  const output = Object.fromEntries(built.map((file) => [file, hashFile(path.join(root, file))]));
  const sources = {};
  for (const file of built) {
    const source = sourceOf(root, file);
    if (source === null) throw new Error(`${root}: no source for the built ${file}`);
    sources[source] = hashFile(path.join(root, source));
  }
  for (const input of BUILD_INPUTS) sources[input] = hashFile(path.join(root, input));
  return { output, sources };
}
