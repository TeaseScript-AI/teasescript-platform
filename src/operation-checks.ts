import type { CallExpression, Expression, Identifier, ScalarTypeName } from "./ast.js";
import {
  isTemporalMethod,
  TEMPORAL_METHODS,
  temporalArgumentsProblem,
} from "./temporal-builtins.js";
import { misspelledPropertyHint } from "./object-properties.js";
import { type KnownValue } from "./static-evaluation.js";
import {
  INTEGER_TYPE,
  isAssignable,
  isKnown,
  isScalar,
  members,
  NULL_TYPE,
  REGEX_TYPE,
  resolved,
  STRING_TYPE,
  union,
  valueKindOfType,
  isIdentityType,
  isShown,
  type StaticType,
} from "./static-types.js";
import { describeKind, describeValue, typeName } from "./static-types/type-names.js";
import { joinElementMessage } from "./shown-text-rules.js";
import { orderedFamily, VALUE_KINDS, type OrderedFamily } from "./value-kinds.js";
import {
  argumentCountMessage,
  argumentShapeProblem,
  getArgumentsProblem,
  unknownNamedArgumentMessage,
} from "./argument-rules.js";
import { DICT_METHODS, dictMethod } from "./dict-operations.js";
import { handleMethod, handleMethodNames, kindsWithMethod } from "./handle-members.js";
import {
  countProblem,
  LIST_METHODS,
  listArgumentMessage,
  listMethod,
  missingListMethodMessage,
  SORT_RULE,
  type ListKind,
  type ListMethod,
  type ListParameterKind,
} from "./list-methods.js";
import {
  argumentFix,
  argumentTypeMessage,
  isTextMember,
  isTextMethod,
  LIST_JOIN,
  methodArgumentCountMessage,
  regexMemberMessage,
  stringLength,
  takesRegex,
  takesText,
  TEXT_METHODS,
  unknownTextMemberMessage,
  type ArgumentKind,
  type DomainValue,
  type MethodParameters,
  type TextDomain,
  type TextParameter,
  type TextSignature,
} from "./text-operations.js";
import { isRegex } from "./runtime/values/value-predicates.js";
import {
  type Known,
  type OperationProblem,
  withoutParentheses,
  forUse,
} from "./operation-check-support.js";

/** The problem with calling `length`, which text, lists, sets, and dicts have as a property. */
const LENGTH_PROPERTY = "'length' is a property, not a method. Write .length without parentheses.";

/**
 * Compile-time problems with a member read (`call` is `null`) or method call: unknown text members, members of values
 * that have none, and visible misuse of text operation and `join` arguments, also on a receiver of unknown type for the
 * methods only text or only lists have. On a receiver of unknown type, a method that no value has is reported, and the
 * arguments of the other methods are checked where no receiver with the method takes them. Objects, speakers, handles,
 * unions, and the other list and set members are left to the type check's own rules or to the runtime.
 */
