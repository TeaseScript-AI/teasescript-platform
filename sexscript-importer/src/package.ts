import {
  constantString,
  isAstNode,
  isRecord,
  walkAst,
  type AstNode,
  type ParsedGroovyFile,
  type SourceSpan,
} from "./ast.ts";
import type { IrExpression, IrStatement, MigrationDiagnostic, MigrationProgram } from "./ir.ts";
import { packageResources, type PackageFileReader } from "./java-data.ts";
import {
  buildHelperRegistry,
  describeMixinModule,
  loadedModuleDirectories,
  lowerParsedFile,
  packageFunctionNames,
  packageGlobalTypes,
  packageFunctionResults,
  uncalledDiagnostics,
  withUncalledNotes,
  legacyUnreferencedFunctions,
  packageMapUses,
  packageResultUses,
  packageStableNames,
  packageStopsBackgroundSounds,
  photoCopy,
  withGuardedInputs,
} from "./lower.ts";
import { helperDefinitionOrder, SYSTEM_SPEAKER, withActionDispatcher } from "./helpers.ts";
import { renameConflictingIdentifiers } from "./naming.ts";
import { legacyProfilePrompt } from "./profile.ts";
import { expressionType, functionResultTypes, type TeaseType } from "./variable-types.ts";
import type { AcceptedForm, MediaFile } from "./workarounds.ts";

const ACCEPTED_EXTERNAL_CALLS = new Set([
  "askBoolean",
  "askBooleans",
  "askInteger",
  "askNumber",
  "askText",
  "ceil",
  "chance",
  "findImages",
  "floor",
  "getDate",
  "getDateTime",
  "getTime",
  "getTimestamp",
  "max",
  "min",
  "openUrl",
  "random",
  "randomInteger",
  "removePermanentButton",
  "round",
  "showButton",
  "takePhoto",
  "toBoolean",
  "toDate",
  "toDateTime",
  "toInteger",
  "toNumber",
  "toString",
  "toTime",
  "toTimestamp",
]);

export interface PackageOptions {
  /** Accepted forms to emit instead of their workarounds (see workarounds.ts). */
  accepted?: ReadonlySet<AcceptedForm>;
  /** The package's images, which legacy image counts read at conversion time. */
  media?: readonly MediaFile[];
  /** Every file of the package's legacy data folder, relative to it, which file existence tests read. */
  files?: readonly string[];
  /** Reads a file of `files`, whose text package text reads snapshot (java-data.ts). */
  readFile?: PackageFileReader;
  /**
   * Scripts of the package that are no entries of their own, by their paths from the legacy scripts folder, such as an
   * expansion or a story chapter of an assembled unit: the generated entry menu does not offer them.
   */
  internalScripts?: readonly string[];
  /**
   * Releases of the package that a corpus merge put side by side, each the files of one release by their paths from
   * the legacy scripts folder, such as an older version of a script with its own module versions
   * (`toy__sha256_<hash>.groovy` with `toy/misc__sha256_<hash>.groovy`): a file of a release loads only that release's
   * modules, and any other file only the modules that are no other version (moduleVisibility).
   */
  releases?: ReadonlyArray<readonly string[]>;
  /**
   * A lone file converted on its own, without a package around it: it keeps its name, and a transfer names the
   * converted file of any legacy script name. Otherwise each script keeps its legacy path beside a main.tease.
   */
  standalone?: boolean;
}

/** Every literal text of the package's files. */
function packageTexts(files: readonly ParsedGroovyFile[]): Set<string> {
  const texts = new Set<string>();
  for (const file of files)
    walkAst(file.root, (node) => {
      const text = constantString(node);
      if (text !== null) texts.add(text);
    });
  return texts;
}

/**
 * The storage key under which the legacy player recorded each start of a script (FullScript.groovytemplate with
 * ScriptContainer.getMiniCurrentScriptName): its path from the scripts folder, up to the first dot, without a
 * language suffix such as `_de`, with dots for slashes. A merged variant's `__sha256_…` suffix is no part of it.
 */
function launchKey(sourceName: string): string {
  let name = sourceName.replaceAll("\\", "/").replace(/__sha256_[0-9a-f]+(?=\.[^/]*$)/u, "");
  const folder = name.lastIndexOf("scripts/");
  name =
    folder >= 0 ? name.slice(folder + "scripts/".length) : name.slice(name.lastIndexOf("/") + 1);
  if (name.includes(".")) name = name.slice(0, name.indexOf("."));
  if (name.includes("_") && name.lastIndexOf("_") > name.length - 4)
    name = name.slice(0, name.lastIndexOf("_"));
  return name.replaceAll("/", ".");
}

/**
 * The legacy player saved `<key>.launch.firsttime`, `.lasttime` (Unix seconds), and `.nb` (the number of starts) when
 * a script started. Where the package reads one of them, the script saves them first, after its leading comments.
 */
function withLaunchMarkers(
  program: MigrationProgram,
  key: string,
  texts: ReadonlySet<string>,
): MigrationProgram {
  const [first, last, count] = ["firsttime", "lasttime", "nb"].map(
    (name) => `${key}.launch.${name}`,
  );
  if (![first, last, count].some((name) => texts.has(name!))) return program;
  const now: IrExpression = {
    kind: "methodCall",
    target: { kind: "call", name: "getTimestamp", positional: [], named: {} },
    name: "toSeconds",
    arguments: [],
  };
  const literal = (value: string): IrExpression => ({ kind: "literal", value });
  const message = `The legacy player recorded each start of this script under "${key}.launch.*", which the package reads; the script saves the first and last start time and the number of starts as it did.`;
  const markers: IrStatement[] = [
    { kind: "comment", text: `// NOTE SX_LAUNCH_MARKERS: ${message}`, trailing: false, span: null },
    {
      kind: "if",
      condition: {
        kind: "binary",
        operator: "==",
        left: { kind: "load", key: literal(first!) },
        right: { kind: "literal", value: null },
      },
      then: [{ kind: "save", key: literal(first!), value: now, span: null }],
      else: [],
      span: null,
    },
    { kind: "save", key: literal(last!), value: now, span: null },
    {
      kind: "save",
      key: literal(count!),
      value: {
        kind: "binary",
        operator: "+",
        left: { kind: "load", key: literal(count!), defaultValue: { kind: "literal", value: 0 } },
        right: { kind: "literal", value: 1 },
      },
      span: null,
    },
  ];
  const leading = program.statements.findIndex((statement) => statement.kind !== "comment");
  const at = leading < 0 ? program.statements.length : leading;
  return {
    ...program,
    statements: [...program.statements.slice(0, at), ...markers, ...program.statements.slice(at)],
    diagnostics: [
      ...program.diagnostics,
      { code: "SX_LAUNCH_MARKERS", severity: "warning", message, span: null },
    ],
  };
}

/** Names of the languages that legacy file names mark with a suffix such as `_de`. */
const LANGUAGES: Readonly<Record<string, string>> = {
  de: "Deutsch",
  en: "English",
  es: "Español",
  fr: "Français",
  it: "Italiano",
  nl: "Nederlands",
  pl: "Polski",
  pt: "Português",
  ru: "Русский",
};

/**
 * The menu label of each offered script: its title from setInfos, or else its file name made readable, with the
 * language of a `_de`-style variant; a label several scripts share also names the file.
 */
