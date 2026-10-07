import { walkAst, type ParsedGroovyFile } from "./ast.ts";
import type {
  TeaseCompileDiagnostic,
  TeaseProjectCompiler,
  TeaseProjectCompileResult,
  TeaseProjectFile,
  TeaseProjectImage,
} from "./compile-check.ts";
import { emitTease } from "./emit-tease.ts";
import { imageCatalog } from "./image-tags.ts";
import { rootDiagnostics } from "./diagnostics.ts";
import type { IrStatement, MigrationProgram } from "./ir.ts";
import type { PackageFileReader } from "./java-data.ts";
import { lowerPackage } from "./package.ts";
import type { AcceptedForm } from "./workarounds.ts";
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
  /** The script's backward legacy-line jumps (FeasibilityReport.backwardLineJumps); 0 for other files. */
  backwardLineJumps: number;
  /** Whether a package smoke run executed this script; null when no runner was supplied. */
  smokeRunReached: boolean | null;
}

export interface FeasibilityOptions {
  /** Real TeaseScript project compiler used for the compiler-clean gate; it compiles the package as one project. */
  compiler?: TeaseProjectCompiler;
  /** Real TeaseScript runtime used for smoke runs of the package project; needs `compiler`. */
  runner?: TeaseProjectRunner;
  /** Accepted forms to emit instead of their workarounds; the shim makes them compile and run. */
  accepted?: ReadonlySet<AcceptedForm>;
  /** Keeps texts with blank lines as one message each (LowerOptions.keepParagraphs). */
  keepParagraphs?: boolean;
  /**
   * The package's images, which legacy image counts read at conversion time, and which the gate and the smoke runs give
   * the compiler with the folder tags their generated sidecars carry.
   */
  media?: readonly MediaFile[];
  /** Every file of the package's legacy data folder, relative to it, which file existence tests read. */
  files?: readonly string[];
  /** Reads a file of `files`, whose text package text reads snapshot (java-data.ts). */
  readFile?: PackageFileReader;
  /** Scripts that are no entries of their own, which the generated entry menu does not offer (PackageOptions). */
  internalScripts?: readonly string[];
  /** Releases that a corpus merge put side by side (PackageOptions.releases). */
  releases?: ReadonlyArray<readonly string[]>;
  /**
   * The converted package as written, after any manual output patches, read as the Player reads it, which
   * `finalPackage` compiles and runs as it is; needs `compiler`.
   */
  finalPackage?: FinalPackageInput;
}

/** A converted package as the Player reads it: its sources with the SHA-256 of each file, and its tagged images. */
export interface FinalPackageInput {
  files: ReadonlyArray<TeaseProjectFile & { sha256: string }>;
  images: readonly TeaseProjectImage[];
  /** Files the Player skips or cannot read, each as `path: message`. */
  problems: readonly string[];
}

/** The converted package as written: whether its files compile as one project, and a native run from `main.tease`. */
export interface FinalPackageCheck {
  /** The files checked, with the SHA-256 of each. */
  files: Array<{ path: string; sha256: string }>;
  /** The images of the catalog that tag queries searched. */
  imageCount: number;
  /** Files the Player skips or cannot read, each as `path: message`. */
  problems: string[];
  compiles: boolean;
  /** The files with compiler errors. */
  failingFiles: string[];
  /** Compiler errors grouped by code and message. */
  errorsByMessage: Record<string, number>;
  /** Null without a runner or `main.tease`, or when the project does not compile. */
  run: ProjectRunResult | null;
}

