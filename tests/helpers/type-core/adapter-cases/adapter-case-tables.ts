import type { Expression } from "../../../../src/ast.js";
import type { DynamicWhy } from "../../../../src/type-inference/graph.js";
import { caseInputs, type CaseInputs } from "./adapter-case-inputs.js";
import { isClosedFact, legacyOperation, type LegacyOutcome } from "./adapter-parity.js";
import { type Variant, type Template } from "./adapter-case-forms.js";
import { CHOICE_TEMPLATES, FORM_TEMPLATES, COMMAND_TEMPLATES } from "./adapter-case-asks.js";
import {
  VALUES_TEMPLATES,
  REGRESSION_TEMPLATES,
  PREDICTION_TEMPLATES,
} from "./adapter-case-lists.js";

/*
 * The case tables of the branched routines of the legacy checker (O4 stage 2b, work note): `askChoice`,
 * `askForm`, the list functions over values and selectors, `linearRegression` and `predict`. Each routine's table is
 * enumerated here from templates over the registry's kinds and the written forms of an operand, and every row is
 * pinned by the legacy oracle: its fact, the errors at the operation and elsewhere, and the operands' facts. The class
 * of a row is declared by `classify` from the row's shape and the variant's declarations, never guessed from the fact
 * alone; a row whose answer changes on purpose at stage 5 is marked `stage5` and asserts no adapter answer.
 *
 * The tables are written to `tests/fixtures/type-inference/adapter-cases/<routine>.jsonl` and compared with what
 * this module generates, so that a table cannot drift from the oracle or from the templates.
 */

export type RoutineName = "choice" | "form" | "values" | "regression" | "prediction" | "commands";

export type CaseClass =
  /** A closed fact without an error: the adapter realizes it. */
  | "fact"
  /** A closed fact with an error at the operation: the check reports and still types; the adapter realizes the fact. */
  | "recovery"
  /**
   * No fact: the legacy's `unknown`, with or without a report. The adapter's answer realizes to unknown (`invalid`,
   * `dynamic`, or a part it cannot know); which of them, and the provenance, is not asserted here (the orchestrator's
   * decision of 2026-10-18: the oracle does not expose that distinction; stage 4's differential tests it where it
   * becomes observable, site by site, in the diagnostics, the cascade suppression and the runtime guards).
   */
  | "unknown"
  /** A legacy fact that stage 5 changes on purpose (owner decisions Q1 and Q2): pinned, not required. */
  | "legacy"
  /** An operand holds a slot that saw only null, which the legacy has not decided: the solver's case, not a relation's. */
  | "open";

export type AdapterCell = "fact" | "unknown" | null;

export interface CaseRow {
  /** `<routine>/<template>/<variant>`. */
  readonly id: string;
  readonly source: string;
  /** The legacy's fact at the operation: a type text, or `unknown`. */
  readonly fact: string;
  /** Where the fact was read when not at the expression itself: the binding, for an expression the check records no type for. */
  readonly factFrom?: "binding";
  /** The error codes the operation reports, in order: those inside its span that are not an operand's own. */
  readonly errors: readonly string[];
  /** The error codes an operand reports on its own, such as a list literal that mixes kinds. */
  readonly operandErrors: readonly string[];
  readonly elsewhere: readonly string[];
  /** The facts of the operation's operands, in source order: the options, or the arguments. */
  readonly operands: readonly string[];
  readonly class: CaseClass;
  readonly adapter: AdapterCell;
  /** Why an operand the legacy cannot type is dynamic: the view the adapter is given for it. */
  readonly why: DynamicWhy | null;
  /** The messages of the operation's own errors, in order: the reports beside the fact, pinned, not interpreted. */
  readonly messages: readonly string[];
  readonly stage5?: "Q1" | "Q2";
  readonly note?: string;
}

/** A generated row with the oracle's outcome and the relation's inputs, so that a test asserts the row as generated. */
export interface GeneratedRow {
  readonly row: CaseRow;
  readonly outcome: LegacyOutcome;
  readonly inputs: CaseInputs;
}

const ROUTINES: ReadonlyMap<RoutineName, readonly Template[]> = new Map([
  ["choice", CHOICE_TEMPLATES],
  ["form", FORM_TEMPLATES],
  ["values", VALUES_TEMPLATES],
  ["regression", REGRESSION_TEMPLATES],
  ["prediction", PREDICTION_TEMPLATES],
  ["commands", COMMAND_TEMPLATES],
]);

export const ROUTINE_NAMES: readonly RoutineName[] = [...ROUTINES.keys()];

// ---------------------------------------------------------------------------------------------------------------------
// The generator and the class rule

function program(variant: Variant): string {
  const lines =
    variant.call === undefined
      ? [...variant.prelude, `let r = ${variant.operation}`]
      : [
          ...variant.prelude,
          "function f(p) {",
          `  let r = ${variant.operation}`,
          "}",
          `f(${variant.call})`,
        ];
  return [...lines, "exit"].join("\n");
}

