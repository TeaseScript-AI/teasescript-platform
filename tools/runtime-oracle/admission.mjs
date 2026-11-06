// Which files a runtime-oracle root may load or certify (docs/TESTING.md "Runtime pipeline oracle"). One classifier,
// `classify`, decides by a file's real location, and every site accepts from it: a load (the run's resolve hook)
// accepts a built-in, a certified file or a locked package's file; certification (a root's check before use, and the
// seal) accepts only certified files. A root's declarations are validated before they count, so a discovered closure
// proposes certified files and never authorizes them. Provenance (which bytes) is materialize.mjs's, by exact-SHA
// acquisition, fresh seals and hashes; no location rule proves it.

import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const within = (directory, file) => file.startsWith(directory + path.sep);
const segments = (relative) => relative.split(/[\\/]/u);

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
 * Whether the real path `file` is the root's own: strictly inside its canonical directory, outside its dependency
 * directory, and with no `node_modules` segment on the way, so that no package directory anywhere in the root (also
 * one under `dist/`) is the root's own.
 */
function own(rootInventory, file) {
  if (!within(rootInventory.root, file)) return false;
  if (rootInventory.dependencies !== null && within(rootInventory.dependencies, file)) return false;
  return !segments(path.relative(rootInventory.root, file)).includes("node_modules");
}

/**
 * The inventory of `root`: its canonical directory, its locked packages, and the files it declares certified
 * (`declared`, paths relative to `root`). Every declaration is validated before it counts: (a) it is relative, with no
 * `..` and no `node_modules` segment, and (b) its real path is a file of the root's own (`own`), so a link out of the
 * root never counts. Each is bound to its real path. Throws naming the first that is not, so a declaration can never
 * widen what the root admits.
 */
export function inventory(root, declared) {
  const canonical = fs.realpathSync(root);
  const base = { root: canonical, ...lockedPackages(root) };
  const files = new Set();
  for (const file of declared) {
    const parts = segments(file);
    // (a) The declared spelling is a root path; (b), below, its real path is the root's own. Each refuses what the
    // other admits: a link named `node_modules` to an owned directory, and a plain path linked into a package's.
    if (path.isAbsolute(file) || parts.includes("..") || parts.includes("node_modules"))
      throw new Error(`${canonical}: the declared file '${file}' is not a root path`);
    const at = path.join(canonical, file);
    let real;
    try {
      real = fs.realpathSync(at);
    } catch {
      throw new Error(`${canonical}: the declared file '${file}' does not exist`);
    }
    if (!own(base, real))
      throw new Error(
        `${canonical}: the declared file '${file}' is not a file of the root's own (it is ${real})`,
      );
    files.add(real);
  }
  return { ...base, files };
}

/**
 * What the file at the real path `realFile` is to a root with `rootInventory`: `"certified"` (one of its own declared
 * files), `"package <key>"` (a file of a package its lockfile installs), or `null`.
 */
export function classify(rootInventory, realFile) {
  if (rootInventory.dependencies !== null && within(rootInventory.dependencies, realFile)) {
    const owner = ownerKey(realFile, rootInventory.dependencies);
    return owner !== null && rootInventory.admitted.has(owner) ? `package ${owner}` : null;
  }
  // `files` holds only validated declarations, each a file of the root's own (`inventory`).
  return rootInventory.files.has(realFile) ? "certified" : null;
}

/** Whether a load of `url` is admitted: a genuine Node built-in, or a real file that `classify` admits. */
export function admitsUrl(rootInventory, url) {
  if (url.startsWith("node:")) return isBuiltin(url);
  if (!url.startsWith("file:")) return false;
  try {
    return classify(rootInventory, fs.realpathSync(fileURLToPath(url))) !== null;
  } catch {
    return false;
  }
}
