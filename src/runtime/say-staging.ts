import { isConversion } from "../conversions.js";
import { isListFunction } from "../list-function-rules.js";
import { onlyReadsList } from "../list-methods.js";
import { isNumericFunction } from "../numeric-functions.js";
import { isRandomFunction } from "../random-functions.js";
import { isClockFunction, isTemporalMethod } from "../temporal-builtins.js";
import { isTextOnlyMethod } from "../text-operations.js";
import { expressionPlanChildren } from "../plan/expression-children.js";
import type { ExpressionPlan, SayInstruction } from "../plan/model.js";

/**
 * Engine functions that only read copies of their arguments and return a new value; so do the conversions, the numeric
 * and angle functions, the list functions, and the random functions, apart from drawing from the session generator, and
 * the clock reads, which read the session clock (see `Conversion`, `NumericFunction`, `ListFunction`, `RandomFunction`,
 * and `ClockFunction`). A host built-in runs code the engine has not checked, so it is not listed.
 */
const READING_FUNCTIONS: ReadonlySet<string> = new Set(["hashText", "script", "escapeMarkup"]);

/**
 * Whether a call of the method `name` only reads its receiver and arguments, whatever value it is called on: every
 * method of text and of date and time values does (see `TextMethod` and `TemporalMethod`), and no other value has a
 * method of a date and time value's name; a method of lists and sets that only reads them (see `LIST_METHODS`) also
 * only reads text, a dict, or a range that has a method of its name. No method of a timer, media, button, or message
 * handle only reads.
 */
export function isReadingMethod(name: string): boolean {
  return isTextOnlyMethod(name) || isTemporalMethod(name) || onlyReadsList(name);
}

const selectiveSays = new WeakMap<SayInstruction, boolean>();

/**
 * Whether a say stages on copies of only the snapshot parts it changes in place, instead of on a deep copy of the
 * whole state: no expression it evaluates can change any other state. It evaluates its value unless its text is
 * prepared, its presentation when it has one, and its pacing when that is an expression. Results are cached per
 * instruction.
 */
export function sayStagesSelectively(instruction: SayInstruction): boolean {
  let known = selectiveSays.get(instruction);
  if (known !== undefined) return known;
  known =
    (instruction.textTemporary !== undefined || changesOnlyGenerator(instruction.value)) &&
    (instruction.presentation === null || changesOnlyGenerator(instruction.presentation)) &&
    (typeof instruction.pacing !== "object" || changesOnlyGenerator(instruction.pacing));
  selectiveSays.set(instruction, known);
  return known;
}

/**
 * Whether evaluating an expression changes no state in place but the session generator: it reads variables,
 * temporaries, and storage, builds new values, and calls only the functions and methods listed above and the
 * conversions, which may also report warnings. A conversion that may wait for the Player's file store runs as an
 * instruction before the say, which reads its result, so a call of one in the plan only reads. A lookup may still build
 * a key index of a dict it reads, which is derived from entries it does not change. Any other expression, including one
 * of a kind added later, counts as one that may change state.
 */
function changesOnlyGenerator(root: ExpressionPlan): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    switch (node.kind) {
      case "call":
        if (
          node.callee.kind === "identifier"
            ? !READING_FUNCTIONS.has(node.callee.name) &&
              !isConversion(node.callee.name) &&
              !isListFunction(node.callee.name) &&
              !isNumericFunction(node.callee.name) &&
              !isRandomFunction(node.callee.name) &&
              !isClockFunction(node.callee.name)
            : node.callee.kind !== "property" || !isReadingMethod(node.callee.name)
        )
          return false;
        break;
      case "literal":
      case "regex":
      case "duration":
      case "calendarDuration":
      case "identifier":
      case "debugMode":
      case "accountField":
      case "temporary":
      case "list":
      case "object":
      case "set":
      case "dict":
      case "group":
      case "template":
      case "property":
      case "index":
      case "typeTest":
      case "unary":
      case "unit":
      case "angleUnit":
      case "binary":
      case "range":
      case "storageLoad":
      case "tagQuery":
        break;
      // Reading a prepared reference can detach it, which changes the temporary that holds it.
      case "preparedReference":
      default:
        return false;
    }
    // One by one: a wide list must not depend on the host's argument-spread limit.
    for (const child of expressionPlanChildren(node)) pending.push(child);
  }
  return true;
}