export function memberProblems(
  receiver: Expression,
  receiverType: StaticType,
  property: Identifier,
  call: CallExpression | null,
  typeOf: (expression: Expression) => StaticType,
  known: Known,
): OperationProblem[] {
  const type = forUse(receiverType);
  const name = property.name;
  const problem = (message: string): OperationProblem[] => [
    { kind: "invalidOperand", message, span: property.span },
  ];
  if (type.kind === "scalar" && type.name === "string") {
    if (name === "length") return call === null ? [] : problem(LENGTH_PROPERTY);
    if (!isTextMethod(name))
      return problem(unknownTextMemberMessage(name, call === null ? "property" : "method"));
    const method = TEXT_METHODS[name];
    if (call === null)
      return problem(
        `'${name}' is a method. Write ${name}(${method.parameters.length === 0 ? "" : "..."}) with parentheses.`,
      );
    const text = known(receiver);
    return argumentProblems(
      method,
      call,
      typeOf,
      known,
      typeof text === "string" ? text : undefined,
    );
  }
  if (type.kind === "list" && name === "join") {
    if (call === null) return problem("'join' is a method. Write .join() with parentheses.");
    const problems = argumentProblems(LIST_JOIN, call, typeOf, known, undefined);
    const element = unshowableElement(receiver, type.element, typeOf);
    if (element !== undefined)
      problems.push({
        kind: "unshowableValue",
        message: joinElementMessage(valueKindOfType(element.type)),
        span: element.expression.span,
      });
    return problems;
  }
  if (type.kind === "unknown" || type.kind === "open") {
    // Only lists have `join`, and only text has the other text methods, so their arguments are checked even when the
    // receiver is not known.
    if (call === null) return [];
    // A name that no value has as a method fails on every receiver; every value with `length` has it as a property.
    if (!METHOD_NAMES.has(name))
      return problem(
        name === "length"
          ? LENGTH_PROPERTY
          : `No value has a method '${name}'.${misspelledPropertyHint(name, [...METHOD_NAMES, "length"]) || " Check the name."}`,
      );
    // Every receiver with a method of lists and sets takes as many arguments, but a message or a permanent button may
    // take `remove()` without any. Text takes text or a regex where a list takes any value, and only lists and sets take
    // a count, a list, or a collection, so those arguments are checked on any receiver too.
    const list = listMethod(name);
    if (list !== undefined && name !== "join")
      return listArgumentProblems(list, undefined, property, call, typeOf, known, true);
    const member = name === "join" ? LIST_JOIN : isTextMethod(name) ? TEXT_METHODS[name] : null;
    if (member !== null) return argumentProblems(member, call, typeOf, known, undefined);
    // Only date and time values have their methods, which take no arguments.
    if (isTemporalMethod(name)) {
      const named = call.arguments.filter((argument) => argument.kind === "namedArgument");
      const found = temporalArgumentsProblem(
        name,
        call.arguments.length - named.length,
        named.map((argument) => argument.name.name),
      );
      if (found === undefined) return [];
      const span =
        found.kind === "unknownNamedArgument"
          ? named.find((argument) => argument.name.name === found.name)!.name.span
          : property.span;
      return [{ kind: found.kind, message: found.message, span }];
    }
    // Only handles have the other methods, and every handle with one takes the same.
    return handleMethodProblems(name, call);
  }
  if (type.kind !== "scalar" && type.kind !== "null" && type.kind !== "range") return [];
  if (isScalar(type, "regex"))
    return problem(regexMemberMessage(name, call === null ? "property" : "method"));
  const fix =
    type.kind === "scalar" && isTextMember(name)
      ? " Convert it to text first with toString(...)."
      : "";
  return problem(
    `${capitalized(describeValue(type))} has no ${call === null ? "property" : "method"} '${name}'.${fix}`,
  );
}

/**
 * Argument names and the number of arguments of a method that only handles have, such as `pause()`, as the first handle
 * with it takes them (see `HandleMethod`).
 */
function handleMethodProblems(name: string, call: CallExpression): OperationProblem[] {
  const kind = kindsWithMethod(name)[0];
  if (kind === undefined) return [];
  const named = call.arguments.flatMap((argument) =>
    argument.kind === "namedArgument" ? [argument.name] : [],
  );
  const problem = argumentShapeProblem(
    name,
    handleMethod(kind, name)!.shape,
    call.arguments.length - named.length,
    named.map((identifier) => identifier.name),
  );
  if (problem === undefined) return [];
  return [
    {
      kind: problem.kind,
      message: problem.message,
      span:
        problem.kind === "unknownNamedArgument"
          ? named.find((identifier) => identifier.name === problem.name)!.span
          : call.span,
    },
  ];
}

/**
 * Argument names, which text operations, `join`, and the methods of lists and sets but `get` never take, and the number
 * of arguments.
 */
function shapeProblems(member: MethodParameters, call: CallExpression): OperationProblem[] {
  const parameters = member.parameters!;
  const named = call.arguments.find((argument) => argument.kind === "namedArgument");
  if (named !== undefined)
    return [
      {
        kind: "unknownNamedArgument",
        message: unknownNamedArgumentMessage(member.name, named.name.name, []),
        span: named.name.span,
      },
    ];
  const required = parameters.filter((parameter) => parameter.optional !== true).length;
  if (call.arguments.length < required || call.arguments.length > parameters.length)
    return [
      {
        kind: "argumentCount",
        message: methodArgumentCountMessage(member, call.arguments.length),
        span: call.span,
      },
    ];
  return [];
}