function menuLabels(
  paths: readonly string[],
  scripts: PackageScripts,
  programs: readonly MigrationProgram[],
): Map<string, string> {
  const indexOf = new Map([...scripts.pathOf].map(([index, path]) => [path, index]));
  const base = (path: string): string => path.replace(/^.*\//u, "").replace(/\.tease$/u, "");
  // The language setInfos gave, else a name's language suffix (`intro_de`); named where the entries differ in it.
  const languageOf = (path: string): string | undefined => {
    const given = programs[indexOf.get(path) ?? -1]?.metadata?.language?.trim().toLowerCase();
    if (given !== undefined && LANGUAGES[given.slice(0, 2)] !== undefined) return given.slice(0, 2);
    return /_([a-z]{2})$/u.exec(base(path))?.[1];
  };
  const languages = new Set(paths.map((path) => languageOf(path) ?? "en"));
  const labels = new Map(
    paths.map((path) => {
      const title = programs[indexOf.get(path) ?? -1]?.metadata?.title?.trim() ?? "";
      const language = languages.size > 1 ? languageOf(path) : undefined;
      const readable = base(path)
        .replace(/_([a-z]{2})$/u, (suffix, code: string) =>
          LANGUAGES[code] === undefined ? suffix : "",
        )
        .replace(/[_-]+/gu, " ")
        .trim();
      const label = title !== "" ? title : readable !== "" ? readable : base(path);
      const named =
        language !== undefined && LANGUAGES[language] !== undefined
          ? `${label} (${LANGUAGES[language]})`
          : label;
      return [path, named] as const;
    }),
  );
  const counts = new Map<string, number>();
  for (const label of labels.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
  return new Map(
    [...labels].map(([path, label]) =>
      counts.get(label)! > 1
        ? [
            path,
            isOtherVersion(path)
              ? `${label} (alternate version of ${base(path.replace(SHA_VERSION, ""))}, ${/__sha256_([0-9a-f]+)/iu.exec(path)![1]!.slice(0, 6)})`
              : `${label} (${base(path)})`,
          ]
        : [path, label],
    ),
  );
}

/** The suffix by which the corpus merge kept another version of a script beside it: `name__sha256_<hash>`. */
const SHA_VERSION = /__sha256_[0-9a-f]+(?=\.tease$)/iu;

/** Whether a script is another version of a script, which the corpus merge kept beside it. */
function isOtherVersion(path: string): boolean {
  return SHA_VERSION.test(path);
}

/** The indexes of the files that `internal` names by their paths from the legacy scripts folder. */
function internalScripts(
  files: readonly ParsedGroovyFile[],
  internal: readonly string[] | undefined,
): Set<number> {
  const suffixes = (internal ?? []).map((path) => `/${path.replaceAll("\\", "/").toLowerCase()}`);
  return new Set(
    files.flatMap((file, index) => {
      const name = `/${file.sourceName.replaceAll("\\", "/").toLowerCase()}`;
      return suffixes.some((suffix) => name.endsWith(suffix)) ? [index] : [];
    }),
  );
}

/**
 * The files a converted package writes (ADR 0022): each script, and each helper class file with global functions, at
 * its legacy path from the scripts folder, and main.tease. Empty for a file converted on its own.
 */
export function packageOutputs(
  lowered: LoweredPackage,
): Array<{ path: string; program: MigrationProgram; fileIndex: number | null }> {
  const outputs = lowered.composed.flatMap(
    (
      program,
      index,
    ): Array<{ path: string; program: MigrationProgram; fileIndex: number | null }> => {
      const path = lowered.paths[index];
      return path === null || path === undefined || program.module !== undefined
        ? []
        : [{ path, program, fileIndex: index }];
    },
  );
  if (lowered.main !== null && "menu" in lowered.main)
    outputs.push({ path: "main.tease", program: lowered.main.menu, fileIndex: null });
  return outputs;
}

export function lowerSelfContainedPackage(
  files: readonly ParsedGroovyFile[],
  options: PackageOptions = {},
): MigrationProgram[] {
  return lowerPackage(files, { standalone: true, ...options }).composed;
}

export interface LoweredPackage {
  /** Each file lowered with package context, before helper composition. */
  lowered: MigrationProgram[];
  /**
   * Scripts with their package helpers and loaded modules embedded, a helper class with global functions as its own
   * file, and other files as lowered.
   */
  composed: MigrationProgram[];
  /**
   * The package's entry, `main.tease` (ADR 0022 §1): a legacy `main.groovy` by its index, or a generated file (`menu`)
   * that goes to the main script or offers the scripts the legacy player listed. Null for files converted on their
   * own, which keep their names.
   */
  main: { file: number } | { menu: MigrationProgram } | null;
  /**
   * The TeaseScript path of each file relative to the package root, its legacy path from the scripts folder; null for
   * files that write no file of their own and for files converted on their own.
   */
  paths: Array<string | null>;
}

/** A package's scripts with their TeaseScript paths, relative to the package root (packageScripts). */
interface PackageScripts {
  /** The legacy name of each script (its path without `.groovy`, in lower case) to its TeaseScript path. */
  paths: Map<string, string>;
  /** A legacy `main.groovy` in the top folder, which is the package's main.tease itself; null without one. */
  entry: number | null;
  /** The scripts in the package root, which the legacy player listed. */
  rootScripts: number[];
  /** The TeaseScript path of each script by file index. */
  pathOf: Map<number, string>;
  /** The package root directory, with `/` separators. */
  root: string;
}

/** The scripts of a package, with their paths from the legacy scripts folder. */
function packageScripts(
  files: readonly ParsedGroovyFile[],
  standalone: boolean,
): PackageScripts | null {
  const scripts = files.flatMap((file, index) =>
    file.root?.kind === "scriptBody" && describeMixinModule(file) === null ? [index] : [],
  );
  // A file converted alone has no package around it.
  if (scripts.length === 0 || (standalone && files.length < 2)) return null;
  const segments = new Map(
    scripts.map((index) => [index, files[index]!.sourceName.replaceAll("\\", "/").split("/")]),
  );
  const directories = scripts.map((index) => segments.get(index)!.slice(0, -1));
  const common = directories.reduce((shared, directory) => {
    let length = 0;
    while (length < shared.length && shared[length] === directory[length]) length += 1;
    return shared.slice(0, length);
  }, directories[0]!);
  // Paths start at the legacy scripts folder, so the files keep the original folders and names; without one, at the
  // scripts' common folder.
  const scriptsAt = common.map((segment) => segment.toLowerCase()).lastIndexOf("scripts");
  const root = scriptsAt < 0 ? common : common.slice(0, scriptsAt + 1);
  const relative = (index: number): string => segments.get(index)!.slice(root.length).join("/");
  const rootScripts = scripts.filter((index) => !relative(index).includes("/"));
  // A legacy `main.groovy` in the top folder is the package's main.tease itself.
  const entry =
    rootScripts.find((index) => relative(index).toLowerCase() === "main.groovy") ?? null;
  // Each script keeps its name; only a legacy `main.groovy` is the package's main.tease itself.
  const pathOf = new Map(
    scripts.map((index) => [index, relative(index).replace(/\.groovy$/iu, ".tease")]),
  );
  // A legacy script name is a path from the legacy scripts folder, which may be an ancestor of the scripts' common
  // directory (`TheProgram/002TherapistA` when every script is in `TheProgram/`), so the name also resolves with the
  // common directory's own folders in front.
  const paths = new Map<string, string>();
  // Only folders below the legacy scripts folder are part of a script name.
  const scriptsFolder = root.lastIndexOf("scripts");
  const deepest = scriptsFolder < 0 ? root.length : root.length - scriptsFolder - 1;
  for (let depth = 0; depth <= deepest; depth += 1) {
    const prefix = root.slice(root.length - depth).join("/");
    for (const index of scripts) {
      const name = `${prefix === "" ? "" : `${prefix}/`}${relative(index)}`
        .replace(/\.groovy$/iu, "")
        .toLowerCase();
      if (!paths.has(name)) paths.set(name, pathOf.get(index)!);
    }
  }
  return { paths, entry, rootScripts, pathOf, root: root.join("/") };
}

/**
 * A `main.tease` for a package whose root holds several scripts: the legacy player listed them for the player to pick,
 * so a menu offers each one that no other script chains to, also through the localized variant the legacy player chose
 * by language (`intro_de` for `intro`).
 */
function entryMenu(
  scripts: PackageScripts,
  programs: readonly MigrationProgram[],
  internal: ReadonlySet<number>,
): MigrationProgram {
  const targets = new Set<string>();
  // The literal transfers of each script, by its path.
  const transfers = new Map<string, Set<string>>();
  // The scripts with a computed transfer (`goto script(...)`), which may reach any script of their folder.
  const computed = new Set<string>();
  let source = "";
  const collect = (statements: readonly IrStatement[]): void => {
    for (const statement of statements) {
      if (statement.kind === "goto" && statement.target.kind === "file") {
        targets.add(statement.target.path.toLowerCase());
        transfers.set(
          source,
          (transfers.get(source) ?? new Set()).add(statement.target.path.toLowerCase()),
        );
      }
      if (statement.kind === "goto" && statement.target.kind !== "file") computed.add(source);
      if (statement.kind === "function") collect(statement.body);
      if (statement.kind === "if") {
        collect(statement.then);
        collect(statement.else);
      }
      if (statement.kind === "while" || statement.kind === "repeat" || statement.kind === "for")
        collect(statement.body);
      if (statement.kind === "switch") {
        for (const item of statement.cases) collect(item.body);
        collect(statement.default);
      }
    }
  };
  programs.forEach((program, index) => {
    source = (scripts.pathOf.get(index) ?? "").toLowerCase();
    collect(program.statements);
  });
  const base = (path: string): string =>
    path.replace(/_[a-z]{2}(?:_[a-z]{2})?\.tease$/iu, ".tease");
  const depthOf = (path: string): number => path.split("/").length - 1;
  const targeted = (path: string): boolean =>
    targets.has(path.toLowerCase()) || targets.has(base(path).toLowerCase());
  // The entries (owner decision 2026-10-05): the scripts of the top folder that call setInfos, as the legacy player
  // listed them, apart from internal scripts and scripts that another script chains to; without one there, those one
  // folder down, beside folders such as system/. Where every script of a level is chained to, as scripts that chain to
  // each other in a circle, the hub of the circle starts (entryScripts).
  const paths = [...scripts.pathOf.values()];
  const folderOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1).toLowerCase();
  const edges = new Map(
    paths.map((path) => {
      const to = transfers.get(path.toLowerCase()) ?? new Set<string>();
      const anyBelow = computed.has(path.toLowerCase());
      // A chain to a script also reached its localized variants, which the legacy player chose by language.
      return [
        path,
        paths.filter(
          (other) =>
            other !== path &&
            (to.has(other.toLowerCase()) ||
              to.has(base(other).toLowerCase()) ||
              (anyBelow && other.toLowerCase().startsWith(folderOf(path)))),
        ),
      ] as const;
    }),
  );
  const listed = new Set(
    [...scripts.pathOf].flatMap(([index, path]) =>
      !internal.has(index) && programs[index]?.metadata != null ? [path] : [],
    ),
  );
  // A main script's sub-scripts sit in the folder of its name, `jewell/` for `jewell.groovy`, and their chains back to it
  // do not make it a chained script.
  const ownFolder = (path: string): string => `${path.replace(/\.tease$/iu, "").toLowerCase()}/`;
  const chainedFromOutside = (path: string): boolean =>
    [...transfers].some(
      ([from, to]) =>
        from !== path.toLowerCase() &&
        !from.startsWith(ownFolder(path)) &&
        (to.has(path.toLowerCase()) ||
          // A chain to the main script also reached its localized variant, unless it returns from the main's own folder.
          (to.has(base(path).toLowerCase()) &&
            from !== base(path).toLowerCase() &&
            !from.startsWith(ownFolder(base(path))))),
    );
  const named = (depth: number): string[] =>
    [...listed]
      .filter((path) => depthOf(path) === depth && !chainedFromOutside(path))
      .sort(versionOrder);
  const starts = entryScripts(paths, edges, listed);
  const hubs = (depth: number): string[] =>
    starts.filter((path) => depthOf(path) === depth).sort(versionOrder);
  const entries =
    named(0).length > 0
      ? named(0)
      : named(1).length > 0
        ? named(1)
        : hubs(0).length > 0
          ? hubs(0)
          : hubs(1);
  // Without such a script, the scripts of the top folder that nothing chains to.
  const rootListed = scripts.rootScripts.filter((index) => !internal.has(index));
  const offered = rootListed
    .map((index) => scripts.pathOf.get(index)!)
    .filter((path) => !targeted(path))
    .sort(versionOrder);
  const rooted =
    offered.length > 0
      ? offered
      : (rootListed.length > 0 ? rootListed : scripts.rootScripts).map((index) =>
          scripts.pathOf.get(index)!,
        );
  // A package whose scripts are all in folders, such as System/, offers the scripts nothing chains to, or every script.
  const everyScript = [...scripts.pathOf]
    .flatMap(([index, path]) => (internal.has(index) ? [] : [path]))
    .sort();
  const choices =
    entries.length > 0
      ? entries
      : rooted.length > 0
        ? rooted
        : everyScript.some((path) => !targeted(path))
          ? everyScript.filter((path) => !targeted(path))
          : everyScript;
  const variants = [...scripts.pathOf.values()]
    .filter((path) => base(path) !== path && targeted(path) && !targets.has(path.toLowerCase()))
    .sort();
  const message =
    (choices.length === 1
      ? `The legacy player listed the package's scripts for the player to pick; a TeaseScript package starts at main.tease, which goes to ${choices[0]}, the only listed script that no other script chains to.`
      : "The legacy player listed the package's scripts for the player to pick; a TeaseScript package starts at main.tease, so this menu offers each script that no other script chains to.") +
    (variants.length === 0
      ? ""
      : ` The legacy player also chose a localized variant of a script by the system language, which the converted scripts do not, so these variants are not reached: ${variants.join(", ")}.`);
  const name = menuLabels(choices, scripts, programs);
  // Each button returns an identifier named after its script, which a switch sends to that script.
  const id = menuIds(choices);
  // With one script to offer, the package starts there.
  const question: IrStatement[] =
    choices.length === 1
      ? []
      : [
          {
            kind: "say",
            value: { kind: "literal", value: "Which script do you want to start?" },
            span: null,
          },
          {
            kind: "let",
            name: "picked",
            value: {
              kind: "choice",
              options: choices.map((path) => ({ kind: "literal", value: name.get(path)! })),
              labels: choices.map((path) => id.get(path)!),
            },
            span: null,
          },
        ];
  const goto = (path: string): IrStatement => ({
    kind: "goto",
    target: { kind: "file", path },
    span: null,
  });
  const chain: IrStatement[] =
    choices.length === 1
      ? [goto(choices[0]!)]
      : [
          {
            kind: "switch",
            value: { kind: "variable", name: "picked" },
            cases: choices
              .slice(0, -1)
              .map((path) => ({
                matches: [{ kind: "literal", value: id.get(path)! }],
                body: [goto(path)],
                span: null,
              })),
            default: [goto(choices.at(-1)!)],
            span: null,
          },
        ];
  // One entry needs no menu and no note: main.tease goes there.
  if (choices.length === 1 && variants.length === 0)
    return {
      sourceName: `${scripts.root}/main.tease`,
      metadata: null,
      statements: chain,
      diagnostics: [],
    };
  return {
    sourceName: `${scripts.root}/main.tease`,
    metadata: null,
    statements: [
      { kind: "comment", text: `// NOTE SX_ENTRY_MENU: ${message}`, trailing: false, span: null },
      ...question,
      ...chain,
    ],
    diagnostics: [{ code: "SX_ENTRY_MENU", severity: "warning", message, span: null }],
  };
}

/**
 * The scripts a package starts at: in each group of scripts that chain to each other in a circle (a strongly connected
 * component) that no script outside it chains to, the listed script the others return to most (the hub), or the
 * group's one listed script.
 */
function entryScripts(
  paths: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
  listed: ReadonlySet<string>,
): string[] {
  // Tarjan's algorithm, iterative over the transfer graph.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const component = new Map<string, number>();
  let counter = 0;
  let components = 0;
  const connect = (start: string): void => {
    const work: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work.at(-1)!;
      const targets = edges.get(frame.node) ?? [];
      if (frame.next < targets.length) {
        const target = targets[frame.next]!;
        frame.next += 1;
        if (!index.has(target)) {
          index.set(target, counter);
          low.set(target, counter);
          counter += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(target)!));
        }
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent !== undefined)
        low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
          onStack.delete(member);
          component.set(member, components);
          if (member === frame.node) break;
        }
        components += 1;
      }
    }
  };
  for (const path of paths) if (!index.has(path)) connect(path);
  const reached = new Set<number>();
  for (const [from, targets] of edges)
    for (const target of targets)
      if (component.get(from) !== component.get(target)) reached.add(component.get(target)!);
  const result: string[] = [];
  for (let group = 0; group < components; group += 1) {
    if (reached.has(group)) continue;
    const members = paths.filter((path) => component.get(path) === group && listed.has(path));
    if (members.length <= 1) {
      result.push(...members);
      continue;
    }
    // The hub is the script the others return to most; then the one that chains to most, the shallowest, and the first.
    const inGroup = paths.filter((path) => component.get(path) === group);
    const incoming = (path: string): number =>
      inGroup.filter((other) => (edges.get(other) ?? []).includes(path)).length;
    const outgoing = (path: string): number => edges.get(path)?.length ?? 0;
    result.push(
      members.toSorted(
        (left, right) =>
          incoming(right) - incoming(left) ||
          outgoing(right) - outgoing(left) ||
          left.split("/").length - right.split("/").length ||
          versionOrder(left, right),
      )[0]!,
    );
  }
  return result;
}

