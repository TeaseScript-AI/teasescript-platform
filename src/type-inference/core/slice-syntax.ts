import type {
  Block,
  CallExpression,
  Expression,
  Program,
  Statement,
  TypeAnnotation,
} from "../../ast.js";
import { CONVERSIONS, isConversion, type Conversion } from "../../conversions.js";
import { dictMethod } from "../../dict-operations.js";
import { listMethod } from "../../list-methods.js";
import { isTextMethod, TEXT_METHODS } from "../../text-operations.js";
import type { SourceSpan } from "../../source.js";
import { SLICE_DEPTH } from "./contract-descriptors.js";
import { methodCategory } from "./method-categories.js";
import type { CoreFile } from "./program.js";

/*
 * The candidate slice's syntax (the port plan's S5, `backend.ts`'s module comment): whether a program is inside it is a
 * property of the slice, read by the candidate route before its analysis (`CORE_BACKEND`) and by the analysis's capture
 * of the stores' contracts (#1526 phase B, `Consumers`), so both decide alike from one walk. A pure walk of the syntax:
 * it reads no answer of the analysis.
 */

/** A construct outside the slice: where it stands and what it is. */
export interface Outside {
  readonly file: number;
  readonly span: SourceSpan;
  readonly what: string;
}

// ------------------------------------------------------------------------------------------------- the syntax

