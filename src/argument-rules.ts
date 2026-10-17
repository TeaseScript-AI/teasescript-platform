import type { MethodParameters } from "./text-operations.js";

/**
 * Rules of a call's arguments, each with one message, whichever pass checks the call: compile error `TSV020` for their
 * number and form, `TSV022` for a name the callee does not take, and `TSV024` for a value the callee needs. The name
 * pass checks the script's functions and the commands it knows by name, the type checker the methods and the other
 * built-ins. The runtime checks the built-ins and methods again, for a plan that this compiler did not check and for a
 * receiver whose type the compiler does not know, and gives the same message: `TSR028` for their number and names,
 * `TSR015` for a name given to a method of text, a list, or a set.
 */

/** What a callee takes, as in `no arguments`, `1 argument (text)`, or `1 to 2 arguments (start, end)`. */
export function argumentsTaken(names: readonly string[], required = names.length): string {
  if (names.length === 0) return "no arguments";
  const count =
    required === names.length
      ? `${required} argument${required === 1 ? "" : "s"}`
      : `${required} to ${names.length} arguments`;
  return `${count} (${names.join(", ")})`;
}

/**
 * A call of `callee` with a number of arguments without a name that it does not take: `takes` says what it takes, as
 * `argumentsTaken` does, and `fix`, when given, how to write the call.
 */
export function argumentCountMessage(
  callee: string,
  takes: string,
  received: number,
  fix?: string,
): string {
  return `${callee}() takes ${takes}, received ${received}.${fix === undefined ? "" : ` ${fix}`}`;
}

/**
 * A call with `received` arguments of a function of the current date and time or a method of a date or time value,
 * which take none (V30 §35), from the compiler (`TSV020`) and the runtime (`TSR028`, `TSR015`). A format follows the
 * player's settings.
 */
export function temporalArgumentsMessage(name: string, received: number): string {
  return argumentCountMessage(
    name,
    "no arguments",
    received,
    name.startsWith("format")
      ? "It shows the value in the player's own date and time format."
      : undefined,
  );
}

/**
 * A named argument `name` that `callee` does not take. `names` are the names it takes; a callee that takes none takes
 * its arguments without names, or no arguments at all when `positional` is false.
 */
export function unknownNamedArgumentMessage(
  callee: string,
  name: string,
  names: readonly string[],
  positional = true,
): string {
  if (names.length === 0)
    return `${callee}() takes ${positional ? "its arguments without names" : "no arguments"}. Remove '${name}:'.`;
  const quoted = names.map((one) => `'${one}:'`);
  const listed =
    quoted.length === 1
      ? `Its only named argument is ${quoted[0]}`
      : `Its named arguments are ${quoted.length === 2 ? quoted.join(" and ") : `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`}`;
  return `${callee}() has no parameter '${name}'. ${listed}.`;
}

/**
 * A call written as `form` without the `default:` it needs: `when` says what the default is for, and `fix` what to do
 * instead of a default that is never needed.
 */
export function missingDefaultMessage(
  form: string,
  when: string,
  fix = "Add one, such as 'default: null'.",
): string {
  return `'${form}' needs a 'default:' ${when}. ${fix}`;
}

/**
 * A command that takes `what` first, without a name, and every other argument by name, such as `showPopup` or
 * `openUrl`, called another way; `example` is a call of the right form.
 */
export function leadingArgumentMessage(callee: string, what: string, example: string): string {
  return `${callee}() takes ${what} first, without a name, and every other argument by name, as in '${example}'.`;
}

/** A command whose `name` is given both without a name and as `name:`. */
export function leadingArgumentTwiceMessage(callee: string, name: string): string {
  return `${callee}() takes one ${name}: give it without a name or as '${name}:', not both.`;
}

/** A call of `callee` without `what` it needs, such as `a value for 'a'`; `fix` says how to give it. */
export function missingArgumentMessage(callee: string, what: string, fix: string): string {
  return `${callee}() needs ${what}. ${fix}`;
}

/** A problem with the names or the number of a call's arguments; `name` is the name the callee does not take. */
export type ArgumentProblem =
  | { readonly kind: "unknownNamedArgument"; readonly name: string; readonly message: string }
  | { readonly kind: "argumentCount"; readonly message: string };

/** What a callee takes: `count` arguments without a name, which `takes` says as `argumentsTaken` does, and `names`. */
export interface ArgumentShape {
  readonly count: number;
  readonly takes: string;
  readonly names: readonly string[];
}

/** The shape of a callee that takes no arguments, such as a timer's `pause()`. */
export const NO_ARGUMENTS: ArgumentShape = { count: 0, takes: argumentsTaken([]), names: [] };

/** The shape of a callee that takes `parameters` without a name and no names. */
export function positionalShape(parameters: readonly string[]): ArgumentShape {
  return { count: parameters.length, takes: argumentsTaken(parameters), names: [] };
}

/**
 * The first problem with the names and the number of a call's arguments, as the compiler reports it first: the first of
 * `named` that `shape` does not take, then `received` arguments without a name where it takes another number.
 * `positional` is as for `unknownNamedArgumentMessage`. `undefined` when the arguments fit.
 */
