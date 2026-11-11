// The stamp of the Player test bundle's sources, `dist/player-test-modules/sources.json`, and the plugin that writes it.
// `tests/helpers/player-modules.ts` refuses a bundle whose stamp differs from the checkout's walk, so a compiled test
// cannot run against Player or engine code older than its own.
//
// The stamp covers locations, not the bundle's module graph: every file under `src/` and `player/` (no folder named
// `node_modules` is entered) and every root entry except the checkout's own bookkeeping (`ROOT_BOOKKEEPING`). A root
// entry is a regular file, or a link to one, directly in the repository root; a folder, or a link to a folder (such as
// the `node_modules` that `check-changed` links into a worktree), is not. Each is recorded by its path from the root with `/`: a file by the SHA-256 of its content; a
// symlink to a file by its target's identity (its path from the root, or its absolute path outside it) and that content;
// a symlink to a folder, a broken symlink, or an unreadable entry by what it is, which fails the build. The set of paths
// is part of the stamp, so an added, removed or renamed file is a change.
//
// The build also fails, so that no input of another kind passes unstamped, on: a bundled module outside the area that
// is neither under `node_modules` nor a bundler module (`\0`); a configuration file or a file it imports outside the
// area; a bundled module with a query or of a type other than `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs` or `.json`;
// a `tsconfig*.json` in the area, or a file it reaches by local `extends` or `references`, that cannot be read, has a
// malformed edge, or reaches outside the area.
//
// The check attests the stamped file set, contents and link identities under the canonical build invocation
// (`npm run build:player-test-modules`). Not attested: another CLI or API mode or inline options; files that
// configuration or plugin code reads outside the area; environment variables, `node_modules`, Node's version; a change
// during configuration loading or the build. The walk runs at `buildStart`, after Vite has loaded the configuration and
// read the `.env` files, so the inputs must be stable from configuration loading through the build.

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

/**
 * The checkout's own bookkeeping in the root, not stamped: the machinery that makes a checkout writes it after the
 * build, and no build reads it. Each with its reason.
 */
const ROOT_BOOKKEEPING = new Map([
  [".git", "the checkout's pointer to its repository, which differs between any two checkouts"],
  [".sha", "the queue's tree marker: the commit the tree was made from"],
  [".complete", "the queue's tree marker: the tree is complete"],
]);
/** The folders, under the root, that the stamp walks. */
const AREA_FOLDERS = ["src", "player"];
/** The module forms the build admits: a plain file the bundler reads as it is. */
const ADMITTED = /\.(?:[cm]?ts|[cm]?js|json)$/u;
/** What a stamp entry is when it is not a file the build can read; the build refuses these. */
const UNSTAMPABLE = /^(?:folder link|broken link|unreadable) /u;

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const slashes = (path: string) => path.replaceAll("\\", "/");

