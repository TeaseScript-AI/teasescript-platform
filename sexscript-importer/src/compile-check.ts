import { isRecord } from "./ast.ts";

export interface TeaseCompileDiagnostic {
  severity: string;
  code: string;
  message: string;
  /** One-based line in the generated `.tease` source. */
  line: number | null;
  /** One-based column in the generated `.tease` source. */
  column: number | null;
}

export interface TeaseCompileResult {
  compiled: boolean;
  diagnostics: TeaseCompileDiagnostic[];
}

/** `builtins` registers additional host function names, as the compiler's `builtins` option does. */
export type TeaseCompiler = (source: string, builtins?: readonly string[]) => TeaseCompileResult;

const repositoryCompilerUrl = new URL("../../dist/src/index.js", import.meta.url);

/**
 * Loads the real TeaseScript compiler from the repository build.
 * Run `npm run build:typescript` in the repository root first.
 */
export async function loadRepositoryCompiler(): Promise<TeaseCompiler> {
  let module: unknown;
  try {
    module = await import(repositoryCompilerUrl.href);
  } catch (error) {
    throw new Error(
      `TeaseScript compiler build not found at ${repositoryCompilerUrl.pathname}; run "npm run build:typescript" in the repository root.`,
      { cause: error },
    );
  }
  if (!isRecord(module) || typeof module.compileSource !== "function") {
    throw new Error("Repository build does not export compileSource().");
  }
  const compileSource = module.compileSource;
  return (source, builtins = []) => {
    const result: unknown = compileSource(source, { builtins: [...builtins] });
    return readCompilationResult(result);
  };
}

/** One file of a project (ADR 0022): its package path, `main.tease` for the entry, and its source. */
export interface TeaseProjectFile {
  path: string;
  source: string;
}

export interface TeaseProjectDiagnostic extends TeaseCompileDiagnostic {
  /** The project file the diagnostic belongs to. */
  path: string;
}

export interface TeaseProjectCompileResult {
  /** Whether the project compiled into one plan, which needs every file free of errors. */
  compiled: boolean;
  diagnostics: TeaseProjectDiagnostic[];
}

export type TeaseProjectCompiler = (
  files: readonly TeaseProjectFile[],
  builtins?: readonly string[],
) => TeaseProjectCompileResult;

/** Loads the real compiler's project compilation (`compileProject`) from the repository build. */
export async function loadRepositoryProjectCompiler(): Promise<TeaseProjectCompiler> {
  const module: unknown = await import(repositoryCompilerUrl.href);
  if (!isRecord(module) || typeof module.compileProject !== "function") {
    throw new Error("Repository build does not export compileProject().");
  }
  const compileProject = module.compileProject;
  return (files, builtins = []) => {
    const result: unknown = compileProject(
      files.map(({ path, source }) => ({ path, source })),
      { builtins: [...builtins] },
    );
    if (!isRecord(result) || !Array.isArray(result.diagnostics)) {
      throw new Error("compileProject() returned an unexpected result shape.");
    }
    return {
      compiled: result.plan !== null && result.plan !== undefined,
      diagnostics: result.diagnostics.map((value: unknown) => ({
        ...readDiagnostic(value),
        path: isRecord(value) && typeof value.path === "string" ? value.path : "",
      })),
    };
  };
}

function readCompilationResult(value: unknown): TeaseCompileResult {
  if (!isRecord(value) || !Array.isArray(value.diagnostics)) {
    throw new Error("compileSource() returned an unexpected result shape.");
  }
  return {
    compiled: value.plan !== null && value.plan !== undefined,
    diagnostics: value.diagnostics.map(readDiagnostic),
  };
}

function readDiagnostic(value: unknown): TeaseCompileDiagnostic {
  if (!isRecord(value)) throw new Error("compileSource() returned a malformed diagnostic.");
  const start = isRecord(value.span) && isRecord(value.span.start) ? value.span.start : null;
  return {
    severity: typeof value.severity === "string" ? value.severity : "error",
    code: typeof value.code === "string" ? value.code : "UNKNOWN",
    message: typeof value.message === "string" ? value.message : "",
    line: typeof start?.line === "number" ? start.line + 1 : null,
    column: typeof start?.column === "number" ? start.column + 1 : null,
  };
}
