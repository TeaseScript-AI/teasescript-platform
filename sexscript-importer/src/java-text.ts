/**
 * Java and Groovy text, number, collection, and random APIs as TeaseScript values and generated helpers: URL form
 * encoding, Math functions, Random draws, character arrays, number predicates, overlapping text counts, Java number
 * conversions, and collection constructors. Each rule converts only when the receiver and the arguments are proven
 * to have the types its Java method needs; anything else keeps the lowering's own diagnostic.
 */
import { constantString, variableName, type AstNode, type SourceSpan } from "./ast.ts";
import type { IrExpression, IrStatement } from "./ir.ts";
import { argumentsOf, asNode, buildTree, dottedName, memberOf, type Tree } from "./java-ast.ts";
import { noteOnce, type JavaRuleHost } from "./java-data.ts";
import { LIST, NULL, NUMBER, onlyOf, STRING } from "./types.ts";

/** The values of a body that Java text, number, and random rules recognize. */
export interface TextAnalysis {
  /** Variables assigned one `new Random()` whose every use draws a number. */
  readonly randoms: ReadonlySet<string>;
  /** Variables that only ever hold the characters of a text (`text.toCharArray()`). */
  readonly charArrays: ReadonlySet<string>;
  /** HashSet constructors kept in a variable whose order a loop, a listing, or another use may observe. */
  readonly orderedSets: ReadonlySet<AstNode>;
}

const RANDOM_TYPES = new Set(["Random", "java.util.Random"]);
const RANDOM_DRAWS = new Set(["nextBoolean", "nextDouble", "nextFloat", "nextGaussian", "nextInt"]);
const LIST_TYPES = new Set([
  "ArrayList",
  "java.util.ArrayList",
  "LinkedList",
  "java.util.LinkedList",
  "Vector",
  "java.util.Vector",
]);
const SET_TYPES = new Set([
  "HashSet",
  "java.util.HashSet",
  "LinkedHashSet",
  "java.util.LinkedHashSet",
]);
/** Set members that do not observe the order of a Java HashSet. */
const ORDER_FREE_SET_MEMBERS = new Set(["add", "contains", "isEmpty", "remove", "size"]);
const MATH_CLASSES = new Set(["Math", "java.lang.Math", "StrictMath"]);
const URL_ENCODER = new Set(["URLEncoder", "java.net.URLEncoder"]);
const STRING_CLASSES = new Set(["String", "java.lang.String"]);

const MATH_NOTE =
  "Java computed this with its own floating-point library; the generated helper computes it with ordinary arithmetic, which can differ in the last digits, and stops the script where Java gave NaN or Infinity, which are no TeaseScript numbers.";
const ENCODE_NOTE =
  "Java encoded every character as UTF-8; the generated helper encodes ASCII and Latin-1 characters the same way and stops the script at any other character, such as an emoji.";
const NUMBER_TEXT_NOTE =
  "Java also accepted digits of other scripts, such as Arabic-Indic digits; the generated check accepts the digits 0 to 9.";
const RANDOM_NOTE =
  "Java's Random object kept its own sequence of random numbers; its draws come from the session's random numbers now, with the same distribution.";
const INT_NOTE =
  "Java's intValue() dropped the bits of a whole number beyond the int range and capped a decimal number at it; toInteger() keeps the whole number.";
const ROUNDING_NOTE =
  "Java Math.round() rounds .5 toward positive infinity (-1.5 becomes -1); TeaseScript round() rounds ties away from zero (-1.5 becomes -2, V30 §13).";
const DECIMAL_ROUNDING_NOTE =
  "Groovy rounded a decimal (BigDecimal) number half up at its decimal digits; the binary number here can round a tie such as 12.345 down.";
const SET_ORDER_NOTE =
  "A Java HashSet listed its members in hash order; a TeaseScript set keeps the order in which they were added.";

// ---------------------------------------------------------------------------------------------------------------
// Analysis