/** Script paths in name order, with other versions of a script (`name__sha256_<hash>`) after the scripts. */
function versionOrder(first: string, second: string): number {
  if (isOtherVersion(first) !== isOtherVersion(second)) return isOtherVersion(first) ? 1 : -1;
  return first < second ? -1 : first > second ? 1 : 0;
}

export function lowerPackage(
  parsedFiles: readonly ParsedGroovyFile[],
  options: PackageOptions = {},
): LoweredPackage {
  // Questions inside short circuits are asked at their own moment (withGuardedInputs).
  const files = parsedFiles.map(withGuardedInputs);
  const helperRegistry = buildHelperRegistry(files);
  const visible = moduleVisibility(files, options.releases ?? []);
  const moduleInfos = files.map((file) => describeMixinModule(file));
  const mixinModules = moduleInfos.flatMap((info) => info ?? []);
  const stableNames = packageStableNames(files);
  const storageLiterals = packageStorageLiterals(files);
  const copiedImages = new Set(
    files.flatMap((file) => {
      const paths: string[] = [];
      walkAst(file.root, (node) => {
        const copy = photoCopy(node);
        if (copy !== null) paths.push(copy.path);
      });
      return paths;
    }),
  );
  // Function names and object field types are shared only by a script and the mixin modules it loads.
  const groups = compositionGroups(files, visible);
  const stopsBackgroundSounds = packageStopsBackgroundSounds(files);
  const resultUses = packageResultUses(files);
  // The files of each folder, as each file sees them (moduleVisibility).
  const directoryFiles = files.map((_, index) => {
    const listing = new Map<string, string[]>();
    files.forEach((file, other) => {
      if (!visible(index, other)) return;
      const directory = file.sourceName.split(/[\\/]/u).at(-2) ?? "";
      listing.set(directory, [...(listing.get(directory) ?? []), file.sourceName]);
    });
    return listing;
  });
  // Map uses are shared within a composition group, like function names and field types.
  const scripts = packageScripts(files, options.standalone === true);
  const functionResults = files.map((_, index) => packageFunctionResults(groups[index]!));
  const javaResources =
    options.files === undefined
      ? undefined
      : packageResources(files, options.files, options.readFile ?? null);
  const mapUses = files.map((_, index) => packageMapUses(groups[index]!, functionResults[index]!));
  const lowered = files.map((file, index) =>
    lowerParsedFile(file, {
      mapUses: mapUses[index]!,
      functionResults: functionResults[index]!,
      helperRegistry,
      mixinModules: moduleInfos.flatMap((info, other) =>
        info !== null && visible(index, other) ? [info] : [],
      ),
      packageFunctions: packageFunctionNames(groups[index]!),
      stableNames,
      storageLiterals,
      copiedImages,
      globalTypes: packageGlobalTypes(groups[index]!),
      stopsBackgroundSounds,
      resultUses,
      directoryFiles: directoryFiles[index]!,
      ...(scripts === null ? {} : { scriptPaths: scripts.paths }),
      renameIdentifiers: false,
      ...(options.accepted === undefined ? {} : { accepted: options.accepted }),
      ...(options.media === undefined ? {} : { media: options.media }),
      ...(options.files === undefined ? {} : { files: options.files }),
      ...(javaResources === undefined ? {} : { javaResources }),
    }),
  );
  const helperPrograms = lowered.filter(
    (_, index) => files[index]?.root?.kind === "compilationUnit",
  );
  const functionCatalog = buildFunctionCatalog(helperPrograms);
  // In a package, the methods of a legacy helper class live in the class's own file as global functions where they
  // can (classGlobals); the others are copied into each script that calls them.
  const classOutputs =
    options.standalone === true ? new Map<number, MigrationProgram>() : classFiles(files, lowered);
  const classFunctions = new Set(
    [...classOutputs.values()].flatMap((program) =>
      program.statements.flatMap((statement) =>
        statement.kind === "function" ? [statement.name] : [],
      ),
    ),
  );

  // In a package, a mixin module directory that one script loads keeps its modules as their own files (owner decision
  // 2026-10-05); one that several scripts load is composed into each.
  const loaders = new Map<string, number>();
  lowered.forEach((program, index) => {
    if (files[index]?.root?.kind !== "scriptBody" || program.module !== undefined) return;
    for (const directory of program.loadsModuleDirectories ?? [])
      loaders.set(directory, (loaders.get(directory) ?? 0) + 1);
  });
  const separateModules = new Set(
    options.standalone === true || scripts === null
      ? []
      : [...loaders].flatMap(([directory, count]) => (count === 1 ? [directory] : [])),
  );
  // What a function nothing references cannot convert becomes a note, in the file and in the composed script.
  const uncalled: MigrationDiagnostic[][] = files.map(() => []);
  const texts = packageTexts(files);
  const composed = lowered.map((program, index) => {
    if (files[index]?.root?.kind !== "scriptBody" || program.module !== undefined) return program;
    const script = withLaunchMarkers(
      composeProgram(
        withLoadedModules(
          program,
          lowered.filter((module, other) => module.module !== undefined && visible(index, other)),
          separateModules,
        ),
        functionCatalog,
        classFunctions,
      ),
      launchKey(files[index]!.sourceName),
      texts,
    );
    uncalled[index] = uncalledDiagnostics(script, legacyUnreferencedFunctions(groups[index]!));
    return withUncalledNotes(script, uncalled[index]!);
  });
  // A module's own program takes the notes every script that loads it gives the same code.
  const loading = (program: MigrationProgram): number[] =>
    lowered.flatMap((script, index) =>
      program.module !== undefined &&
      (script.loadsModuleDirectories ?? []).includes(program.module.directory)
        ? [index]
        : [],
    );
  const notes = (program: MigrationProgram, index: number): MigrationDiagnostic[] => {
    if (program.module === undefined) return uncalled[index]!;
    const scripts = loading(program);
    if (scripts.length === 0) return [];
    return uncalled[scripts[0]!]!.filter((diagnostic) =>
      scripts.every((script) => uncalled[script]!.includes(diagnostic)),
    );
  };
  const noted = composed.map((program, index) =>
    program.module === undefined ? program : withUncalledNotes(program, notes(program, index)),
  );
  const scriptIndexes = noted.flatMap((program, index) =>
    files[index]?.root?.kind === "scriptBody" && program.module === undefined ? [index] : [],
  );
  const accepted = options.accepted ?? new Set();
  const moduleFiles = withModuleFiles(noted, files);
  const withClasses = noted.map(
    (program, index) => moduleFiles.get(index) ?? classOutputs.get(index) ?? program,
  );
  if (scripts === null || options.standalone === true) {
    // Files converted on their own keep everything they need; a lone script of a package also asks the profile.
    const entryIndex = scriptIndexes.length === 1 ? scriptIndexes[0]! : null;
    const programs = withClasses.map((program, index) =>
      index === entryIndex ? withProfile(program, withClasses, accepted) : program,
    );
    return {
      lowered: lowered.map((program, index) => withUncalledNotes(program, notes(program, index))),
      composed: programs,
      main: null,
      paths: files.map(() => null),
    };
  }
  // main.tease (ADR 0022 §1): a legacy `main.groovy`, or a generated file that asks the legacy profile and goes to the
  // package's main script, or offers its scripts where it has several.
  const legacyMain = scripts.entry;
  const generated: MigrationProgram | null =
    legacyMain !== null
      ? null
      : entryMenu(scripts, withClasses, internalScripts(files, options.internalScripts));
  const mainProgram = withProfile(generated ?? withClasses[legacyMain!]!, withClasses, accepted);
  const outputIndexes = [
    ...new Set([...scriptIndexes, ...classOutputs.keys(), ...moduleFiles.keys()]),
  ].filter((index) => index !== legacyMain);
  const shared = withMainHelpers(
    outputIndexes.map((index) => withClasses[index]!),
    mainProgram,
  );
  // Globals and global functions reach every file (V30 §11): any other name of one of them gets another name there.
  const globalNames = (program: MigrationProgram): string[] =>
    program.statements.flatMap((statement) =>
      (statement.kind === "function" || statement.kind === "let") && statement.global === true
        ? [statement.name]
        : [],
    );
  const project = new Set([shared.main, ...shared.programs].flatMap(globalNames));
  const apart = (program: MigrationProgram, renameProtected: boolean): MigrationProgram => {
    const own = new Set(globalNames(program));
    return renameConflictingIdentifiers(
      program,
      new Set(),
      renameProtected,
      new Set([...project].filter((name) => !own.has(name))),
    );
  };
  const main = apart(shared.main, true);
  const programs = withClasses.map((program, index) => {
    if (index === legacyMain) return main;
    const position = outputIndexes.indexOf(index);
    return position < 0 ? program : apart(shared.programs[position]!, false);
  });
  return {
    lowered: lowered.map((program, index) => withUncalledNotes(program, notes(program, index))),
    composed: programs,
    main: legacyMain !== null ? { file: legacyMain } : { menu: main },
    paths: files.map(
      (file, index) =>
        scripts.pathOf.get(index) ??
        (classOutputs.has(index) || (moduleFiles.has(index) && !scripts.pathOf.has(index))
          ? packagePath(file.sourceName, scripts.root)
          : null),
    ),
  };
}