/** The operation's operands as written: the options and named arguments of an ask, or the arguments of a call. */
function operandNodes(outcome: LegacyOutcome): readonly Expression[] {
  const node = outcome.node;
  return node.kind === "interactionExpression"
    ? [
        ...node.options.map((option) => option.expression),
        ...node.formArguments.map((argument) => argument.value),
      ]
    : node.kind === "callExpression"
      ? node.arguments.map((argument) => argument.value)
      : [];
}

function operandFacts(outcome: LegacyOutcome): string[] {
  return operandNodes(outcome).map(
    (operand) =>
      outcome
        .factsAt({ start: operand.span.start.offset, end: operand.span.end.offset })
        .join(" / ") || "untyped",
  );
}

/** The legacy's errors of an operand standing alone, keyed by code and offsets within it; checked once per text. */
const OWN_ERRORS = new Map<string, ReadonlySet<string>>();

function ownErrorsOf(variant: Variant, source: string, operand: Expression): ReadonlySet<string> {
  const text = source.slice(operand.span.start.offset, operand.span.end.offset);
  const alone = program({ ...variant, operation: text });
  const kept = OWN_ERRORS.get(alone);
  if (kept !== undefined) return kept;
  const outcome = legacyOperation(alone);
  const start = outcome.node.span.start.offset;
  const found = new Set(
    outcome.errorSpans.map((error) => `${error.code}@${error.start - start}-${error.end - start}`),
  );
  OWN_ERRORS.set(alone, found);
  return found;
}

/**
 * The errors inside the operation's span split into the operation's own and its operands' own: an error an operand
 * reports when it stands alone, at the same place, is the operand's (a list literal that mixes kinds), not the
 * operation's, and the relation is not asked to answer for it.
 */
function splitErrors(
  variant: Variant,
  source: string,
  outcome: LegacyOutcome,
): {
  readonly errors: { readonly code: string; readonly message: string }[];
  readonly operandErrors: string[];
} {
  const errors: { readonly code: string; readonly message: string }[] = [];
  const operandErrors: string[] = [];
  const operands = operandNodes(outcome).map((operand) => ({
    start: operand.span.start.offset,
    end: operand.span.end.offset,
    own: ownErrorsOf(variant, source, operand),
  }));
  for (const error of outcome.errorSpans) {
    const operand = operands.find(
      (candidate) => error.start >= candidate.start && error.end <= candidate.end,
    );
    const key =
      operand === undefined
        ? undefined
        : `${error.code}@${error.start - operand.start}-${error.end - operand.start}`;
    if (key !== undefined && operand!.own.has(key)) operandErrors.push(error.code);
    else errors.push({ code: error.code, message: error.message });
  }
  return { errors, operandErrors };
}

/**
 * The class of a row, from what the oracle says (work note): a closed fact is `fact`, or `recovery`
 * with an error; no fact is `unknown`, with the legacy's codes and messages pinned beside it, and the adapter's
 * answer must realize to unknown; a `stage5` variant is `legacy`, and a row with an undecided null slot is `open`:
 * neither asserts an adapter answer.
 */
function classify(
  variant: Variant,
  fact: string,
  errors: readonly { readonly code: string; readonly message: string }[],
  inputs: CaseInputs,
): { readonly class: CaseClass; readonly adapter: AdapterCell } {
  if (variant.stage5 !== undefined) return { class: "legacy", adapter: null };
  if (inputs.open) return { class: "open", adapter: null };
  const closed = fact !== "unknown" && isClosedFact(fact);
  if (fact !== "unknown" && !closed)
    throw new Error(`the fact ${fact} of ${variant.id} is not closed`);
  if (closed) return { class: errors.length > 0 ? "recovery" : "fact", adapter: "fact" };
  return { class: "unknown", adapter: "unknown" };
}

/** Every row of a routine's table, generated from its templates and pinned by the legacy oracle. */
export function generateTable(routine: RoutineName): GeneratedRow[] {
  const templates = ROUTINES.get(routine);
  if (templates === undefined) throw new Error(`no routine ${routine}`);
  const rows: GeneratedRow[] = [];
  const seen = new Set<string>();
  for (const template of templates)
    for (const variant of template.variants()) {
      const id = `${routine}/${template.id}/${variant.id}`;
      if (seen.has(id)) throw new Error(`two rows ${id}`);
      seen.add(id);
      const source = program(variant);
      const outcome = legacyOperation(source);
      if (outcome.type === null)
        throw new Error(`the legacy typed no operation at ${id}:\n${source}`);
      const fact = outcome.type;
      const inputs = caseInputs(outcome, variant.why);
      const { errors, operandErrors } = splitErrors(variant, source, outcome);
      const { class: cls, adapter } = classify(variant, fact, errors, inputs);
      const row: CaseRow = {
        id,
        source,
        fact,
        errors: errors.map((error) => error.code),
        messages: errors.map((error) => error.message),
        operandErrors,
        elsewhere: outcome.errorsElsewhere,
        operands: operandFacts(outcome),
        class: cls,
        adapter,
        why: variant.why,
        ...(outcome.factFrom === "binding" ? { factFrom: "binding" as const } : {}),
        ...(variant.stage5 === undefined ? {} : { stage5: variant.stage5 }),
        ...(variant.note === undefined ? {} : { note: variant.note }),
      };
      rows.push({ row, outcome, inputs });
    }
  return rows;
}
