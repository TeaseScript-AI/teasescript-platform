import type { ParsedGroovyFile, SourceSpan } from "./ast.ts";
import type { IrExpression, IrStatement, MigrationDiagnostic, MigrationProgram } from "./ir.ts";
import { buildHelperRegistry, lowerParsedFile } from "./lower.ts";

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
  const helperRegistry = buildHelperRegistry(files);
  const lowered = files.map((file) => lowerParsedFile(file, { helperRegistry }));
  const helperPrograms = lowered.filter((_, index) => files[index]?.root?.kind === "compilationUnit");
  const functionCatalog = buildFunctionCatalog(helperPrograms);

  return lowered.map((program, index) => {
    if (files[index]?.root?.kind !== "scriptBody") return program;
    return composeProgram(program, functionCatalog);
  });
}

interface HelperFunctionEntry {
  statement: Extract<IrStatement, { kind: "function" }>;
  diagnostics: MigrationDiagnostic[];
}

function buildFunctionCatalog(programs: MigrationProgram[]): Map<string, HelperFunctionEntry | null> {
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
        diagnostics: program.diagnostics.filter((diagnostic) => inside(diagnostic.span, statement.span)),
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
    program.statements.flatMap((statement) => (statement.kind === "function" ? [statement.name] : [])),
  );
  const required = new Set<string>();
  const diagnostics = [...program.diagnostics];
  const queue = [...collectCallNames(program.statements)];

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (localFunctions.has(name) || required.has(name) || !catalog.has(name)) continue;
    const entry = catalog.get(name);
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
  return {
    ...program,
    statements,
    diagnostics: deduplicateDiagnostics(diagnostics),
  };
}

export function packageDependencyDiagnostics(statements: readonly IrStatement[]): MigrationDiagnostic[] {
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

function collectCallNames(value: unknown): Set<string> {
  const names = new Set<string>();
  walk(value, (expression) => {
    if (expression.kind === "call") names.add(expression.name);
  });
  return names;
}

function walk(value: unknown, visit: (expression: IrExpression) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (isIrExpression(record)) visit(record as IrExpression);
  for (const child of Object.values(record)) walk(child, visit);
}

function isIrExpression(value: Record<string, unknown>): boolean {
  return new Set([
    "literal",
    "variable",
    "list",
    "object",
    "index",
    "property",
    "methodCall",
    "load",
    "choice",
    "range",
    "unary",
    "binary",
    "call",
  ]).has(String(value.kind));
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