export function argumentShapeProblem(
  callee: string,
  shape: ArgumentShape,
  received: number,
  named: readonly string[],
  positional = true,
): ArgumentProblem | undefined {
  const unknown = named.find((name) => !shape.names.includes(name));
  if (unknown !== undefined)
    return {
      kind: "unknownNamedArgument",
      name: unknown,
      message: unknownNamedArgumentMessage(callee, unknown, shape.names, positional),
    };
  if (received === shape.count) return undefined;
  return { kind: "argumentCount", message: argumentCountMessage(callee, shape.takes, received) };
}

/** The parameters of the built-ins that take a fixed number of positional arguments and no names (V30 §7, §8). */
export const FIXED_PARAMETERS: ReadonlyMap<string, readonly string[]> = new Map([
  ["escapeMarkup", ["text"]],
]);

/** The argument count message of `script(...)`, which takes a path, and a label only by name (V30 §29). */
export function scriptArgumentCountMessage(received: number): string {
  return argumentCountMessage(
    "script",
    "1 argument (path)",
    received,
    `Name a label with 'label:', as in 'script("rooms/hall.tease", label: "start")'.`,
  );
}

/** A method that takes positional arguments with these names. */
function positionalMethod(name: string, ...parameters: string[]): [string, MethodParameters] {
  return [name, { name, parameters: parameters.map((parameter) => ({ name: parameter })) }];
}

/**
 * The parameters of the methods of lists and sets (V30 §16), timers and media (V30 §22), and date and time values
 * (V30 §35) that take only positional arguments, besides `join`, the searches, `take`, and `takeLast`, which have their
 * own checks. Every other receiver with one of these methods takes as many: text for `contains` and `reverse`, and a dict
 * for `contains`, `remove`, and `clear`. Only a message and a permanent button take `remove()` without arguments (#836).
 */
export const POSITIONAL_METHODS: ReadonlyMap<string, MethodParameters> = new Map([
  positionalMethod("add", "value"),
  positionalMethod("addAll", "other"),
  positionalMethod("remove", "value"),
  positionalMethod("removeAt", "index"),
  positionalMethod("removeFirst"),
  positionalMethod("removeLast"),
  positionalMethod("clear"),
  positionalMethod("contains", "value"),
  positionalMethod("sort"),
  positionalMethod("shuffle"),
  positionalMethod("reverse"),
  positionalMethod("intersection", "other"),
  positionalMethod("union", "other"),
  positionalMethod("difference", "other"),
  positionalMethod("toSet"),
  positionalMethod("toList"),
  positionalMethod("pause"),
  positionalMethod("resume"),
  positionalMethod("stop"),
  positionalMethod("toISO"),
  positionalMethod("formatDate"),
  positionalMethod("formatTime"),
  positionalMethod("formatDateTime"),
  positionalMethod("toAbsoluteDateTime"),
  positionalMethod("toDateTime"),
  positionalMethod("toSeconds"),
  positionalMethod("toMilliseconds"),
]);

/** The parameter of `take`, `takeLast`, and the searches of a list (V30 §16), which a set does not have. */
export const LIST_ONLY_METHODS: ReadonlyMap<string, MethodParameters> = new Map([
  positionalMethod("take", "count"),
  positionalMethod("takeLast", "count"),
  positionalMethod("indexOf", "value"),
  positionalMethod("lastIndexOf", "value"),
  positionalMethod("count", "value"),
]);

/** What `get` reads with a `default:`: an index of a list, a key of a dict, or either, where the compiler knows neither. */
export type GetReceiver = "list" | "dict" | "either";

const GET_TEXTS = {
  list: {
    reads: "index",
    when: "for an index the list does not have",
    fix: "Read an element that must exist as 'list[index]'.",
  },
  dict: {
    reads: "key",
    when: "for a missing key",
    fix: "Read a key that must exist as 'dict[key]'.",
  },
  either: {
    reads: "index or key",
    when: "for an index or key the value does not have",
    fix: "Read one that must exist as 'value[index]'.",
  },
} as const;

/**
 * The first problem with the arguments of `get(index or key, default: value)` (#844), which takes one index or key and a
 * `default:`; `named` are the names of the call, `default` among them.
 */
export function getArgumentsProblem(
  receiver: GetReceiver,
  received: number,
  named: readonly string[],
): ArgumentProblem | undefined {
  const unknown = named.find((name) => name !== "default");
  if (unknown !== undefined)
    return {
      kind: "unknownNamedArgument",
      name: unknown,
      message: unknownNamedArgumentMessage("get", unknown, ["default"]),
    };
  if (received === 1 && named.length === 1) return undefined;
  const { reads, when, fix } = GET_TEXTS[receiver];
  return {
    kind: "argumentCount",
    message:
      received === 1 && named.length === 0
        ? missingDefaultMessage(`get(${reads}, default: value)`, when, fix)
        : argumentCountMessage("get", `1 argument (${reads}) and a 'default:'`, received),
  };
}

/**
 * The first problem with the arguments of a dict method (V30 §16): `contains(key)` and `remove(key)` take a key,
 * `clear()` none, and `get(key, default: value)` a key and a `default:`; `named` are the names of the call.
 */
export function dictArgumentsProblem(
  method: string,
  received: number,
  named: readonly string[],
): ArgumentProblem | undefined {
  if (method === "get") return getArgumentsProblem("dict", received, named);
  return argumentShapeProblem(
    method,
    positionalShape(method === "clear" ? [] : ["key"]),
    received,
    named,
  );
}