/**
 * The problems with the arguments of a method of text or `join` that the compiler can see: their shape, each argument's
 * type, and each domain whose values it knows, with the runtime's text (see `TextDomain`), where the arguments the
 * domain reads have no other problem. A domain is checked after the last argument it reads, and reported there.
 * `receiverText` is the text the method is called on, when it is known.
 */
function argumentProblems(
  member: TextSignature,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
  known: Known,
  receiverText: string | undefined,
): OperationProblem[] {
  const shape = shapeProblems(member, call);
  if (shape.length > 0) return shape;
  const parameters = member.parameters;
  const problems: OperationProblem[] = [];
  // The known value of each argument, `undefined` where it is not known, and `null` after a problem with it.
  const values: (DomainValue | undefined | null)[] = [];
  let length: number | undefined;
  const check = (domain: TextDomain): void => {
    const known: DomainValue[] = [];
    for (const read of domain.reads) {
      const value =
        read !== "length"
          ? values[read]
          : receiverText === undefined
            ? undefined
            : (length ??= stringLength(receiverText));
      if (value === undefined || value === null) return;
      known.push(value);
    }
    const message = domain.problem(known, member);
    if (message === undefined) return;
    for (const read of domain.reads) if (read !== "length") values[read] = null;
    problems.push({
      kind: "invalidOperand",
      message,
      span: call.arguments[lastArgument(domain)]!.value.span,
    });
  };
  for (const [index, argument] of call.arguments.entries()) {
    const parameter = parameters[index]!;
    const value = argument.value;
    const type = typeOf(value);
    const text = takesText(parameter);
    const searches = takesRegex(parameter);
    const needed = searches
      ? text
        ? union([STRING_TYPE, REGEX_TYPE])
        : REGEX_TYPE
      : text
        ? STRING_TYPE
        : INTEGER_TYPE;
    if (!isAssignable(needed, type)) {
      values[index] = null;
      problems.push(
        nullCheckProblem(value, type, needed) ?? {
          kind: "invalidOperand",
          message: argumentTypeMessage(member, parameter, describeKind(type)),
          span: value.span,
          ...(text || searches ? {} : { widened: value }),
          fix: argumentFix(parameter, argumentKind(type)),
        },
      );
      continue;
    }
    values[index] = knownArgument(parameter, known(value));
    for (const domain of member.domains) if (lastArgument(domain) === index) check(domain);
  }
  return problems;
}

/** The position of the last argument a domain reads. */
function lastArgument(domain: TextDomain): number {
  return Math.max(...domain.reads.map((read) => (read === "length" ? -1 : read)));
}

/** The known `value` of an argument of `parameter` as its domains read it: text, a whole number, or a regex. */
function knownArgument(
  parameter: TextParameter,
  value: KnownValue | undefined,
): DomainValue | undefined {
  if (!takesText(parameter) && !takesRegex(parameter))
    return typeof value === "number" ? value : undefined;
  return (takesText(parameter) && typeof value === "string") ||
    (takesRegex(parameter) && value !== undefined && isRegex(value))
    ? value
    : undefined;
}

/**
 * The first element of a list literal whose known type `join` cannot show, or for a computed list, its element type
 * when no element of that type can be shown.
 */
function unshowableElement(
  receiver: Expression,
  element: StaticType,
  typeOf: (expression: Expression) => StaticType,
): { readonly expression: Expression; readonly type: StaticType } | undefined {
  let node = receiver;
  while (node.kind === "parenthesizedExpression") node = node.expression;
  if (node.kind !== "listLiteral")
    return joinShowable(element) ? undefined : { expression: receiver, type: element };
  for (const expression of node.elements) {
    const type = typeOf(expression);
    if (!joinShowable(type)) return { expression, type };
  }
  return undefined;
}