/** One smoke run of a package project. */
export interface PackageRunResult {
  /** `main.tease`, or the file an isolated run started at. */
  entry: string;
  /** A run started at a script that no earlier run reached, with the storage the run from `main.tease` left. */
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
   * Texts that repeated the text just before them because the legacy display replaced it (repeated-text.ts): dropped,
   * shortened to what they add, kept because their interpolated values differ, dropped before a transfer to a script
   * that shows them again first, and kept as an animation that only adds punctuation, such as growing dots.
   */
  repeatedText: {
    dropped: number;
    shortened: number;
    kept: number;
    acrossChain: number;
    animation: number;
  };
  /** Literal image and sound paths that no file of the package matches (`SX_MEDIA_MISSING`). */
  missingMedia: number;
  /** Asks that took the text said right before them as their question (`SX_ASK_QUESTION`, #634). */
  askQuestions: number;
  /** Empty texts dropped, which only cleared the legacy display (`SX_BLANK_TEXT`). */
  blankTexts: number;
  /**
   * Legacy settings flows asked as one `askForm`: runs of settings asks (`SX_SETTINGS_FORM`) and menus that toggle
   * settings until the player leaves (`SX_MENU_FORM`).
   */
  forms: { sequences: number; menus: number };
  /**
   * Texts with blank lines (withParagraphs): `says` and asks' questions split into one message per paragraph (the
   * question the last paragraph, `questions`; the question with the remarks after it, `questionRemarks`; or the last
   * paragraph where none asks, `questionFallbacks`), form questions whose later paragraphs became the outro, single
   * paragraphs without the blank lines around them, and texts left whole as layout or by the unit's keepParagraphs.
   */
  paragraphs: {
    says: number;
    questions: number;
    questionRemarks: number;
    questionFallbacks: number;
    outros: number;
    trimmed: number;
    layout: number;
    kept: number;
  };
  /**
   * Literal waits right after a text (withReadingTimes): `replaced` by the Player's reading time, or `kept` as longer
   * than 1.5 times it, or kept as the `beats` of texts without letters or a loop's `ticks`; `keptPaced` texts that keep their reading time where a replaced
   * wait's may still run; kept waits after a split text that withParagraphs `shortened` or `dropped`.
   */
  readingWaits: {
    replaced: number;
    kept: number;
    keptPaced: number;
    beats: number;
    ticks: number;
    shortened: number;
    dropped: number;
  };
  /**
   * Buttons whose waiting time stays a duration (withElapsedDurations): comparisons of a button's seconds with a number
   * (`compared`), and variables that hold such a duration (`variables`).
   */
  buttonDurations: { compared: number; variables: number };
  /** Texts the legacy display redrew, now one message changed in place (withMessageHandles). */
  messageHandles: { animations: number; counters: number };
  /**
   * The order check: in each script's output, the NOTE and TODO comments that name a legacy line more than 20 lines
   * before the one the previous such comment names, summed over the scripts (lineOrderJumps). The output follows the
   * legacy code order, so a jump marks code that moved.
   */
  backwardLineJumps: number;
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
   * from `main.tease`, then isolated runs of runnable scripts no earlier run reached. A file runs where the project
   * compiles it, also with unconverted statements kept as TODO comments, as in the Player; a file that does not compile
   * except pending capabilities becomes a stub that ends the run as `blocked`. Pending capabilities use placeholder
   * copies with host stand-ins. Assumes one package per report.
   */
  smokeRuns: PackageRunResult[];
  /** Smoke-run outcomes `halted`, `failed`, `blocked`, `stepLimit`, `stuck`; prefixed `isolated` for those runs. */
  smokeRunStatusCounts: Record<string, number>;
  /** Runtime failures of smoke runs, grouped by code and message; prefixed `isolated` for those runs. */
  smokeRunFailuresByMessage: Record<string, number>;
  /** Null when no runner was supplied. */
  smokeRunReachedScriptFileCount: number | null;
  files: FeasibilityFileReport[];
  /** The check of the package as written; null unless its files and a compiler were given. */
  finalPackage: FinalPackageCheck | null;
}

