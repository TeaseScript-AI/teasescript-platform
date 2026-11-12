// A compile's decision records, its receiving completion's included, and the decisions by key.
import type { DecisionWork } from "../../src/type-inference/core/answers.js";
import { withTestDemandAllowance } from "../../src/type-inference/core/budget.js";
import { Consumers } from "../../src/type-inference/core/consumers.js";
import type { SourceFile } from "./type-core-analysis.js";
import { inMode, type Mode, MODES } from "./type-core-oracles-modes.js";
import { publishedRoute } from "./type-core-oracles-publication.js";

/** A compile's admission decision records (`decisionRecords`), each a copy of its `DecisionWork`. */
export interface DecisionRecords {
  /** Each pass's own decisions (`Consumers.decisions`, as its `check` left them), one list per pass, in their order. */
  readonly ordinary: readonly (readonly DecisionWork[])[];
  /**
   * Each receiving completion's decisions (`Consumers.completion.decisions`, once the compile ended), one list per
   * completion that ran: `allowance` what was left of the program's when it decided, `completion.local` its own.
   */
  readonly completion: readonly (readonly DecisionWork[])[];
  /** The route's plan and diagnostics, or the construct it rejects (`publishedRoute`). */
  readonly text: string;
}

/** The kinds of decision record (`DecisionRecords`). */
export type DecisionRecordKind = "ordinary" | "completion";

/**
 * Throws unless `runs` together hold a record of each of `kinds`: a probe that reads a property the records are not
 * under, or a route that never reaches a completion, then fails instead of comparing empty lists.
 *
 * @public (a probe over many compiles reads it from a built tree, not by an import)
 */
export function requireRecords(
  runs: Iterable<DecisionRecords>,
  kinds: readonly DecisionRecordKind[],
): void {
  const read = new Set<DecisionRecordKind>();
  for (const run of runs)
    for (const kind of kinds) if (run[kind].some((list) => list.length > 0)) read.add(kind);
  const missing = kinds.filter((kind) => !read.has(kind));
  if (missing.length > 0) throw new Error(`No ${missing.join(" or ")} decision record was read.`);
}

/** Whether a `decisionRecords` compile is running: one inside it would record into both (Codex r1's H1 on #1692). */
let recordingDecisions = false;

/**
 * A decision record's key: its place (project-wide, so its file too) and its exact path, step by step. Units, allowance
 * and stop are a record's values, not its key; the mode and the demand allowance are its compile's.
 */
export function decisionKey(decision: Pick<DecisionWork, "place" | "path">): string {
  return JSON.stringify([decision.place, decision.path]);
}

/**
 * One list's records by their keys (`decisionKey`), each key's records in the list's order: a list can hold one place's
 * decision at one path more than once (#1757), so a record is identified by its key and its occurrence there, never
 * overwritten by a later one.
 */
export function decisionsByKey(decisions: readonly DecisionWork[]): Map<string, DecisionWork[]> {
  const keyed = new Map<string, DecisionWork[]>();
  for (const d of decisions) {
    const key = decisionKey(d);
    keyed.set(key, [...(keyed.get(key) ?? []), d]);
  }
  return keyed;
}

/**
 * The one record of `decisions` (one pass's list, or one completion's) at `place` and exactly `path`: a probe that
 * takes the first record of a place, or a path by its joined text, can read another than it means. Throws where the
 * list holds none or several.
 */
export function decisionOf(
  decisions: readonly DecisionWork[],
  at: Pick<DecisionWork, "place" | "path">,
): DecisionWork {
  const key = decisionKey(at);
  const found = decisions.filter((d) => decisionKey(d) === key);
  if (found.length !== 1)
    throw new Error(
      `${found.length === 0 ? "No" : found.length} decision records at ${key}; the list has ${decisions.map(decisionKey).join(", ") || "none"}.`,
    );
  return found[0]!;
}

/**
 * The decision records of `files` compiled through the public route (`publishedRoute`: `compileProjectWithBackend` with
 * the core backend, its receiving completion included, which `analyseCore` alone never runs), in `mode` (the source
 * order with the sharing on by default) at the test demand allowance `demand` (`null`, the default: the natural one).
 * Read where the compiler leaves them, from every pass's walk and every completion, not from one `Answers`. With
 * `require`, the compile must read a record of each kind given (`requireRecords`). Not reentrant: a call while one runs
 * throws, since its walks would be the outer compile's too. The way a probe reads decision records
 * (`tests/families/README.md`).
 *
 * @public (a probe reads it from a built tree, not by an import)
 */
export function decisionRecords(
  files: readonly SourceFile[],
  globals: readonly string[],
  options: {
    readonly mode?: Mode;
    readonly demand?: number | null;
    readonly require?: readonly DecisionRecordKind[];
  } = {},
): DecisionRecords {
  const { mode = MODES[0]!, demand = null, require = [] } = options;
  if (recordingDecisions) throw new Error("decisionRecords is already recording a compile.");
  const copy = (list: readonly DecisionWork[]): DecisionWork[] =>
    list.map((d) => ({ ...d, path: [...d.path] }));
  const ordinary: DecisionWork[][] = [];
  // (each pass's walk: a receiving completion runs on the walk of the pass that settled, `Answers.completed`)
  const walks: Consumers[] = [];
  const check = Consumers.prototype.check;
  Consumers.prototype.check = function (this: Consumers) {
    walks.push(this);
    // (a pass a stop ends keeps the decisions it made, the stopped one included)
    try {
      check.call(this);
    } finally {
      ordinary.push(copy(this.decisions));
    }
  };
  let text: string;
  recordingDecisions = true;
  try {
    const run = (): string => inMode(mode, () => publishedRoute(files, globals).text);
    text = demand === null ? run() : withTestDemandAllowance(demand, run);
  } finally {
    Consumers.prototype.check = check;
    recordingDecisions = false;
  }
  const completion = walks.flatMap(({ completion }) =>
    completion === null ? [] : [copy(completion.decisions)],
  );
  const records = { ordinary, completion, text };
  requireRecords([records], require);
  return records;
}
