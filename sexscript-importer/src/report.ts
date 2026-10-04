import { walkAst, type ParsedGroovyFile } from "./ast.ts";
import type {
  TeaseCompileDiagnostic,
  TeaseProjectCompiler,
  TeaseProjectCompileResult,
  TeaseProjectFile,
} from "./compile-check.ts";
import { emitTease } from "./emit-tease.ts";
import { rootDiagnostics } from "./diagnostics.ts";
import type { IrStatement, MigrationProgram } from "./ir.ts";
import { lowerPackage } from "./package.ts";
import type { ProposalId } from "./proposals.ts";
import {
  pendingHostFunctions,
  shimPendingCapabilities,
  type MediaFile,
  type PendingShim,
} from "./pending.ts";
import type {
  HostFunction,
  ProjectRunResult,
  RuntimeValue,
  TeaseProjectRunner,
} from "./runtime-check.ts";

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

export interface FeasibilityFileReport {
  sourceName: string;
  parseErrors: number;
  migrationErrors: number;
  rootMigrationErrors: number;
  sourceStatementNodes: number;
  emittedIrStatements: number;
  unsupportedPlaceholders: number;
  recognized: boolean;
  lowered: boolean;
  dependencyClosed: boolean;
  /** Null when no compiler was supplied or the file is not a script body. */
  compilerClean: boolean | null;
  /**
   * Compiler-clean once accepted-but-unimplemented TeaseScript capabilities are replaced by placeholder
   * calls; null when no compiler was supplied or the file is not a script body.
   */
  compilerCleanExceptPending: boolean | null;
  /** Accepted TeaseScript capabilities used by the output that the current compiler does not implement. */
  pendingCapabilities: string[];
  /** Compiler diagnostics that remain after the pending-capability placeholders. */
  compilerDiagnostics: TeaseCompileDiagnostic[];
  /** Whether a package smoke run executed this script; null when no runner was supplied. */
  smokeRunReached: boolean | null;
}

export interface FeasibilityOptions {
  /** Real TeaseScript project compiler used for the compiler-clean gate; it compiles the package as one project. */
  compiler?: TeaseProjectCompiler;
  /** Real TeaseScript runtime used for smoke runs of the package project; needs `compiler`. */
  runner?: TeaseProjectRunner;
  /** Proposed language changes to emit in their working syntax; the shim makes them compile and run. */
  proposals?: ReadonlySet<ProposalId>;
  /** The package's images, for smoke runs of proposed media tags. */
  media?: readonly MediaFile[];
}

/** One smoke run of a package project. */
export interface PackageRunResult {
  /** `main.tease`, or the file an isolated run started at. */
  entry: string;
  /** A run started at a script that no earlier run reached, with empty storage instead of the package's state. */
  isolated: boolean;
  /** `blocked`: the run reached a file that has no runnable conversion. */
  status: ProjectRunResult["status"] | "blocked";
  /** `script` is the project file of the failure. */
  failure: (NonNullable<ProjectRunResult["failure"]> & { script: string }) | null;
  blockedTarget: string | null;
  /** Project files that ran, in first-visit order. */
  visited: string[];
  transfers: number;
  steps: number;
}

