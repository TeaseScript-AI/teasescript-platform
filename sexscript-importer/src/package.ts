import { isRecord, type ParsedGroovyFile, type SourceSpan } from "./ast.ts";
import type { IrStatement, MigrationDiagnostic, MigrationProgram } from "./ir.ts";
import {
  buildHelperRegistry,
  describeMixinModule,
  loadedModuleDirectories,
  lowerParsedFile,
  packageFunctionNames,
  packageGlobalTypes,
  packageResultUses,
  packageStableNames,
  packageStopsBackgroundSounds,
} from "./lower.ts";
import { helperDefinitionOrder, withActionDispatcher } from "./helpers.ts";
import { renameConflictingIdentifiers } from "./naming.ts";
import type { ProposalId } from "./proposals.ts";

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
  "getMilliseconds",
  "getSeconds",
  "getTime",
  "openUrl",
  "random",
  "randomInteger",
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
]);

export interface PackageOptions {
  /** Proposed language changes to emit in their working syntax (see proposals.ts). */
  proposals?: ReadonlySet<ProposalId>;
}

export function lowerSelfContainedPackage(
  files: readonly ParsedGroovyFile[],
  options: PackageOptions = {},
): MigrationProgram[] {
  return lowerPackage(files, options).composed;
}

export interface LoweredPackage {
  /** Each file lowered with package context, before helper composition. */
  lowered: MigrationProgram[];
  /** Scripts with their package helpers and loaded modules embedded; other files as lowered. */
  composed: MigrationProgram[];
}

export function lowerPackage(
  files: readonly ParsedGroovyFile[],
  options: PackageOptions = {},
): LoweredPackage {
  const helperRegistry = buildHelperRegistry(files);
  const mixinModules = files.flatMap((file) => describeMixinModule(file) ?? []);
  const stableNames = packageStableNames(files);
  // Function names and object field types are shared only by a script and the mixin modules it loads.
  const groups = compositionGroups(files);
  const stopsBackgroundSounds = packageStopsBackgroundSounds(files);
  const resultUses = packageResultUses(files);
  const directoryFiles = new Map<string, string[]>();
  for (const file of files) {
    const directory = file.sourceName.split(/[\\/]/u).at(-2) ?? "";
    directoryFiles.set(directory, [...(directoryFiles.get(directory) ?? []), file.sourceName]);
  }
  const lowered = files.map((file, index) =>
    lowerParsedFile(file, {
      helperRegistry,
      mixinModules,
      packageFunctions: packageFunctionNames(groups[index]!),
      stableNames,
      globalTypes: packageGlobalTypes(groups[index]!),
      stopsBackgroundSounds,
      resultUses,
      directoryFiles,
      renameIdentifiers: false,
      ...(options.proposals === undefined ? {} : { proposals: options.proposals }),
    }),
  );
  const helperPrograms = lowered.filter(
    (_, index) => files[index]?.root?.kind === "compilationUnit",
  );
  const functionCatalog = buildFunctionCatalog(helperPrograms);
  const modulePrograms = lowered.filter((program) => program.module !== undefined);

  const composed = lowered.map((program, index) => {
    if (files[index]?.root?.kind !== "scriptBody" || program.module !== undefined) return program;
    return composeProgram(withLoadedModules(program, modulePrograms), functionCatalog);
  });
  return { lowered, composed };
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
    moduleStatements.push(...renamed.statements);
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