/** The written types of the slice: named types, `T?` and `T[]` of them. */
function annotationOutside(annotation: TypeAnnotation): TypeAnnotation | null {
  const pending: [TypeAnnotation, number][] = [[annotation, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [type, depth] = next;
    switch (type.kind) {
      case "namedType":
        break;
      case "optionalType":
        pending.push([type.value, depth]);
        break;
      case "listType":
        // a list at the facts' deepest depth (`SLICE_DEPTH`)
        if (depth + 1 >= SLICE_DEPTH) return type;
        pending.push([type.element, depth + 1]);
        break;
      default:
        return type;
    }
  }
  return null;
}

/** An AST kind: a row of the route's syntax table (`DISPOSITIONS`). */
export type SyntaxKind = Statement["kind"] | Expression["kind"];

type NodeOfKind<K extends SyntaxKind> = Extract<Statement | Expression, { readonly kind: K }>;

/** What the walk knows beside a node: its file's `let` names, the host values, and the keys loaded so far. */
interface SyntaxWalk {
  readonly lets: ReadonlySet<string>;
  readonly globals: ReadonlySet<string>;
  /** Each key loaded so far, once in the project: the agreement of a key's loads is S9b's (S3 §3). */
  readonly loaded: Set<string>;
}

/** What a modelled row does at a node: the children walked after it, in source order, or its refusal there. */
type Visit =
  | { readonly walk: readonly (Statement | Expression | Block | null)[] }
  | { readonly refuse: { readonly span: SourceSpan; readonly what: string } };

/**
 * A row of the table: `refused`, a construct outside the slice, refused at its span as `this <kind in words>`; or
 * `modelled`, a construct of the slice, with the conditions under which it is, which its `visit` checks.
 */
type Disposition<K extends SyntaxKind> =
  | { readonly row: "refused" }
  | { readonly row: "modelled"; readonly visit: (node: NodeOfKind<K>, walk: SyntaxWalk) => Visit };

const REFUSED = { row: "refused" } as const;
const walk = (...children: (Statement | Expression | Block | null)[]): Visit => ({
  walk: children,
});
const refuse = (span: SourceSpan, what: string): Visit => ({ refuse: { span, what } });
/** A construct of the slice under no condition of its own, with these children. */
const modelled = <K extends SyntaxKind>(
  children: (node: NodeOfKind<K>) => (Statement | Expression | Block | null)[] = () => [],
): Disposition<K> => ({ row: "modelled", visit: (node) => walk(...children(node)) });

/**
 * The route's syntax table: a row for every AST kind (a kind without one, or a row for no kind, fails the build), so a
 * new construct is refused by its row, never by a default, and opening one is a change of its row.
 */
export const DISPOSITIONS: { readonly [K in SyntaxKind]: Disposition<K> } = {
  // ------------------------------------------------------------------------------------------- statements
  speakerDeclaration: REFUSED,
  speakerSetterStatement: REFUSED,
  sayStatement: {
    row: "modelled",
    visit: (node) =>
      node.presentation !== null ||
      node.speaker !== null ||
      node.skipPolicy !== null ||
      node.pacing !== null ||
      (node.value.kind === "stringLiteral" &&
        node.value.parts.some((part) => part.kind !== "stringText"))
        ? refuse(node.span, "this say")
        : node.value.kind === "stringLiteral"
          ? walk()
          : walk(node.value),
  },
  showButtonStatement: REFUSED,
  waitStatement: REFUSED,
  timerStatement: REFUSED,
  showImageStatement: REFUSED,
  hideImageStatement: REFUSED,
  showCameraStatement: REFUSED,
  hideCameraStatement: REFUSED,
  showPopupStatement: REFUSED,
  openUrlStatement: REFUSED,
  exportTextStatement: REFUSED,
  showPermanentButtonStatement: REFUSED,
  playMediaStatement: REFUSED,
  stopAudioStatement: REFUSED,
  saveStatement: REFUSED,
  deleteStatement: REFUSED,
  exitStatement: modelled(),
  endStatement: REFUSED,
  labelStatement: REFUSED,
  gotoStatement: REFUSED,
  callFileStatement: REFUSED,
  letStatement: {
    row: "modelled",
    visit: (node) => {
      const written = node.typeAnnotation === null ? null : annotationOutside(node.typeAnnotation);
      return written !== null ? refuse(written.span, "this written type") : walk(node.initializer);
    },
  },
  globalStatement: REFUSED,
  assignmentStatement: {
    row: "modelled",
    visit: (node) =>
      node.operator !== "="
        ? refuse(node.span, "this assignment")
        : node.target.kind === "identifier"
          ? walk(node.target, node.value)
          : node.target.kind === "propertyAccessExpression"
            ? walk(node.target.object, node.value)
            : refuse(node.span, "this assignment"),
  },
  ifStatement: modelled((node) => [node.condition, node.thenBlock, node.elseBlock]),
  switchStatement: REFUSED,
  repeatStatement: modelled((node) => [node.count, node.body]),
  forStatement: modelled((node) => [node.iterable, node.body]),
  whileStatement: REFUSED,
  breakStatement: REFUSED,
  continueStatement: REFUSED,
  functionDeclaration: REFUSED,
  returnStatement: REFUSED,
  expressionStatement: {
    row: "modelled",
    // (a call for what it does, such as `xs.sort()`)
    visit: (node) =>
      node.expression.kind === "callExpression"
        ? walk(node.expression)
        : refuse(node.span, "this expression statement"),
  },
  // ------------------------------------------------------------------------------------------- expressions
  identifier: {
    row: "modelled",
    visit: (node, { lets, globals }) =>
      lets.has(node.name) || globals.has(node.name)
        ? walk()
        : refuse(node.span, `the name '${node.name}'`),
  },
  booleanLiteral: modelled(),
  nullLiteral: modelled(),
  numberLiteral: modelled(),
  durationLiteral: REFUSED,
  unitExpression: REFUSED,
  angleExpression: REFUSED,
  stringLiteral: {
    row: "modelled",
    visit: (node) =>
      node.parts.some((part) => part.kind !== "stringText")
        ? refuse(node.span, "text with interpolation")
        : walk(),
  },
  regexLiteral: modelled(),
  listLiteral: modelled((node) => [...node.elements]),
  objectLiteral: modelled((node) => node.properties.map((property) => property.value)),
  setLiteral: REFUSED,
  dictLiteral: REFUSED,
  parenthesizedExpression: modelled((node) => [node.expression]),
  propertyAccessExpression: {
    row: "modelled",
    // (a member of a literal that is no object, written as the receiver: its members are S9b's, as the route refuses any
    // receiver that may be no object after the analysis, `outsideAnswers`)
    visit: (node) =>
      NOT_OBJECT_LITERALS.has(unwrapped(node.object).kind)
        ? refuse(node.span, "this member or element read")
        : walk(node.object),
  },
  indexExpression: modelled((node) => [node.object, node.index]),
  callExpression: {
    row: "modelled",
    visit: (node) =>
      sliceCall(node) === null
        ? refuse(node.span, "this call expression")
        : walk(
            ...(node.callee.kind === "propertyAccessExpression" ? [node.callee.object] : []),
            ...node.arguments.map((argument) => argument.value),
          ),
  },
  unaryExpression: REFUSED,
  binaryExpression: {
    row: "modelled",
    // (`otherwise`, and the narrowing's own null tests, `x != null` and `x == null`, §13.2's G: every other operator is
    // S9b's, by its own rule)
    visit: (node) =>
      node.operator !== "otherwise" && !nullTest(node)
        ? refuse(node.span, "this binary expression")
        : walk(node.left, node.right),
  },
  rangeExpression: modelled((node) => [node.start, node.end]),
  interactionExpression: REFUSED,
  sayExpression: REFUSED,
  showButtonExpression: REFUSED,
  showPopupExpression: REFUSED,
  timerExpression: REFUSED,
  playMediaExpression: REFUSED,
  showCameraExpression: REFUSED,
  showPermanentButtonExpression: REFUSED,
  loadExpression: {
    row: "modelled",
    visit: (node, { loaded }) => {
      const key = unwrapped(node.key);
      // the key as the session names it, whatever its spelling
      const name =
        key.kind === "stringLiteral" && key.parts.every((part) => part.kind === "stringText")
          ? key.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join("")
          : null;
      // (a computed key is external data, F19: no other load's key; a default written as `null` is only null, which the
      // route refuses after the analysis wherever it finds one, `outsideAnswers`: without a declared type, the storage
      // rules' error, S9b's)
      if (
        node.defaultValue === null ||
        (name !== null && loaded.has(name)) ||
        unwrapped(node.defaultValue).kind === "nullLiteral"
      )
        return refuse(node.span, "this load expression");
      if (name !== null) loaded.add(name);
      return walk(node.key, node.defaultValue);
    },
  },
  tagQueryExpression: REFUSED,
  typeTestExpression: {
    row: "modelled",
    // (`x is T` and `x is not T`, the narrowing's type test, its type a written type of the slice)
    visit: (node) => {
      const written = annotationOutside(node.type);
      return written !== null ? refuse(written.span, "this written type") : walk(node.value);
    },
  },
};

/**
 * The first construct of the files outside the slice's syntax, in source order: a statement, an expression, a written
 * type, or a name that is neither one of its file's variables nor a host value (a built-in, a speaker). Each node is
 * judged by its row of `DISPOSITIONS`, then its children, so an open construct holding a closed one is refused at the
 * closed one.
 */
export function outsideSyntax(
  files: readonly CoreFile[],
  globals: ReadonlySet<string>,
): Outside | null {
  const loaded = new Set<string>();
  for (const [file, { program }] of files.entries()) {
    const context: SyntaxWalk = { lets: letNames(program), globals, loaded };
    const pending: (Statement | Expression)[] = [...program.statements].reverse();
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      // EVIDENCE: invariant: a node's row is the row of its own kind, so its `visit` takes that node.
      const row = DISPOSITIONS[node.kind] as Disposition<SyntaxKind>;
      if (row.row === "refused")
        return { file, span: node.span, what: `this ${describe(node.kind)}` };
      const visit = row.visit(node, context);
      if ("refuse" in visit) return { file, ...visit.refuse };
      // children are pushed last to first, so they are visited in source order
      for (let position = visit.walk.length - 1; position >= 0; position -= 1) {
        const child = visit.walk[position];
        if (child === null || child === undefined) continue;
        if (child.kind === "block")
          for (let at = child.statements.length - 1; at >= 0; at -= 1)
            pending.push(child.statements[at]!);
        else pending.push(child);
      }
    }
  }
  return null;
}

