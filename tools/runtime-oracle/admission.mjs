// Which files a runtime-oracle root may load or certify (docs/TESTING.md "Runtime pipeline oracle"). One function,
// `admit`, decides it by a file's real location, never by the shape of a path it was reached through: the run's resolve
// hook, the check of a root's built and certified files, and the seal all ask it. A root admits Node's built-ins, its
// own certified files where they really are inside its canonical directory, and the files of the packages its own
// lockfile installs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const within = (directory, file) => file.startsWith(directory + path.sep);

/**
 * The lockfile key of `file`, a real path under `dependencies` (the real path of a root's `node_modules`): the whole
 * chain up to the package after the last `node_modules` boundary in the path, as npm keys its lockfile, such as
 * `node_modules/a/node_modules/@s/b`, or `node_modules/a/lib/node_modules/c`, which npm never locks. A package's own
 * subdirectories, also one with a `package.json` of its own, stay that package's. `null` outside `dependencies`, or for a
 * file directly in a `node_modules` or scope directory.
 */
export function ownerKey(file, dependencies) {
  if (!within(dependencies, file)) return null;
  const parts = path.relative(dependencies, file).split(path.sep);
  // The package starts after the last `node_modules` in the path, or at the top of `dependencies`.
  const last = parts.lastIndexOf("node_modules");
  const start = last + 1;
  const length = parts[start]?.startsWith("@") ? 2 : 1;
  if (start + length >= parts.length) return null;
  return ["node_modules", ...parts.slice(0, start + length)].join("/");
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
 * The inventory of `root`: its canonical directory, the files it certifies (`certified`, paths relative to `root`) where
 * they must really be, and its locked packages. A certified file is admitted only at its place inside the canonical
 * directory, so a file reached through a link to elsewhere is not the root's.
 */
export function inventory(root, certified) {
  const canonical = fs.realpathSync(root);
  const files = new Set(certified.map((file) => path.join(canonical, file)));
  return { root: canonical, files, ...lockedPackages(root) };
}

/**
 * Whether a root with `rootInventory` may load or certify the file at `realFile` (a real path): the one decision every
 * check uses. Returns what admits it, or `null`.
 */
export function admit(rootInventory, realFile) {
  if (rootInventory.files.has(realFile)) return "certified";
  if (rootInventory.dependencies === null) return null;
  const owner = ownerKey(realFile, rootInventory.dependencies);
  return owner !== null && rootInventory.admitted.has(owner) ? `package ${owner}` : null;
}

/** Whether a module URL resolves to something `rootInventory` admits: a built-in, or an admitted real file. */
export function admitsUrl(rootInventory, url) {
  if (url.startsWith("node:")) return true;
  if (!url.startsWith("file:")) return false;
  try {
    return admit(rootInventory, fs.realpathSync(fileURLToPath(url))) !== null;
  } catch {
    return false;
  }
}

/**
 * Checks that every one of `certified` (relative to `root`) is really where the root says, inside its canonical
 * directory and not reached through a link: throws naming the first that is not.
 */
export function certifyFiles(rootInventory, certified) {
  for (const file of certified) {
    const real = fs.realpathSync(path.join(rootInventory.root, file));
    if (admit(rootInventory, real) !== "certified")
      throw new Error(`${rootInventory.root}: ${file} is not inside the root (it is ${real})`);
  }
}