/** Whether a value of this type may be shown by `join` (`isShown`); `join` checks the value. */
function joinShowable(type: StaticType): boolean {
  return members(type).some(isShown);
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The scalar kind of a known argument type, for choosing the conversion a message suggests. */
function argumentKind(type: StaticType): ArgumentKind {
  const value = forUse(type);
  if (value.kind !== "scalar") return null;
  return value.name === "string" ||
    value.name === "integer" ||
    value.name === "number" ||
    value.name === "boolean" ||
    value.name === "duration"
    ? value.name
    : null;
}

/**
 * How other code may change a variable: by assigning it, or only by changing the list, set, dict, or object it holds in
 * place, which keeps the variable on the same value, so never null.
 */
export type Sharing = "assigns" | "changes";

/** Records how `name` is changed, where an assignment says more than a change in place. */
export function noteSharing<K>(writes: Map<K, Sharing>, name: K, how: Sharing): void {
  if (writes.get(name) !== "assigns") writes.set(name, how);
}

/** The variable a place belongs to, such as `xs` for `xs[0].name`, or `null` for a place no variable holds. */
export function rootName(expression: Expression): string | null {
  let node = expression;
  while (
    node.kind === "parenthesizedExpression" ||
    node.kind === "propertyAccessExpression" ||
    node.kind === "indexExpression"
  )
    node = node.kind === "parenthesizedExpression" ? node.expression : node.object;
  return node.kind === "identifier" ? node.name : null;
}

/**
 * The name of every method a value has: those of text (V30 §8), of lists and sets (V30 §16), of dicts (V30 §40), of
 * handles (see `HANDLE_MEMBERS`), and of date and time values (V30 §35). Other values, such as numbers, objects, and
 * speakers, have none.
 */
const METHOD_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(TEXT_METHODS),
  ...Object.keys(LIST_METHODS),
  ...Object.keys(DICT_METHODS),
  ...handleMethodNames(),
  ...Object.keys(TEMPORAL_METHODS),
]);

/**
 * The method `name` as every receiver with it takes its arguments, all of them without a name: a method of lists and
 * sets but `get` and `join`. A dict (see `DICT_METHODS`), a range, text, a message, and a permanent button take as many
 * with the methods they share with lists, but a message and a permanent button take `remove()`.
 */
function positionalMethod(name: string): MethodParameters | undefined {
  const method = listMethod(name);
  return method !== undefined &&
    !("named" in method && method.named !== undefined) &&
    method.parameters!.every((parameter) => parameter.optional !== true)
    ? method
    : undefined;
}

/**
 * Argument names and the number of arguments of a method that takes them without names (see `positionalMethod`), which
 * every receiver with the method rejects. Where the receiver may be a message or a permanent button (`removable`),
 * `remove()` may have no argument.
 */
export function positionalMethodProblems(
  name: string,
  call: CallExpression,
  removable: boolean,
): OperationProblem[] {
  const method = positionalMethod(name);
  return method === undefined ? [] : methodShapeProblems(method, call, removable);
}

/**
 * Argument names and the number of arguments of a dict's method `name` (see `DICT_METHODS`) but `get`, which takes them
 * without names, as `positionalMethodProblems` checks those of lists, for a dict in a union.
 */
export function dictMethodProblems(
  name: string,
  call: CallExpression,
  removable: boolean,
): OperationProblem[] {
  const method = dictMethod(name);
  return method === undefined || method.named !== undefined
    ? []
    : methodShapeProblems(method, call, removable);
}

/** Argument names and the number of arguments of `method`, which may be `remove()` where the receiver is `removable`. */
function methodShapeProblems(
  method: MethodParameters,
  call: CallExpression,
  removable: boolean,
): OperationProblem[] {
  const problems = shapeProblems(method, call);
  if (!removable || method.name !== "remove" || problems[0]?.kind !== "argumentCount")
    return problems;
  if (call.arguments.length === 0) return [];
  return [
    {
      kind: "argumentCount",
      message: argumentCountMessage(
        "remove",
        "1 argument, or none on a message or permanent button",
        call.arguments.length,
      ),
      span: call.span,
    },
  ];
}

/**
 * Compile-time problems with a call of a method of lists and sets (see `LIST_METHODS`) on a list or set of a known
 * type: a method its kind does not have, then the problems of `listArgumentProblems`.
 */