/**
 * The generated parts that the files of a package share move to main.tease (ADR 0022 §1), which is generated anyway:
 * the system speaker (helpers.ts `systemSpeaker`), declared once, and each generated helper (helpers.ts) as one
 * `global function`, where it reads no file-level value and calls only built-ins and other such helpers, such as the
 * helpers that keep a file's background sounds (globalFunctionNames).
 */
function withMainHelpers(
  programs: readonly MigrationProgram[],
  main: MigrationProgram,
): { programs: MigrationProgram[]; main: MigrationProgram } {
  const all = [main, ...programs];
  const helpers = new Map<string, FunctionStatement>();
  for (const program of all)
    for (const statement of program.statements)
      if (
        statement.kind === "function" &&
        helperDefinitionOrder(statement) >= 0 &&
        !helpers.has(statement.name)
      )
        helpers.set(statement.name, statement);
  const functions = all.flatMap((program) =>
    program.statements.flatMap((statement) => (statement.kind === "function" ? [statement] : [])),
  );
  // Generated state that spans files, such as the switch button's ID, becomes a global; a file's background sounds,
  // which the legacy player stopped when the script ended, stay with the file.
  const states = new Map<string, LetStatement>();
  for (const program of all)
    for (const statement of program.statements)
      if (
        statement.kind === "let" &&
        helperDefinitionOrder(statement) >= 0 &&
        statement.name !== BACKGROUND_SOUNDS &&
        isLiteralValue(statement.value)
      )
        states.set(statement.name, statement);
  const global = globalFunctionNames(
    [...helpers.values()],
    new Set(states.keys()),
    new Set(functions.map(({ name }) => name)),
  );
  // A state moves only with a helper that uses it.
  for (const name of [...states.keys()])
    if (
      ![...helpers.values()].some(
        (helper) => global.has(helper.name) && freeNames(helper).variables.has(name),
      )
    )
      states.delete(name);
  const isSpeaker = (statement: IrStatement): boolean =>
    statement.kind === "speaker" && statement.name === SYSTEM_SPEAKER;
  const speaker = all.flatMap((program) => program.statements).find(isSpeaker);
  const moves = (statement: IrStatement): boolean =>
    isSpeaker(statement) ||
    (statement.kind === "function" && global.has(statement.name)) ||
    (statement.kind === "let" && states.has(statement.name));
  const without = (program: MigrationProgram): MigrationProgram => ({
    ...program,
    statements: program.statements.filter((statement) => !moves(statement)),
  });
  const shared: IrStatement[] = [
    ...(speaker === undefined ? [] : [speaker]),
    ...[...states.values()].map((statement): IrStatement => ({ ...statement, global: true })),
    ...[...helpers.values()]
      .filter(({ name }) => global.has(name))
      .sort((left, right) => helperDefinitionOrder(left) - helperDefinitionOrder(right))
      .map((statement): IrStatement => ({ ...statement, global: true })),
  ];
  const own = without(main).statements;
  // A comment that opens the file, such as the entry menu's note, stays first.
  const lead = own.findIndex((statement) => statement.kind !== "comment");
  const at = lead < 0 ? own.length : lead;
  return {
    programs: programs.map(without),
    main: { ...main, statements: [...own.slice(0, at), ...shared, ...own.slice(at)] },
  };
}

