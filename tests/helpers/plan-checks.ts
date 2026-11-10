import {
  instructionSourcePath,
  type InstructionPlan,
  type PartStep,
  type PlanSourceLocation,
  type TypePlan,
} from "../../src/plan/model.js";

/** The plan's fields that each hold a check the script runs (`src/plan/model.ts`). */
const CHECK_FIELDS = new Set([
  "typeCheck",
  "indexCheck",
  "fallbackCheck",
  "expected",
  "repair",
  "requireExisting",
  "partChecks",
]);

/** Whether `value` is a plan's source location. */
function isSpan(value: unknown): value is PlanSourceLocation {
  return (
    typeof value === "object" &&
    value !== null &&
    "so" in value &&
    "sl" in value &&
    "eo" in value &&
    typeof value.so === "number" &&
    typeof value.sl === "number" &&
    typeof value.eo === "number"
  );
}

/**
 * Each check field of the plan, with the innermost node above it that has a span and the index of the instruction that
 * holds it (`null` outside `plan.instructions`). An explicit stack, so a plan nested deeper than a recursive walk can
 * follow is walked too.
 */
function walkChecks(
  plan: unknown,
  visit: (
    field: string,
    value: unknown,
    span: PlanSourceLocation | null,
    instruction: number | null,
  ) => void,
): void {
  const pending: [unknown, PlanSourceLocation | null, number | null][] = [[plan, null, null]];
  while (pending.length > 0) {
    const [value, span, instruction] = pending.pop()!;
    if (Array.isArray(value)) for (const each of value) pending.push([each, span, instruction]);
    else if (typeof value === "object" && value !== null) {
      const here = "span" in value && isSpan(value.span) ? value.span : span;
      for (const [key, each] of Object.entries(value)) {
        if (CHECK_FIELDS.has(key) && each !== undefined && each !== false)
          visit(key, each, here, instruction);
        if (value === plan && key === "instructions" && Array.isArray(each))
          each.forEach((child, index) => pending.push([child, here, index]));
        else pending.push([each, here, instruction]);
      }
    }
  }
}

/**
 * The checks a plan runs (#2081): each check field of every instruction once, and each part check. Read by
 * `tests/type-core/type-core-budget.test.ts` and, from a built tree, by `tools/compiler-replay.mjs`.
 */
export function planChecks(plan: unknown): number {
  let count = 0;
  walkChecks(plan, (_, each) => {
    count += Array.isArray(each) ? each.length : 1;
  });
  return count;
}

/** One check a plan runs, as `planCheckList` lists it. */
export interface PlanCheck {
  /** The plan's field that holds it (`CHECK_FIELDS`). */
  readonly field: string;
  /** Its instruction's file (`instructionSourcePath`); `null` outside the plan's instructions. */
  readonly path: string | null;
  /** The innermost node above it with a span: its one-based line and its offsets, `null` where none has one. */
  readonly line: number | null;
  readonly offset: number | null;
  readonly end: number | null;
  /** The type it checks (`planText`), where it names one. */
  readonly type?: string;
  /** The receiving place or part as the runtime's message names it, where it has one. */
  readonly place?: string;
  /** A part check's path, as `.name` and `[]` steps. */
  readonly part?: string;
}

/**
 * The checks `planChecks` counts, one entry each (a part check's list one entry a part), in source order: by path,
 * offset, end, field, then the rest. A differential record's plan column (`tests/families/differential.mjs`).
 */
export function planCheckList(plan: InstructionPlan): PlanCheck[] {
  const out: PlanCheck[] = [];
  walkChecks(plan, (field, value, span, instruction) => {
    const at = {
      field,
      path: instruction === null ? null : instructionSourcePath(plan, instruction),
      line: span === null ? null : span.sl + 1,
      offset: span?.so ?? null,
      end: span?.eo ?? null,
    };
    for (const check of Array.isArray(value) ? value : [value]) {
      // (a check field holds `true`, a type plan, a `TypeCheckPlan` or a list of `PartCheckPlan`s, `src/plan/model.ts`)
      // EVIDENCE: invariant: each of those forms is read here only by the members it has.
      const described = check as Partial<{
        kind: string;
        type: TypePlan;
        place: string;
        path: readonly PartStep[];
      }> | null;
      // EVIDENCE: invariant: of those, only a type plan has a `kind`.
      const plain = typeof described?.kind === "string" ? (check as TypePlan) : null;
      out.push({
        ...at,
        ...(plain !== null
          ? { type: planText(plain) }
          : described?.type === undefined
            ? {}
            : { type: planText(described.type) }),
        ...(typeof described?.place === "string" ? { place: described.place } : {}),
        ...(Array.isArray(described?.path)
          ? {
              part: described.path
                .map((step) => ("property" in step ? `.${step.property}` : "[]"))
                .join(""),
            }
          : {}),
      });
    }
  });
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return out.sort(
    (a, b) =>
      order(a.path ?? "", b.path ?? "") ||
      (a.offset ?? -1) - (b.offset ?? -1) ||
      (a.end ?? -1) - (b.end ?? -1) ||
      order(a.field, b.field) ||
      order(JSON.stringify(a), JSON.stringify(b)),
  );
}

/** A checked type in full, its unions' members sorted: the plan's side of `derivedText`. */
export function planText(type: TypePlan | null): string {
  if (type === null) return "any";
  if (type.kind === "union") return type.members.map(planText).sort().join("|");
  if (type.kind === "list" || type.kind === "set" || type.kind === "dict")
    return `${type.kind}<${planText(type.element)}>`;
  if (type.kind === "object")
    return `{${[...type.properties.map(({ name, type: of }) => `${name}: ${planText(of)}`), ...(type.keepExtra === true ? ["..."] : [])].join(", ")}}`;
  return type.kind;
}
