import { ordersWith, VALUE_KIND_NAMES, type ValueKind } from "../../value-kinds.js";
import type { SourceSite } from "../graph.js";
import {
  fanIdentity,
  firstContext,
  firstWriter,
  makeItem,
  mergeItems,
  ownContext,
  REASON,
  type ContextWord,
  type Item,
  type ItemScope,
  type ItemTag,
  type Writer,
} from "./items.js";

/**
 * The runtime's operator table (checkpoint 9, F16 and C4): for each operator, the operand kinds the runtime accepts and
 * the kind of the result. The runtime is the authority: `tests/type-core-operator-table.test.ts` evaluates every
 * operator on every pair of value kinds and fails where a row exists that the runtime rejects or a row is missing that
 * it accepts. For the core this table replaces the legacy checker's `arithmeticType`
 * (`src/static-types/arithmetic.ts`).
 */

export type Operator = "+" | "-" | "*" | "/" | "%" | "neg" | "<" | "<=" | ">" | ">=";

export interface OperatorRow {
  readonly operator: Operator;
  /** The operand kinds: left and right, or the one operand of `neg`. */
  readonly operands: readonly ValueKind[];
  readonly result: ValueKind;
  /**
   * Whether the runtime takes these kinds only for some values: a calendar duration scaled or divided to whole parts, a
   * date moved by a calendar duration without an exact offset, two calendar durations of one family divided or ordered.
   * The result is then a possibility with an `operand` check, which the runtime owns (F16).
   */
  readonly byValue: boolean;
}

const CALCULATIONS = ["+", "-", "*", "/", "%", "neg"] as const;

const COMPARISONS = ["<", "<=", ">", ">="] as const;

const DURATIONS = [
  "duration duration duration",
  "duration calendarDuration calendarDuration",
  "calendarDuration duration calendarDuration",
  "calendarDuration calendarDuration calendarDuration",
  "angle angle angle",
].join("|");

/**
 * Arithmetic and negation as the runtime has them: `src/runtime/evaluation/operators.ts` with `src/duration.ts` and
 * `src/angle.ts`, `src/runtime/values/pure-operations.ts` for joined text and lists,
 * `src/runtime/values/temporal-operations.ts` for dates and times, and the evaluator's unary case. One row per `|`: the
 * operand kinds, then the result. `N` stands for `integer` and for `number`; as a result it is `integer` when every
 * operand is an integer and `number` otherwise (V30 §4). A `?` after the result marks a row the runtime takes by value.
 */
const ARITHMETIC: Readonly<Record<(typeof CALCULATIONS)[number], string>> = {
  "+": `N N N|string string string|list list list|${DURATIONS}|date calendarDuration date?|datetime calendarDuration datetime?|absoluteDateTime duration absoluteDateTime`,
  "-": `N N N|${DURATIONS}|date calendarDuration date?|date date calendarDuration|datetime calendarDuration datetime?|absoluteDateTime duration absoluteDateTime|absoluteDateTime absoluteDateTime duration`,
  "*": "N N N|N duration duration|N calendarDuration calendarDuration?|N angle angle|duration N duration|calendarDuration N calendarDuration?|angle N angle",
  "/": "N N number|duration N duration|duration duration number|calendarDuration N calendarDuration?|calendarDuration calendarDuration number?|angle N angle|angle angle number",
  "%": "N N N",
  neg: "N N|duration duration|calendarDuration calendarDuration|angle angle",
};

const NUMBERS: readonly ValueKind[] = ["integer", "number"];

function valueKind(name: string): ValueKind {
  const kind = VALUE_KIND_NAMES.find((candidate) => candidate === name);
  if (kind === undefined) throw new Error(`The operator table names no value kind '${name}'.`);
  return kind;
}

function transcribed(operator: Operator, rows: string): OperatorRow[] {
  return rows.split("|").flatMap((row) => {
    const names = row.split(" ");
    const written = names.pop()!;
    const byValue = written.endsWith("?");
    const result = byValue ? written.slice(0, -1) : written;
    let combinations: ValueKind[][] = [[]];
    for (const name of names)
      combinations = combinations.flatMap((done) =>
        (name === "N" ? NUMBERS : [valueKind(name)]).map((kind) => [...done, kind]),
      );
    return combinations.map((operands) => ({
      operator,
      operands,
      result:
        result === "N"
          ? operands.every((kind) => kind === "integer")
            ? "integer"
            : "number"
          : valueKind(result),
      byValue,
    }));
  });
}

/**
 * `<`, `<=`, `>` and `>=` order two values of one family that has an order, as `ordersWith` tells the runtime (V30 §5,
 * §35); two calendar durations only when their nonzero parts are of one family, which the runtime checks by value.
 */
function compared(operator: Operator): OperatorRow[] {
  return VALUE_KIND_NAMES.flatMap((left) =>
    VALUE_KIND_NAMES.filter((right) => ordersWith(left, right)).map((right) => ({
      operator,
      operands: [left, right],
      result: "boolean" as const,
      byValue: left === "calendarDuration",
    })),
  );
}

/** Every row, by operator. */
const ROWS: ReadonlyMap<Operator, readonly OperatorRow[]> = new Map<Operator, OperatorRow[]>([
  ...CALCULATIONS.map((operator): [Operator, OperatorRow[]] => [
    operator,
    transcribed(operator, ARITHMETIC[operator]),
  ]),
  ...COMPARISONS.map((operator): [Operator, OperatorRow[]] => [operator, compared(operator)]),
]);

