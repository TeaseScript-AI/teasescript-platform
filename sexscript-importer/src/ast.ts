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

export interface SourceComment {
  line: number;
  column: number;
  endLine: number;
  /** Exact comment text including its line or block comment delimiters. */
  text: string;
}

export interface ParsedGroovyFile {
  formatVersion: 1;
  sourceName: string;
  groovyVersion: string;
  mode: "script-body" | "unit";
  root: AstNode | null;
  /** Original legacy source text; absent in older parser output. */
  source?: string;
  /** Source comments in source order; absent in older parser output. */
  comments?: SourceComment[];
  diagnostics: ParserDiagnostic[];
}

export interface GroovyParameter {
  name: string;
  defaultValue: AstNode | null;
  /** Groovy declared the parameter's type, `int count`, rather than leaving it to `def`. */
  typed?: true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAstNode(value: unknown): value is AstNode {
  return isRecord(value) && typeof value.kind === "string";
}

/** Validates parser-helper JSON at the process boundary. */
export function parseParsedGroovyFile(value: unknown, origin: string): ParsedGroovyFile {
  if (!isRecord(value) || value.formatVersion !== 1) {
    throw new Error(`Unsupported parser format in ${origin}`);
  }
  const { sourceName, groovyVersion, mode, root, source, comments, diagnostics } = value;
  if (
    typeof sourceName !== "string" ||
    typeof groovyVersion !== "string" ||
    (mode !== "script-body" && mode !== "unit") ||
    (root !== null && !isAstNode(root)) ||
    (source !== undefined && typeof source !== "string") ||
    !Array.isArray(diagnostics)
  ) {
    throw new Error(`Malformed parser output in ${origin}`);
  }
  const parsedDiagnostics: ParserDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (
      !isRecord(diagnostic) ||
      typeof diagnostic.code !== "string" ||
      typeof diagnostic.message !== "string"
    ) {
      throw new Error(`Malformed parser diagnostic in ${origin}`);
    }
    parsedDiagnostics.push({ code: diagnostic.code, message: diagnostic.message });
  }
  return {
    formatVersion: 1,
    sourceName,
    groovyVersion,
    mode,
    root,
    ...(source === undefined ? {} : { source }),
    comments: parseComments(comments, origin),
    diagnostics: parsedDiagnostics,
  };
}

function parseComments(value: unknown, origin: string): SourceComment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Malformed parser comments in ${origin}`);
  return value.map((comment) => {
    if (
      !isRecord(comment) ||
      typeof comment.line !== "number" ||
      typeof comment.column !== "number" ||
      typeof comment.endLine !== "number" ||
      typeof comment.text !== "string"
    ) {
      throw new Error(`Malformed parser comment in ${origin}`);
    }
    return {
      line: comment.line,
      column: comment.column,
      endLine: comment.endLine,
      text: comment.text,
    };
  });
}

/**
 * Reads exported closure (`default`) or method (`initialExpression`) parameters.
 * Returns null when any entry is malformed.
 */
export function groovyParameters(value: unknown): GroovyParameter[] | null {
  if (!Array.isArray(value)) return [];
  const result: GroovyParameter[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string") return null;
    const initial = item.initialExpression ?? item.default;
    const typed = typeof item.type === "string" && !/^(java\.lang\.)?Object$/u.test(item.type);
    result.push({
      name: item.name,
      defaultValue: isAstNode(initial) ? initial : null,
      ...(typed ? { typed: true as const } : {}),
    });
  }
  return result;
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