/**
 * Mixin modules that one script loads, each as its own file (owner decision 2026-10-05): the statements the script's
 * composition marked with a module (withLoadedModules) go to that module's file, and the script keeps the rest. A
 * module's functions are `global function`s, since the script calls them, and so is everything they use of their own
 * file and of the script (withGlobalReach). The result maps the index of the script, and of each module, to its file.
 */
function withModuleFiles(
  programs: readonly MigrationProgram[],
  files: readonly ParsedGroovyFile[],
): Map<number, MigrationProgram> {
  const result = new Map<number, MigrationProgram>();
  const indexOfSource = new Map(files.map((file, index) => [file.sourceName, index]));
  programs.forEach((program, script) => {
    if (program.module !== undefined) return;
    const origins = [...new Set(program.statements.flatMap((statement) => statement.origin ?? []))];
    if (origins.length === 0) return;
    const strip = ({ origin: _origin, ...statement }: IrStatement): IrStatement => statement;
    const own = program.statements.filter((statement) => statement.origin === undefined);
    const modules = origins.map((origin) => {
      const index = indexOfSource.get(origin)!;
      const module = programs[index]!;
      return {
        index,
        program: {
          sourceName: module.sourceName,
          metadata: null,
          statements: program.statements
            .filter((statement) => statement.origin === origin)
            .map(strip),
          diagnostics: module.diagnostics,
        } satisfies MigrationProgram,
      };
    });
    const reached = withGlobalReach([
      { ...program, statements: own },
      ...modules.map(({ program: module }) => module),
    ]);
    result.set(script, reached[0]!);
    modules.forEach(({ index }, position) => result.set(index, reached[position + 1]!));
  });
  return result;
}

/**
 * The files with every function of the second and later files (the modules) a `global function`, and with what those
 * reach a global in turn (V30 §11): a function or value they use, of their own file or of the first file (the script
 * that loads them). A value whose start is not literal is declared with its type's empty value, which the file then
 * assigns where it declared it (ADR 0022 §6.4).
 */