export interface FeasibilityReport {
  fileCount: number;
  scriptBodyFileCount: number;
  recognizedScriptFileCount: number;
  loweredScriptFileCount: number;
  dependencyClosedScriptFileCount: number;
  /** Null when no compiler was supplied. */
  compilerCleanScriptFileCount: number | null;
  /** Null when no compiler was supplied. */
  compilerCleanExceptPendingScriptFileCount: number | null;
  parseErrorFileCount: number;
  migrationCleanFileCount: number;
  sourceStatementNodes: number;
  emittedIrStatements: number;
  unsupportedPlaceholders: number;
  migrationErrors: number;
  rootMigrationErrors: number;
  diagnosticsByCode: Record<string, number>;
  rootDiagnosticsByCode: Record<string, number>;
  /**
   * Compiler diagnostics that remain after pending-capability placeholders, grouped by code and message.
   * These point at importer output rather than at known TeaseScript implementation gaps.
   */
  compilerDiagnosticsByMessage: Record<string, number>;
  /** Script files using each pending TeaseScript capability. */
  pendingCapabilityFileCounts: Record<string, number>;
  /**
   * Dependency-closed script files that would compile except for pending capabilities, counted per capability
   * they use: the implementation gaps that block otherwise convertible content.
   */
  blockingPendingCapabilityFileCounts: Record<string, number>;
  /**
   * Whether the package compiles as one project (ADR 0022), with pending capabilities replaced by placeholders and as
   * generated; null without a compiler.
   */
  projectCompiles: boolean | null;
  projectCompilesAsGenerated: boolean | null;
  /**
   * Package smoke runs in the real runtime, which follows the transfers between files itself: the package project
   * from `main.tease`, then isolated runs of runnable scripts no earlier run reached. Files that do not compile clean
   * except pending capabilities become stubs that end the run as `blocked`; pending capabilities use placeholder
   * copies with host stand-ins. Assumes one package per report.
   */
  smokeRuns: PackageRunResult[];
  /** Smoke-run outcomes `halted`, `failed`, `blocked`, `stepLimit`, `stuck`; prefixed `isolated` for those runs. */
  smokeRunStatusCounts: Record<string, number>;
  /** Runtime failures of smoke runs, grouped by code and message; prefixed `isolated` for those runs. */
  smokeRunFailuresByMessage: Record<string, number>;
  /** Null when no runner was supplied. */
  smokeRunReachedScriptFileCount: number | null;
  /**
   * Functions several scripts share, promoted to `global function`s in a generated helpers.tease (#570): how many
   * names and copies, the globals they read, the functions that stay in each file and why, and whether helpers.tease
   * compiles (null without a compiler or helpers).
   */
  globalFunctions: {
    promoted: number;
    copiesReplaced: number;
    globals: Array<{ name: string; kind: string }>;
    kept: Array<{ name: string; copies: number; reason: string }>;
    helpersCompile: boolean | null;
  } | null;
  files: FeasibilityFileReport[];
}

