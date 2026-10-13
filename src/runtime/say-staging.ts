import { expressionPlanChildren } from "../plan/expression-children.js";
import type { ExpressionPlan, SayInstruction } from "../plan/model.js";

/**
 * Engine functions that, apart from drawing from the session generator, only read copies of their arguments and the
 * scene clock, and return a new value. A host built-in runs code the engine has not checked, so it is not listed.
 * `toJson` and `fromJson` are calls only with a written `files: false`; otherwise they may wait for the Player's file
 * store and run as instructions before the say, which reads their result.
 */
const READING_FUNCTIONS: ReadonlySet<string> = new Set([
  "random",
  "chance",
  "randomInteger",
  "randomWeighted",
  "randomNormal",
  "randomBeta",
  "randomPert",
  "toString",
  "toNumber",
  "toInteger",
  "toBoolean",
  "toDate",
  "toTime",
  "toDateTime",
  "toAbsoluteDateTime",
  "toJson",
  "fromJson",
  "toBase64",
  "fromBase64",
  "round",
  "floor",
  "ceil",
  "min",
  "max",
  "abs",
  "sqrt",
  "pow",
  "sign",
  "mod",
  "clamp",
  "exp",
  "ln",
  "log10",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "atan2",
  "sum",
  "average",
  "median",
  "percentile",
  "stddev",
  "linearRegression",
  "predict",
  "getDate",
  "getTime",
  "getDateTime",
  "getAbsoluteDateTime",
  "script",
  "escapeMarkup",
]);

/**
 * Methods that only read their receiver and arguments on every value that has a method of that name: lists, sets,
 * dicts, text, and date and time values. A name that changes its receiver on any of them, such as `reverse`, which
 * reverses a list in place, is not listed, nor is any method of a timer, media, button, or message handle.
 */
const READING_METHODS: ReadonlySet<string> = new Set([
  "contains",
  "indexOf",
  "lastIndexOf",
  "count",
  "get",
  "toSet",
  "toList",
  "take",
  "takeLast",
  "intersection",
  "union",
  "difference",
  "join",
  "startsWith",
  "endsWith",
  "substring",
  "split",
  "replace",
  "trim",
  "trimStart",
  "trimEnd",
  "uppercase",
  "lowercase",
  "uppercaseFirst",
  "repeat",
  "padStart",
  "padEnd",
  "toISO",
  "formatDate",
  "formatTime",
  "formatDateTime",
  "toDateTime",
  "toAbsoluteDateTime",
  "toSeconds",
  "toMilliseconds",
]);

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
 * temporaries, and storage, builds new values, and calls only the functions and methods listed above, which may also
 * report warnings. A lookup may still build a key index of a dict it reads, which is derived from entries it does not
 * change. Any other expression, including one of a kind added later, counts as one that may change state.
 */
function changesOnlyGenerator(root: ExpressionPlan): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    switch (node.kind) {
      case "call":
        if (
          node.callee.kind === "identifier"
            ? !READING_FUNCTIONS.has(node.callee.name)
            : node.callee.kind !== "property" || !READING_METHODS.has(node.callee.name)
        )
          return false;
        break;
      case "literal":
      case "duration":
      case "calendarDuration":
      case "identifier":
      case "debugMode":
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