/** Whether a comparison is a null test, `x != null` or `x == null` (either side the `null`). */
function nullTest(node: Extract<Expression, { kind: "binaryExpression" }>): boolean {
  return (
    (node.operator === "!=" || node.operator === "==") &&
    (unwrapped(node.left).kind === "nullLiteral" || unwrapped(node.right).kind === "nullLiteral")
  );
}

/** The slice's literals that are no object (`outsideSyntax`'s literal cases). */
const NOT_OBJECT_LITERALS: ReadonlySet<Expression["kind"]> = new Set([
  "numberLiteral",
  "booleanLiteral",
  "nullLiteral",
  "regexLiteral",
  "stringLiteral",
  "listLiteral",
]);

function unwrapped(expression: Expression): Expression {
  let current = expression;
  while (current.kind === "parenthesizedExpression") current = current.expression;
  return current;
}

/** The calls of the slice, by what each is (see the module's comment); `null` for any other call. */
type SliceCall =
  "get" | "conversion" | "fromJson" | "fileFromBase64" | "decrypt" | "method" | "toJson";

/**
 * A method of text, a list, a set or a dict that changes nothing in its receiver, and a list's `sort`, called with as
 * many positional arguments as one of its contracts takes and no named one: the methods whose arguments and elements C13
 * checks (`signatures.ts`); a call's shape is the argument rules' (TSV020, S9b). A method that adds to its receiver
 * stores its argument, whose check has no place in the plan yet; one that removes, reorders or copies the receiver's
 * elements is the slice's when the runs the route's tests derive follow it.
 */