export const OPERATOR_ROWS: readonly OperatorRow[] = Object.freeze([...ROWS.values()].flat());

const rowKey = (operator: Operator, operands: readonly ItemTag[]): string =>
  `${operator} ${operands.join(" ")}`;

const BY_OPERANDS: ReadonlyMap<string, OperatorRow> = new Map(
  OPERATOR_ROWS.map((row) => [rowKey(row.operator, row.operands), row]),
);

/** The row of `operator` for these operand kinds, or `undefined` when the runtime rejects them. */
export function operatorRow(
  operator: Operator,
  operands: readonly ItemTag[],
): OperatorRow | undefined {
  return BY_OPERANDS.get(rowKey(operator, operands));
}

/**
 * The items of an operation's result, from the items of its operands, one combination of operand items at a time (F16):
 * - a combination the table has no row for fails at runtime and gives nothing (C4 reports it);
 * - an `unknown` operand gives, as possibilities, the results of every row the other operands' kinds allow (`x / 4`
 *   with `x` unknown: number, duration, calendar duration, angle), and these items stand for that one operand (`fan`,
 *   §4 r4.14), explained by its writer and reason; a combination of unknowns only, or one whose unknowns are all
 *   deferred parameters, stays unknown;
 * - a result kind is definite when no operand is unknown, every operand item is definite, and every combination that
 *   succeeds gives that kind by a row that needs no check by value.
 * The reasons and the first context word of a combination's items go to its result, an unknown bringing its reason's
 * word (`ownContext`); a guarded operand marks it (§3.2).
 * `operation` is the operation's site, the identity of an unknown operand without a writer; `writer` explains a result
 * whose operands have no writer.
 */
export function operationItems(
  operator: Operator,
  operands: readonly (readonly Item[])[],
  scope: ItemScope,
  operation: SourceSite,
  writer: Writer | null = null,
): Item[] {
  const rows = ROWS.get(operator) ?? [];
  const results: Item[] = [];
  // per result kind, the combinations that give it by a row needing no check by value
  const definite = new Map<ItemTag, number>();
  let succeeded = 0;
  let unsure = false;
  let combinations: (readonly Item[])[] = [[]];
  for (const items of operands)
    combinations = combinations.flatMap((done) =>
      items.filter((item) => item.tag !== "empty").map((item) => [...done, item]),
    );
  for (const combination of combinations) {
    scope.work.charge("operatorSteps", rows.length + 1);
    const reasons = combination.reduce((all, item) => all | item.reasons, 0);
    // an unknown operand's reason word comes before any condition's word (`hostValue / divisor()`: `unknown`, not `call`)
    const context = combination.reduce<ContextWord | null>(
      (first, item) => firstContext(first, ownContext(item)),
      null,
    );
    const shared = {
      reasons,
      context,
      cert: "pos" as const,
      ...(combination.some((item) => item.guarded === true) ? { guarded: true as const } : {}),
      ...(combination.some((item) => item.called === true) ? { called: true as const } : {}),
    };
    // A2, A3 r4.36: a result kind of a combination holding external data (an external unknown, or an operand item that is
    // itself possible solely through external data)
    const external = combination.some(
      (item) =>
        item.extOnly === true || (item.tag === "unknown" && (item.reasons & REASON.external) !== 0),
    );
    const known = external ? { ...shared, extOnly: true as const } : shared;
    const explained = combination.reduce((first, item) => firstWriter(first, item.writer), writer);
    const unknowns = combination.filter((item) => item.tag === "unknown");
    if (
      unknowns.length === combination.length ||
      (unknowns.length > 0 && unknowns.every((item) => item.reasons === REASON.deferred))
    ) {
      results.push(makeItem("unknown", explained, shared));
      unsure = true;
      continue;
    }
    // the unknown operand these results stand for, when the combination holds exactly one, and the earliest writer of
    // the items that carry it, so that `+` and `*` explain alike in either order
    const carriers = combination.filter((item) => item.tag === "unknown" || item.fan !== undefined);
    const fans = new Set(
      carriers.map((item) =>
        item.tag === "unknown" || item.fan === undefined
          ? fanIdentity(item.writer, operation)
          : item.fan,
      ),
    );
    const fan = fans.size === 1 ? [...fans][0] : undefined;
    const fanWriter = carriers.reduce<Writer | null>(
      (first, item) => firstWriter(first, item.writer),
      null,
    );
    for (const row of rows) {
      if (
        row.operands.length !== combination.length ||
        !row.operands.every(
          (kind, index) =>
            combination[index]!.tag === "unknown" || combination[index]!.tag === kind,
        )
      )
        continue;
      results.push(
        fan === undefined
          ? makeItem(row.result, explained, known)
          : makeItem(row.result, fanWriter, { ...known, fan }),
      );
      if (unknowns.length > 0) {
        unsure = true;
        continue;
      }
      succeeded += 1;
      if (!row.byValue) definite.set(row.result, (definite.get(row.result) ?? 0) + 1);
      // a combination of known kinds has one row
      break;
    }
  }
  const sure =
    !unsure &&
    succeeded > 0 &&
    operands.every((items) => items.every((item) => item.cert === "def"));
  return mergeItems(results, scope).map((item) =>
    sure && definite.get(item.tag) === succeeded ? { ...item, cert: "def" } : item,
  );
}
