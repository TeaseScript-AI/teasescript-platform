import { constantString, variableName, walkAst, type AstNode, type ParsedGroovyFile } from "./ast.ts";
import { SEXSCRIPT_API_METHODS } from "./sexscript-api.ts";

export interface InventoryReport {
  fileCount: number;
  parseErrorCount: number;
  nodeKinds: Record<string, number>;
  unsupportedNodeTypes: Record<string, number>;
  methodCalls: Record<string, number>;
  implicitCalls: Record<string, number>;
  mainReceiverCalls: Record<string, number>;
  sexScriptApiCalls: Record<string, number>;
  constructorTypes: Record<string, number>;
}

export function inventoryFiles(files: ParsedGroovyFile[]): InventoryReport {
  const report: InventoryReport = {
    fileCount: files.length,
    parseErrorCount: 0,
    nodeKinds: {},
    unsupportedNodeTypes: {},
    methodCalls: {},
    implicitCalls: {},
    mainReceiverCalls: {},
    sexScriptApiCalls: {},
    constructorTypes: {},
  };

  for (const file of files) {
    if (file.diagnostics.length > 0 || file.root === null) {
      report.parseErrorCount += 1;
      continue;
    }
    walkAst(file.root, (node) => inventoryNode(report, node));
  }
  return sortReport(report);
}

function inventoryNode(report: InventoryReport, node: AstNode): void {
  increment(report.nodeKinds, node.kind);

  if (node.kind === "unsupportedStatement" || node.kind === "unsupportedExpression") {
    increment(report.unsupportedNodeTypes, text(node.groovyType) ?? "unknown");
    return;
  }

  if (node.kind === "constructorCall") {
    increment(report.constructorTypes, text(node.type) ?? "unknown");
    return;
  }

  if (node.kind !== "methodCall") return;
  const method = constantString(node.method);
  if (method === null) return;

  increment(report.methodCalls, method);
  if (node.implicitThis === true) increment(report.implicitCalls, method);
  if (variableName(node.object) === "main") increment(report.mainReceiverCalls, method);

  if (
    SEXSCRIPT_API_METHODS.has(method) &&
    (node.implicitThis === true || variableName(node.object) === "main")
  ) {
    increment(report.sexScriptApiCalls, method);
  }
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sortCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).sort(([leftName, leftCount], [rightName, rightCount]) => {
      if (leftCount !== rightCount) return rightCount - leftCount;
      return leftName.localeCompare(rightName);
    }),
  );
}

function sortReport(report: InventoryReport): InventoryReport {
  return {
    ...report,
    nodeKinds: sortCounts(report.nodeKinds),
    unsupportedNodeTypes: sortCounts(report.unsupportedNodeTypes),
    methodCalls: sortCounts(report.methodCalls),
    implicitCalls: sortCounts(report.implicitCalls),
    mainReceiverCalls: sortCounts(report.mainReceiverCalls),
    sexScriptApiCalls: sortCounts(report.sexScriptApiCalls),
    constructorTypes: sortCounts(report.constructorTypes),
  };
}
