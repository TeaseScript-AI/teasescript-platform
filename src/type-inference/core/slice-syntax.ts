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

/**
 * The first construct of the files outside the slice's syntax, in source order: a statement, an expression, a written
 * type, or a name that is neither one of its file's variables nor a host value (a built-in, a speaker).
 */
export function outsideSyntax(
  files: readonly CoreFile[],
  globals: ReadonlySet<string>,
): Outside | null {
  // the keys loaded so far, each once in the project: the agreement of a key's loads is S9b's (S3 §3)
  const loaded = new Set<string>();
  for (const [file, { program }] of files.entries()) {
    const lets = letNames(program);
    const outside = (span: SourceSpan, what: string): Outside => ({ file, span, what });
    const pending: (Statement | Expression)[] = [...program.statements].reverse();
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      // children are pushed last to first, so they are visited in source order
      const push = (children: readonly (Statement | Expression | Block | null)[]): void => {
        for (let position = children.length - 1; position >= 0; position -= 1) {
          const child = children[position];
          if (child === null || child === undefined) continue;
          if (child.kind === "block")
            for (let at = child.statements.length - 1; at >= 0; at -= 1)
              pending.push(child.statements[at]!);
          else pending.push(child);
        }
      };
      switch (node.kind) {
        case "letStatement": {
          const written =
            node.typeAnnotation === null ? null : annotationOutside(node.typeAnnotation);
          if (written !== null) return outside(written.span, "this written type");
          push([node.initializer]);
          break;
        }
        case "assignmentStatement":
          if (node.operator !== "=") return outside(node.span, "this assignment");
          if (node.target.kind === "identifier") push([node.target, node.value]);
          else if (node.target.kind === "propertyAccessExpression")
            push([node.target.object, node.value]);
          else return outside(node.span, "this assignment");
          break;
        case "ifStatement":
          push([node.condition, node.thenBlock, node.elseBlock]);
          break;
        case "repeatStatement":
          push([node.count, node.body]);
          break;
        case "forStatement":
          push([node.iterable, node.body]);
          break;
        case "sayStatement":
          if (
            node.presentation !== null ||
            node.speaker !== null ||
            node.skipPolicy !== null ||
            node.pacing !== null ||
            (node.value.kind === "stringLiteral" &&
              node.value.parts.some((part) => part.kind !== "stringText"))
          )
            return outside(node.span, "this say");
          if (node.value.kind !== "stringLiteral") push([node.value]);
          break;
        case "expressionStatement":
          // (a call for what it does, such as `xs.sort()`)
          if (node.expression.kind !== "callExpression")
            return outside(node.span, "this expression statement");
          push([node.expression]);
          break;
        case "exitStatement":
        case "numberLiteral":
        case "booleanLiteral":
        case "nullLiteral":
        case "regexLiteral":
          break;
        case "stringLiteral":
          if (node.parts.some((part) => part.kind !== "stringText"))
            return outside(node.span, "text with interpolation");
          break;
        case "identifier":
          if (!lets.has(node.name) && !globals.has(node.name))
            return outside(node.span, `the name '${node.name}'`);
          break;
        case "listLiteral":
          push(node.elements);
          break;
        case "indexExpression":
          push([node.object, node.index]);
          break;
        case "rangeExpression":
          push([node.start, node.end]);
          break;
        case "parenthesizedExpression":
          push([node.expression]);
          break;
        case "objectLiteral":
          push(node.properties.map((property) => property.value));
          break;
        case "propertyAccessExpression":
          // (a member of a literal that is no object, written as the receiver: its members are S9b's, as the route
          // refuses any receiver that may be no object after the analysis, `outsideAnswers`)
          if (NOT_OBJECT_LITERALS.has(unwrapped(node.object).kind))
            return outside(node.span, "this member or element read");
          push([node.object]);
          break;
        case "binaryExpression":
          // (`otherwise`, and the narrowing's own null tests, `x != null` and `x == null`, §13.2's G: every other operator
          // is S9b's, by its own rule)
          if (node.operator !== "otherwise" && !nullTest(node))
            return outside(node.span, "this binary expression");
          push([node.left, node.right]);
          break;
        case "typeTestExpression": {
          // (`x is T` and `x is not T`, the narrowing's type test, its type a written type of the slice)
          const written = annotationOutside(node.type);
          if (written !== null) return outside(written.span, "this written type");
          push([node.value]);
          break;
        }
        case "callExpression": {
          const call = sliceCall(node);
          if (call === null) return outside(node.span, "this call expression");
          push([
            ...(node.callee.kind === "propertyAccessExpression" ? [node.callee.object] : []),
            ...node.arguments.map((argument) => argument.value),
          ]);
          break;
        }
        case "loadExpression": {
          const key = unwrapped(node.key);
          // the key as the session names it, whatever its spelling
          const name =
            key.kind === "stringLiteral" && key.parts.every((part) => part.kind === "stringText")
              ? key.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join("")
              : null;
          // (a computed key is external data, F19: no other load's key; a default written as `null` is only null, which
          // the route refuses after the analysis wherever it finds one, `outsideAnswers`: without a declared type, the
          // storage rules' error, S9b's)
          if (
            node.defaultValue === null ||
            (name !== null && loaded.has(name)) ||
            unwrapped(node.defaultValue).kind === "nullLiteral"
          )
            return outside(node.span, "this load expression");
          if (name !== null) loaded.add(name);
          push([node.key, node.defaultValue]);
          break;
        }
        default:
          return outside(node.span, `this ${describe(node.kind)}`);
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