export function analyzeFeasibility(
  files: ParsedGroovyFile[],
  options: FeasibilityOptions = {},
): FeasibilityReport {
  const {
    lowered: filePrograms,
    composed: packagePrograms,
    main,
    globals,
    paths,
  } = lowerPackage(files, options.proposals === undefined ? {} : { proposals: options.proposals });
  const helpers = globals?.helpers ?? null;
  const isScriptBodyAt = (index: number): boolean =>
    files[index]!.root?.kind === "scriptBody" && packagePrograms[index]?.module === undefined;
  // The package as a project (ADR 0022): each script at its path, a single script as main.tease, the generated entry
  // menu, and helpers.tease.
  const scriptIndexes = files.flatMap((_, index) => (isScriptBodyAt(index) ? [index] : []));
  const projectPathOf = new Map<number, string>(
    scriptIndexes.flatMap((index): Array<[number, string]> => {
      const own = paths[index] ?? (scriptIndexes.length === 1 ? MAIN : null);
      return own === null ? [] : [[index, own]];
    }),
  );
  const projectFiles: ProjectEntry[] = [
    ...[...projectPathOf].map(([index, path]) => ({
      path,
      program: packagePrograms[index]!,
      fileIndex: index,
    })),
    ...(main !== null && "menu" in main
      ? [{ path: MAIN, program: main.menu, fileIndex: null }]
      : []),
    ...(helpers === null ? [] : [{ path: HELPERS, program: helpers, fileIndex: null }]),
  ].map((entry) => ({ ...entry, shim: shimPendingCapabilities(entry.program) }));
  const shimOf = new Map(projectFiles.map((entry) => [entry.path, entry.shim]));
  const placeholders = [...new Set(projectFiles.flatMap((entry) => entry.shim.builtins))].sort();
  const shimmed =
    options.compiler?.(
      projectFiles.map(({ path, shim }) => ({ path, source: shim.source })),
      placeholders,
    ) ?? null;
  const generated =
    options.compiler?.(
      projectFiles.map(({ path, program }) => ({ path, source: emitTease(program) })),
    ) ?? null;
  const shimmedDiagnostics = diagnosticsByPath(shimmed);
  const generatedDiagnostics = diagnosticsByPath(generated);
  const errorFree = (
    diagnostics: ReadonlyMap<string, TeaseCompileDiagnostic[]>,
    path: string,
  ): boolean => (diagnostics.get(path) ?? []).every(({ severity }) => severity !== "error");
  const report: FeasibilityReport = {
    fileCount: files.length,
    scriptBodyFileCount: 0,
    recognizedScriptFileCount: 0,
    loweredScriptFileCount: 0,
    dependencyClosedScriptFileCount: 0,
    compilerCleanScriptFileCount: options.compiler === undefined ? null : 0,
    compilerCleanExceptPendingScriptFileCount: options.compiler === undefined ? null : 0,
    parseErrorFileCount: 0,
    migrationCleanFileCount: 0,
    sourceStatementNodes: 0,
    emittedIrStatements: 0,
    unsupportedPlaceholders: 0,
    migrationErrors: 0,
    rootMigrationErrors: 0,
    diagnosticsByCode: emptyCounts(),
    rootDiagnosticsByCode: emptyCounts(),
    compilerDiagnosticsByMessage: emptyCounts(),
    pendingCapabilityFileCounts: emptyCounts(),
    blockingPendingCapabilityFileCounts: emptyCounts(),
    projectCompiles: shimmed?.compiled ?? null,
    projectCompilesAsGenerated: generated?.compiled ?? null,
    smokeRuns: [],
    smokeRunStatusCounts: emptyCounts(),
    smokeRunFailuresByMessage: emptyCounts(),
    globalFunctions:
      globals === null
        ? null
        : {
            promoted: globals.promoted.length,
            copiesReplaced: globals.promoted.reduce((sum, { copies }) => sum + copies, 0),
            globals: globals.globals,
            kept: globals.kept,
            helpersCompile:
              helpers === null || shimmed === null ? null : errorFree(shimmedDiagnostics, HELPERS),
          },
    smokeRunReachedScriptFileCount: options.runner === undefined ? null : 0,
    files: [],
  };

  // The project files a smoke run may execute: every file that compiles clean except pending capabilities.
  const runnable = new Set<string>();
  for (const entry of projectFiles) {
    if (entry.fileIndex === null && shimmed !== null && errorFree(shimmedDiagnostics, entry.path))
      runnable.add(entry.path);
  }
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex]!;
    const parseErrors = file.diagnostics.length;
    // Runtime-loaded mixin modules contribute code to the script that loads them; they are not scripts.
    const isScriptBody = isScriptBodyAt(fileIndex);
    const recognized = parseErrors === 0 && file.root !== null;
    if (isScriptBody) {
      report.scriptBodyFileCount += 1;
      if (recognized) report.recognizedScriptFileCount += 1;
    }
    if (!recognized) report.parseErrorFileCount += 1;

    let sourceStatementNodes = 0;
    if (file.root !== null) {
      walkAst(file.root, (node) => {
        if (SOURCE_STATEMENT_KINDS.has(node.kind)) sourceStatementNodes += 1;
      });
    }

    const program = filePrograms[fileIndex]!;
    const packageProgram = packagePrograms[fileIndex]!;
    const errors = program.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    const packageErrors = packageProgram.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    );
    const roots = rootDiagnostics(errors);
    const ir = countIrStatements(packageProgram.statements);
    const lowered = isScriptBody && errors.length === 0;
    const dependencyClosed = lowered && packageErrors.length === 0;
    const projectPath = projectPathOf.get(fileIndex) ?? null;
    const shim = (projectPath === null ? undefined : shimOf.get(projectPath)) ?? null;
    let compilerClean: boolean | null = null;
    let compilerCleanExceptPending: boolean | null = null;
    let compilerDiagnostics: TeaseCompileDiagnostic[] = [];
    const pendingCapabilities = [...(shim?.capabilities ?? [])].sort();
    if (isScriptBody) {
      for (const capability of pendingCapabilities) {
        increment(report.pendingCapabilityFileCounts, capability);
      }
    }
    if (shimmed !== null && isScriptBody && recognized && projectPath !== null) {
      compilerClean = dependencyClosed && errorFree(generatedDiagnostics, projectPath);
      compilerCleanExceptPending = dependencyClosed && errorFree(shimmedDiagnostics, projectPath);
      compilerDiagnostics = shimmedDiagnostics.get(projectPath) ?? [];
      if (compilerClean && report.compilerCleanScriptFileCount !== null) {
        report.compilerCleanScriptFileCount += 1;
      }
      if (compilerCleanExceptPending && report.compilerCleanExceptPendingScriptFileCount !== null) {
        report.compilerCleanExceptPendingScriptFileCount += 1;
      }
      if (compilerCleanExceptPending && !compilerClean) {
        for (const capability of pendingCapabilities) {
          increment(report.blockingPendingCapabilityFileCounts, capability);
        }
      }
      if (compilerCleanExceptPending) runnable.add(projectPath);
      for (const diagnostic of compilerDiagnostics) {
        increment(report.compilerDiagnosticsByMessage, `${diagnostic.code} ${diagnostic.message}`);
      }
    }

    if (errors.length === 0) report.migrationCleanFileCount += 1;
    if (lowered) report.loweredScriptFileCount += 1;
    if (dependencyClosed) report.dependencyClosedScriptFileCount += 1;
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
      recognized,
      lowered,
      dependencyClosed,
      compilerClean,
      compilerCleanExceptPending,
      pendingCapabilities,
      compilerDiagnostics,
      smokeRunReached: options.runner === undefined ? null : false,
    });
  }

  report.diagnosticsByCode = sortCounts(report.diagnosticsByCode);
  report.rootDiagnosticsByCode = sortCounts(report.rootDiagnosticsByCode);
  report.compilerDiagnosticsByMessage = sortCounts(report.compilerDiagnosticsByMessage);
  report.pendingCapabilityFileCounts = sortCounts(report.pendingCapabilityFileCounts);
  report.blockingPendingCapabilityFileCounts = sortCounts(
    report.blockingPendingCapabilityFileCounts,
  );
  if (options.runner !== undefined && options.compiler !== undefined) {
    runPackageProject(
      report,
      projectFiles,
      runnable,
      options.compiler,
      options.runner,
      options.media,
    );
    const reached = new Set(report.smokeRuns.flatMap(({ visited }) => visited));
    for (const [index, path] of projectPathOf) {
      const fileReport = report.files[index]!;
      if (isScriptBodyAt(index) && reached.has(path)) {
        fileReport.smokeRunReached = true;
        report.smokeRunReachedScriptFileCount! += 1;
      }
    }
  }
  report.smokeRunStatusCounts = sortCounts(report.smokeRunStatusCounts);
  report.smokeRunFailuresByMessage = sortCounts(report.smokeRunFailuresByMessage);
  report.files.sort((left, right) => {
    if (left.rootMigrationErrors !== right.rootMigrationErrors)
      return right.rootMigrationErrors - left.rootMigrationErrors;
    return left.sourceName.localeCompare(right.sourceName);
  });
  return report;
}