function withGlobalReach(programs: readonly MigrationProgram[]): MigrationProgram[] {
  const definitions = programs.map(
    (program) =>
      new Map(
        program.statements.flatMap((statement): Array<[string, IrStatement]> =>
          statement.kind === "function" || statement.kind === "let"
            ? [[statement.name, statement]]
            : [],
        ),
      ),
  );
  const global = programs.map(() => new Set<string>());
  const queue: Array<{ file: number; statement: FunctionStatement }> = [];
  const mark = (file: number, name: string): void => {
    if (global[file]!.has(name)) return;
    global[file]!.add(name);
    const statement = definitions[file]!.get(name);
    if (statement?.kind === "function") queue.push({ file, statement });
  };
  programs.forEach((program, file) => {
    if (file === 0) return;
    for (const statement of program.statements)
      if (statement.kind === "function") mark(file, statement.name);
  });
  while (queue.length > 0) {
    const { file, statement } = queue.shift()!;
    const used = freeNames(statement);
    for (const name of [...used.variables, ...used.calls]) {
      const owner = definitions[file]!.has(name)
        ? file
        : definitions[0]!.has(name)
          ? 0
          : definitions.findIndex((names) => names.has(name));
      if (owner >= 0) mark(owner, name);
    }
  }
  const results = functionResultTypes(programs.flatMap((program) => program.statements));
  return programs.map((program, file) => ({
    ...program,
    statements: program.statements.flatMap((statement): IrStatement[] => {
      if (statement.kind === "function" && global[file]!.has(statement.name))
        return [{ ...statement, global: true }];
      if (statement.kind !== "let" || !global[file]!.has(statement.name)) return [statement];
      if (isLiteralValue(statement.value)) return [{ ...statement, global: true }];
      const inferred = expressionType(
        statement.value,
        () => ({ kind: "unknown" }),
        (name) => results.get(name),
      );
      return [
        { ...statement, value: startValue(statement.type, inferred), global: true },
        {
          kind: "assign",
          target: { kind: "variable", name: statement.name },
          operator: "=",
          value: statement.value,
          span: statement.span,
        },
      ];
    }),
  }));
}

/** The value a global of this annotation or inferred type starts with before its file assigns it. */
function startValue(type: string | undefined, inferred: TeaseType): IrExpression {
  if (type === undefined) {
    // An empty list takes its element type from the first one assigned (ADR 0021 rule 1.3).
    if (inferred.kind === "list") return { kind: "list", items: [] };
    if (inferred.kind === "scalar" && inferred.name === "string")
      return { kind: "literal", value: "" };
    if (inferred.kind === "scalar" && inferred.name === "boolean")
      return { kind: "literal", value: false };
    if (inferred.kind === "scalar" && (inferred.name === "integer" || inferred.name === "number"))
      return { kind: "literal", value: 0 };
    return { kind: "literal", value: null };
  }
  if (type.endsWith("?")) return { kind: "literal", value: null };
  if (type.endsWith("[]")) return { kind: "list", items: [] };
  if (type === "string") return { kind: "literal", value: "" };
  if (type === "boolean") return { kind: "literal", value: false };
  return { kind: "literal", value: 0 };
}

/**
 * The functions that can be `global function`s (V30 §11): a global function reads only globals, its parameters, and
 * its locals, and calls only global functions and built-ins. `variables` are the globals it may read, and `defined`
 * every function name of the package, so a call to one that cannot be global keeps the caller local too.
 */
function globalFunctionNames(
  candidates: readonly FunctionStatement[],
  variables: ReadonlySet<string>,
  defined: ReadonlySet<string>,
): Set<string> {
  const free = new Map(candidates.map((statement) => [statement.name, freeNames(statement)]));
  const global = new Set(candidates.map(({ name }) => name));
  for (let changed = true; changed;) {
    changed = false;
    for (const name of [...global]) {
      const names = free.get(name)!;
      if (
        [...names.variables].every((variable) => variables.has(variable)) &&
        [...names.calls].every((call) => global.has(call) || !defined.has(call))
      )
        continue;
      global.delete(name);
      changed = true;
    }
  }
  return global;
}

/**
 * Each legacy helper class file of a package that other files call into, as its own file (ADR 0022): its static
 * fields with literal values as globals, and the methods that can be global functions (globalFunctionNames) as
 * such; the other methods are copied into each script that calls them (composeProgram). A class with no such method
 * writes no file.
 */
function classFiles(
  files: readonly ParsedGroovyFile[],
  lowered: readonly MigrationProgram[],
): Map<number, MigrationProgram> {
  const result = new Map<number, MigrationProgram>();
  const defined = new Set(
    lowered.flatMap((program) =>
      program.statements.flatMap((statement) =>
        statement.kind === "function" ? [statement.name] : [],
      ),
    ),
  );
  const called = new Set(
    lowered.flatMap((program, index) =>
      files[index]?.root?.kind === "compilationUnit"
        ? []
        : [...collectCallNames(program.statements)],
    ),
  );
  files.forEach((file, index) => {
    if (file.root?.kind !== "compilationUnit") return;
    const program = lowered[index]!;
    // A method that dispatches closure values needs the file's action dispatcher, which stays with each script.
    if ((program.actions ?? []).length > 0) return;
    const fields = program.statements.flatMap((statement) =>
      statement.kind === "let" && isLiteralValue(statement.value) ? [statement] : [],
    );
    const methods = program.statements.flatMap((statement) =>
      statement.kind === "function" && helperDefinitionOrder(statement) < 0 ? [statement] : [],
    );
    const helpers = program.statements.flatMap((statement) =>
      statement.kind === "function" && helperDefinitionOrder(statement) >= 0 ? [statement] : [],
    );
    const global = globalFunctionNames(
      [...methods, ...helpers],
      new Set(fields.map(({ name }) => name)),
      defined,
    );
    // Methods other files call are global functions; the class's other methods stay local to its file.
    const kept = methods.filter(({ name }) => global.has(name));
    // A global function calls only global functions, so the methods those call are global too.
    const exported = new Set(kept.flatMap(({ name }) => (called.has(name) ? [name] : [])));
    if (exported.size === 0) return;
    for (const name of exported)
      for (const call of freeNames(kept.find((method) => method.name === name)!).calls)
        if (kept.some((method) => method.name === call)) exported.add(call);
    result.set(
      index,
      renameConflictingIdentifiers({
        ...program,
        statements: [
          ...fields.map((statement): IrStatement => ({ ...statement, global: true })),
          ...helpers.filter(({ name }) => global.has(name)),
          ...kept.map((statement): IrStatement =>
            exported.has(statement.name) ? { ...statement, global: true } : statement,
          ),
        ],
        diagnostics: program.diagnostics.filter((diagnostic) =>
          kept.some((statement) => inside(diagnostic.span, statement.span)),
        ),
      }),
    );
  });
  return result;
}

type FunctionStatement = Extract<IrStatement, { kind: "function" }>;
type LetStatement = Extract<IrStatement, { kind: "let" }>;

/** The generated list of a file's background sound handles (helpers.ts), which stays with its file. */
const BACKGROUND_SOUNDS = "sexscriptBackgroundSounds";

/** The variables a function uses that it does not declare, and the names it calls. */
function freeNames(statement: FunctionStatement): { variables: Set<string>; calls: Set<string> } {
  const declared = new Set(statement.parameters.map((parameter) => parameter.name));
  const variables = new Set<string>();
  const calls = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (value.kind === "let" && typeof value.name === "string") declared.add(value.name);
    if (value.kind === "for" && typeof value.variable === "string") declared.add(value.variable);
    if (value.kind === "variable" && typeof value.name === "string") variables.add(value.name);
    if (value.kind === "call" && typeof value.name === "string") calls.add(value.name);
    for (const child of Object.values(value)) visit(child);
  };
  visit(statement.parameters.map((parameter) => parameter.defaultValue));
  visit(statement.body);
  return { variables: new Set([...variables].filter((name) => !declared.has(name))), calls };
}

