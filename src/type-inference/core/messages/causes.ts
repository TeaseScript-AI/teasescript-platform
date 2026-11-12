import type { Expression } from "../../../ast.js";
import { REFERENCE } from "../contract.js";
import { selectsElement } from "../method-categories.js";
import type { ContextWord, ItemTag } from "../items.js";
import type { ContextDetail, RequiredCheck } from "../result.js";
import type { SourceSite } from "../../graph.js";
import type { MessageSource } from "./site.js";
import { described, parsedExpression } from "./words.js";

// The sentences of a cause: a warning's last, why the value may be of another type, from its origin or its context
// word; and the route rule's error's first, what brings the offending type to the use.

const HANDLER_RUNS: Readonly<Record<NonNullable<ContextDetail["handler"]>, string>> = {
  button: "the button is pressed",
  timer: "its timer expires",
  media: "its media ends or reaches its cue",
};

/**
 * The cause of a warning whose word came with its value from another line (a copy, a projection, a call, an
 * operation): where that value comes from, by the word, never naming this line's read as the word's own subject.
 */
export function originSentence(word: ContextWord, name: string): string {
  const from = `'${name}' gets its value from`;
  switch (word) {
    case "label":
      return `${from} a line that is also reached by a 'goto'.`;
    case "later":
    case "unknown":
      return `'${name}' comes from outside the script, so its type is known only when the script runs.`;
    case "missing":
      return `${from} a property that an object may lack.`;
    case "branch":
      return `${from} an 'if' or another branch, so which value it gets depends on which branch runs.`;
    case "call":
      return `${from} a place that a function or a file the script calls may change.`;
    case "dead-code":
      return `${from} a line that never runs.`;
    case "deferred-parameter":
      return `${from} a parameter of a function called from more than one place.`;
    case "handler":
      return `${from} a place that a button, timer, or media block may change.`;
    case "loop":
      return `${from} a variable that may change in an earlier round of a loop.`;
    case "member":
      return `${from} a list element or a part of another value.`;
    // (the word also covers an object's own `first` and opaque operations: no reference is established)
    case "unmodelled":
      return `The type of '${name}' is known only when the script runs.`;
    case "budget":
      return `Checking '${name}' here before the script plays would take too long, so it is checked when the script runs.`;
  }
}

/** A warning's cause: why the value may be of another type at this line (§3.4), its word the read's own. */
export function contextSentence(
  word: ContextWord,
  name: string,
  detail: ContextDetail,
  kinds: readonly ItemTag[],
): string {
  switch (word) {
    case "label":
      return detail.label === null
        ? `This line is also reached by a 'goto', and '${name}' may change before that jump.`
        : `This line is also reached by 'goto ${detail.label}', and '${name}' may change before that jump.`;
    case "later":
      return "";
    case "missing":
      return detail.receiver === null
        ? `'${name}' may come from an object that has no such property.`
        : `'${detail.receiver.text}' may hold an object that has no '${detail.receiver.member}' property.`;
    case "branch":
      return (
        `'${name}' is set inside an 'if' or another branch, so which value reaches this line depends on which ` +
        "branch runs."
      );
    case "call":
      return detail.callable === null
        ? `'${name}' may be changed by a function or a file the script calls before this line.`
        : `'${name}' is set outside '${detail.callable}', before '${detail.callable}' is called.`;
    case "dead-code":
      return "This line never runs.";
    case "deferred-parameter":
      return detail.callable === null
        ? `'${name}' is a parameter of a function called from more than one place.`
        : `'${detail.callable}' is called from more than one place, so '${name}' may hold another type in each ` +
            "call.";
    case "handler":
      return detail.handler === null
        ? `A button, timer, or media block may run before this line and change '${name}'.`
        : `This block runs when ${HANDLER_RUNS[detail.handler]}, and '${name}' may change inside it before this ` +
            "line.";
    case "loop":
      return `'${name}' may change in an earlier round of this loop.`;
    case "member": {
      const container = detail.receiver?.kinds.find(
        (kind) => kind === "list" || kind === "set" || kind === "dict",
      );
      if (container === undefined) return "";
      // (a selection's collection: an element that may be empty)
      const may = kinds.includes("empty") ? "empty" : described(kinds);
      return container === "dict"
        ? `'${name}' is a dict value, and any value of the dict may be ${may}.`
        : `'${name}' is a ${container} element, and any element of the ${container} may be ${may}.`;
    }
    case "unknown":
      return `'${name}' comes from outside the script, so its type is known only when the script runs.`;
    case "budget":
      return `Checking '${name}' here before the script plays would take too long, so it is checked when the script runs.`;
    case "unmodelled": {
      // (the warning's own kind where it is a reference: one warning per reference kind of a union)
      const reference =
        kinds.find((kind) => REFERENCE.has(kind)) ??
        detail.receiver?.kinds.find((kind) => REFERENCE.has(kind));
      return reference === undefined || detail.receiver === null
        ? `The type of '${name}' is known only when the script runs.`
        : // (one reference type of several the receiver may hold: it may be that one)
          `'${detail.receiver.text}' ${detail.receiver.kinds.every((kind) => kind === reference) ? "is" : "may be"} ` +
            `${described([reference])}, whose properties are known only when the script runs.`;
    }
  }
}

/**
 * The properties the subject reads below the place its writer's value lands in (`o.x` below `o = { x: null }`: `x`),
 * where both are plain paths of one root; none where the writer is the read itself (a call, a `load`, a selection used
 * where it stands, as an argument too); `null` where it cannot be told.
 */