function sliceMethod(call: CallExpression): boolean {
  if (call.callee.kind !== "propertyAccessExpression") return false;
  const name = call.callee.property.name;
  if (call.arguments.some((argument) => argument.kind === "namedArgument")) return false;
  const list = listMethod(name);
  const dict = dictMethod(name);
  if ((list?.changes !== undefined && name !== "sort") || dict?.changes !== undefined) return false;
  // (a copy of the receiver's elements carries them, F10, which the runs the route's tests derive do not follow yet)
  if (methodCategory(name)?.gives.kind === "copy") return false;
  const parameters = [
    isTextMethod(name) ? TEXT_METHODS[name].parameters : null,
    list === undefined || list.named !== undefined ? null : list.parameters,
    dict === undefined || dict.named !== undefined ? null : dict.parameters,
  ];
  return parameters.some(
    (taken) =>
      taken !== null &&
      call.arguments.length <= taken.length &&
      call.arguments.length >=
        taken.filter((parameter) => !("optional" in parameter && parameter.optional === true))
          .length,
  );
}

/**
 * A call of the slice: a list's `get` with an index and its `default:`; a conversion of a value with its `default:`;
 * `fromJson` with its text, `default:` and maybe `files: false`; `fileFromBase64` with its text and `default:`;
 * `decryptText` or `decryptFile` with its value, `default:` and `password:` or `key:`. Any other is `null`.
 */
export function sliceCall(call: CallExpression): SliceCall | null {
  const positional = call.arguments.filter((argument) => argument.kind === "positionalArgument");
  const named = new Map(
    call.arguments.flatMap((argument) =>
      argument.kind === "namedArgument" ? [[argument.name.name, argument.value] as const] : [],
    ),
  );
  if (call.callee.kind === "propertyAccessExpression" && call.callee.property.name !== "get")
    return sliceMethod(call) ? "method" : null;
  // `toJson` of a value, whose files the slice writes as their text (C13: what it writes, `signatures.ts`)
  if (call.callee.kind === "identifier" && call.callee.name === "toJson")
    return positional.length === 1 && named.size === 0 ? "toJson" : null;
  if (positional.length !== 1 || !named.has("default")) return null;
  const others = [...named.keys()].filter((name) => name !== "default");
  if (call.callee.kind === "propertyAccessExpression") return others.length === 0 ? "get" : null;
  if (call.callee.kind !== "identifier") return null;
  const name = call.callee.name;
  if (name === "fromJson") {
    const files = named.get("files");
    return others.every((other) => other === "files") &&
      (files === undefined || (files.kind === "booleanLiteral" && !files.value))
      ? "fromJson"
      : null;
  }
  if (name === "fileFromBase64") return others.length === 0 ? "fileFromBase64" : null;
  if (name === "decryptText" || name === "decryptFile")
    return others.length === 1 && (others[0] === "password" || others[0] === "key")
      ? "decrypt"
      : null;
  if (!isConversion(name)) return null;
  const conversion: Conversion = CONVERSIONS[name];
  return conversion.takes === "value" && conversion.kinds !== "shown" && others.length === 0
    ? "conversion"
    : null;
}

/** A node kind in words: `ifStatement` is "if statement". */
function describe(kind: string): string {
  return kind.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}

/** The names a file's `let` statements and `for` loops declare, at any depth. */
function letNames(program: Program): Set<string> {
  const names = new Set<string>();
  const pending: (readonly Statement[])[] = [program.statements];
  for (let list = pending.pop(); list !== undefined; list = pending.pop())
    for (const statement of list)
      switch (statement.kind) {
        case "letStatement":
          names.add(statement.name.name);
          break;
        case "ifStatement":
          pending.push(statement.thenBlock.statements);
          if (statement.elseBlock !== null)
            pending.push(
              statement.elseBlock.kind === "block"
                ? statement.elseBlock.statements
                : [statement.elseBlock],
            );
          break;
        case "repeatStatement":
          pending.push(statement.body.statements);
          break;
        case "forStatement":
          names.add(statement.variable.name);
          if (statement.valueVariable !== null) names.add(statement.valueVariable.name);
          pending.push(statement.body.statements);
          break;
      }
  return names;
}
