/**
 * Rules of a call's arguments, each with one message, whichever pass checks the call: compile error `TSV020` for their
 * number and form, and `TSV022` for a name the callee does not take. The name pass checks the script's functions and
 * the commands it knows by name, the type checker the methods and the other built-ins. Text operations use the same
 * message for their number of arguments at runtime (`TSR028`).
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
