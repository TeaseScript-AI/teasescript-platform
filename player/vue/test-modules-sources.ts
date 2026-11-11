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
// The build also fails, so that no input of another kind passes unstamped, on: a module the bundler loaded (each one in
// `getModuleIds()`, also one whose code it inlined or dropped) that lies outside the area and is neither under
// `node_modules` nor a bundler module (`\0`), or that has a query or a type other than `.ts`, `.mts`, `.cts`, `.js`,
// `.mjs`, `.cjs` or `.json`; a module left external by its path rather than by a package's or Node's name; an `envDir`
// outside the area; a public folder; a configuration file or a file it imports outside the area; a root without a `tsconfig.json`, as the compiler then reads the
// nearest one above the checkout; a `tsconfig*.json` in the area, or a file it reaches by `extends` or `references`,
// that TypeScript reports a diagnostic on, cannot be read, or lies outside the area. A local `extends` (one starting with
// `.` or `/`) must name its file: a path ending in `.json` that is a regular file, as TypeScript and Vite's compiler
// then read that file, where they choose differently for a name without it. A package's `extends` lies under
// `node_modules`, as TypeScript resolves it; a `references` target is TypeScript's.
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
 * Checks the files a `tsconfig*.json` reaches by `extends` and `references`, recursively; throws on a file TypeScript
 * cannot read, a diagnostic TypeScript places on an `extends` or `references` property, a local `extends` that does not
 * name a regular `.json` file, or a target that cannot be read or lies outside the area. A local `extends` is followed
 * by its name; every other file TypeScript extends (`getParsedCommandLineOfConfigFile`) must be a package's, under
 * `node_modules`; references are TypeScript's (`resolveProjectReferencePath`). Other diagnostics, such as a compiler
 * option this TypeScript does not know, are the compiler's to judge, not the stamp's.
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
  // Where in its file each `extends` or `references` property lies, as TypeScript parses the file.
  const edges = (file: string): (readonly [number, number])[] => {
    const statement = ts.readJsonConfigFile(file, ts.sys.readFile).statements[0];
    if (statement === undefined || !ts.isObjectLiteralExpression(statement.expression)) return [];
    return statement.expression.properties.flatMap((property) =>
      ts.isPropertyAssignment(property) &&
      ts.isStringLiteral(property.name) &&
      (property.name.text === "extends" || property.name.text === "references")
        ? [[property.pos, property.end] as const]
        : [],
    );
  };
  for (const diagnostic of parsed?.errors ?? []) {
    const { file, start: at } = diagnostic;
    if (
      diagnostic.category !== ts.DiagnosticCategory.Error ||
      file === undefined ||
      at === undefined
    )
      continue;
    if (edges(file.fileName).some(([from, to]) => at >= from && at < to))
      diagnostics.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
  }
  if (parsed === undefined || diagnostics.length > 0)
    throw new Error(`${start} cannot be read as a tsconfig: ${diagnostics.join("; ")}`);
  const readable = (target: string) => existsSync(target) && statSync(target).isFile();
  const inside = (target: string) => inArea(root, realpathSync(target)) && inArea(root, target);
  // The local files of the `extends` chain, each by the name its `extends` writes.
  const named = new Set<string>();
  const follow = (file: string) => {
    const written: unknown = ts.readConfigFile(file, ts.sys.readFile).config?.extends;
    for (const value of [written].flat()) {
      // Not a string: TypeScript's diagnostic on the property. Not local: a package's, judged below.
      if (typeof value !== "string" || !(/^[./\\]/u.test(value) || isAbsolute(value))) continue;
      const target = slashes(resolve(dirname(file), value));
      if (!value.endsWith(".json") || !readable(target))
        throw new Error(
          `${file} extends "${value}", which names no regular .json file: write the name of the file it extends, ending in .json`,
        );
      if (!inside(target)) throw new Error(`${file} extends ${target}, outside the stamped area`);
      if (!named.has(target)) {
        named.add(target);
        follow(target);
      }
    }
  };
  follow(start);
  for (const target of extendedFiles(parsed.options))
    if (
      !named.has(slashes(target)) &&
      !(readable(target) && dependency(target) && dependency(realpathSync(target)))
    )
      throw new Error(
        `${start} extends ${target}, which is neither named by an extends in the area nor a readable file of a package under node_modules`,
      );
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
  // The modules the bundler parsed; any other module it reports was left external, to be loaded when a test runs.
  const parsed = new Set<string>();
  return {
    name: "test-modules-sources",
    config: () => ({ resolve: { preserveSymlinks: true } }),
    configResolved(resolved) {
      config = resolved;
    },
    moduleParsed(info) {
      parsed.add(info.id);
    },
    async buildStart() {
      const { root } = config;
      parsed.clear();
      stamp = walkSources(root);
      for (const [path, value] of stamp)
        if (UNSTAMPABLE.test(value))
          this.error(`test-modules-sources: ${path} cannot be stamped (${value})`);
      for (const file of config.configFileDependencies)
        if (!dependency(file) && !inArea(root, file))
          this.error(
            `test-modules-sources: the configuration reads ${file}, outside the stamped area`,
          );
      // Vite's compiler reads the nearest `tsconfig.json` above a module: the root's, or one above the checkout.
      if (!stamp.has("tsconfig.json"))
        this.error(
          "test-modules-sources: the root has no tsconfig.json, so the compiler would read one above the checkout",
        );
      // Vite resolves `publicDir: false` to "".
      if (config.publicDir !== "")
        this.error(`test-modules-sources: the build has a public folder (${config.publicDir})`);
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
      handler(options) {
        if (options.dir === undefined)
          this.error("test-modules-sources: the build has no output folder");
        // Every module the bundler loaded, not only those rendered into a chunk: a module whose code it inlined or
        // dropped still decides the bundle.
        for (const id of this.getModuleIds()) {
          if (id.startsWith("\0") || dependency(id)) continue;
          if (!parsed.has(id)) {
            // Left external: a package or Node built-in by its name is loaded from `node_modules` or Node.
            if (/^[./\\]/u.test(id) || isAbsolute(id))
              this.error(
                `test-modules-sources: ${id} is left external by its path, a file the tests read that the stamp does not cover`,
              );
            continue;
          }
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