/** The stamp entry of one path: its content's hash, a link's target and hash, or what keeps it from being read. */
function entry(root: string, path: string): string {
  try {
    if (!lstatSync(path).isSymbolicLink()) return sha256(path);
    if (!existsSync(path))
      return `broken link ${slashes(resolve(dirname(path), readlinkSync(path)))}`;
    // A target in the checkout by its path from the root, one outside it by its absolute path: both stay as they are when
    // the checkout moves.
    const target = realpathSync(path);
    const inside = relative(root, target);
    const identity = slashes(
      isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`) ? target : inside,
    );
    if (statSync(path).isDirectory()) return `folder link ${identity}`;
    return `link ${identity} ${sha256(path)}`;
  } catch {
    return `unreadable ${slashes(relative(root, path))}`;
  }
}

/** The stamp of the area under `root`: path from the root to entry, in path order. */
export function walkSources(checkout: string): Map<string, string> {
  // Link targets are named from the root's real path, as whichever path reached the checkout.
  const root = realpathSync(checkout);
  const stamp = new Map<string, string>();
  const add = (path: string) => stamp.set(slashes(relative(root, path)), entry(root, path));
  const walk = (folder: string) => {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, item.name);
      if (item.name === "node_modules") continue;
      if (item.isDirectory()) walk(path);
      else add(path);
    }
  };
  // The root's folders, and its links to folders (a linked `node_modules`), are not its files.
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory() || ROOT_BOOKKEEPING.has(item.name)) continue;
    if (item.isSymbolicLink() && existsSync(path) && statSync(path).isDirectory()) continue;
    add(path);
  }
  // An area folder is walked when it is a folder; a link in its place is judged as any entry, so a link to a folder fails.
  for (const folder of AREA_FOLDERS) {
    const path = join(root, folder);
    const status = lstatSync(path, { throwIfNoEntry: false });
    if (status?.isDirectory() === true) walk(path);
    else if (status !== undefined) add(path);
  }
  return new Map([...stamp].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Whether `file` (absolute) lies in the stamped area of `root`. */
function inArea(root: string, file: string): boolean {
  const path = relative(root, file);
  const parts = slashes(path).split("/");
  const first = parts[0] ?? "";
  if (isAbsolute(path) || first === "" || first === ".." || parts.includes("node_modules"))
    return false;
  return parts.length === 1 ? !ROOT_BOOKKEEPING.has(first) : AREA_FOLDERS.includes(first);
}

const dependency = (file: string) => slashes(file).includes("/node_modules/");

/**
 * The local files a `tsconfig*.json` reaches by `extends` and `references`, recursively; throws on a file that cannot
 * be read, a malformed edge, or a target outside the area. A reference is always a local path; an `extends` that is no
 * relative or absolute path names a package, a dependency, and ends the walk.
 */
async function tsconfigClosure(root: string, start: string, seen: Set<string>): Promise<void> {
  if (seen.has(start)) return;
  seen.add(start);
  const { default: ts } = await import("typescript-vue");
  const parsed = ts.parseConfigFileTextToJson(start, readFileSync(start, "utf8"));
  if (parsed.error !== undefined || typeof parsed.config !== "object" || parsed.config === null)
    throw new Error(`${start} cannot be read as a tsconfig`);
  const config: Record<string, unknown> = parsed.config;
  const edges: string[] = [];
  const local = (edge: string) => edge.startsWith(".") || isAbsolute(edge);
  const extendsValue = config.extends;
  if (typeof extendsValue === "string") edges.push(...[extendsValue].filter(local));
  else if (Array.isArray(extendsValue) && extendsValue.every((each) => typeof each === "string"))
    edges.push(...extendsValue.filter(local));
  else if (extendsValue !== undefined) throw new Error(`${start} has a malformed "extends"`);
  const references = config.references;
  if (references !== undefined) {
    if (!Array.isArray(references)) throw new Error(`${start} has malformed "references"`);
    for (const reference of references) {
      const path: unknown =
        typeof reference === "object" && reference !== null && "path" in reference
          ? reference.path
          : undefined;
      if (typeof path !== "string") throw new Error(`${start} has a malformed reference`);
      edges.push(path);
    }
  }
  for (const edge of edges) {
    const base = resolve(dirname(start), edge);
    const target = [base, `${base}.json`, join(base, "tsconfig.json")].find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    );
    if (target === undefined) throw new Error(`${start} reaches ${edge}, which does not resolve`);
    if (!inArea(root, realpathSync(target)) || !inArea(root, target))
      throw new Error(`${start} reaches ${target}, outside the stamped area`);
    await tsconfigClosure(root, target, seen);
  }
}

/** The Vite plugin that checks the build's inputs against the area and writes `sources.json`. */
export function testModulesSources(): Plugin {
  let config: ResolvedConfig;
  let stamp = new Map<string, string>();
  return {
    name: "test-modules-sources",
    config: () => ({ resolve: { preserveSymlinks: true } }),
    configResolved(resolved) {
      config = resolved;
    },
    async buildStart() {
      const { root } = config;
      stamp = walkSources(root);
      for (const [path, value] of stamp)
        if (UNSTAMPABLE.test(value))
          this.error(`test-modules-sources: ${path} cannot be stamped (${value})`);
      for (const file of config.configFileDependencies)
        if (!dependency(file) && !inArea(root, file))
          this.error(
            `test-modules-sources: the configuration reads ${file}, outside the stamped area`,
          );
      const seen = new Set<string>();
      for (const path of stamp.keys())
        if (/(?:^|\/)tsconfig[^/]*\.json$/u.test(path))
          try {
            await tsconfigClosure(root, join(root, path), seen);
          } catch (error) {
            this.error(
              `test-modules-sources: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
    },
    // Written by hand, as Vite emits no assets from a server-side build, and last, after any other stamping plugin.
    writeBundle: {
      order: "post",
      sequential: true,
      handler(options, bundle) {
        if (options.dir === undefined)
          this.error("test-modules-sources: the build has no output folder");
        for (const output of Object.values(bundle))
          if (output.type === "chunk")
            for (const id of output.moduleIds) {
              if (id.startsWith("\0") || dependency(id)) continue;
              if (id.includes("?") || !ADMITTED.test(id))
                this.error(`test-modules-sources: ${id} is a form the stamp does not cover`);
              if (!inArea(config.root, id))
                this.error(`test-modules-sources: ${id} is bundled from outside the stamped area`);
            }
        writeFileSync(
          join(options.dir, "sources.json"),
          `${JSON.stringify(Object.fromEntries(stamp), null, 1)}\n`,
        );
      },
    },
  };
}