export function analyzeText(root: AstNode): TextAnalysis {
  const tree = buildTree(root);
  const randoms = new Set<string>();
  const charArrays = new Set<string>();
  const orderedSets = new Set<AstNode>();
  for (const [name, values] of tree.assignments) {
    if (tree.parameters.has(name)) continue;
    const reads = tree.reads.get(name) ?? [];
    const members = reads.map((read) => memberOf(read, tree));
    if (
      values.length === 1 &&
      values[0]?.kind === "constructorCall" &&
      RANDOM_TYPES.has(String(values[0].type)) &&
      argumentsOf(values[0]).length === 0 &&
      members.every(
        (member) => member !== null && !member.property && RANDOM_DRAWS.has(member.name),
      )
    )
      randoms.add(name);
    if (
      values.length > 0 &&
      values.every(
        (value) =>
          value !== null &&
          value.kind === "methodCall" &&
          constantString(value.method) === "toCharArray" &&
          argumentsOf(value).length === 0,
      )
    )
      charArrays.add(name);
    if (observesOrder(reads, tree)) {
      for (const value of values) if (value !== null && hashOrdered(value)) orderedSets.add(value);
    }
  }
  return { randoms, charArrays, orderedSets };
}

/** A HashSet (not a LinkedHashSet), whose iteration order Java chose by hash codes. */
function hashOrdered(node: AstNode): boolean {
  return (
    node.kind === "constructorCall" &&
    SET_TYPES.has(String(node.type)) &&
    !String(node.type).endsWith("LinkedHashSet")
  );
}

