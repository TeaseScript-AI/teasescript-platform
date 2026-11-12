// The type core's wrap oracle (#2493): a source's analysis and finished compile by line, so a source whose expressions
// pass through an identity helper compares with its twin, which declares the helper and calls it nowhere.
import { compileProjectWithBackend } from "../../src/compiler.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { coreOutcome } from "../../src/type-inference/core/backend.js";
import { checkedResult } from "../../src/type-inference/core/check-result/check-result.js";
import { createImmediatePacingRuntimeSnapshot } from "./immediate-pacing-runtime.js";
import { planCheckList } from "./plan-checks.js";
import { coreRequest, type SourceFile } from "./type-core-analysis.js";
import { inMode, type Mode } from "./type-core-oracles-modes.js";
import { run } from "../../src/runtime/engine.js";

/** The identity helper a marked source's expressions pass through. */
const HELPER = "global function pass(value) {\n  return value\n}\n";

/**
 * `marked` after the helper's declaration, each `⟦expression⟧` written as it is (`plain`, the twin), as
 * `pass(expression)` or as `(expression)`: the lines of the three match.
 */
export function markedSource(marked: string, form: "plain" | "pass" | "parentheses"): string {
  const [open, close] = form === "plain" ? ["", ""] : [form === "pass" ? "pass(" : "(", ")"];
  return HELPER + marked.replaceAll("⟦", open).replaceAll("⟧", close);
}

/** A site's start as its file's path and one-based line. */
function lineAt(files: readonly SourceFile[], file: number, offset: number): string {
  const text = files[file]!.source;
  return `${files[file]!.path}:${text.slice(0, offset).split("\n").length}`;
}

/**
 * A source's analysis (`checkedResult`) in `mode`, serialized with every site (`file`, `start`, `end`) as its file's
 * path and line, so offsets the helper's calls move do not differ, and a diagnostic's `provenance` as its context word
 * alone: the rest words its message's fix, and a value in parentheses is worded as not read directly (#2493). `null` when the files do not parse or
 * resolve.
 */
export function analysisByLine(
  files: readonly SourceFile[],
  mode: Mode,
  globals?: readonly string[],
): string | null {
  const request = coreRequest(files, globals);
  if (request === null) return null;
  const result = inMode(mode, () => checkedResult(analyseCore(request), request));
  return JSON.stringify(result, (key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const site = Object.fromEntries(Object.entries(value));
    if (key === "provenance") return site["context"];
    return typeof site["file"] === "number" && typeof site["start"] === "number"
      ? lineAt(files, site["file"], site["start"])
      : value;
  });
}

/** What a finished compile gives by line: its diagnostics, its plan's checks and its run's events. */
export interface CompiledByLine {
  readonly diagnostics: readonly string[];
  readonly checks: readonly string[];
  /** The run's said texts and its end, or `null` without a plan. */
  readonly run: readonly string[] | null;
}

/**
 * A source compiled to its end in `mode` with the core past the slice's syntax check (`coreOutcome`), which refuses a
 * function, and its plan run with immediate pacing: each diagnostic by path, line, severity and code, without its
 * message, which quotes the expression; each check by its line and what it checks.
 */
export function compiledByLine(
  files: readonly SourceFile[],
  mode: Mode,
  globals: readonly string[] = ["hostValue"],
): CompiledByLine {
  const result = inMode(mode, () =>
    compileProjectWithBackend(files, { globals }, { name: "core", analyze: coreOutcome }),
  );
  const diagnostics = result.diagnostics.map(
    (diagnostic) =>
      `${diagnostic.path}:${diagnostic.span.start.line + 1} ${diagnostic.severity} ${diagnostic.code}`,
  );
  if (result.plan === null) return { diagnostics, checks: [], run: null };
  const checks = planCheckList(result.plan).map(({ offset: _offset, end: _end, ...check }) =>
    JSON.stringify(check),
  );
  const ran = run(result.plan, createImmediatePacingRuntimeSnapshot(result.plan));
  return {
    diagnostics,
    checks,
    run: [
      ...ran.events.flatMap((event) =>
        event.kind === "say"
          ? [`say ${event.text}`]
          : event.kind === "runtimeFailure"
            ? [`${event.code} at line ${event.span.start.line + 1}`]
            : [],
      ),
      ran.snapshot.status,
    ],
  };
}
