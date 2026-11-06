// Which files a runtime-oracle root may load (docs/TESTING.md "Runtime pipeline oracle"). One rule, used both before a
// run (to refuse a root) and by the run's resolve hook (to refuse an import): a root loads Node's built-ins, its own
// built files, and the files of the packages its own lockfile installs, and nothing else.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The lockfile key of `file`, a real path under `dependencies` (the real path of a root's `node_modules`): the longest
 * `node_modules/<name>` or `node_modules/@scope/<name>` chain it lies in, as npm keys its lockfile, such as
 * `node_modules/a/node_modules/@s/b`. A package's own subdirectories, also one with a `package.json` of its own, stay
 * that package's; each nested `node_modules` starts another. `null` outside `dependencies`, or for a file directly in it.
 */
export function ownerKey(file, dependencies) {
  const relative = path.relative(dependencies, file);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep);
  const key = [];
  let index = 0;
  for (;;) {
    const name = parts[index]?.startsWith("@")
      ? parts.slice(index, index + 2)
      : parts.slice(index, index + 1);
    // A file directly in a `node_modules` or a scope directory belongs to no package.
    if (index + name.length >= parts.length) return null;
    key.push("node_modules", ...name);
    index += name.length;
    if (parts[index] !== "node_modules") return key.join("/");
    index += 1;
  }
}

/**
 * The packages `root`'s lockfile installs, each checked against what is installed: a locked entry is present at its
 * locked version, or absent only when the lockfile marks it optional. Throws naming the first entry that does not
 * hold. Returns the real path of the root's `node_modules` (or `null` without one) and the admitted lockfile keys.
 */
export function lockedPackages(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  if (lock.lockfileVersion !== 3 || typeof lock.packages !== "object")
    throw new Error(`${root}: package-lock.json is not a lockfile of version 3`);
  const modules = path.join(root, "node_modules");
  const dependencies = fs.existsSync(modules) ? fs.realpathSync(modules) : null;
  const admitted = new Set();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "") continue;
    if (!key.startsWith("node_modules/"))
      throw new Error(`${root}: lockfile entry '${key}' is outside node_modules`);
    if (entry.link)
      throw new Error(
        `${root}: lockfile entry '${key}' is a link, which the oracle does not admit`,
      );
    const installed =
      dependencies === null ? null : path.join(dependencies, key.slice("node_modules/".length));
    const manifest = installed === null ? null : path.join(installed, "package.json");
    if (manifest === null || !fs.existsSync(manifest)) {
      if (entry.optional || entry.devOptional) continue;
      throw new Error(`${root}: the locked package '${key}' is not installed`);
    }
    const version = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
    if (version !== entry.version)
      throw new Error(`${root}: '${key}' is installed at ${version}, locked at ${entry.version}`);
    admitted.add(key);
  }
  return { dependencies, admitted };
}

/**
 * The inventory a root runs with: its built files (real paths) and its locked packages. `builtFiles` are paths
 * relative to `root`.
 */
export function inventory(root, builtFiles) {
  const files = new Set(builtFiles.map((file) => fs.realpathSync(path.join(root, file))));
  return { root: fs.realpathSync(root), files, ...lockedPackages(root) };
}

/** Whether a root with `admittedInventory` may load the module at `url`; the one decision every check uses. */
export function admits(admittedInventory, url) {
  if (url.startsWith("node:")) return true;
  if (!url.startsWith("file:")) return false;
  let file;
  try {
    file = fs.realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
  if (admittedInventory.files.has(file)) return true;
  if (admittedInventory.dependencies === null) return false;
  const owner = ownerKey(file, admittedInventory.dependencies);
  return owner !== null && admittedInventory.admitted.has(owner);
}