function observesOrder(reads: readonly AstNode[], tree: Tree): boolean {
  return reads.some((read) => {
    const member = memberOf(read, tree);
    return member === null || member.property || !ORDER_FREE_SET_MEMBERS.has(member.name);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Lowering

const call = (name: string, ...positional: IrExpression[]): IrExpression => ({
  kind: "call",
  name,
  positional,
  named: {},
});
const method = (target: IrExpression, name: string, ...args: IrExpression[]): IrExpression => ({
  kind: "methodCall",
  target,
  name,
  arguments: args,
});
const binary = (operator: string, left: IrExpression, right: IrExpression): IrExpression => ({
  kind: "binary",
  operator,
  left,
  right,
});
const literal = (value: number | string | boolean | null): IrExpression => ({
  kind: "literal",
  value,
});

/** Java class constants: `Math.PI` and `Math.E`. */
export function textProperty(node: AstNode, name: string): IrExpression | undefined {
  const owner = dottedName(asNode(node.object));
  if (owner === null || !MATH_CLASSES.has(owner)) return undefined;
  if (name === "PI") return literal(Math.PI);
  if (name === "E") return literal(Math.E);
  return undefined;
}

/** Static and instance method calls of the rules above. */
export function textCall(
  node: AstNode,
  name: string,
  args: readonly AstNode[],
  host: JavaRuleHost,
): IrExpression | null | undefined {
  const receiver = asNode(node.object);
  if (receiver === null) return undefined;
  const owner = dottedName(receiver);
  const analysis = host.state.text;
  const lowerAll = (): IrExpression[] | null => lowerEach(args, host);
  // Static methods of Java classes.
  if (owner !== null && !host.isVariable(owner.split(".")[0]!)) {
    if (MATH_CLASSES.has(owner)) return mathCall(node, name, args, host);
    if (URL_ENCODER.has(owner) && name === "encode" && args.length === 2) {
      const charset = constantString(args[1])?.toLowerCase().replace(/[_-]/gu, "");
      if (charset !== "utf8") return undefined;
      const text = host.lower(args[0]!);
      if (text === null) return null;
      noteOnce(host, "SX_FORM_ENCODE", ENCODE_NOTE, node.span);
      return host.helper("formEncode", [text]);
    }
    if (STRING_CLASSES.has(owner) && name === "valueOf" && args.length === 1) {
      const chars = variableName(args[0]);
      if (chars === null || !analysis.charArrays.has(chars)) return undefined;
      return method({ kind: "variable", name: chars }, "join", literal(""));
    }
    return undefined;
  }
  // Draws of a Random object, which the conversion removes.
  const random = variableName(receiver);
  if ((random !== null && analysis.randoms.has(random)) || isNewRandom(receiver)) {
    const lowered = lowerAll();
    return lowered === null ? null : randomDraw(name, lowered, host);
  }
  const type = host.valueType(receiver);
  const text = onlyOf(type, STRING | NULL) && (type & STRING) !== 0;
  const number = onlyOf(type, NUMBER);
  switch (name) {
    case "toCharArray": {
      if (args.length !== 0 || !text) return undefined;
      const value = host.lower(receiver);
      return value === null ? null : method(value, "split", literal(""));
    }
    case "isInteger":
    case "isNumber": {
      // Groovy defines both for text only.
      if (args.length !== 0 || (type & (NUMBER | LIST)) !== 0) return undefined;
      const value = host.lower(receiver);
      if (value === null) return null;
      noteOnce(host, "SX_NUMBER_TEXT", NUMBER_TEXT_NOTE, node.span);
      return host.helper(name === "isInteger" ? "isInteger" : "isNumber", [value]);
    }
    case "count": {
      // Every occurrence in text, overlapping ones too (an occurrence of a literal that cannot overlap is converted by
      // the lowering itself).
      if (args.length !== 1 || !text || (host.valueType(args[0]!) & ~(STRING | NULL)) !== 0)
        return undefined;
      const part = constantString(args[0]);
      if (part !== null && part !== "" && !overlapsItself(part)) return undefined;
      const lowered = lowerAll();
      if (lowered === null) return null;
      const value = host.lower(receiver);
      return value === null ? null : host.helper("countText", [value, lowered[0]!]);
    }
    case "indexOf": {
      // indexOf(part, start): Java searches from the start position, clamped to the text.
      if (args.length !== 2 || !text) return undefined;
      if (!onlyOf(host.valueType(args[0]!), STRING) || !onlyOf(host.valueType(args[1]!), NUMBER))
        return undefined;
      const lowered = lowerAll();
      const value = host.lower(receiver);
      if (lowered === null || value === null) return null;
      return host.helper("indexFrom", [value, lowered[0]!, lowered[1]!]);
    }
    case "charAt": {
      if (args.length !== 1 || !text || !onlyOf(host.valueType(args[0]!), NUMBER)) return undefined;
      const value = host.lower(receiver);
      const index = host.lower(args[0]!);
      if (value === null || index === null) return null;
      return method(value, "substring", index, binary("+", index, literal(1)));
    }
    case "abs": {
      if (args.length !== 0 || !number) return undefined;
      const value = host.lower(receiver);
      return value === null ? null : host.helper("abs", [value]);
    }
    case "intdiv": {
      // Groovy intdiv() divides whole numbers and drops the fraction toward zero, as toInteger() does.
      if (args.length !== 1 || !number || !onlyOf(host.valueType(args[0]!), NUMBER))
        return undefined;
      const value = host.lower(receiver);
      const divisor = host.lower(args[0]!);
      if (value === null || divisor === null) return null;
      return call("toInteger", binary("/", value, divisor));
    }
    case "intValue": {
      if (args.length !== 0 || !number) return undefined;
      const value = host.lower(receiver);
      if (value === null) return null;
      noteOnce(host, "SX_INT_RANGE", INT_NOTE, node.span);
      return call("toInteger", value);
    }
    case "round": {
      if (!number || args.length > 1) return undefined;
      const value = host.lower(receiver);
      if (value === null) return null;
      if (args.length === 0) {
        noteOnce(host, "SX_ROUNDING_TIES", ROUNDING_NOTE, node.span);
        return call("round", value);
      }
      // Groovy round(digits) of a double: floor(value * 10^digits + 0.5) / 10^digits.
      const digits = args[0]!.kind === "constant" ? args[0]!.value : null;
      if (typeof digits !== "number" || !Number.isInteger(digits) || digits < 0 || digits > 15)
        return undefined;
      if (!(value.kind === "call" && value.name === "toNumber"))
        noteOnce(host, "SX_DECIMAL_ROUNDING", DECIMAL_ROUNDING_NOTE, node.span);
      const factor = literal(10 ** digits);
      return binary(
        "/",
        call("floor", binary("+", binary("*", value, factor), literal(0.5))),
        factor,
      );
    }
    default:
      return undefined;
  }
}

function mathCall(
  node: AstNode,
  name: string,
  args: readonly AstNode[],
  host: JavaRuleHost,
): IrExpression | null | undefined {
  const helpers = new Map<
    string,
    { helper: "sqrt" | "log" | "pow" | "cos" | "sin" | "exp"; arity: number }
  >([
    ["sqrt", { helper: "sqrt", arity: 1 }],
    ["log", { helper: "log", arity: 1 }],
    ["pow", { helper: "pow", arity: 2 }],
    ["cos", { helper: "cos", arity: 1 }],
    ["sin", { helper: "sin", arity: 1 }],
    ["exp", { helper: "exp", arity: 1 }],
  ]);
  if (name === "random" && args.length === 0) return call("random");
  const entry = helpers.get(name);
  if (entry === undefined || args.length !== entry.arity) return undefined;
  const lowered = lowerEach(args, host);
  if (lowered === null) return null;
  noteOnce(host, "SX_MATH_PRECISION", MATH_NOTE, node.span);
  return host.helper(entry.helper, lowered);
}

/** Every node lowered, or null when one could not be. */
function lowerEach(nodes: readonly AstNode[], host: JavaRuleHost): IrExpression[] | null {
  const lowered: IrExpression[] = [];
  for (const node of nodes) {
    const value = host.lower(node);
    if (value === null) return null;
    lowered.push(value);
  }
  return lowered;
}

function randomDraw(
  name: string,
  args: readonly IrExpression[],
  host: JavaRuleHost,
): IrExpression | undefined {
  switch (name) {
    case "nextInt":
      // nextInt(n) draws 0 up to n; nextInt() any int.
      if (args.length === 1)
        return call("randomInteger", {
          kind: "range",
          from: literal(0),
          to: args[0]!,
          inclusive: false,
        });
      return args.length === 0
        ? call("randomInteger", {
            kind: "range",
            from: literal(-2147483648),
            to: literal(2147483648),
            inclusive: false,
          })
        : undefined;
    case "nextDouble":
    case "nextFloat":
      return args.length === 0 ? call("random") : undefined;
    case "nextBoolean":
      return args.length === 0 ? call("chance", literal(50)) : undefined;
    case "nextGaussian":
      return args.length === 0 ? host.helper("gaussian", []) : undefined;
    default:
      return undefined;
  }
}

/** Whether occurrences of a text can overlap: some proper start of it is also its end. */
function overlapsItself(text: string): boolean {
  for (let length = 1; length < text.length; length += 1) {
    if (text.slice(0, length) === text.slice(text.length - length)) return true;
  }
  return false;
}

function isNewRandom(node: AstNode): boolean {
  return (
    node.kind === "constructorCall" &&
    RANDOM_TYPES.has(String(node.type)) &&
    argumentsOf(node).length === 0
  );
}

/** `def rnd = new Random()`: the draws use the session's random numbers, so the object goes. */
export function textDeclaration(
  name: string,
  value: AstNode,
  span: SourceSpan | null,
  host: JavaRuleHost,
): IrStatement[] | null {
  if (!host.state.text.randoms.has(name) || !isNewRandom(value)) return null;
  noteOnce(host, "SX_RANDOM_OBJECT", RANDOM_NOTE, span);
  return [];
}

/** `new ArrayList()` and `new HashSet(list)` as TeaseScript lists and sets. */
export function textConstructor(
  node: AstNode,
  host: JavaRuleHost,
): IrExpression | null | undefined {
  const type = String(node.type);
  const args = argumentsOf(node);
  const isList = LIST_TYPES.has(type);
  const isSet = SET_TYPES.has(type);
  if ((!isList && !isSet) || args.length > 1) return undefined;
  if (host.state.text.orderedSets.has(node))
    noteOnce(host, "SX_SET_ORDER", SET_ORDER_NOTE, node.span);
  const source = args[0];
  // A capacity creates an empty collection.
  if (source === undefined || onlyOf(host.valueType(source), NUMBER))
    return isList ? { kind: "list", items: [] } : { kind: "list", items: [], set: true };
  if (!onlyOf(host.valueType(source), LIST)) return undefined;
  const items = host.lower(source);
  if (items === null) return null;
  if (isList) return items;
  if (items.kind === "list") return { ...items, set: true };
  return method({ kind: "list", items: [], set: true }, "union", items);
}
