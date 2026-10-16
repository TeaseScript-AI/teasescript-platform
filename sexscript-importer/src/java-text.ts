/**
 * Java and Groovy text, number, collection, and random APIs as TeaseScript values and generated helpers: URL form
 * encoding, Math functions, Random draws, character arrays, number predicates, overlapping text counts, regular
 * expressions, Java number conversions, and collection constructors. Each rule converts only when the receiver and the arguments are proven
 * to have the types its Java method needs; anything else keeps the lowering's own diagnostic.
 */
import { constantString, isAstNode, variableName, type AstNode, type SourceSpan } from "./ast.ts";
import type { IrExpression, IrStatement } from "./ir.ts";
import {
  argumentsOf,
  asNode,
  buildTree,
  dottedName,
  isNullConstant,
  memberOf,
  type Tree,
} from "./java-ast.ts";
import { noteOnce, type JavaRuleHost } from "./java-data.ts";
import { javaRegex } from "./java-regex.ts";
import { whole } from "./java-time.ts";
import { literalPattern, parseTailPattern } from "./regex-subset.ts";
import { LIST, NULL, NUMBER, OBJECT, onlyOf, STRING } from "./types.ts";

/** The values of a body that Java text, number, and random rules recognize. */
export interface TextAnalysis {
  /** Variables assigned one `new Random()` whose every use draws a number. */
  readonly randoms: ReadonlySet<string>;
  /** Variables that only ever hold the characters of a text (`text.toCharArray()`). */
  readonly charArrays: ReadonlySet<string>;
  /** HashSet constructors kept in a variable whose order a loop, a listing, or another use may observe. */
  readonly orderedSets: ReadonlySet<AstNode>;
  /** StringBuilder and StringBuffer variables whose every use reads, appends to, or replaces part of the text. */
  readonly textBuffers: ReadonlySet<string>;
  /** The constructors that the text buffer variables are assigned. */
  readonly bufferValues: ReadonlySet<AstNode>;
  /** Map keys whose every value in the body's map literals is a closure, as `[label: "a slap", action: { ... }]`. */
  readonly closureFields: ReadonlySet<string>;
  /** `reverse()` calls of a value whose type the conversion does not know that its use shows to be text (textReverses). */
  readonly textReverses: ReadonlySet<AstNode>;
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
  // A queue starts as an empty list too; its size reads as a list's (LLM_Mistress).
  "LinkedBlockingQueue",
  "java.util.concurrent.LinkedBlockingQueue",
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
const BUFFER_TYPES = new Set([
  "StringBuilder",
  "java.lang.StringBuilder",
  "StringBuffer",
  "java.lang.StringBuffer",
]);
/** Members of a text buffer that read its text. */
const BUFFER_READS = new Set(["length", "toString"]);
const SYSTEM_CLASSES = new Set(["System", "java.lang.System"]);
const FILE_CLASSES = new Set(["File", "java.io.File"]);
const COLLECTIONS_CLASSES = new Set(["Collections", "java.util.Collections"]);
/** Methods of a Groovy map, which a map key of the same name does not replace. */
const MAP_METHODS = new Set([
  "clear",
  "containsKey",
  "containsValue",
  "each",
  "find",
  "findAll",
  "get",
  "isEmpty",
  "keySet",
  "put",
  "putAll",
  "remove",
  "size",
  "values",
]);
const CHARACTER_CLASSES = new Set(["Character", "java.lang.Character"]);
const URL_ENCODER = new Set(["URLEncoder", "java.net.URLEncoder"]);
const STRING_CLASSES = new Set(["String", "java.lang.String"]);

const MATH_NOTE =
  "Java computed this with its own floating-point library, and its sin(), cos(), and tan() took an angle as a number of radians, which is an angle in rad here; the result can differ in the last digits (more for very large angles), and the script stops where Java gave NaN or Infinity, which are no TeaseScript numbers.";
const ENCODE_NOTE =
  "Java encoded every character as UTF-8; the generated helper encodes printable ASCII and Latin-1 characters, tabs, and line breaks the same way and stops the script at any other character, such as another control character or an emoji.";
const NUMBER_TEXT_NOTE =
  "Java also accepted digits of other scripts, such as Arabic-Indic digits; the generated check accepts the digits 0 to 9.";
const RANDOM_NOTE =
  "Java's Random object kept its own sequence of random numbers; its draws come from the session's random numbers now, with the same distribution.";
const INT_NOTE =
  "Java's intValue() dropped the bits of a whole number beyond the int range and capped a decimal number at it; toInteger() keeps the whole number.";
const ROUNDING_NOTE =
  "If this number was a Java double, Groovy round() rounded .5 toward positive infinity (-1.5 became -1); TeaseScript round() rounds ties away from zero (-1.5 becomes -2, V30 §13), as Groovy did for a decimal (BigDecimal) number.";
const DECIMAL_ROUNDING_NOTE =
  "Groovy rounded a decimal (BigDecimal) number half up at its decimal digits; the binary number here can round a tie such as 12.345 down.";
const LINE_SEPARATOR_NOTE =
  "Java used the platform's line separator, \\r\\n on Windows; the text uses a line break (\\n), as TeaseScript text does.";
const CHARACTER_NOTE =
  "Java's (char) cast made any character from its code; the generated helper makes the printable ASCII characters and stops the script at any other code.";
const CHAR_AT_NOTE =
  "Java's charAt() gave a character, which compared equal to one-character text but counted as its code in arithmetic; the converted one-character text cannot be added to a number.";
const SET_ORDER_NOTE =
  "A Java HashSet listed its members in hash order; a TeaseScript set keeps the order in which they were added.";

// ---------------------------------------------------------------------------------------------------------------
// Analysis

export function analyzeText(root: AstNode): TextAnalysis {
  const tree = buildTree(root);
  const randoms = new Set<string>();
  const charArrays = new Set<string>();
  const orderedSets = new Set<AstNode>();
  const textBuffers = new Set<string>();
  const bufferValues = new Set<AstNode>();
  for (const [name, values] of tree.assignments) {
    if (tree.parameters.has(name)) continue;
    const reads = tree.reads.get(name) ?? [];
    const members = reads.map((read) => memberOf(read, tree));
    // Every value is a new Random, also where blocks declare the name again.
    if (
      values.length > 0 &&
      values.every(
        (value) =>
          value?.kind === "constructorCall" &&
          RANDOM_TYPES.has(String(value.type)) &&
          argumentsOf(value).length === 0,
      ) &&
      members.every(
        (member) => member !== null && !member.property && RANDOM_DRAWS.has(member.name),
      )
    )
      randoms.add(name);
    // Declarations without a value (`def a, chars`) hold no other value.
    const charValues = values.filter((value) => value !== null && !isNullConstant(value));
    if (
      charValues.length > 0 &&
      charValues.every(
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
    const only = values.length === 1 ? values[0] : null;
    if (
      only !== null &&
      only !== undefined &&
      only.kind === "constructorCall" &&
      BUFFER_TYPES.has(String(only.type)) &&
      argumentsOf(only).length <= 1 &&
      reads.every((read) => bufferUse(read, tree))
    ) {
      textBuffers.add(name);
      bufferValues.add(only);
    }
  }
  return {
    randoms,
    charArrays,
    orderedSets,
    textBuffers,
    bufferValues,
    closureFields: closureFields(tree),
    textReverses: textReverses(tree, closureFields(tree)),
  };
}

/** Groovy methods that only text has, of which a value's use shows that the value is text. */
const TEXT_ONLY_METHODS = new Set([
  "substring",
  "toLowerCase",
  "toUpperCase",
  "trim",
  "startsWith",
  "endsWith",
  "charAt",
  "toCharArray",
  "capitalize",
  "tokenize",
  "matches",
  "replaceAll",
  "replaceFirst",
  "split",
  "isNumber",
  "isInteger",
  "toInteger",
]);

/**
 * `reverse()` calls that reverse text: of the result of a text-only method, `name.substring(1).reverse()`, or whose
 * result is the receiver of one, `path.reverse().substring(0, 4)` (a list has no such method, so Groovy failed there);
 * also a `reverse()` of the same receiver inside that method's arguments, which read nothing that may change it
 * (BuzzQuiz's `QFiles[r0].reverse().substring(0, QFiles[r0].reverse().indexOf("/"))`).
 */
function textReverses(tree: Tree, closures: ReadonlySet<string>): Set<AstNode> {
  const unchanging = (node: AstNode): boolean => effectFree(node, closures);
  const isReverse = (node: AstNode | null | undefined): node is AstNode =>
    node?.kind === "methodCall" &&
    constantString(node.method) === "reverse" &&
    argumentsOf(node).length === 0;
  const textOnly = (node: AstNode | null | undefined): boolean =>
    node?.kind === "methodCall" && TEXT_ONLY_METHODS.has(constantString(node.method) ?? "");
  const key = (node: AstNode | null): string =>
    JSON.stringify(node, (name: string, value: unknown) => (name === "span" ? undefined : value));
  const reverses = [...tree.parents.keys()].filter(isReverse);
  const found = new Set<AstNode>();
  // The text-only calls whose receiver is a proven reverse() of a repeatable value, with that value's key.
  const provers = new Map<AstNode, string>();
  for (const node of reverses) {
    const parent = tree.parents.get(node) ?? null;
    const receiver = asNode(node.object);
    const isReceiver = textOnly(parent) && asNode(parent!.object) === node;
    if (!isReceiver && !textOnly(receiver)) continue;
    found.add(node);
    if (isReceiver && repeatable(receiver) && argumentsOf(parent!).every(unchanging))
      provers.set(parent!, key(receiver));
  }
  for (const node of reverses) {
    const receiver = asNode(node.object);
    if (found.has(node) || !repeatable(receiver)) continue;
    for (let at = tree.parents.get(node) ?? null; at !== null; at = tree.parents.get(at) ?? null) {
      const prover = provers.get(at);
      if (prover === undefined) continue;
      if (prover === key(receiver) && asNode(at.object) !== node) found.add(node);
      break;
    }
  }
  return found;
}

/** Groovy methods of text and lists that change nothing. */
const READING_METHODS = new Set([
  ...TEXT_ONLY_METHODS,
  "reverse",
  "indexOf",
  "lastIndexOf",
  "contains",
  "size",
  "length",
]);

/**
 * Whether evaluating a value changes nothing: no assignment, step, construction, or call that may run code, also not a
 * map's closure that a method call with its key runs (`closures`, closureFields).
 */
function effectFree(node: AstNode, closures: ReadonlySet<string>): boolean {
  if (node.kind === "postfix" || node.kind === "prefix" || node.kind === "constructorCall")
    return false;
  if (node.kind === "binary" && typeof node.operator === "string") {
    const operator = node.operator;
    if (
      operator === "<<" ||
      (operator.endsWith("=") && !["==", "!=", "<=", ">="].includes(operator))
    )
      return false;
  }
  // A reading method of a value: a call without a receiver, or of the script itself, runs a function or closure of the
  // script, whatever its name.
  if (
    node.kind === "methodCall" &&
    (!READING_METHODS.has(constantString(node.method) ?? "") ||
      (closures.has(constantString(node.method) ?? "") && !textOrListResult(asNode(node.object))) ||
      node.implicitThis === true ||
      asNode(node.object) === null ||
      ["this", "main", "super"].includes(variableName(node.object) ?? ""))
  )
    return false;
  if (node.kind === "closure") return false;
  for (const [name, value] of Object.entries(node)) {
    if (name === "span") continue;
    for (const child of Array.isArray(value) ? value : [value])
      if (isAstNode(child) && !effectFree(child, closures)) return false;
  }
  return true;
}

/** A reverse() or text-only method's result, text or a list, which no map's closure field is called on. */
function textOrListResult(node: AstNode | null): boolean {
  return (
    node?.kind === "methodCall" &&
    (constantString(node.method) === "reverse" ||
      TEXT_ONLY_METHODS.has(constantString(node.method) ?? ""))
  );
}

/** A variable, or an element or a field of one at a constant or variable position, which reading does not change. */
function repeatable(node: AstNode | null): boolean {
  if (node === null) return false;
  if (node.kind === "variable") return true;
  if (node.kind === "property") return repeatable(asNode(node.object));
  if (node.kind === "binary" && node.operator === "[") {
    const index = asNode(node.right);
    return (
      repeatable(asNode(node.left)) &&
      index !== null &&
      (index.kind === "constant" || index.kind === "variable")
    );
  }
  return false;
}

/** Map keys whose every literal value is a closure or a variable that only ever holds closures. */
function closureFields(tree: Tree): Set<string> {
  const closures = new Set<string>();
  for (const [name, values] of tree.assignments) {
    if (values.length > 0 && values.every((value) => value?.kind === "closure")) closures.add(name);
  }
  const fields = new Map<string, boolean>();
  for (const node of tree.parents.keys()) {
    if (node.kind !== "mapEntry") continue;
    const key = constantString(node.key);
    const value = asNode(node.value);
    if (key === null || value === null) continue;
    const closure = value.kind === "closure" || closures.has(variableName(value) ?? "");
    fields.set(key, (fields.get(key) ?? true) && closure);
  }
  return new Set(
    [...fields].filter(([key, closure]) => closure && !MAP_METHODS.has(key)).map(([key]) => key),
  );
}

/** A HashSet (not a LinkedHashSet), whose iteration order Java chose by hash codes. */
function hashOrdered(node: AstNode): boolean {
  return (
    node.kind === "constructorCall" &&
    SET_TYPES.has(String(node.type)) &&
    !String(node.type).endsWith("LinkedHashSet")
  );
}

/** `buffer.toString()`, `buffer.length()`, `buffer.append(part)` as a statement, or `buffer[from..to] = text`. */
function bufferUse(read: AstNode, tree: Tree): boolean {
  const member = memberOf(read, tree);
  if (member !== null && !member.property) {
    if (BUFFER_READS.has(member.name)) return member.arguments.length === 0;
    return (
      member.name === "append" &&
      member.arguments.length === 1 &&
      tree.parents.get(member.call)?.kind === "expressionStatement"
    );
  }
  return rangeWrite(read, tree) !== null;
}

/** The index range of `buffer[from..to] = text` whose receiver is the read, with literal whole bounds. */
function rangeWrite(
  read: AstNode,
  tree: Tree,
): { from: number; to: number; value: AstNode } | null {
  const index = tree.parents.get(read) ?? null;
  if (index?.kind !== "binary" || index.operator !== "[" || asNode(index.left) !== read)
    return null;
  const assignment = tree.parents.get(index) ?? null;
  if (
    assignment?.kind !== "binary" ||
    assignment.operator !== "=" ||
    asNode(assignment.left) !== index
  )
    return null;
  if (tree.parents.get(assignment)?.kind !== "expressionStatement") return null;
  const range = asNode(index.right);
  const from = range?.kind === "range" ? asNode(range.from)?.value : undefined;
  const to = range?.kind === "range" ? asNode(range.to)?.value : undefined;
  const value = asNode(assignment.right);
  if (typeof from !== "number" || typeof to !== "number" || value === null) return null;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
  return range?.inclusive === true
    ? { from, to, value }
    : to > from
      ? { from, to: to - 1, value }
      : null;
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

/** The number π, written `pi` (V30 "Numeric functions"). */
const PI: IrExpression = { kind: "literal", value: Math.PI, constant: "pi" };

/** Java class constants: `Math.PI` and `Math.E`. */
export function textProperty(node: AstNode, name: string): IrExpression | undefined {
  const owner = dottedName(asNode(node.object));
  if (owner === null || !MATH_CLASSES.has(owner)) return undefined;
  if (name === "PI") return PI;
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
    if (
      (STRING_CLASSES.has(owner) && name === "valueOf") ||
      (CHARACTER_CLASSES.has(owner) && name === "toString")
    ) {
      if (args.length !== 1) return undefined;
      const code = characterCode(args[0]!);
      if (code !== null) {
        const value = host.lower(code);
        if (value === null) return null;
        noteOnce(host, "SX_CHARACTER_CODE", CHARACTER_NOTE, node.span);
        return host.helper("character", [whole(value)]);
      }
      const chars = variableName(args[0]);
      if (name !== "valueOf" || chars === null || !analysis.charArrays.has(chars)) return undefined;
      return method({ kind: "variable", name: chars }, "join", literal(""));
    }
    if (SYSTEM_CLASSES.has(owner) && name === "getProperty" && args.length === 1) {
      if (constantString(args[0]) !== "line.separator") return undefined;
      noteOnce(host, "SX_LINE_SEPARATOR", LINE_SEPARATOR_NOTE, node.span);
      return literal("\n");
    }
    return undefined;
  }
  // `new File(path).getName()`: the last part of a package path, as java.io.File gave it on Windows.
  if (
    name === "getName" &&
    args.length === 0 &&
    receiver.kind === "constructorCall" &&
    FILE_CLASSES.has(String(receiver.type)) &&
    argumentsOf(receiver).length === 1
  ) {
    const pathNode = argumentsOf(receiver)[0]!;
    if (host.isPhoto(pathNode) || !onlyOf(host.valueType(pathNode), STRING | NULL))
      return undefined;
    const path = host.lower(pathNode);
    return path === null ? null : host.helper("fileName", [path]);
  }
  // `record.action()` calls the closure that the record's field holds, as a Groovy map did.
  if (
    analysis.closureFields.has(name) &&
    (owner === null || host.isVariable(owner.split(".")[0]!)) &&
    onlyOf(host.valueType(receiver), OBJECT | NULL) &&
    (host.valueType(receiver) & OBJECT) !== 0
  ) {
    const field = host.lower({
      kind: "property",
      span: node.span,
      object: receiver,
      property: { kind: "constant", span: null, value: name },
    });
    const lowered = lowerAll();
    if (field === null || lowered === null) return null;
    return host.actionCall(field, lowered);
  }
  // The text of a StringBuilder or StringBuffer variable.
  const buffer = variableName(receiver);
  if (buffer !== null && analysis.textBuffers.has(buffer) && args.length === 0) {
    const text: IrExpression = { kind: "variable", name: buffer };
    if (name === "toString") return text;
    if (name === "length") return { kind: "property", target: text, name: "length" };
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
  const maybeText = (type & STRING) !== 0;
  switch (name) {
    case "matches": {
      // Java's match of the whole text, such as the rough email shape `.{1,50}@.{5,50}`.
      if (args.length !== 1 || !maybeText) return undefined;
      const regex = regexLiteral(args[0]!, "whole", host);
      if (regex === undefined || regex === null) return regex;
      const value = host.lower(receiver);
      return value === null ? null : method(matchedText(value, type), "matches", regex);
    }
    case "get": {
      // Java List.get(index) reads a position; a negative one fails in both.
      if (args.length !== 1 || !onlyOf(type, LIST | NULL) || (type & LIST) === 0) return undefined;
      if (!onlyOf(host.valueType(args[0]!), NUMBER)) return undefined;
      const list = host.lower(receiver);
      const index = host.lower(args[0]!);
      return list === null || index === null ? null : { kind: "index", target: list, index };
    }
    case "reverse": {
      // Groovy reverse() of a list or text is a new reversed value; the receiver stays as it was. TeaseScript reverse()
      // gives text a new text, by code points as Java kept surrogate pairs, and reverses a list in place (#860), so a
      // list's copy is reversed where the statement may take it first, and the helper builds one elsewhere.
      const list = onlyOf(type, LIST | NULL) && (type & LIST) !== 0;
      if (args.length !== 0 || (!list && !text && !analysis.textReverses.has(node)))
        return undefined;
      const value = host.lower(receiver);
      if (value === null) return null;
      if (!list) return { kind: "methodCall", target: value, name: "reverse", arguments: [] };
      return host.reversedCopy(value, node) ?? host.helper("reversed", [value]);
    }
    case "toCharArray": {
      // Only text has toCharArray(), charAt(), and indexOf(part, start): on any other value Groovy failed, as the
      // converted text operation does, so a receiver that may be text needs no further proof.
      if (args.length !== 0 || !maybeText) return undefined;
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
      if (args.length !== 2 || !maybeText) return undefined;
      if (!onlyOf(host.valueType(args[0]!), STRING) || !onlyOf(host.valueType(args[1]!), NUMBER))
        return undefined;
      const lowered = lowerAll();
      const value = host.lower(receiver);
      if (lowered === null || value === null) return null;
      return host.helper("indexFrom", [value, lowered[0]!, lowered[1]!]);
    }
    case "charAt": {
      if (args.length !== 1 || !maybeText || !onlyOf(host.valueType(args[0]!), NUMBER))
        return undefined;
      const value = host.lower(receiver);
      const index = host.lower(args[0]!);
      if (value === null || index === null) return null;
      noteOnce(host, "SX_CHARACTER_TEXT", CHAR_AT_NOTE, node.span);
      return method(value, "substring", index, binary("+", index, literal(1)));
    }
    case "abs": {
      if (args.length !== 0 || !number) return undefined;
      const value = host.lower(receiver);
      return value === null ? null : call("abs", value);
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
  if (name === "random" && args.length === 0) return call("random");
  // TeaseScript's sqrt() and pow() give Java's results, and stop the script where Java gave NaN or Infinity (V30
  // "Numeric functions"), as ln() and exp() do. Java's sin(), cos(), and tan() took a number of radians, where
  // TeaseScript's take an angle, `x rad`; its asin(), acos(), atan(), and atan2() give an angle, which a sine passes
  // straight on; toRadians() and toDegrees() converted a number (V30 "Exponentials, logarithms, and angles").
  if ((name === "sqrt" && args.length === 1) || (name === "pow" && args.length === 2)) {
    const lowered = lowerEach(args, host);
    return lowered === null ? null : call(name, ...lowered);
  }
  const arity = MATH_FUNCTIONS.get(name);
  if (arity === undefined || args.length !== arity) return undefined;
  const lowered = lowerEach(args, host);
  if (lowered === null) return null;
  noteOnce(host, "SX_MATH_PRECISION", MATH_NOTE, node.span);
  const value = lowered[0]!;
  switch (name) {
    case "log":
      return call("ln", value);
    case "sin":
    case "cos":
    case "tan":
      return call(name, isAngle(value) ? value : { kind: "angle", value, unit: "rad" });
    case "toRadians":
      return call("toRad", { kind: "angle", value, unit: "deg" });
    case "toDegrees":
      return call("toDeg", isAngle(value) ? value : { kind: "angle", value, unit: "rad" });
    default:
      return call(name, ...lowered);
  }
}

/** The Java Math functions that TeaseScript has under its own names, by their number of arguments. */
const MATH_FUNCTIONS = new Map([
  ["log", 1],
  ["exp", 1],
  ["sin", 1],
  ["cos", 1],
  ["tan", 1],
  ["asin", 1],
  ["acos", 1],
  ["atan", 1],
  ["atan2", 2],
  ["toRadians", 1],
  ["toDegrees", 1],
]);

/** A value that is an angle already: an inverse function's result. */
function isAngle(value: IrExpression): boolean {
  return (
    value.kind === "angle" ||
    (value.kind === "call" && ["asin", "acos", "atan", "atan2"].includes(value.name))
  );
}

/** Groovy `base ** exponent`, the power that Java's Math.pow() also gives. */
export function powerOperation(node: AstNode, host: JavaRuleHost): IrExpression | null | undefined {
  if (node.operator !== "**") return undefined;
  const operands = [asNode(node.left), asNode(node.right)];
  if (operands.some((operand) => operand === null)) return undefined;
  const lowered = lowerEach(
    operands.filter((operand) => operand !== null),
    host,
  );
  return lowered === null ? null : call("pow", ...lowered);
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
      // The standard normal distribution that Java's polar method drew from.
      return args.length === 0 ? call("randomNormal", literal(0), literal(1)) : undefined;
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

/** `buffer.append(part)` and `list.add(index, value)` as statements. */
export function textStatement(
  node: AstNode,
  name: string,
  args: readonly AstNode[],
  span: SourceSpan | null,
  host: JavaRuleHost,
): IrStatement[] | null {
  const receiver = asNode(node.object);
  // Collections.sort(list) sorts the list in place, as TeaseScript sort() does.
  const owner = dottedName(receiver);
  const list = args[0];
  if (
    owner !== null &&
    COLLECTIONS_CLASSES.has(owner) &&
    !host.isVariable(owner.split(".")[0]!) &&
    name === "sort" &&
    args.length === 1 &&
    list !== undefined &&
    variableName(list) !== null
  ) {
    const type = host.valueType(list);
    if (!onlyOf(type, LIST | NULL) || (type & LIST) === 0) return null;
    if (!host.listWrite(list, node)) return [];
    const value = host.lower(list);
    if (value === null) return null;
    return [{ kind: "expression", expression: method(value, name), span }];
  }
  const variable = variableName(receiver);
  if (receiver === null || variable === null) return null;
  const target: IrExpression = { kind: "variable", name: variable };
  if (name === "append" && args.length === 1 && host.state.text.textBuffers.has(variable)) {
    const part = host.lower(args[0]!);
    if (part === null) return null;
    return [{ kind: "assign", target, operator: "=", value: concat(target, part), span }];
  }
  // list.add(index, value) inserts: a new list of the elements before, the value, and the rest.
  if (name === "add" && args.length === 2) {
    const type = host.valueType(receiver);
    if (!onlyOf(type, LIST | NULL) || (type & LIST) === 0) return null;
    if (!onlyOf(host.valueType(args[0]!), NUMBER)) return null;
    if (!host.listWrite(receiver, node)) return [];
    const index = host.lower(args[0]!);
    const value = host.lower(args[1]!);
    if (index === null || value === null) return null;
    const inserted =
      index.kind === "literal" && index.value === 0
        ? binary("+", { kind: "list", items: [value] }, target)
        : host.helper("insert", [target, index, value]);
    return [{ kind: "assign", target, operator: "=", value: inserted, span }];
  }
  return null;
}

/** `buffer[from..to] = text`: the text with that range replaced. */
export function textAssignment(
  node: AstNode,
  span: SourceSpan | null,
  host: JavaRuleHost,
): IrStatement[] | null {
  const index = asNode(node.left);
  if (node.operator !== "=" || index?.kind !== "binary" || index.operator !== "[") return null;
  const variable = variableName(index.left);
  if (variable === null || !host.state.text.textBuffers.has(variable)) return null;
  const range = asNode(index.right);
  const from = range?.kind === "range" ? asNode(range.from)?.value : undefined;
  const last = range?.kind === "range" ? asNode(range.to)?.value : undefined;
  if (typeof from !== "number" || typeof last !== "number") return null;
  const to = range?.inclusive === true ? last + 1 : last;
  const valueNode = asNode(node.right);
  const value = valueNode === null ? null : host.lower(valueNode);
  if (value === null) return null;
  const text: IrExpression = { kind: "variable", name: variable };
  const replaced: IrExpression = {
    kind: "template",
    parts: [
      { value: method(text, "substring", literal(0), literal(from)) },
      textPart(value),
      // StringBuilder.replace() ends the range at the end of the text.
      {
        value: method(
          text,
          "substring",
          call("min", literal(to), { kind: "property", target: text, name: "length" }),
        ),
      },
    ],
  };
  return [{ kind: "assign", target: text, operator: "=", value: replaced, span }];
}

/** Text joined with a part as Java's append() and `+` show it. */
function concat(text: IrExpression, part: IrExpression): IrExpression {
  return { kind: "template", parts: [{ value: text }, textPart(part)] };
}

/** A template part: literal text as text, any other value interpolated. */
function textPart(value: IrExpression): { text: string } | { value: IrExpression } {
  return value.kind === "literal" && typeof value.value === "string"
    ? { text: value.value }
    : { value };
}

/** The code of `(char) code`, with its parentheses. */
function characterCode(node: AstNode): AstNode | null {
  if (node.kind !== "cast" || (node.type !== "char" && node.type !== "Character")) return null;
  return asNode(node.value);
}

/**
 * A legacy regular expression as a TeaseScript regex literal (java-regex.ts), for a match of the whole text or a test
 * of a match anywhere; null after a TODO that says why it has none, undefined for a pattern that is no constant text.
 */
export function regexLiteral(
  node: AstNode,
  within: "whole" | "find",
  host: JavaRuleHost,
): IrExpression | null | undefined {
  const regex = convertedRegex(node, within, host);
  return regex && regex.literal;
}

/**
 * A legacy regular expression as regexLiteral() converts it, also for every match (`all`, java-regex.ts), with the
 * number of its groups and whether it can match no text.
 */
export function convertedRegex(
  node: AstNode,
  within: "whole" | "find" | "all",
  host: JavaRuleHost,
): { literal: IrExpression; groups: number; empty: boolean } | null | undefined {
  const pattern = constantString(node);
  if (pattern === null) return undefined;
  const regex = javaRegex(pattern, within);
  if ("reason" in regex) {
    host.diagnostic(
      "SX_JAVA_REGEX",
      "error",
      `Java's regular expression /${pattern}/ has no TeaseScript regex that matches the same text: it uses ${regex.reason}.`,
      node.span,
    );
    return null;
  }
  return {
    literal: { kind: "regex", pattern: regex.pattern, flags: regex.flags },
    groups: regex.groups,
    empty: regex.empty,
  };
}

/** The text Groovy matched a regular expression against: a value that may be no text as `${value}`. */
function matchedText(value: IrExpression, type: number): IrExpression {
  return onlyOf(type, STRING) ? value : { kind: "template", parts: [{ value }] };
}

/**
 * `text ==~ /pattern/`, Groovy's whole match of a regular expression: a pattern that a text matches by its end
 * (parseTailPattern) as `endsWith`, any other as a TeaseScript regex.
 */
export function textMatch(node: AstNode, host: JavaRuleHost): IrExpression | null | undefined {
  if (node.operator !== "==~") return undefined;
  const left = asNode(node.left);
  const right = asNode(node.right);
  const pattern = right === null ? null : constantString(right);
  // Groovy matched the text of the value; a value that is never text stays manual.
  const type = left === null ? 0 : host.valueType(left);
  if (left === null || right === null || pattern === null || (type & STRING) === 0)
    return undefined;
  const tail = parseTailPattern(pattern);
  if (tail !== null) {
    const value = host.lower(left);
    if (value === null) return null;
    const text = matchedText(value, type);
    return tail.insensitive
      ? method(method(text, "lowercase"), "endsWith", literal(tail.tail.toLowerCase()))
      : method(text, "endsWith", literal(tail.tail));
  }
  const regex = regexLiteral(right, "whole", host);
  if (regex === null) return null;
  const value = host.lower(left);
  return value === null ? null : method(matchedText(value, type), "matches", regex!);
}

/**
 * `text =~ /pattern/` as a condition: Groovy's Matcher was true when find() found a match anywhere in the text. A
 * literal pattern is a test for the text, any other one for a TeaseScript regex. Undefined for another node.
 */
export function textFind(node: AstNode, host: JavaRuleHost): IrExpression | null | undefined {
  if (node.kind !== "binary" || node.operator !== "=~") return undefined;
  const left = asNode(node.left);
  const right = asNode(node.right);
  const pattern = right === null ? null : constantString(right);
  const type = left === null ? 0 : host.valueType(left);
  if (left === null || right === null || pattern === null || (type & STRING) === 0)
    return undefined;
  const searched = literalPattern(pattern);
  const search = searched !== null ? literal(searched) : regexLiteral(right, "find", host);
  if (search === null) return null;
  const value = host.lower(left);
  return value === null ? null : method(matchedText(value, type), "contains", search!);
}

/** `(text =~ /pattern/).count > 0`, a count of matches above zero, as the test of a match (textFind). */
export function matchCount(node: AstNode, host: JavaRuleHost): IrExpression | null | undefined {
  if (node.operator !== ">" && node.operator !== "!=") return undefined;
  const count = asNode(node.left);
  const matcher = count?.kind === "property" ? asNode(count.object) : null;
  if (
    !isZero(asNode(node.right)) ||
    matcher === null ||
    constantString(count!.property) !== "count"
  )
    return undefined;
  return textFind(matcher, host);
}

function isZero(node: AstNode | null): boolean {
  return node?.kind === "constant" && node.value === 0;
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

/** `new ArrayList()` and `new HashSet(list)` as TeaseScript lists and sets, and text buffers as their text. */
export function textConstructor(
  node: AstNode,
  host: JavaRuleHost,
): IrExpression | null | undefined {
  const type = String(node.type);
  const args = argumentsOf(node);
  const first = args[0];
  // new String(text) copies the text; a buffer starts with its text, or empty with a capacity.
  if (STRING_CLASSES.has(type) && args.length === 1 && first !== undefined) {
    return onlyOf(host.valueType(first), STRING) ? host.lower(first) : undefined;
  }
  if (BUFFER_TYPES.has(type) && args.length <= 1) {
    if (!host.state.text.bufferValues.has(node)) return undefined;
    if (first === undefined || onlyOf(host.valueType(first), NUMBER)) return literal("");
    return onlyOf(host.valueType(first), STRING) ? host.lower(first) : undefined;
  }
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
