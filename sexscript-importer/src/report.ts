import { walkAst, type ParsedGroovyFile, type SourceSpan } from "./ast.ts";
import type { IrStatement, MigrationDiagnostic } from "./ir.ts";
import { lowerParsedFile } from "./lower.ts";

const SOURCE_STATEMENT_KINDS = new Set([
  "expressionStatement",
  "if",
  "while",
  "for",
  "switch",
  "return",
  "break",
  "continue",
  "tryCatch",
  "unsupportedStatement",
]);
const WRAPPER_DIAGNOSTIC_CODES = new Set([
  "SX_SAVE_ARGUMENT",
  "SX_UNSUPPORTED_ARGUMENT",
  "SX_UNSUPPORTED_ASSIGNMENT_VALUE",
  "SX_UNSUPPORTED_CALL",
  "SX_UNSUPPORTED_DECLARATION_VALUE",
  "SX_UNSUPPORTED_EXPRESSION_STATEMENT",
  "SX_UNSUPPORTED_FOR",
  "SX_UNSUPPORTED_FUNCTION_RETURN",
  "SX_UNSUPPORTED_IF",
  "SX_UNSUPPORTED_WHILE",
]);


export interface FeasibilityFileReport {
  sourceName: string;
  parseErrors: number;
  migrationErrors: number;
  rootMigrationErrors: number;
  sourceStatementNodes: number;
  emittedIrStatements: number;
  unsupportedPlaceholders: number;
}

export interface FeasibilityReport {
  fileCount: number;
  parseErrorFileCount: number;
  migrationCleanFileCount: number;
  sourceStatementNodes: number;
  emittedIrStatements: number;
  unsupportedPlaceholders: number;
  migrationErrors: number;
  rootMigrationErrors: number;
  diagnosticsByCode: Record<string, number>;
  rootDiagnosticsByCode: Record<string, number>;
  files: FeasibilityFileReport[];
}

export function analyzeFeasibility(files: ParsedGroovyFile[]): FeasibilityReport {
  const report: FeasibilityReport = {
    fileCount: files.length,
    parseErrorFileCount: 0,
    migrationCleanFileCount: 0,
    sourceStatementNodes: 0,
    emittedIrStatements: 0,
    unsupportedPlaceholders: 0,
    migrationErrors: 0,
    rootMigrationErrors: 0,
    diagnosticsByCode: emptyCounts(),
    rootDiagnosticsByCode: emptyCounts(),
    files: [],
  };

  for (const file of files) {
    const parseErrors = file.diagnostics.length;
    if (parseErrors > 0 || file.root === null) report.parseErrorFileCount += 1;

    let sourceStatementNodes = 0;
    if (file.root !== null) {
      walkAst(file.root, (node) => {
        if (SOURCE_STATEMENT_KINDS.has(node.kind)) sourceStatementNodes += 1;
      });
    }

    const program = lowerParsedFile(file);
    const errors = program.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    const roots = rootDiagnostics(errors);
    const ir = countIrStatements(program.statements);

    if (errors.length === 0) report.migrationCleanFileCount += 1;
    report.sourceStatementNodes += sourceStatementNodes;
    report.emittedIrStatements += ir.total;
    report.unsupportedPlaceholders += ir.unsupported;
    report.migrationErrors += errors.length;
    report.rootMigrationErrors += roots.length;
    for (const diagnostic of errors) increment(report.diagnosticsByCode, diagnostic.code);
    for (const diagnostic of roots) increment(report.rootDiagnosticsByCode, diagnostic.code);

    report.files.push({
      sourceName: file.sourceName,
      parseErrors,
      migrationErrors: errors.length,
      rootMigrationErrors: roots.length,
      sourceStatementNodes,
      emittedIrStatements: ir.total,
      unsupportedPlaceholders: ir.unsupported,
    });
  }

  report.diagnosticsByCode = sortCounts(report.diagnosticsByCode);
  report.rootDiagnosticsByCode = sortCounts(report.rootDiagnosticsByCode);
  report.files.sort((left, right) => {
    if (left.rootMigrationErrors !== right.rootMigrationErrors) return right.rootMigrationErrors - left.rootMigrationErrors;
    return left.sourceName.localeCompare(right.sourceName);
  });
  return report;
}

export function rootDiagnostics(diagnostics: MigrationDiagnostic[]): MigrationDiagnostic[] {
  const exact = new Map<string, MigrationDiagnostic>();
  const withoutSpan: MigrationDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.span == null) {
      withoutSpan.push(diagnostic);
      continue;
    }
    const key = spanKey(diagnostic.span);
    const current = exact.get(key);
    if (current === undefined || (isWrapper(current) && !isWrapper(diagnostic))) {
      exact.set(key, diagnostic);
    }
  }

  const located = [...exact.values()];
  const roots = located.filter((candidate) => {
    if (!isWrapper(candidate)) return true;
    const candidateSpan = candidate.span;
    if (candidateSpan == null) return true;
    return !located.some((other) =>
      other !== candidate && other.span != null && strictlyContains(candidateSpan, other.span),
    );
  });
  return [...withoutSpan, ...roots];
}

function isWrapper(diagnostic: MigrationDiagnostic): boolean {
  return WRAPPER_DIAGNOSTIC_CODES.has(diagnostic.code);
}

function countIrStatements(statements: IrStatement[]): { total: number; unsupported: number } {
  let total = 0;
  let unsupported = 0;
  const visit = (items: IrStatement[]): void => {
    for (const statement of items) {
      total += 1;
      if (statement.kind === "unsupported") unsupported += 1;
      if (statement.kind === "if") {
        visit(statement.then);
        visit(statement.else);
      } else if (statement.kind === "while" || statement.kind === "for" || statement.kind === "function") {
        visit(statement.body);
      } else if (statement.kind === "switch") {
        for (const branch of statement.cases) visit(branch.body);
        visit(statement.default);
      }
    }
  };
  visit(statements);
  return { total, unsupported };
}

function strictlyContains(outer: SourceSpan, inner: SourceSpan): boolean {
  const startsBeforeOrEqual = comparePosition(outer.line, outer.column, inner.line, inner.column) <= 0;
  const endsAfterOrEqual = comparePosition(outer.endLine, outer.endColumn, inner.endLine, inner.endColumn) >= 0;
  return startsBeforeOrEqual && endsAfterOrEqual && spanKey(outer) !== spanKey(inner);
}

function comparePosition(leftLine: number, leftColumn: number, rightLine: number, rightColumn: number): number {
  if (leftLine !== rightLine) return leftLine - rightLine;
  return leftColumn - rightColumn;
}

function spanKey(span: SourceSpan): string {
  return `${span.line}:${span.column}:${span.endLine}:${span.endColumn}`;
}

function emptyCounts(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function sortCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).sort(([leftName, leftCount], [rightName, rightCount]) => {
      if (leftCount !== rightCount) return rightCount - leftCount;
      return leftName.localeCompare(rightName);
    }),
  );
}