export function analyzeFeasibility(
  files: ParsedGroovyFile[],
  options: FeasibilityOptions = {},
): FeasibilityReport {
  const {
    lowered: filePrograms,
    composed: packagePrograms,
    main,
    paths,
  } = lowerPackage(files, {
    ...(options.accepted === undefined ? {} : { accepted: options.accepted }),
    ...(options.keepParagraphs === true ? { keepParagraphs: true } : {}),
    ...(options.media === undefined ? {} : { media: options.media }),
    ...(options.files === undefined ? {} : { files: options.files }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
    ...(options.internalScripts === undefined ? {} : { internalScripts: options.internalScripts }),
    ...(options.releases === undefined ? {} : { releases: options.releases }),
  });
  const isScriptBodyAt = (index: number): boolean =>
    files[index]!.root?.kind === "scriptBody" && packagePrograms[index]?.module === undefined;
  // The package as a project (ADR 0022): each script at its path, a single script as main.tease, the generated
  // main.tease, and the files of helper classes.
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
    // A helper class's own file, with its global functions.
    ...files.flatMap((file, index) => {
      const path = paths[index];
      return file.root?.kind === "compilationUnit" && path != null
        ? [{ path, program: packagePrograms[index]!, fileIndex: null }]
        : [];
    }),
  ].map((entry) => ({ ...entry, shim: shimPendingCapabilities(entry.program) }));
  const shimOf = new Map(projectFiles.map((entry) => [entry.path, entry.shim]));
  const placeholders = [...new Set(projectFiles.flatMap((entry) => entry.shim.builtins))].sort();
  const images = options.media === undefined ? undefined : imageCatalog(options.media);
  const shimmed =
    options.compiler?.(
      projectFiles.map(({ path, shim }) => ({ path, source: shim.source })),
      placeholders,
      images,
    ) ?? null;
  const generated =
    options.compiler?.(
      projectFiles.map(({ path, program }) => ({ path, source: emitTease(program) })),
      [],
      images,
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
    repeatedText: { dropped: 0, shortened: 0, kept: 0, acrossChain: 0, animation: 0 },
    missingMedia: 0,
    askQuestions: 0,
    blankTexts: 0,
    forms: { sequences: 0, menus: 0 },
    paragraphs: {
      says: 0,
      questions: 0,
      questionRemarks: 0,
      questionFallbacks: 0,
      outros: 0,
      trimmed: 0,
      layout: 0,
      kept: 0,
    },
    readingWaits: {
      replaced: 0,
      kept: 0,
      keptPaced: 0,
      beats: 0,
      ticks: 0,
      shortened: 0,
      dropped: 0,
    },
    buttonDurations: { compared: 0, variables: 0 },
    messageHandles: { animations: 0, counters: 0 },
    backwardLineJumps: 0,
    compilerDiagnosticsByMessage: emptyCounts(),
    pendingCapabilityFileCounts: emptyCounts(),
    blockingPendingCapabilityFileCounts: emptyCounts(),
    projectCompiles: shimmed?.compiled ?? null,
    projectCompilesAsGenerated: generated?.compiled ?? null,
    smokeRuns: [],
    smokeRunStatusCounts: emptyCounts(),
    smokeRunFailuresByMessage: emptyCounts(),
    smokeRunReachedScriptFileCount: options.runner === undefined ? null : 0,
    files: [],
    finalPackage:
      options.finalPackage === undefined || options.compiler === undefined
        ? null
        : checkFinalPackage(options.finalPackage, options.compiler, options.runner),
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
      // A file with unconverted statements, kept as TODO comments, still runs where it compiles, as in the Player.
      if (errorFree(shimmedDiagnostics, projectPath)) runnable.add(projectPath);
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
    const backwardLineJumps = isScriptBody ? lineOrderJumps(emitTease(packageProgram)) : 0;
    report.backwardLineJumps += backwardLineJumps;
    for (const { code } of program.diagnostics) {
      if (code === "SX_REPEATED_TEXT_DROPPED") report.repeatedText.dropped += 1;
      else if (code === "SX_REPEATED_TEXT_SHORTENED") report.repeatedText.shortened += 1;
      else if (code === "SX_REPEATED_TEXT_KEPT") report.repeatedText.kept += 1;
      else if (code === "SX_REPEATED_TEXT_ANIMATION") report.repeatedText.animation += 1;
      else if (code === "SX_MEDIA_MISSING") report.missingMedia += 1;
      else if (code === "SX_ASK_QUESTION") report.askQuestions += 1;
      else if (code === "SX_BLANK_TEXT") report.blankTexts += 1;
      else if (code === "SX_SETTINGS_FORM") report.forms.sequences += 1;
      else if (code === "SX_MENU_FORM") report.forms.menus += 1;
      else if (code === "SX_PARAGRAPHS") report.paragraphs.says += 1;
      else if (code === "SX_PARAGRAPH_QUESTION") report.paragraphs.questions += 1;
      else if (code === "SX_PARAGRAPH_QUESTION_REMARKS") report.paragraphs.questionRemarks += 1;
      else if (code === "SX_PARAGRAPH_QUESTION_FALLBACK") report.paragraphs.questionFallbacks += 1;
      else if (code === "SX_FORM_OUTRO") report.paragraphs.outros += 1;
      else if (code === "SX_PARAGRAPH_TRIMMED") report.paragraphs.trimmed += 1;
      else if (code === "SX_PARAGRAPHS_LAYOUT") report.paragraphs.layout += 1;
      else if (code === "SX_PARAGRAPHS_KEPT") report.paragraphs.kept += 1;
      else if (code === "SX_WAIT_READING") report.readingWaits.replaced += 1;
      else if (code === "SX_WAIT_KEPT") report.readingWaits.kept += 1;
      else if (code === "SX_WAIT_KEPT_PACED") report.readingWaits.keptPaced += 1;
      else if (code === "SX_WAIT_BEAT") report.readingWaits.beats += 1;
      else if (code === "SX_WAIT_TICK") report.readingWaits.ticks += 1;
      else if (code === "SX_PARAGRAPH_WAIT") report.readingWaits.shortened += 1;
      else if (code === "SX_PARAGRAPH_WAIT_DROPPED") report.readingWaits.dropped += 1;
      else if (code === "SX_BUTTON_DURATION") report.buttonDurations.compared += 1;
      else if (code === "SX_BUTTON_DURATION_VARIABLE") report.buttonDurations.variables += 1;
      else if (code === "SX_MESSAGE_ANIMATION") report.messageHandles.animations += 1;
      else if (code === "SX_MESSAGE_COUNTER") report.messageHandles.counters += 1;
    }
    for (const { code } of packageProgram.diagnostics)
      if (code === "SX_REPEATED_TEXT_ACROSS_CHAIN") report.repeatedText.acrossChain += 1;

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
      backwardLineJumps,
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
    runPackageProject(report, projectFiles, runnable, options.compiler, options.runner, images);
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

/**
 * Host functions of the smoke harness: each runnable file announces itself when it starts, a stub of an unconverted
 * file ends the run, and an isolated run starts at its file.
 */
const ENTER = "sxSmokeEnter";
const BLOCKED = "sxSmokeBlocked";
const START = "sxSmokeStart";

/** Compiles the package as written, without placeholders, and runs it natively from `main.tease` when it compiles. */
function checkFinalPackage(
  { files, images, problems }: FinalPackageInput,
  compiler: TeaseProjectCompiler,
  runner: TeaseProjectRunner | undefined,
): FinalPackageCheck {
  const sources = files.map(({ path, source }) => ({ path, source }));
  const compiled = compiler(sources, [], images);
  const errors = compiled.diagnostics.filter(({ severity }) => severity === "error");
  const errorsByMessage = emptyCounts();
  for (const { code, message } of errors) increment(errorsByMessage, `${code} ${message}`);
  return {
    files: files.map(({ path, sha256 }) => ({ path, sha256 })),
    imageCount: images.length,
    problems: [...problems],
    compiles: compiled.compiled,
    failingFiles: [...new Set(errors.map(({ path }) => path))].sort(),
    errorsByMessage: sortCounts(errorsByMessage),
    run:
      runner === undefined || !compiled.compiled || !files.some(({ path }) => path === MAIN)
        ? null
        : runner(sources, {}, { images }),
  };
}

function diagnosticsByPath(
  result: TeaseProjectCompileResult | null,
): Map<string, TeaseCompileDiagnostic[]> {
  const byPath = new Map<string, TeaseCompileDiagnostic[]>();
  for (const { path, ...diagnostic } of result?.diagnostics ?? [])
    byPath.set(path, [...(byPath.get(path) ?? []), diagnostic]);
  return byPath;
}

/** A stand-in for a file that has no runnable conversion: reaching it ends the run as `blocked`. */
function stub(path: string, source = ""): string {
  return `${globalDeclarations(source)}${BLOCKED}(${JSON.stringify(path)})\nexit\n`;
}

/**
 * The declarations of a file that other files see: speakers (V30 §37), globals, and global functions (V30 §11), such
 * as the generated helpers of main.tease; the files that run still need them when the file becomes a stub.
 */
function globalDeclarations(source: string): string {
  const lines = source.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^(?:global|speaker) /u.test(lines[index]!)) continue;
    kept.push(lines[index]!);
    // The declaration continues on indented and blank lines, up to a closing delimiter at the start of a line.
    while (index + 1 < lines.length && /^(?:\s|$|[}\])]|""")/u.test(lines[index + 1]!)) {
      index += 1;
      kept.push(lines[index]!);
      if (/^(?:[}\])]|""")/u.test(lines[index]!)) break;
    }
  }
  return kept.map((line) => `${line}\n`).join("");
}