export function collectionMethodProblems(
  name: string,
  receiverType: StaticType & { readonly kind: ListKind },
  property: Identifier,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
  known: Known,
  removable = false,
): OperationProblem[] {
  const method = listMethod(name);
  if (method === undefined || !method.receivers.includes(receiverType.kind))
    return [
      {
        kind: "invalidOperand",
        message: missingListMethodMessage(receiverType.kind, name),
        span: property.span,
      },
    ];
  return listArgumentProblems(method, receiverType, property, call, typeOf, known, removable);
}

/**
 * Compile-time problems with the arguments of a method of lists and sets, on a list or set of `receiverType`, or on a
 * receiver of any type (`undefined`): their names and number (`get` takes a `default:`, as a dict's does), a count that is
 * not a whole number of at least 0, a list or collection argument that is another value, and on a list elements `sort`
 * cannot order. A list's index is checked as for `list[index]`, and the elements that `add` and `addAll` store as the
 * list's other elements, by the type check.
 */
function listArgumentProblems(
  method: ListMethod,
  receiverType: (StaticType & { readonly kind: ListKind }) | undefined,
  property: Identifier,
  call: CallExpression,
  typeOf: (expression: Expression) => StaticType,
  known: Known,
  removable: boolean,
): OperationProblem[] {
  if (method.named !== undefined) return getProblems(receiverType, call);
  const shape = methodShapeProblems(method, call, removable);
  if (shape.length > 0) return shape;
  // The shape fits, so each argument has its parameter.
  const problems = call.arguments.flatMap((argument, position) =>
    argumentKindProblems(method, method.parameters[position]!.kind, argument.value, typeOf, known),
  );
  if (method.name !== "sort" || receiverType === undefined) return problems;
  const message = sortProblem(receiverType.element);
  return message === undefined
    ? problems
    : [{ kind: "invalidOperand", message, span: property.span }];
}

/** Problems with one argument of a list method for a parameter of `kind`: a count, a list, or a collection. */
function argumentKindProblems(
  method: ListMethod,
  kind: ListParameterKind,
  argument: Expression,
  typeOf: (expression: Expression) => StaticType,
  known: Known,
): OperationProblem[] {
  const problem = (message: string): OperationProblem[] => [
    { kind: "invalidOperand", message, span: argument.span },
  ];
  if (kind === "count") {
    const type = typeOf(argument);
    const nullable = nullCheckProblem(argument, type, INTEGER_TYPE);
    if (nullable !== undefined) return [nullable];
    // The first kind the count may be that is not a whole number, such as the number in `number?`.
    const other = members(type).find((member) => !isAssignable(INTEGER_TYPE, member));
    if (other !== undefined)
      return problem(listArgumentMessage(method.name, "count", describeKind(other), "other"));
    const count = known(argument);
    const message = typeof count === "number" ? countProblem(method.name, count) : undefined;
    return message === undefined ? [] : problem(message);
  }
  if (kind !== "list" && kind !== "collection") return [];
  // Every member of a union argument must be a list, or a list or a set (ADR 0021 rule 3.5).
  const type = forUse(typeOf(argument));
  const kinds = members(type).map((member) => resolved(member));
  const fits = kinds.every(
    (member) =>
      !isKnown(member) ||
      member.kind === "list" ||
      (kind === "collection" && member.kind === "set"),
  );
  if (fits) return [];
  const other =
    kind === "list" && kinds.some((member) => member.kind === "set")
      ? "set"
      : kinds.some((member) => member.kind === "range")
        ? "range"
        : "other";
  return problem(listArgumentMessage(method.name, kind, describeKind(type), other));
}

/**
 * Problems with a list's `get(index, default: value)`: one index and a `default:`, as a dict's `get` takes a key and a
 * `default:` (#844), also where the receiver may be either (`receiverType` is `undefined`). The index is checked as for
 * `list[index]`.
 */
function getProblems(
  receiverType: (StaticType & { readonly kind: ListKind }) | undefined,
  call: CallExpression,
): OperationProblem[] {
  const named = call.arguments.filter((argument) => argument.kind === "namedArgument");
  const problem = getArgumentsProblem(
    receiverType === undefined ? "either" : "list",
    call.arguments.length - named.length,
    named.map((argument) => argument.name.name),
  );
  if (problem === undefined) return [];
  return [
    {
      kind: problem.kind,
      message: problem.message,
      span:
        problem.kind === "unknownNamedArgument"
          ? named.find((argument) => argument.name.name === problem.name)!.name.span
          : call.span,
    },
  ];
}