/** A file of the package project: its path, its program, and the legacy file it comes from, if any. */
interface ProjectEntry {
  path: string;
  program: MigrationProgram;
  fileIndex: number | null;
  shim: PendingShim;
}

/** The fixed entry file of a package (ADR 0022 §1), and the generated file of its global functions (#570). */
const MAIN = "main.tease";
const HELPERS = "helpers.tease";

/**
 * Host functions of the smoke harness: each runnable file announces itself when it starts, a stub of an unconverted
 * file ends the run, and an isolated run starts at its file.
 */
const ENTER = "sxSmokeEnter";
const BLOCKED = "sxSmokeBlocked";
const START = "sxSmokeStart";

function diagnosticsByPath(
  result: TeaseProjectCompileResult | null,
): Map<string, TeaseCompileDiagnostic[]> {
  const byPath = new Map<string, TeaseCompileDiagnostic[]>();
  for (const { path, ...diagnostic } of result?.diagnostics ?? [])
    byPath.set(path, [...(byPath.get(path) ?? []), diagnostic]);
  return byPath;
}

/** A stand-in for a file that has no runnable conversion: reaching it ends the run as `blocked`. */
function stub(path: string): string {
  return `${BLOCKED}(${JSON.stringify(path)})\nexit\n`;
}

/**
 * The shimmed source of a runnable file with a first statement that announces the file, since the runtime reports
 * no transfers itself; and the line of that statement, which later lines of the generated file follow by one.
 */