/**
 * The shimmed source of a runnable file with a first statement that announces the file, since the runtime reports
 * no transfers itself; and the line of that statement, which later lines of the generated file follow by one.
 */
/**
 * A runnable file that announces itself when it starts: its source, the probe's line, and how many lines the probe
 * added, which can be two when the emitter keeps a paragraph break after it.
 */
function announced(
  path: string,
  shim: PendingShim,
): { source: string; probe: { line: number; shift: number } } {
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
  const lines = source.split("\n");
  const line = lines.findIndex((text) => text.startsWith(`${ENTER}(`)) + 1;
  return { source, probe: { line, shift: lines.length - shim.source.split("\n").length } };
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
  images: readonly TeaseProjectImage[] | undefined,
): void {
  if (!entries.some(({ path }) => path === MAIN)) return;
  const builtins = [
    ...new Set([...entries.flatMap(({ shim }) => shim.builtins), ENTER, BLOCKED, START]),
  ].sort();
  const caseCounts = new Map<string, number>();
  for (const { path } of entries)
    caseCounts.set(path.toLowerCase(), (caseCounts.get(path.toLowerCase()) ?? 0) + 1);
  const probeLines = new Map<string, { line: number; shift: number }>();
  const stubbed = new Set<string>();
  const sources = new Map(
    entries.map(({ path, shim, fileIndex }): [string, string] => {
      if (!runnable.has(path) || caseCounts.get(path.toLowerCase())! > 1) {
        stubbed.add(path);
        return [path, stub(path, shim.source)];
      }
      if (fileIndex === null && path !== MAIN) return [path, shim.source];
      const { source, probe } = announced(path, shim);
      probeLines.set(path, probe);
      return [path, source];
    }),
  );
  const runs = (path: string): boolean => !stubbed.has(path);
  // A runnable file may use a global or another file that became a stub; it becomes a stub too.
  for (;;) {
    const result = compiler(
      [...sources].map(([path, source]) => ({ path, source })),
      builtins,
      images,
    );
    if (result.compiled) break;
    const failing = new Set(
      result.diagnostics
        .filter(({ severity, path }) => severity === "error" && runs(path))
        .map(({ path }) => path),
    );
    if (failing.size === 0) return;
    for (const path of failing) {
      sources.set(path, stub(path, sources.get(path)));
      stubbed.add(path);
      probeLines.delete(path);
    }
  }
  // Isolated runs start with the storage the run from main.tease left, as a player who played it first.
  const entryStorage = new Map<string, RuntimeValue>();
  const run = (files: readonly TeaseProjectFile[], entry: string, isolated: boolean): void => {
    const answers = new Map<string, number>();
    const visits: string[] = [];
    let blocked: string | null = null;
    let started = false;
    const hosts: Record<string, HostFunction> = {};
    for (const { shim } of entries) Object.assign(hosts, pendingHostFunctions(shim, answers));
    hosts[ENTER] = ([path]: readonly RuntimeValue[]) => (visits.push(String(path)), null);
    hosts[BLOCKED] = ([target]: readonly RuntimeValue[]) => ((blocked = String(target)), null);
    hosts[START] = () => (started ? "" : ((started = true), entry));
    const result = runner(files, hosts, {
      ...(images === undefined ? {} : { images }),
      storage: isolated ? new Map(entryStorage) : entryStorage,
    });
    const failure = blocked === null ? result.failure : null;
    // The announcing statement moved the generated file's lines after it down.
    const probe = failure?.path === null ? undefined : probeLines.get(failure?.path ?? "");
    const line =
      failure === null || failure.line === null || probe === undefined || failure.line < probe.line
        ? (failure?.line ?? null)
        : failure.line - probe.shift;
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
  // One project serves every isolated run: its main.tease transfers to the file the host names once.
  const isolatedProject = project.map((file) =>
    file.path === MAIN
      ? {
          path: MAIN,
          // It keeps what main.tease declares for the other files, such as the generated global helpers.
          source: `let start = ${START}()\nif start != "" {\n  goto script(start)\n}\n${stub(MAIN, file.source)}`,
        }
      : file,
  );
  for (const path of unreached) {
    if (report.smokeRuns.some(({ visited }) => visited.includes(path))) continue;
    run(isolatedProject, path, true);
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

/**
 * The NOTE and TODO comments of a converted file that name a legacy line more than 20 lines before the line the
 * previous such comment names: code the conversion moved, where the output otherwise follows the legacy order.
 */
export function lineOrderJumps(source: string): number {
  let previous: number | null = null;
  let jumps = 0;
  for (const match of source.matchAll(/\/\/ (?:NOTE|TODO) \w+ line (\d+)/gu)) {
    const line = Number(match[1]);
    if (previous !== null && line < previous - 20) jumps += 1;
    previous = line;
  }
  return jumps;
}
