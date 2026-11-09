import { compileSourceWithBackend } from "../../../src/compiler.js";
import type { InstructionPlan } from "../../../src/plan/model.js";
import type { RuntimeScriptStorageEntrySnapshot } from "../../../src/runtime/host-data/script-storage.js";
import {
  createSerializableList as list,
  type SerializableRuntimeValue,
} from "../../../src/runtime/values/serializable-values.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../../src/type-inference/core/budget.js";
import { completedCore, coreRequest } from "../type-core-analysis.js";
import { HELD_MODES, heldStops, testedStops, type HeldMode } from "../type-core-held-host.js";
import { plannedContent, plannedStores, runGlobals } from "../type-core-route.js";

// #1526 decision 2, condition 1 (TABLE r4.390): the lost-check gate's invariant over a generated matrix. Each cell is a
// destination of type `integer[][]` (its own, a copy's, a property's, a written one, one a later store decides, an object
// literal's property) and a value form bringing `[["x"]]` into it, alone or after sixteen stores that make
// the receiving completion reach its allowance; each run is a stop of it (a decision's at a demand allowance, a settled
// or unsettled program stop, a capped completion, a cap while the completion found its obligations), classified by its
// analysis. A published stopped plan never lets through what the natural plan rejects; a declined one names the
// lost-check text or rule (R)'s, which runs first; each published run is recorded with the check that kept the value.

/** The gate's decline and rule (R)'s, which runs first (#1775). */
export const DECLINES = [
  "a typed parse's or load's default that a stop left open",
  "a store whose check was lost at the budget",
] as const;

/** Where the value is stored: a destination of type `integer[][]`, its type the store's own or another's. */
const DESTINATIONS = {
  // (the destination's type is the value's own: a typed call's reader is the natural check there)
  fresh: (value: string) => `let b = ${value}`,
  copy: (value: string) => `let a = [[1]]\nlet b = a\nb = ${value}`,
  property: (value: string) => `let a = {f: [[1]]}\nlet b = a\nb.f = ${value}`,
  written: (value: string) => `let b: integer[][] = [[1]]\nb = ${value}`,
  // (a later store decides the destination's type: the first store's natural check is against it)
  later: (value: string) => `let b = ${value}\nsay toJson(b)\nb = [[1]]`,
  // (a partial object shape: the value one of the destination's two properties, the other left out)
  partial: (value: string) =>
    `let a = {n: [[1]], m: [[1]]}\nlet b = a\nb = {n: ${value}}\nsay toJson(b.n)`,
  // (an object destination, the value one property of a stored object literal)
  object: (value: string) =>
    `let a = {n: [[1]], m: 1}\nlet b = a\nb = {n: ${value}, m: 2}\nsay toJson(b.n)`,
} as const;

/** A value form, and what makes it bring `[["x"]]` (the natural plan rejects it into every typed destination). */
interface ValueForm {
  readonly text: string;
  readonly globals?: Readonly<Record<string, SerializableRuntimeValue>>;
  readonly storage?: readonly RuntimeScriptStorageEntrySnapshot[];
}

const NESTED_X = list([list(["x"])]);
const VALUES: Readonly<Record<string, ValueForm>> = {
  host: { text: "hostValue", globals: { hostValue: NESTED_X } },
  parse: {
    text: "fromJson(hostValue, default: [[1]], files: false)",
    globals: { hostValue: '[["x"]]' },
  },
  "parse, weaker default": {
    text: "fromJson(hostValue, default: [], files: false)",
    globals: { hostValue: '[["x"]]' },
  },
  load: { text: 'load("k", default: [[1]])', storage: [{ key: "k", value: NESTED_X }] },
  "load, weaker default": {
    text: 'load("k", default: [])',
    storage: [{ key: "k", value: NESTED_X }],
  },
  "get default": { text: "[hostValue].get(0, default: [[1]])", globals: { hostValue: NESTED_X } },
  "literal of host": { text: "[hostValue]", globals: { hostValue: list(["x"]) } },
  "mixed literal of parse": {
    text: "[fromJson(hostValue, default: [1], files: false), [1]]",
    globals: { hostValue: '["x"]' },
  },
  "literal of parse": {
    text: "[fromJson(hostValue, default: [1], files: false)]",
    globals: { hostValue: '["x"]' },
  },
};

/** Sixteen stores before the cell, which make the receiving completion reach its allowance in some modes. */
const PAD = `let pad = {f0: 1}\n${Array.from({ length: 16 }, (_, at) => `pad = {f${at}: ${at}}`).join("\n")}\n`;

export interface MatrixCell {
  readonly name: string;
  readonly source: string;
  readonly input: ValueForm;
}

/** The matrix's cells: every destination with every value form, alone and padded. */
export function matrixCells(): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const [destination, store] of Object.entries(DESTINATIONS))
    for (const [form, input] of Object.entries(VALUES))
      for (const padded of [false, true])
        cells.push({
          name: `${destination} / ${form}${padded ? " / padded" : ""}`,
          source: `${padded ? PAD : ""}${store(input.text)}\nsay toJson(b)\nsay "AFTER"\nexit\n`,
          input,
        });
  return cells;
}

