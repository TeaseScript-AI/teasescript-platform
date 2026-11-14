import type { Expression, Statement } from "../../../../src/ast.js";
import {
  serializableEquals,
  type SerializableRuntimeValue,
} from "../../../../src/runtime/values/serializable-values.js";
import { Underivable, unwrap, writtenType } from "./type-core-derived.js";
import { fitsType } from "./type-core-derived-values.js";

/*
 * The derived oracle's loops and switches (#2488's step 2b), read from the sources, never the plan. A condition that is
 * not a boolean, and a `while` still running after `ROUNDS` rounds, are underivable.
 */

/** The signal of a `break` to the innermost loop. */
export class Break {}

/** The signal of a `continue` to the innermost loop. */
export class Continue {}

/** The rounds a `while` may run before the oracle calls it one it does not see end. */
const ROUNDS = 10_000;

/** Runs a block. */
type Run = (statements: readonly Statement[]) => void;
/** An expression's value. */
type Read = (expression: Expression) => SerializableRuntimeValue;

/** One round of a loop's body: whether the loop goes on (`false` after a `break`). */
export function round(run: Run, body: readonly Statement[]): boolean {
  try {
    run(body);
  } catch (signal) {
    if (signal instanceof Break) return false;
    if (signal instanceof Continue) return true;
    throw signal;
  }
  return true;
}

export function runWhile(
  statement: Extract<Statement, { kind: "whileStatement" }>,
  run: Run,
  read: Read,
): void {
  for (let rounds = 0; ; rounds += 1) {
    const condition = read(statement.condition);
    if (typeof condition !== "boolean")
      throw new Underivable("a `while` on a value that is not a boolean");
    if (!condition) return;
    if (rounds === ROUNDS) throw new Underivable("a `while` the oracle does not see end");
    if (!round(run, statement.body.statements)) return;
  }
}

export function runSwitch(
  statement: Extract<Statement, { kind: "switchStatement" }>,
  run: Run,
  read: Read,
): void {
  const subject = read(statement.subject);
  for (const switchCase of statement.cases) {
    const test = switchCase.typeTest;
    const matches =
      test !== null
        ? fitsType(subject, writtenType(test.type)) !== test.negated
        : switchCase.values.some((value) => {
            const held = read(value);
            if (unwrap(value).kind !== "rangeExpression") return serializableEquals(subject, held);
            return (
              typeof subject === "number" &&
              typeof held === "object" &&
              held !== null &&
              held.kind === "range" &&
              subject >= held.start &&
              (held.inclusive ? subject <= held.end : subject < held.end)
            );
          });
    if (matches) {
      run(switchCase.body.statements);
      return;
    }
  }
  if (statement.defaultBlock !== null) run(statement.defaultBlock.statements);
}