/** Whether a value is made of literals only, so it can start a global (ADR 0022 §6.4). */
function isLiteralValue(value: IrExpression): boolean {
  switch (value.kind) {
    case "literal":
    case "duration":
      return true;
    case "list":
      return value.items.every(isLiteralValue);
    case "object":
      return value.properties.every(
        (property) => property.key === undefined && isLiteralValue(property.value),
      );
    default:
      return false;
  }
}

/** A file's TeaseScript path from the package root, its legacy path from the scripts folder. */
function packagePath(sourceName: string, root: string): string {
  const name = sourceName.replaceAll("\\", "/");
  const relative = root !== "" && name.startsWith(`${root}/`) ? name.slice(root.length + 1) : name;
  return relative.replace(/\.groovy$/iu, ".tease");
}

/**
 * The literal values the package stores under each storage key that only ever receives literals: a key with any
 * computed value, or one that a save with a computed key could name (its fixed beginning matches), is left out, and
 * so is a key the package never stores.
 */
function packageStorageLiterals(
  files: readonly ParsedGroovyFile[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const literals = new Map<string, Set<string>>();
  const computed = new Set<string>();
  const computedPrefixes: string[] = [];
  for (const file of files) {
    walkAst(file.root, (node) => {
      if (node.kind !== "methodCall" || node.implicitThis !== true) return;
      const name = constantString(node.method);
      if (name !== "save" && name !== "send") return;
      const argumentList = isAstNode(node.arguments) ? node.arguments.items : undefined;
      const [keyNode, valueNode]: Array<AstNode | undefined> = Array.isArray(argumentList)
        ? argumentList.filter(isAstNode)
        : [];
      if (keyNode === undefined || valueNode === undefined) return;
      const key = constantString(keyNode);
      if (key === null) {
        const prefix = keyPrefix(keyNode);
        computedPrefixes.push(prefix);
        return;
      }
      const value = constantString(valueNode);
      if (value === null) computed.add(key);
      else literals.set(key, (literals.get(key) ?? new Set()).add(value));
    });
  }
  return new Map(
    [...literals].filter(
      ([key]) => !computed.has(key) && !computedPrefixes.some((prefix) => key.startsWith(prefix)),
    ),
  );
}

/** A generated entry menu that first asks the legacy player's profile the package reads but never saves. */
function withProfile(
  menu: MigrationProgram,
  programs: readonly MigrationProgram[],
  accepted: ReadonlySet<AcceptedForm>,
): MigrationProgram {
  const profile = legacyProfilePrompt(programs, menu, accepted);
  return profile.length === 0
    ? menu
    : renameConflictingIdentifiers(
        { ...menu, statements: [...profile, ...menu.statements] },
        new Set(),
        false,
      );
}

/** The fixed beginning of a computed storage key: the text before its first computed part. */
function keyPrefix(node: AstNode): string {
  const literal = constantString(node);
  if (literal !== null) return literal;
  if (node.kind === "gstring") {
    const first: unknown = Array.isArray(node.strings) ? node.strings[0] : undefined;
    return typeof first === "string" ? first : "";
  }
  if (node.kind === "binary" && node.operator === "+" && isAstNode(node.left)) {
    const left = constantString(node.left);
    if (left !== null && isAstNode(node.right)) return left + keyPrefix(node.right);
    return keyPrefix(node.left);
  }
  return "";
}

/**
 * A script that loads mixin modules gets their complete code, in file-name order: injected methods may be
 * reachable only through callbacks, so nothing is dropped as unused. Module globals that collide with names
 * already taken are renamed inside their module first.
 */
/** For each file, the files whose names it shares: a script with the modules it loads, and those modules. */
/**
 * Which files a file sees as modules (PackageOptions.releases): a file of a release sees the files of that release and
 * the files of no release; every file skips the files of no release that are another version of a file the folder
 * holds (`name__sha256_<hash>`).
 */
function moduleVisibility(
  files: readonly ParsedGroovyFile[],
  releases: ReadonlyArray<readonly string[]>,
): (viewer: number, other: number) => boolean {
  const path = (file: ParsedGroovyFile): string =>
    file.sourceName.replaceAll("\\", "/").toLowerCase();
  const sets = releases.map(
    (paths) =>
      new Set(
        files.flatMap((file, index) =>
          paths.some((item) => path(file).endsWith(`/${item.replaceAll("\\", "/").toLowerCase()}`))
            ? [index]
            : [],
        ),
      ),
  );
  const names = new Set(files.map(path));
  const otherVersion = files.map((file) => {
    const base = path(file).replace(/__sha256_[0-9a-f]+(?=\.groovy$)/u, "");
    return base !== path(file) && names.has(base);
  });
  return (viewer, other) => {
    if (viewer === other) return true;
    if (sets.some((set) => set.has(viewer) && set.has(other))) return true;
    return (
      !otherVersion[other] &&
      (!sets.some((set) => set.has(viewer)) || !sets.some((set) => set.has(other)))
    );
  };
}

function compositionGroups(
  files: readonly ParsedGroovyFile[],
  visible: (viewer: number, other: number) => boolean,
): ParsedGroovyFile[][] {
  const moduleDirectory = files.map((file) => describeMixinModule(file)?.directory ?? null);
  const loads = files.map((file) => new Set(loadedModuleDirectories(file)));
  return files.map((file, index) => {
    const directories = new Set(loads[index]);
    const own = moduleDirectory[index];
    if (own !== null && own !== undefined) directories.add(own);
    if (directories.size === 0) return [file];
    return files.filter((_, other) => {
      const directory = moduleDirectory[other];
      if (!visible(index, other)) return false;
      return (
        other === index ||
        (directory !== null && directory !== undefined && directories.has(directory)) ||
        [...loads[other]!].some((loaded) => directories.has(loaded))
      );
    });
  });
}

function withLoadedModules(
  program: MigrationProgram,
  modulePrograms: readonly MigrationProgram[],
  /** Module directories whose statements are marked with their module (`origin`), to go to the module's own file. */
  separate: ReadonlySet<string> = new Set(),
): MigrationProgram {
  const directories = new Set(program.loadsModuleDirectories ?? []);
  if (directories.size === 0) return program;
  // Generated helpers are identical in every program: keep one definition of each, first in the file.
  const helpers = new Map<number, IrStatement>();
  const withoutHelpers = (statements: readonly IrStatement[]): IrStatement[] =>
    statements.filter((statement) => {
      const order = helperDefinitionOrder(statement);
      if (order < 0) return true;
      if (!helpers.has(order)) helpers.set(order, statement);
      return false;
    });
  const programStatements = withoutHelpers(program.statements);
  const programNames = new Set(rootNames(program.statements));
  const taken = new Set(programNames);
  let moduleStatements: IrStatement[] = [];
  const diagnostics = [...program.diagnostics];
  const modules = modulePrograms
    .filter((module) => module.module !== undefined && directories.has(module.module.directory))
    .toSorted((left, right) => left.module!.name.localeCompare(right.module!.name));
  const actions = new Set(program.actions ?? []);
  for (const module of modules) {
    const statements = withoutHelpers(module.statements);
    const info = module.module!;
    // Modules load in order, so a method that a later module injects again replaces the earlier one.
    const injected = info.injected.filter((name) => !programNames.has(name));
    for (const name of injected) {
      const replaced = moduleStatements.some(
        (statement) => statement.kind === "function" && statement.name === name,
      );
      if (!replaced) continue;
      moduleStatements = moduleStatements.filter(
        (statement) => !(statement.kind === "function" && statement.name === name),
      );
      taken.delete(name);
      diagnostics.push({
        code: "SX_MODULE_METHOD_REPLACED",
        severity: "warning",
        message: `Module ${info.name} injects ${name} again; the converted script keeps only this later version, while Groovy code that ran while an earlier module loaded, or a setup it returned, still used the earlier one.`,
        span: null,
      });
    }
    for (const name of info.functions.filter((name) => programNames.has(name))) {
      diagnostics.push({
        code: "SX_MODULE_METHOD_OVERRIDE",
        severity: "warning",
        message: `Module ${info.name} injects ${name}, which the script itself defines; Groovy called the injected method once the module was loaded, while the converted script keeps both under different names. Decide which one callers need.`,
        span: null,
      });
    }
    const renamed = renameConflictingIdentifiers({ ...module, statements }, taken, false);
    for (const name of rootNames(renamed.statements)) taken.add(name);
    // A module function's own diagnostics name the module, as its diagnostics in the script do.
    const origin = separate.has(info.directory) ? { origin: module.sourceName } : {};
    moduleStatements.push(
      ...renamed.statements.map((statement) =>
        statement.kind === "function" && statement.ownDiagnostics !== undefined
          ? {
              ...statement,
              ...origin,
              ownDiagnostics: statement.ownDiagnostics.map((diagnostic) => ({
                ...diagnostic,
                sourceName: diagnostic.sourceName ?? module.sourceName,
              })),
            }
          : { ...statement, ...origin },
      ),
    );
    diagnostics.push(
      ...renamed.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        sourceName: diagnostic.sourceName ?? module.sourceName,
      })),
    );
    for (const action of renamed.actions ?? []) actions.add(action);
  }
  return {
    ...program,
    statements: [
      ...[...helpers].sort(([left], [right]) => left - right).map(([, statement]) => statement),
      ...moduleStatements,
      ...programStatements,
    ],
    diagnostics,
    actions: [...actions],
  };
}