/** A stop's kind, by its analysis. */
export type StopKind =
  | "decision stop, completed"
  | "decision stop, completion capped"
  | "decision stop, capped while finding its obligations"
  | `settled program stop, ${string}`
  | "unsettled program stop";

/** How a stopped run ended: published, and which check carries the value; or declined. */
export type RunOutcome =
  | {
      readonly kind: "published";
      readonly kept: "store check" | "reader" | "none";
      readonly escapes: boolean;
    }
  | { readonly kind: "declined"; readonly what: string };

export interface MatrixRun {
  readonly cell: string;
  readonly mode: string;
  readonly stop: StopKind;
  readonly at: string;
  readonly outcome: RunOutcome;
}

const GLOBALS = ["hostValue", "hostOther"];

/** Whether a plan lets the cell's value through: its run reaches `AFTER` showing the forbidden text. */
function passes(plan: InstructionPlan, input: ValueForm): boolean {
  const run = runGlobals(plan, input.globals ?? {}, input.storage);
  return (
    run.said.some((at) => at.text === "AFTER") && run.said.some((at) => at.text.includes('"x"'))
  );
}

/** Which published check carries the cell's store: a check at its site, a typed reader, or none. */
function keptBy(plan: InstructionPlan, source: string): "store check" | "reader" | "none" {
  const store = source.includes("b.f = ")
    ? source.lastIndexOf("b.f = ")
    : source.lastIndexOf("b = ");
  // (a store's whole check at or after the cell's store, or a part check below it)
  const checked =
    plannedStores(plan).some((line) => Number(/ (\d+):\d+ /u.exec(line)![1]) >= store) ||
    JSON.stringify(plan).includes('"partChecks"');
  if (checked) return "store check";
  const content = plannedContent(plan, source);
  return content.some((line) => /^(load|expected) /u.test(line)) ? "reader" : "none";
}

function stopKind(
  source: string,
  mode: HeldMode,
  allowance: number | undefined,
  demand: number | undefined,
): StopKind | null {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
  const answers = mode.run(() => {
    const run = () => completedCore(request);
    const allowed = () => (allowance === undefined ? run() : withTestAllowance(allowance, run));
    return demand === undefined ? allowed() : withTestDemandAllowance(demand, allowed);
  });
  const { budget } = answers;
  if (budget.exhausted !== null)
    // (a settled program stop by the phase it stopped in: the capture's extraction, the walk, the publication, …)
    return budget.settled ? `settled program stop, ${budget.stoppedIn}` : "unsettled program stop";
  if (!budget.decisions.some((d) => d.stopped)) return null;
  if ((budget.closure?.counts.capped ?? 0) > 0)
    return answers.receiving.length === 0
      ? "decision stop, capped while finding its obligations"
      : "decision stop, completion capped";
  return "decision stop, completed";
}

/**
 * Every stopped run of a cell in a mode: each demand allowance of 16, 32 and 64, and the settled program stops
 * (`testedStops`) and the last unsettled one; `null` where the natural compile publishes no plan or lets the value through
 * (the cell then holds nothing to lose).
 */
export function matrixRuns(cell: MatrixCell, mode: HeldMode): MatrixRun[] | null {
  const compile = (allowance?: number, demand?: number) =>
    mode.run(() => {
      const once = () => compileSourceWithBackend(cell.source, { globals: GLOBALS }, CORE_BACKEND);
      const allowed = () => (allowance === undefined ? once() : withTestAllowance(allowance, once));
      return demand === undefined ? allowed() : withTestDemandAllowance(demand, allowed);
    });
  let natural;
  try {
    natural = compile();
  } catch (error) {
    if (error instanceof CandidateOutsideSlice) return null;
    throw error;
  }
  if (natural.plan === null || passes(natural.plan, cell.input)) return null;
  const stops: { allowance?: number; demand?: number; at: string }[] = [16, 32, 64].map(
    (demand) => ({ demand, at: `demand ${demand}` }),
  );
  const settled = heldStops(
    { name: cell.name, source: cell.source, slice: true, values: [] },
    mode,
  );
  for (const { allowance, phase } of testedStops(settled))
    stops.push({ allowance, at: `${phase} @${allowance}` });
  const lowest = Math.min(...settled.map((stop) => stop.allowance));
  if (Number.isFinite(lowest) && lowest > 1)
    stops.push({ allowance: lowest - 1, at: `unsettled @${lowest - 1}` });
  const runs: MatrixRun[] = [];
  for (const { allowance, demand, at } of stops) {
    const stop = stopKind(cell.source, mode, allowance, demand);
    if (stop === null) continue;
    let outcome: RunOutcome;
    try {
      const { plan } = compile(allowance, demand);
      outcome =
        plan === null
          ? { kind: "published", kept: "none", escapes: false }
          : {
              kind: "published",
              kept: keptBy(plan, cell.source),
              escapes: passes(plan, cell.input),
            };
    } catch (error) {
      if (!(error instanceof CandidateOutsideSlice)) throw error;
      outcome = { kind: "declined", what: error.what };
    }
    runs.push({ cell: cell.name, mode: mode.name, stop, at, outcome });
  }
  return runs;
}

/** The modes the matrix runs in: source order with sharing, and reversed without it. */
export const MATRIX_MODES: readonly HeldMode[] = [HELD_MODES[0]!, HELD_MODES[3]!];