function readBelow(
  required: RequiredCheck & { readonly writer: SourceSite },
  source: MessageSource,
): readonly string[] | null {
  // (the writer read where it is used, an argument among them: its own value)
  if (source.text(required.writer) === required.subject) return [];
  const landing = source.landing(required.writer);
  if (landing === null) return null;
  const names: string[] = [];
  let at = parsedExpression(required.subject)?.expression;
  while (at?.kind === "propertyAccessExpression" && !selectsElement(at.property.name)) {
    names.unshift(at.property.name);
    at = at.object;
  }
  if (at?.kind !== "identifier" || at.name !== landing.root || landing.method !== undefined)
    return null;
  for (const [index, step] of landing.steps.entries())
    if (!("property" in step) || step.property !== names[index]) return null;
  return names.slice(landing.steps.length);
}

/**
 * What brings a possible null to the route rule's error's use, in the owner's words (2026-11-11, #2287), from the
 * writer N10 names as its own text parses: one row per expression kind, so a new kind does not compile without its
 * row. An object literal answers through the property the subject reads below it; any other row only where the writer
 * is the subject's own value. `null` gives the first clause alone: a writer that is no form a cause names.
 */
function nullCause(
  required: RequiredCheck & { readonly writer: SourceSite },
  source: MessageSource,
): string | null {
  const text = source.text(required.writer);
  const parsed = parsedExpression(text);
  const below = readBelow(required, source);
  if (parsed === null) return null;
  const own = (expression: Expression): string =>
    text.slice(expression.span.start.offset - parsed.at, expression.span.end.offset - parsed.at);
  // (the writer's line, and the lines its text spans before the expression; in another file, that file's as well)
  const lineOf = (expression: Expression): string =>
    inFile(
      required,
      source.line(required.writer) +
        text.slice(0, expression.span.start.offset - parsed.at).split("\n").length -
        1,
    );
  const copy = (expression: Expression): string | null => {
    let at = expression;
    while (at.kind === "propertyAccessExpression" && !selectsElement(at.property.name))
      at = at.object;
    return at.kind === "identifier"
      ? `it is a copy of '${own(expression)}' (${lineOf(expression)}), which can hold null`
      : null;
  };
  const cause = (expression: Expression, steps: readonly string[] | null): string | null => {
    const line = lineOf(expression);
    switch (expression.kind) {
      case "nullLiteral":
        // (a `null` stored, a parameter's default among them, is the value of the place it is written for)
        return `it is set to null on ${line}`;
      case "parenthesizedExpression":
        return cause(expression.expression, steps);
      case "objectLiteral": {
        if (steps === null || steps.length === 0) return null;
        const property = expression.properties.find((each) => each.name.name === steps[0]);
        return property === undefined ? null : cause(property.value, steps.slice(1));
      }
      default:
        if (steps === null || steps.length > 0) return null;
    }
    switch (expression.kind) {
      case "loadExpression":
        return `'load' on ${line} can give null`;
      case "identifier":
        return copy(expression);
      case "propertyAccessExpression":
        return selectsElement(expression.property.name)
          ? `'${own(expression)}' on ${line} can give null`
          : copy(expression);
      case "indexExpression":
        return `an element of '${own(expression.object)}' (${line}) can be null`;
      case "binaryExpression":
        return expression.operator === "otherwise"
          ? `'${own(expression)}' on ${line} can give null`
          : null;
      case "callExpression": {
        const { callee } = expression;
        const name =
          callee.kind === "identifier"
            ? callee.name
            : callee.kind === "propertyAccessExpression"
              ? callee.property.name
              : null;
        return name === null ? null : `'${name}' on ${line} can give null`;
      }
      case "interactionExpression": {
        const name = /^[A-Za-z_]\w*/.exec(own(expression))?.[0];
        return name === undefined ? null : `'${name}' on ${line} can give null`;
      }
      case "booleanLiteral":
      case "numberLiteral":
      case "durationLiteral":
      case "unitExpression":
      case "angleExpression":
      case "stringLiteral":
      case "regexLiteral":
      case "listLiteral":
      case "setLiteral":
      case "dictLiteral":
      case "unaryExpression":
      case "rangeExpression":
      case "sayExpression":
      case "showButtonExpression":
      case "showPopupExpression":
      case "timerExpression":
      case "playMediaExpression":
      case "showCameraExpression":
      case "showPermanentButtonExpression":
      case "tagQueryExpression":
      case "typeTestExpression":
        return null;
      default: {
        const unnamed: never = expression;
        return unnamed;
      }
    }
  };
  return cause(parsed.expression, below);
}

/**
 * The route rule's error's first sentence (AD-1, #1073), from N10's payload: the read, the offending kind,
 * and the writer's line; its fix is the warning's it stands in for (`coreMessage`). A null's names what brings it
 * (`nullCause`), else nothing past the rule.
 */
export function requiredSentence(
  kinds: readonly ItemTag[],
  required: RequiredCheck,
  source: MessageSource,
): string {
  const { writer } = required;
  if (!kinds.includes("null"))
    return writer === null
      ? `'${required.subject}' can be ${described(kinds)} here.`
      : `'${required.subject}' can be ${described(kinds)} here because of ${inFile(required, source.line(writer))}.`;
  // (a block's body that inherits no check, with no store of its own: the first clause alone)
  const cause = writer === null ? null : nullCause({ ...required, writer }, source);
  const first = `'${required.subject}' must be checked for null before it is used here`;
  return cause === null ? `${first}.` : `${first}: ${cause}.`;
}

/**
 * A writer's line as a message names it: `line 3`, or `line 3 of 'b.tease'` where the writer stands in another file
 * than the use (the form the reachability diagnostics give a line in another file).
 */
function inFile(required: RequiredCheck, line: number): string {
  return required.writerFile === null ? `line ${line}` : `line ${line} of '${required.writerFile}'`;
}
