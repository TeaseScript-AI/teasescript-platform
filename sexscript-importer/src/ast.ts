export interface SourceSpan {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface AstNode {
  kind: string;
  span: SourceSpan | null;
  [key: string]: unknown;
}

export interface ParserDiagnostic {
  code: string;
  message: string;
}

export interface ParsedGroovyFile {
  formatVersion: 1;
  sourceName: string;
  groovyVersion: string;
  mode: "script-body" | "unit";
  root: AstNode | null;
  diagnostics: ParserDiagnostic[];
}

export function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).kind === "string"
  );
}

export function walkAst(value: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkAst(item, visit);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  if (isAstNode(value)) visit(value);
  for (const child of Object.values(value)) walkAst(child, visit);
}

export function constantString(value: unknown): string | null {
  if (!isAstNode(value) || value.kind !== "constant") return null;
  return typeof value.value === "string" ? value.value : null;
}

export function variableName(value: unknown): string | null {
  if (!isAstNode(value) || value.kind !== "variable") return null;
  return typeof value.name === "string" ? value.name : null;
}