function announced(path: string, shim: PendingShim): { source: string; line: number } {
  const source = emitTease({
    ...shim.program,
    statements: [
      {
        kind: "expression",
        expression: {
          kind: "call",
          name: ENTER,
          positional: [{ kind: "literal", value: path }],
          named: {},
        },
        span: null,
      },
      ...shim.program.statements,
    ],
  });
  const line = source.split("\n").findIndex((text) => text.startsWith(`${ENTER}(`)) + 1;
  return { source, line };
}

/**
 * Runs the package as one project from `main.tease`, then each runnable script no earlier run reached in isolation,
 * through a `main.tease` that transfers to it. Files that are not runnable, that stop compiling once others became
 * stubs, or whose paths differ only in case (one file on the legacy player's file systems) are stubs; the runtime
 * follows the transfers between files.
 */
function runPackageProject(
  report: FeasibilityReport,
  entries: readonly ProjectEntry[],
  runnable: ReadonlySet<string>,
  compiler: TeaseProjectCompiler,
  runner: TeaseProjectRunner,
  media: readonly MediaFile[] | undefined,
): void {
  if (!entries.some(({ path }) => path === MAIN)) return;
  const builtins = [
    ...new Set([...entries.flatMap(({ shim }) => shim.builtins), ENTER, BLOCKED, START]),
  ].sort();
  const caseCounts = new Map<string, number>();
  for (const { path } of entries)
    caseCounts.set(path.toLowerCase(), (caseCounts.get(path.toLowerCase()) ?? 0) + 1);
  const probeLines = new Map<string, number>();
  const sources = new Map(
    entries.map(({ path, shim, fileIndex }): [string, string] => {
      if (!runnable.has(path) || caseCounts.get(path.toLowerCase())! > 1) return [path, stub(path)];
      if (fileIndex === null && path !== MAIN) return [path, shim.source];
      const { source, line } = announced(path, shim);
      probeLines.set(path, line);
      return [path, source];
    }),
  );
  const runs = (path: string): boolean => sources.get(path) !== stub(path);
  // A runnable file may use a global or another file that became a stub; it becomes a stub too.
  for (;;) {
    const result = compiler(
      [...sources].map(([path, source]) => ({ path, source })),
      builtins,
    );
    if (result.compiled) break;
    const failing = new Set(
      result.diagnostics
        .filter(({ severity, path }) => severity === "error" && runs(path))
        .map(({ path }) => path),
    );
    if (failing.size === 0) return;
    for (const path of failing) {
      sources.set(path, stub(path));
      probeLines.delete(path);
    }
  }
  const run = (files: readonly TeaseProjectFile[], entry: string, isolated: boolean): void => {
    const answers = new Map<string, number>();
    const visits: string[] = [];
    let blocked: string | null = null;
    let started = false;
    const hosts: Record<string, HostFunction> = {};
    for (const { shim } of entries)
      Object.assign(hosts, pendingHostFunctions(shim, answers, media));
    hosts[ENTER] = ([path]: readonly RuntimeValue[]) => (visits.push(String(path)), null);
    hosts[BLOCKED] = ([target]: readonly RuntimeValue[]) => ((blocked = String(target)), null);
    hosts[START] = () => !started && (started = true);
    const result = runner(files, hosts);
    const failure = blocked === null ? result.failure : null;
    // The announcing statement moved the generated file's lines down by one.
    const probe = failure?.path === null ? undefined : probeLines.get(failure?.path ?? "");
    const line =
      failure === null || failure.line === null || probe === undefined || failure.line < probe
        ? (failure?.line ?? null)
        : failure.line - 1;
    const flow: PackageRunResult = {
      entry,
      isolated,
      status: blocked !== null ? "blocked" : result.status,
      failure: failure === null ? null : { ...failure, line, script: failure.path ?? entry },
      blockedTarget: blocked,
      visited: visits.filter((path, index) => visits.indexOf(path) === index),
      transfers: Math.max(visits.length - 1, 0),
      steps: result.steps,
    };
    const prefix = isolated ? "isolated " : "";
    report.smokeRuns.push(flow);
    increment(report.smokeRunStatusCounts, `${prefix}${flow.status}`);
    if (flow.failure !== null) {
      increment(
        report.smokeRunFailuresByMessage,
        `${prefix}${flow.failure.code} ${flow.failure.message}`,
      );
    }
  };
  const project = [...sources].map(([path, source]) => ({ path, source }));
  run(project, MAIN, false);
  // Scripts that no other script transfers to start isolated runs first, so their targets run with their state.
  const targets = new Set(
    entries.flatMap(({ path, program }) =>
      runs(path)
        ? countIrStatements(program.statements).transfers.filter((target) => target !== path)
        : [],
    ),
  );
  const unreached = entries
    .filter(({ path, fileIndex }) => fileIndex !== null && path !== MAIN && runs(path))
    .map(({ path }) => path)
    .sort(
      (left, right) =>
        Number(targets.has(left)) - Number(targets.has(right)) || left.localeCompare(right),
    );
  for (const path of unreached) {
    if (report.smokeRuns.some(({ visited }) => visited.includes(path))) continue;
    const start = `if ${START}() {\n  goto ${JSON.stringify(path)}\n}\n${stub(MAIN)}`;
    run(
      project.map((file) => (file.path === MAIN ? { path: MAIN, source: start } : file)),
      path,
      true,
    );
  }
}

function countIrStatements(statements: IrStatement[]): {
  total: number;
  unsupported: number;
  /** Literal targets of script transfers. */
  transfers: string[];
} {
  let total = 0;
  let unsupported = 0;
  const transfers: string[] = [];
  const visit = (items: IrStatement[]): void => {
    for (const statement of items) {
      total += 1;
      if (statement.kind === "unsupported") unsupported += 1;
      if (statement.kind === "goto" && statement.target.kind === "file")
        transfers.push(statement.target.path);
      if (statement.kind === "if") {
        visit(statement.then);
        visit(statement.else);
      } else if (
        statement.kind === "while" ||
        statement.kind === "repeat" ||
        statement.kind === "for" ||
        statement.kind === "function"
      ) {
        visit(statement.body);
      } else if (statement.kind === "switch") {
        for (const branch of statement.cases) visit(branch.body);
        visit(statement.default);
      }
    }
  };
  visit(statements);
  return { total, unsupported, transfers };
}

function emptyCounts(): Record<string, number> {
  // Prototype-free, so names such as "toString" become ordinary counter keys.
  // EVIDENCE: Object.create(null) returns an empty object whose keys are written only by increment().
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
