import path from "node:path";
import { walkAst, type ParsedGroovyFile } from "./ast.ts";
import type { TeaseCompileDiagnostic, TeaseCompiler } from "./compile-check.ts";
import { emitTease } from "./emit-tease.ts";
import { rootDiagnostics } from "./diagnostics.ts";
import type { IrStatement } from "./ir.ts";
import { lowerPackage } from "./package.ts";
import type { ProposalId } from "./proposals.ts";
import { pendingHostFunctions, shimPendingCapabilities, type MediaFile } from "./pending.ts";
import {
  flowKey,
  smokeRunFlow,
  type FlowRunResult,
  type FlowScript,
  type TeaseRunner,
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
  /** Real TeaseScript compiler used for the compiler-clean gate. */
  compiler?: TeaseCompiler;
  /** Real TeaseScript runtime used for smoke runs of compiler-clean output; needs `compiler`. */
  runner?: TeaseRunner;
  /**
   * Directory that `run` targets are relative to (the legacy scripts folder); inferred as the files' common
   * directory when absent.
   */
  packageRoot?: string;
  /** Proposed language changes to emit in their working syntax; the shim makes them compile and run. */
  proposals?: ReadonlySet<ProposalId>;
  /** The package's images, for smoke runs of proposed media tags. */
  media?: readonly MediaFile[];
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
   * Package smoke runs in the real runtime, using the placeholder copies with host stand-ins for pending
   * capabilities: one per entry script (a script in the package's top directory), then isolated runs of runnable
   * scripts no earlier run reached. Assumes one package per report.
   */
  smokeRuns: FlowRunResult[];
  /** Smoke-run outcomes `halted`, `failed`, `blocked`, `stepLimit`, `stuck`; prefixed `isolated` for those runs. */
  smokeRunStatusCounts: Record<string, number>;
  /** Runtime failures of smoke runs, grouped by code and message; prefixed `isolated` for those runs. */
  smokeRunFailuresByMessage: Record<string, number>;
  /** Null when no runner was supplied. */
  smokeRunReachedScriptFileCount: number | null;
  files: FeasibilityFileReport[];
}

export function analyzeFeasibility(
  files: ParsedGroovyFile[],
  options: FeasibilityOptions = {},
): FeasibilityReport {
  const { lowered: filePrograms, composed: packagePrograms } = lowerPackage(
    files,
    options.proposals === undefined ? {} : { proposals: options.proposals },
  );
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
    smokeRuns: [],
    smokeRunStatusCounts: emptyCounts(),
    smokeRunFailuresByMessage: emptyCounts(),
    smokeRunReachedScriptFileCount: options.runner === undefined ? null : 0,
    files: [],
  };

  const flowScripts: Array<FlowScriptRecord> = [];
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex]!;
    const parseErrors = file.diagnostics.length;
    // Runtime-loaded mixin modules contribute code to the script that loads them; they are not scripts.
    const isScriptBody =
      file.root?.kind === "scriptBody" && packagePrograms[fileIndex]?.module === undefined;
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
    let compilerClean: boolean | null = null;
    let compilerCleanExceptPending: boolean | null = null;
    let compilerDiagnostics: TeaseCompileDiagnostic[] = [];
    const shim = shimPendingCapabilities(packageProgram);
    const pendingCapabilities = [...shim.capabilities].sort();
    if (isScriptBody) {
      for (const capability of pendingCapabilities) {
        increment(report.pendingCapabilityFileCounts, capability);
      }
    }
    if (options.compiler !== undefined && isScriptBody && recognized) {
      const clean = (result: ReturnType<typeof options.compiler>): boolean =>
        dependencyClosed &&
        result.compiled &&
        result.diagnostics.every((diagnostic) => diagnostic.severity !== "error");
      compilerClean = clean(options.compiler(emitTease(packageProgram)));
      const shimmed = options.compiler(shim.source, shim.builtins);
      compilerCleanExceptPending = clean(shimmed);
      compilerDiagnostics = shimmed.diagnostics;
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
      for (const diagnostic of shimmed.diagnostics) {
        increment(report.compilerDiagnosticsByMessage, `${diagnostic.code} ${diagnostic.message}`);
      }
    }
    // A file that does not parse may be a script; flows that reach it are blocked.
    if (isScriptBody || file.root === null) {
      const source = compilerCleanExceptPending === true ? shim.source : null;
      flowScripts.push({
        sourceName: file.sourceName,
        transfers: ir.transfers,
        script:
          source === null
            ? null
            : { source, builtins: (state) => pendingHostFunctions(shim, state, options.media) },
      });
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
  if (options.runner !== undefined) {
    runPackageFlows(report, flowScripts, options.runner, options.packageRoot);
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

interface FlowScriptRecord {
  sourceName: string;
  script: FlowScript | null;
  transfers: string[];
}

function runPackageFlows(
  report: FeasibilityReport,
  flowScripts: ReadonlyArray<FlowScriptRecord>,
  runner: TeaseRunner,
  packageRoot: string | undefined,
): void {
  // Parser JSON from Windows may use backslashes.
  const segments = (file: string): string[] =>
    path.resolve(file.replaceAll("\\", "/")).split(path.sep);
  const directories = flowScripts.map(({ sourceName }) => segments(sourceName).slice(0, -1));
  const root =
    packageRoot === undefined
      ? directories.reduce((common, directory) => {
          let length = 0;
          while (length < common.length && common[length] === directory[length]) length += 1;
          return common.slice(0, length);
        }, directories[0] ?? [])
      : segments(packageRoot);
  const keyOf = (sourceName: string): string =>
    flowKey(
      segments(sourceName)
        .slice(root.length)
        .join("/")
        .replace(/\.groovy$/iu, ".tease"),
    );
  // Two files whose paths differ only in case are ambiguous for the legacy player; flows reaching them are blocked.
  const keyCounts = new Map<string, number>();
  for (const { sourceName } of flowScripts) {
    keyCounts.set(keyOf(sourceName), (keyCounts.get(keyOf(sourceName)) ?? 0) + 1);
  }
  const scripts = new Map(
    flowScripts.map(({ sourceName, script }) => {
      const key = keyOf(sourceName);
      return [key, keyCounts.get(key) === 1 ? script : null];
    }),
  );
  const entries = flowScripts
    .filter((_, index) => directories[index]!.join(path.sep) === root.join(path.sep))
    .map(({ sourceName }) => keyOf(sourceName))
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .sort();
  const reached = new Set<string>();
  const record = (flow: FlowRunResult): void => {
    const prefix = flow.isolated ? "isolated " : "";
    report.smokeRuns.push(flow);
    increment(report.smokeRunStatusCounts, `${prefix}${flow.status}`);
    if (flow.failure !== null) {
      increment(
        report.smokeRunFailuresByMessage,
        `${prefix}${flow.failure.code} ${flow.failure.message}`,
      );
    }
    for (const script of flow.visited) reached.add(script);
  };
  for (const entry of entries) record(smokeRunFlow(runner, entry, scripts));
  // Scripts that no other script transfers to start isolated runs first, so their targets run with their state.
  const targets = new Set(
    flowScripts.flatMap(({ sourceName, script, transfers }) =>
      script === null
        ? []
        : transfers.map(flowKey).filter((target) => target !== keyOf(sourceName)),
    ),
  );
  const unreached = [...scripts]
    .filter(([, script]) => script !== null)
    .map(([key]) => key)
    .sort(
      (left, right) =>
        Number(targets.has(left)) - Number(targets.has(right)) || left.localeCompare(right),
    );
  for (const key of unreached) {
    if (!reached.has(key)) record(smokeRunFlow(runner, key, scripts, true));
  }
  // Only the script records count; auxiliary classes and modules share no keys with them.
  const reachedFiles = new Set(
    flowScripts
      .filter(({ sourceName }) => reached.has(keyOf(sourceName)))
      .map(({ sourceName }) => sourceName),
  );
  for (const file of report.files) {
    if (reachedFiles.has(file.sourceName)) file.smokeRunReached = true;
  }
  report.smokeRunReachedScriptFileCount = reachedFiles.size;
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
      if (
        statement.kind === "run" &&
        statement.script.kind === "literal" &&
        typeof statement.script.value === "string"
      ) {
        transfers.push(statement.script.value);
      }
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