/** Words an identifier choice value may not be (V30 §38 grammar keywords and protected type names). */
const RESERVED_IDS = new Set([
  ..."let function return if else switch case default repeat for in while break continue and or not set true false".split(
    " ",
  ),
  ..."null choose speaker say as label goto call end exit fallback global tagged save load delete is".split(
    " ",
  ),
  ..."string boolean integer number date time datetime timestamp duration list dict object range media script timer".split(
    " ",
  ),
]);

/**
 * For each script an entry menu offers, an identifier from its file name, such as `intro` for `intro.tease` and
 * `first_de` for `chapters/first_de.tease`: unique, and different from the words TeaseScript reserves.
 */
function menuIds(paths: readonly string[]): Map<string, string> {
  const taken = new Set<string>();
  return new Map(
    paths.map((path) => {
      const file = path
        .split("/")
        .at(-1)!
        .replace(/\.tease$/u, "");
      let base = file.replace(/[^A-Za-z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "");
      if (base === "" || /^[0-9]/u.test(base) || RESERVED_IDS.has(base)) base = `script_${base}`;
      let id = base;
      for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}_${suffix}`;
      taken.add(id);
      return [path, id];
    }),
  );
}

function rootNames(statements: readonly IrStatement[]): string[] {
  return statements.flatMap((statement) =>
    statement.kind === "let" || statement.kind === "function" ? [statement.name] : [],
  );
}

interface HelperFunctionEntry {
  statement: Extract<IrStatement, { kind: "function" }>;
  diagnostics: MigrationDiagnostic[];
  /** The static fields of the function's helper class, which come along with it. */
  fields: IrStatement[];
  /** The action IDs and dispatcher marker the function's program uses (withActionDispatcher). */
  actions: readonly string[];
}

function buildFunctionCatalog(
  programs: MigrationProgram[],
): Map<string, HelperFunctionEntry | null> {
  const catalog = new Map<string, HelperFunctionEntry | null>();
  for (const program of programs) {
    const fields = program.statements.filter((statement) => statement.kind === "let");
    for (const statement of program.statements) {
      if (statement.kind !== "function") continue;
      if (catalog.has(statement.name)) {
        // Generated helpers are identical wherever they appear; other duplicates are ambiguous.
        if (helperDefinitionOrder(statement) < 0) catalog.set(statement.name, null);
        continue;
      }
      catalog.set(statement.name, {
        statement,
        diagnostics: program.diagnostics.filter((diagnostic) =>
          inside(diagnostic.span, statement.span),
        ),
        fields,
        actions: program.actions ?? [],
      });
    }
  }
  return catalog;
}

function composeProgram(
  program: MigrationProgram,
  catalog: Map<string, HelperFunctionEntry | null>,
  /** Helper class methods that are global functions of their class's file, which the script calls there. */
  globalFunctions: ReadonlySet<string> = new Set(),
): MigrationProgram {
  const localFunctions = new Set(
    program.statements.flatMap((statement) =>
      statement.kind === "function" ? [statement.name] : [],
    ),
  );
  const required = new Set<string>();
  const diagnostics = [...program.diagnostics];
  const queue = [...collectCallNames(program.statements)];

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (localFunctions.has(name) || required.has(name) || globalFunctions.has(name)) continue;
    const entry = catalog.get(name);
    if (entry === undefined) continue;
    if (entry === null) {
      diagnostics.push({
        code: "SX_HELPER_NAME_COLLISION",
        severity: "error",
        message: `Package contains more than one auxiliary helper function named ${name}; automatic linkage is ambiguous.`,
        span: null,
      });
      continue;
    }
    required.add(name);
    for (const dependency of collectCallNames(entry.statement.body)) queue.push(dependency);
  }

  const helperStatements: IrStatement[] = [];
  const fields = new Set<IrStatement>();
  const actions = new Set(program.actions ?? []);
  for (const [name, entry] of catalog) {
    if (!required.has(name) || entry === null) continue;
    helperStatements.push(entry.statement);
    diagnostics.push(...entry.diagnostics);
    for (const field of entry.fields) fields.add(field);
    for (const action of entry.actions) actions.add(action);
  }
  helperStatements.unshift(...fields);

  const composed = withActionDispatcher({
    ...program,
    statements: [...helperStatements, ...program.statements],
    ...(actions.size === 0 ? {} : { actions: [...actions] }),
  });
  diagnostics.push(...packageDependencyDiagnostics(composed.statements, globalFunctions));
  return renameConflictingIdentifiers({
    ...composed,
    diagnostics: deduplicateDiagnostics(diagnostics),
  });
}

export function packageDependencyDiagnostics(
  statements: readonly IrStatement[],
  /** Global functions of other files of the package. */
  globalFunctions: ReadonlySet<string> = new Set(),
): MigrationDiagnostic[] {
  const defined = new Set([
    ...globalFunctions,
    ...statements.flatMap((statement) => (statement.kind === "function" ? [statement.name] : [])),
  ]);
  const diagnostics: MigrationDiagnostic[] = [];
  for (const name of collectCallNames(statements)) {
    if (defined.has(name) || ACCEPTED_EXTERNAL_CALLS.has(name)) continue;
    diagnostics.push({
      code: "SX_UNRESOLVED_PACKAGE_CALL",
      severity: "error",
      message: `Generated package call ${name}() does not resolve to generated package code or a known accepted TeaseScript capability.`,
      span: null,
    });
  }
  return diagnostics;
}

function collectCallNames(value: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectCallNames(item, names);
    return names;
  }
  if (!isRecord(value)) return names;
  if (value.kind === "call" && typeof value.name === "string") names.add(value.name);
  for (const child of Object.values(value)) collectCallNames(child, names);
  return names;
}

function inside(child: SourceSpan | null, parent: SourceSpan | null): boolean {
  if (child === null || parent === null) return false;
  if (child.line < parent.line || child.endLine > parent.endLine) return false;
  if (child.line === parent.line && child.column < parent.column) return false;
  if (child.endLine === parent.endLine && child.endColumn > parent.endColumn) return false;
  return true;
}

function deduplicateDiagnostics(diagnostics: MigrationDiagnostic[]): MigrationDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const span = diagnostic.span;
    const key = `${diagnostic.sourceName ?? ""}|${diagnostic.code}|${diagnostic.severity}|${diagnostic.message}|${span?.line ?? ""}|${span?.column ?? ""}|${span?.endLine ?? ""}|${span?.endColumn ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
