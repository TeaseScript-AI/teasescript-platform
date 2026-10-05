import {
  constantString,
  isAstNode,
  isRecord,
  walkAst,
  type AstNode,
  type ParsedGroovyFile,
  type SourceSpan,
} from "./ast.ts";
import type { IrStatement, MigrationDiagnostic, MigrationProgram } from "./ir.ts";
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
} from "./lower.ts";
import { helperDefinitionOrder, withActionDispatcher } from "./helpers.ts";
import { promoteGlobalFunctions, type GlobalPromotion } from "./globals.ts";
import { renameConflictingIdentifiers } from "./naming.ts";
import { legacyProfilePrompt } from "./profile.ts";
import type { ProposalId } from "./proposals.ts";
import type { AcceptedForm, MediaFile } from "./workarounds.ts";

const ACCEPTED_EXTERNAL_CALLS = new Set([
  "askBoolean",
  "askBooleans",
  "askInteger",
  "askNumber",
  "askText",
  "ceil",
  "chance",
  // Proposed media-tags capability; emitted only when the proposal is selected.
  "countImages",
  "floor",
  "getDate",
  "getDateTime",
  "getTime",
  "getTimestamp",
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
  /** Proposed language changes to emit in their working syntax (see proposals.ts). */
  proposals?: ReadonlySet<ProposalId>;
  /** Accepted forms to emit instead of their workarounds (see workarounds.ts). */
  accepted?: ReadonlySet<AcceptedForm>;
  /** The package's images, which legacy image counts read at conversion time. */
  media?: readonly MediaFile[];
  /** Every file of the package's legacy data folder, relative to it, which file existence tests read. */
  files?: readonly string[];
  /**
   * A lone file converted on its own, without a package around it: it keeps its name, and a transfer names the
   * converted file of any legacy script name. Otherwise a package's only script becomes its main.tease.
   */
  standalone?: boolean;
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
  /** Scripts with their package helpers and loaded modules embedded; other files as lowered. */
  composed: MigrationProgram[];
  /**
   * The package's entry, `main.tease` (ADR 0022 §1): the index of the script that becomes it, or a generated menu over
   * the scripts the legacy player listed. Null for a lone file converted on its own, which keeps its name.
   */
  main: { file: number } | { menu: MigrationProgram } | null;
  /**
   * The functions several scripts share as `global function`s (#570), with the globals they read, in a generated
   * `helpers.tease`; null without package context.
   */
  globals: Omit<GlobalPromotion, "programs"> | null;
  /**
   * The TeaseScript path of each file relative to the package root, `main.tease` for the entry script; null for files
   * that are no scripts and for a single script without package context.
   */
  paths: Array<string | null>;
}

/** A package's scripts with their TeaseScript paths, relative to the package root (packageScripts). */
interface PackageScripts {
  /** The legacy name of each script (its path without `.groovy`, in lower case) to its TeaseScript path. */
  paths: Map<string, string>;
  /** The script that becomes `main.tease`, or null when several scripts share the package root. */
  entry: number | null;
  /** The scripts in the package root, which the legacy player listed. */
  rootScripts: number[];
  /** The TeaseScript path of each script by file index. */
  pathOf: Map<number, string>;
  /** The package root directory, with `/` separators. */
  root: string;
}

/**
 * The scripts of a package, with their paths from the package root, the common directory of the scripts. A single
 * script in the root is the entry and becomes `main.tease`, as is one named `main.groovy`.
 */
function packageScripts(
  files: readonly ParsedGroovyFile[],
  standalone: boolean,
): PackageScripts | null {
  const scripts = files.flatMap((file, index) =>
    file.root?.kind === "scriptBody" && describeMixinModule(file) === null ? [index] : [],
  );
  // A file converted alone has no package around it; a package's only script is its main.tease (ADR 0022 §1).
  if (scripts.length === 0 || (standalone && files.length < 2)) return null;
  const segments = new Map(
    scripts.map((index) => [index, files[index]!.sourceName.replaceAll("\\", "/").split("/")]),
  );
  const directories = scripts.map((index) => segments.get(index)!.slice(0, -1));
  const root = directories.reduce((common, directory) => {
    let length = 0;
    while (length < common.length && common[length] === directory[length]) length += 1;
    return common.slice(0, length);
  }, directories[0]!);
  const relative = (index: number): string => segments.get(index)!.slice(root.length).join("/");
  const rootScripts = scripts.filter((index) => !relative(index).includes("/"));
  const entry =
    rootScripts.length === 1
      ? rootScripts[0]!
      : (rootScripts.find((index) => relative(index).toLowerCase() === "main.groovy") ?? null);
  const pathOf = new Map(
    scripts.map((index) => [
      index,
      index === entry ? "main.tease" : relative(index).replace(/\.groovy$/iu, ".tease"),
    ]),
  );
  const paths = new Map(
    scripts.map((index) => [
      relative(index)
        .replace(/\.groovy$/iu, "")
        .toLowerCase(),
      pathOf.get(index)!,
    ]),
  );
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
): MigrationProgram {
  const targets = new Set<string>();
  const collect = (statements: readonly IrStatement[]): void => {
    for (const statement of statements) {
      if (statement.kind === "goto" && statement.target.kind === "file")
        targets.add(statement.target.path.toLowerCase());
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
  for (const program of programs) collect(program.statements);
  const base = (path: string): string =>
    path.replace(/_[a-z]{2}(?:_[a-z]{2})?\.tease$/iu, ".tease");
  const targeted = (path: string): boolean =>
    targets.has(path.toLowerCase()) || targets.has(base(path).toLowerCase());
  const offered = scripts.rootScripts
    .map((index) => scripts.pathOf.get(index)!)
    .filter((path) => !targeted(path))
    .sort();
  const choices =
    offered.length > 0 ? offered : scripts.rootScripts.map((index) => scripts.pathOf.get(index)!);
  const variants = [...scripts.pathOf.values()]
    .filter((path) => base(path) !== path && targeted(path) && !targets.has(path.toLowerCase()))
    .sort();
  const message =
    "The legacy player listed the package's scripts for the player to pick; a TeaseScript package starts at main.tease, so this menu offers each script that no other script chains to." +
    (variants.length === 0
      ? ""
      : ` The legacy player also chose a localized variant of a script by the system language, which the converted scripts do not, so these variants are not reached: ${variants.join(", ")}.`);
  const name = (path: string): string => path.replace(/\.tease$/u, "");
  const picked = { kind: "variable" as const, name: "picked" };
  let chain: IrStatement[] = [
    { kind: "goto", target: { kind: "file", path: choices.at(-1)! }, span: null },
  ];
  for (let index = choices.length - 2; index >= 0; index -= 1) {
    chain = [
      {
        kind: "if",
        condition: {
          kind: "binary",
          operator: "==",
          left: picked,
          right: { kind: "literal", value: index },
        },
        then: [{ kind: "goto", target: { kind: "file", path: choices[index]! }, span: null }],
        else: chain,
        span: null,
      },
    ];
  }
  return {
    sourceName: `${scripts.root}/main.tease`,
    metadata: null,
    statements: [
      { kind: "comment", text: `// NOTE SX_ENTRY_MENU: ${message}`, trailing: false, span: null },
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
          options: choices.map((path) => ({ kind: "literal", value: name(path) })),
        },
        span: null,
      },
      ...chain,
    ],
    diagnostics: [{ code: "SX_ENTRY_MENU", severity: "warning", message, span: null }],
  };
}

export function lowerPackage(
  files: readonly ParsedGroovyFile[],
  options: PackageOptions = {},
): LoweredPackage {
  const helperRegistry = buildHelperRegistry(files);
  const mixinModules = files.flatMap((file) => describeMixinModule(file) ?? []);
  const stableNames = packageStableNames(files);
  const storageLiterals = packageStorageLiterals(files);
  // Function names and object field types are shared only by a script and the mixin modules it loads.
  const groups = compositionGroups(files);
  const stopsBackgroundSounds = packageStopsBackgroundSounds(files);
  const resultUses = packageResultUses(files);
  const directoryFiles = new Map<string, string[]>();
  for (const file of files) {
    const directory = file.sourceName.split(/[\\/]/u).at(-2) ?? "";
    directoryFiles.set(directory, [...(directoryFiles.get(directory) ?? []), file.sourceName]);
  }
  // Map uses are shared within a composition group, like function names and field types.
  const scripts = packageScripts(files, options.standalone === true);
  const functionResults = files.map((_, index) => packageFunctionResults(groups[index]!));
  const mapUses = files.map((_, index) => packageMapUses(groups[index]!, functionResults[index]!));
  const lowered = files.map((file, index) =>
    lowerParsedFile(file, {
      mapUses: mapUses[index]!,
      functionResults: functionResults[index]!,
      helperRegistry,
      mixinModules,
      packageFunctions: packageFunctionNames(groups[index]!),
      stableNames,
      storageLiterals,
      globalTypes: packageGlobalTypes(groups[index]!),
      stopsBackgroundSounds,
      resultUses,
      directoryFiles,
      ...(scripts === null ? {} : { scriptPaths: scripts.paths }),
      renameIdentifiers: false,
      ...(options.proposals === undefined ? {} : { proposals: options.proposals }),
      ...(options.accepted === undefined ? {} : { accepted: options.accepted }),
      ...(options.media === undefined ? {} : { media: options.media }),
      ...(options.files === undefined ? {} : { files: options.files }),
    }),
  );
  const helperPrograms = lowered.filter(
    (_, index) => files[index]?.root?.kind === "compilationUnit",
  );
  const functionCatalog = buildFunctionCatalog(helperPrograms);
  const modulePrograms = lowered.filter((program) => program.module !== undefined);

  // What a function nothing references cannot convert becomes a note, in the file and in the composed script.
  const uncalled: MigrationDiagnostic[][] = files.map(() => []);
  const composed = lowered.map((program, index) => {
    if (files[index]?.root?.kind !== "scriptBody" || program.module !== undefined) return program;
    const script = composeProgram(withLoadedModules(program, modulePrograms), functionCatalog);
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
  // Functions several scripts share become global functions in one helpers.tease (#570).
  const scriptIndexes = noted.flatMap((program, index) =>
    files[index]?.root?.kind === "scriptBody" && program.module === undefined ? [index] : [],
  );
  const promotion =
    scripts === null
      ? null
      : promoteGlobalFunctions(
          scriptIndexes.map((index) => noted[index]!),
          scripts.root,
        );
  const promotedPrograms = noted.map((program, index) => {
    const position = scriptIndexes.indexOf(index);
    return promotion === null || position < 0 ? program : promotion.programs[position]!;
  });
  // The entry asks the legacy player's profile the package reads but never saves.
  const accepted = options.accepted ?? new Set();
  const entryIndex =
    scripts?.entry ?? (scripts === null && scriptIndexes.length === 1 ? scriptIndexes[0]! : null);
  const entryProgram = entryIndex === null ? null : promotedPrograms[entryIndex]!;
  const profile =
    entryProgram === null ? [] : legacyProfilePrompt(promotedPrograms, entryProgram, accepted);
  // The prompt's helpers may meet names of the entry, which then get other names.
  const project = new Set([
    ...(promotion?.promoted.map(({ name }) => name) ?? []),
    ...(promotion?.globals.map(({ name }) => name) ?? []),
  ]);
  const composedPrograms = promotedPrograms.map((program, index) =>
    index === entryIndex && profile.length > 0
      ? renameConflictingIdentifiers(
          { ...program, statements: [...profile, ...program.statements] },
          new Set(),
          false,
          project,
        )
      : program,
  );
  return {
    lowered: lowered.map((program, index) => withUncalledNotes(program, notes(program, index))),
    composed: composedPrograms,
    main:
      scripts === null
        ? null
        : scripts.entry !== null
          ? { file: scripts.entry }
          : { menu: withProfile(entryMenu(scripts, composedPrograms), composedPrograms, accepted) },
    globals:
      promotion === null
        ? null
        : {
            helpers: promotion.helpers,
            promoted: promotion.promoted,
            globals: promotion.globals,
            kept: promotion.kept,
          },
    paths: files.map((_, index) => scripts?.pathOf.get(index) ?? null),
  };
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
function compositionGroups(files: readonly ParsedGroovyFile[]): ParsedGroovyFile[][] {
  const moduleDirectory = files.map((file) => describeMixinModule(file)?.directory ?? null);
  const loads = files.map((file) => new Set(loadedModuleDirectories(file)));
  return files.map((file, index) => {
    const directories = new Set(loads[index]);
    const own = moduleDirectory[index];
    if (own !== null && own !== undefined) directories.add(own);
    if (directories.size === 0) return [file];
    return files.filter((_, other) => {
      const directory = moduleDirectory[other];
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
    moduleStatements.push(
      ...renamed.statements.map((statement) =>
        statement.kind === "function" && statement.ownDiagnostics !== undefined
          ? {
              ...statement,
              ownDiagnostics: statement.ownDiagnostics.map((diagnostic) => ({
                ...diagnostic,
                sourceName: diagnostic.sourceName ?? module.sourceName,
              })),
            }
          : statement,
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

function rootNames(statements: readonly IrStatement[]): string[] {
  return statements.flatMap((statement) =>
    statement.kind === "let" || statement.kind === "function" ? [statement.name] : [],
  );
}

interface HelperFunctionEntry {
  statement: Extract<IrStatement, { kind: "function" }>;
  diagnostics: MigrationDiagnostic[];
}

function buildFunctionCatalog(
  programs: MigrationProgram[],
): Map<string, HelperFunctionEntry | null> {
  const catalog = new Map<string, HelperFunctionEntry | null>();
  for (const program of programs) {
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
      });
    }
  }
  return catalog;
}

function composeProgram(
  program: MigrationProgram,
  catalog: Map<string, HelperFunctionEntry | null>,
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
    if (localFunctions.has(name) || required.has(name)) continue;
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
  for (const [name, entry] of catalog) {
    if (!required.has(name) || entry === null) continue;
    helperStatements.push(entry.statement);
    diagnostics.push(...entry.diagnostics);
  }

  const composed = withActionDispatcher({
    ...program,
    statements: [...helperStatements, ...program.statements],
  });
  diagnostics.push(...packageDependencyDiagnostics(composed.statements));
  return renameConflictingIdentifiers({
    ...composed,
    diagnostics: deduplicateDiagnostics(diagnostics),
  });
}

export function packageDependencyDiagnostics(
  statements: readonly IrStatement[],
): MigrationDiagnostic[] {
  const defined = new Set(
    statements.flatMap((statement) => (statement.kind === "function" ? [statement.name] : [])),
  );
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
