import { isRecord, type ParsedGroovyFile, type SourceSpan } from "./ast.ts";
import type { IrStatement, MigrationDiagnostic, MigrationProgram } from "./ir.ts";
import {
  buildHelperRegistry,
  describeMixinModule,
  lowerParsedFile,
  packageFunctionNames,
} from "./lower.ts";
import { renameConflictingIdentifiers } from "./naming.ts";

const ACCEPTED_EXTERNAL_CALLS = new Set([
  "askBoolean",
  "askBooleans",
  "askInteger",
  "askNumber",
  "askText",
  "ceil",
  "chance",
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
  "toBoolean",
  "toDate",
  "toDateTime",
  "toInteger",
  "toNumber",
  "toString",
  "toTime",
]);

export function lowerSelfContainedPackage(files: readonly ParsedGroovyFile[]): MigrationProgram[] {
  return lowerPackage(files).composed;
}

export interface LoweredPackage {
  /** Each file lowered with package context, before helper composition. */
  lowered: MigrationProgram[];
  /** Scripts with their package helpers and loaded modules embedded; other files as lowered. */
  composed: MigrationProgram[];
}

export function lowerPackage(files: readonly ParsedGroovyFile[]): LoweredPackage {
  const helperRegistry = buildHelperRegistry(files);
  const mixinModules = files.flatMap((file) => describeMixinModule(file) ?? []);
  const packageFunctions = packageFunctionNames(files);
  const lowered = files.map((file) =>
    lowerParsedFile(file, {
      helperRegistry,
      mixinModules,
      packageFunctions,
      renameIdentifiers: false,
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
function withLoadedModules(
  program: MigrationProgram,
  modulePrograms: readonly MigrationProgram[],
): MigrationProgram {
  const directories = new Set(program.loadsModuleDirectories ?? []);
  if (directories.size === 0) return program;
  const taken = new Set(rootNames(program.statements));
  const moduleStatements: IrStatement[] = [];
  const diagnostics = [...program.diagnostics];
  const modules = modulePrograms
    .filter((module) => module.module !== undefined && directories.has(module.module.directory))
    .toSorted((left, right) => left.module!.name.localeCompare(right.module!.name));
  for (const module of modules) {
    const renamed = renameConflictingIdentifiers(module, taken, false);
    for (const name of rootNames(renamed.statements)) taken.add(name);
    moduleStatements.push(...renamed.statements);
    diagnostics.push(...renamed.diagnostics);
  }
  return { ...program, statements: [...moduleStatements, ...program.statements], diagnostics };
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
        catalog.set(statement.name, null);
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

  const statements = [...helperStatements, ...program.statements];
  diagnostics.push(...packageDependencyDiagnostics(statements));
  return renameConflictingIdentifiers({
    ...program,
    statements,
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
    const key = `${diagnostic.code}|${diagnostic.severity}|${diagnostic.message}|${span?.line ?? ""}|${span?.column ?? ""}|${span?.endLine ?? ""}|${span?.endColumn ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
