// The stamp of the Player test bundle's sources, `dist/player-test-modules/sources.json`, and the plugin that writes it.
// `tests/helpers/player-modules.ts` refuses a bundle whose stamp differs from the checkout's walk, so a compiled test
// cannot run against Player or engine code older than its own.
//
// The stamp covers locations, not the bundle's module graph: every file under `src/` and `player/` (a folder named
// `node_modules`, or a link to one, is not entered; a file of that name is an entry) and every root entry except the
// checkout's own bookkeeping (`ROOT_BOOKKEEPING`). A root entry is a regular file, or a link to one, directly in the
// repository root; a folder, or a link to a folder (such as the `node_modules` that `check-changed` links into a
// worktree), is not. Each is recorded by its path from the root with `/`: a file by the SHA-256 of its content; a
// symlink to a file by its target's identity (its path from the root, or its absolute path outside it) and that
// content; a symlink to a folder, a broken symlink, or an unreadable entry by what it is, which fails the build. The
// set of paths is part of the stamp, so an added, removed or renamed file is a change.
//
// The build also fails, so that no input of another kind passes unstamped, on: a bundled module outside the area that
// is neither under `node_modules` nor a bundler module (`\0`); an `envDir` outside the area; a configuration file or a
// file it imports outside the area; a bundled module with a query or of a type other than `.ts`, `.mts`, `.cts`, `.js`,
// `.mjs`, `.cjs` or `.json`; a `tsconfig*.json` in the area, or a file it reaches by `extends` or `references` as
// TypeScript resolves them, that TypeScript reports a diagnostic on, cannot be read, or lies outside the area (an
// `extends` target may be a package's).
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

const folderLink = (path: string) =>
  lstatSync(path).isSymbolicLink() && existsSync(path) && statSync(path).isDirectory();

/** The stamp of the area under `root`: path from the root to entry, in path order. */
export function walkSources(checkout: string): Map<string, string> {
  // Link targets are named from the root's real path, as whichever path reached the checkout.
  const root = realpathSync(checkout);
  const stamp = new Map<string, string>();
  const add = (path: string) => stamp.set(slashes(relative(root, path)), entry(root, path));
  // Only a folder named `node_modules`, or a link to one, is not entered; a file of that name is an entry like any other.
  const walk = (folder: string) => {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, item.name);
      if (item.isDirectory()) {
        if (item.name !== "node_modules") walk(path);
      } else if (item.name !== "node_modules" || !folderLink(path)) add(path);
    }
  };
  // The root's folders, and its links to folders (a linked `node_modules`), are not its files.
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory() || ROOT_BOOKKEEPING.has(item.name)) continue;
    if (!folderLink(path)) add(path);
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
  // A folder named `node_modules` on the way is a dependency's; a file of that name is not.
  if (
    isAbsolute(path) ||
    first === "" ||
    first === ".." ||
    parts.slice(0, -1).includes("node_modules")
  )
    return false;
  return parts.length === 1 ? !ROOT_BOOKKEEPING.has(first) : AREA_FOLDERS.includes(first);
}

/** Whether `file` lies in a folder named `node_modules`: a dependency's. */
const dependency = (file: string) => slashes(file).includes("/node_modules/");

/** The files a parsed `tsconfig*.json` extends, as TypeScript resolved them (its `configFile`, typed only internally). */
export function extendedFiles(options: Record<string, unknown>): string[] {
  const { configFile } = options;
  const files: unknown =
    typeof configFile === "object" && configFile !== null && "extendedSourceFiles" in configFile
      ? configFile.extendedSourceFiles
      : undefined;
  return Array.isArray(files) ? files.filter((file) => typeof file === "string") : [];
}

/**
 * Checks the files a `tsconfig*.json` reaches by `extends` and `references`, recursively, as TypeScript itself resolves
 * them (`getParsedCommandLineOfConfigFile`, `resolveProjectReferencePath`); throws on a diagnostic of the file, or on a
 * target that cannot be read or lies outside the area. An `extends` target may be a package's, under `node_modules`.
 */
export async function tsconfigClosure(
  root: string,
  start: string,
  seen = new Set<string>(),
): Promise<void> {
  if (seen.has(start)) return;
  seen.add(start);
  const { default: ts } = await import("typescript-vue");
  const diagnostics: string[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(start, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) =>
      diagnostics.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")),
  });
  // "No inputs were found" (18003) concerns the files the configuration compiles, not the configuration.
  for (const diagnostic of parsed?.errors ?? [])
    if (diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.code !== 18003)
      diagnostics.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
  if (parsed === undefined || diagnostics.length > 0)
    throw new Error(`${start} cannot be read as a tsconfig: ${diagnostics.join("; ")}`);
  const readable = (target: string) => existsSync(target) && statSync(target).isFile();
  const inside = (target: string) => inArea(root, realpathSync(target)) && inArea(root, target);
  for (const target of extendedFiles(parsed.options))
    if (!readable(target) || !(inside(target) || dependency(realpathSync(target))))
      throw new Error(`${start} extends ${target}, outside the stamped area or unreadable`);
  for (const reference of parsed.projectReferences ?? []) {
    const target = ts.resolveProjectReferencePath(reference);
    if (!readable(target) || !inside(target))
      throw new Error(`${start} references ${target}, outside the stamped area or unreadable`);
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
      // Vite reads the `.env` files of `envDir` (`false` reads none); they are stamped as files of that folder.
      if (config.envDir !== false && !inArea(root, join(config.envDir, ".env")))
        this.error(
          `test-modules-sources: the configuration reads .env files from ${config.envDir}, outside the stamped area`,
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