/**
 * The message for a value that may be of a member type an operation does not support, naming the test that makes it
 * safe: `!= null` for null, which also narrows it. Only a plain variable narrows, so a property or element is first
 * kept in a variable. For null, the message also names a fallback, unless the value is what the operation changes.
 * A null's first sentence is the owner's (2026-11-11, #2287): the value must be checked before it is used, and
 * `cause`, where the checker holds one for a plain variable, what makes it possibly null, as in
 * `its type is 'integer?' (line 2)`.
 */
export function mayBeMessage(
  expression: Expression,
  failing: StaticType,
  passing: readonly StaticType[],
  fallback = true,
  cause: string | null = null,
): string {
  const node = withoutParentheses(expression);
  const label = node.kind === "identifier" ? node.name : null;
  const test = failing.kind === "null" ? "!= null" : `is ${typeName(union(passing))}`;
  // A type that no value decided yet has no name to give.
  const what =
    resolved(failing).kind === "open"
      ? "of a type that no value decided yet, such as an element of an empty list without a written type"
      : describeValue(failing);
  const or = failing.kind === "null" && fallback ? fallbackFix(label ?? "value", passing) : "";
  const subject = label === null ? "This value" : `'${label}'`;
  const first =
    failing.kind !== "null"
      ? `${subject} may be ${what}.`
      : cause === null || label === null
        ? `${subject} must be checked for null before it is used here.`
        : `${subject} must be checked for null before it is used here: ${cause}.`;
  return label === null
    ? `${first} Keep it in a variable and check it first, as in: if value ${test} { ... }${or}`
    : `${first} Check it first: if ${label} ${test} { ... }${or}`;
}

/**
 * The fallback that a null check names as well (owner decision on #850), with a value of the `passing` types: `0` for
 * a number, `""` for text, `false` for a boolean, and `...` for any other value. A handle, such as of a timer or of
 * media, has no value to write as a fallback, so it gets none.
 */
export function fallbackFix(label: string, passing: readonly StaticType[]): string {
  if (passing.some(isIdentityType)) return "";
  const every = (...names: ScalarTypeName[]) =>
    passing.length > 0 && passing.every((type) => isScalar(type, ...names));
  const value = every("integer", "number")
    ? "0"
    : every("string")
      ? '""'
      : every("boolean")
        ? "false"
        : "...";
  return `, or give a fallback: ${label} otherwise ${value}`;
}

/**
 * For an argument that may be null and is otherwise of the `needed` type, the problem that names the null check
 * (owner decision on #504 Q1), such as for a position from `indexOf`.
 */
function nullCheckProblem(
  value: Expression,
  type: StaticType,
  needed: StaticType,
): OperationProblem | undefined {
  const all = members(type);
  const passing = all.filter((member) => member.kind !== "null");
  if (
    passing.length === 0 ||
    passing.length === all.length ||
    !passing.every((member) => isAssignable(needed, member))
  )
    return undefined;
  return {
    kind: "invalidOperand",
    message: mayBeMessage(value, NULL_TYPE, passing),
    span: value.span,
  };
}

/** Why elements of `element` type cannot be sorted, or `undefined` when they can or may: one ordered family only. */
function sortProblem(element: StaticType): string | undefined {
  const candidates = members(element).map(resolved);
  if (candidates.some((candidate) => !isKnown(candidate))) return undefined;
  const familyOfType = (candidate: StaticType): OrderedFamily | undefined => {
    const kind = valueKindOfType(candidate);
    return kind === undefined ? undefined : orderedFamily(kind);
  };
  const unsortable = candidates.find((candidate) => familyOfType(candidate) === undefined);
  if (unsortable !== undefined) return `${SORT_RULE}, not ${describeKind(unsortable)}.`;
  const families = new Set(candidates.map(familyOfType));
  return families.size > 1
    ? `sort() needs elements of one kind, but this list may hold ${[...families].map((family) => VALUE_KINDS[family!].plural).join(" and ")}.`
    : undefined;
}
