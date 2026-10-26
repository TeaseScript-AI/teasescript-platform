import type {
  CollectionType,
  FunctionDeclaration,
  FunctionParameter,
  GlobalStatement,
  LetStatement,
  NamedType,
  Program,
  SwitchTypeTest,
  TypeAnnotation,
  TypeTestExpression,
  UnionType,
} from "../../ast.js";
import { someNode } from "../../project-globals.js";
import type { SourceSpan } from "../../source.js";
import type { SourceSite } from "../graph.js";
import type { WrittenTypeError } from "./result.js";

/*
 * The core's check of written types (V30 §13, ADR 0021 3.4): a union never holds a whole list, set or dict beside another
 * type, wherever a type is written (a variable, a parameter, a result, and a type test, whose type is one that can follow
 * `let x:`, ADR 0021 4.1), also inside another type (a list or set element, a dict value). `null` beside a collection is
 * its optional form (`integer[] | null` is `integer[]?`) and stays allowed. The collector reads the same types into kinds
 * (`typeTerm`) and reports nothing; this check reads the written types alone, independent of the flow, so a written
 * type in code that never runs or in a function no call reaches errs too. A place keeps its written type as the collector
 * reads it, which decides the place as any written type does (TABLE A1, A4): its stores and reads are checked against it
 * as before, and the error adds nothing there.
 */

/** The type names that stand for any list, set or dict (V30 §13). */
const COLLECTION_NAMES: ReadonlySet<string> = new Set(["list", "set", "dict"]);

/** A node that holds a written type: a variable's or a parameter's declaration, a function (its result), a type test. */
type Holder =
  | LetStatement
  | GlobalStatement
  | FunctionParameter
  | FunctionDeclaration
  | TypeTestExpression
  | SwitchTypeTest;

const HOLDERS: ReadonlySet<unknown> = new Set<Holder["kind"]>([
  "letStatement",
  "globalStatement",
  "functionParameter",
  "functionDeclaration",
  "typeTestExpression",
  "switchTypeTest",
]);

/** The written types of these programs that break the rule, one error per written type, by file in source order. */
export function writtenTypeErrors(programs: readonly Program[]): WrittenTypeError[] {
  const errors: WrittenTypeError[] = [];
  for (const [file, program] of programs.entries()) {
    const found: WrittenTypeError[] = [];
    someNode(program, (node) => {
      if (!HOLDERS.has(node.kind)) return false;
      // EVIDENCE: invariant: a parser-owned node whose kind is a holder's is that holder.
      const holder = node as Holder;
      const type =
        holder.kind === "functionDeclaration"
          ? holder.returnTypeAnnotation
          : holder.kind === "typeTestExpression" || holder.kind === "switchTypeTest"
            ? holder.type
            : holder.typeAnnotation;
      const error = type === null ? null : unionError(file, type);
      if (error !== null) found.push(error);
      return false;
    });
    for (const error of found.sort((a, b) => a.site.start - b.site.start)) errors.push(error);
  }
  return errors;
}

/** The error of one written type: its first union in source order that holds a whole collection beside another type. */
function unionError(file: number, type: TypeAnnotation): WrittenTypeError | null {
  let first: UnionType | null = null;
  // the positions of the type: the whole type, and the element type of each collection in it
  const positions: TypeAnnotation[] = [type];
  for (let position = positions.pop(); position !== undefined; position = positions.pop()) {
    // the position's members through its unions and optionals (`T?` is `T | null`), and its outermost union
    let union: UnionType | null = null;
    let collections = 0;
    let others = 0;
    const members: TypeAnnotation[] = [position];
    for (let member = members.pop(); member !== undefined; member = members.pop())
      switch (member.kind) {
        case "unionType":
          union ??= member;
          for (const inner of member.members) members.push(inner);
          break;
        case "optionalType":
          members.push(member.value);
          break;
        case "namedType":
          if (COLLECTION_NAMES.has(member.name)) collections += 1;
          else if (member.name !== "null") others += 1;
          break;
        default:
          collections += 1;
          positions.push(member.element);
      }
    if (
      union !== null &&
      collections > 0 &&
      collections + others > 1 &&
      (first === null || union.span.start.offset < first.span.start.offset)
    )
      first = union;
  }
  return first === null
    ? null
    : {
        class: "compile-error",
        kind: "written-type",
        site: siteOf(file, type.span),
        union: siteOf(file, first.span),
        suggestion: suggestionFor(first),
      };
}

/**
 * V30's suggestion for a union of the form of its example `h`, `integer | string[]`: one list of a type name beside type
 * names that are no collection, not `null` and not the list's element, whose union belongs inside the list,
 * `(integer | string)[]`, the members in their written order. Any other union has none.
 */
function suggestionFor(union: UnionType): string | null {
  const members: TypeAnnotation[] = [];
  const pending: TypeAnnotation[] = [union];
  for (let next = pending.pop(); next !== undefined; next = pending.pop())
    if (next.kind === "unionType")
      for (let at = next.members.length - 1; at >= 0; at -= 1) pending.push(next.members[at]!);
    else members.push(next);
  const scalar = (type: TypeAnnotation): type is NamedType =>
    type.kind === "namedType" && !COLLECTION_NAMES.has(type.name) && type.name !== "null";
  const [list, ...more] = members.filter(
    (member): member is CollectionType => member.kind === "listType",
  );
  if (list === undefined || more.length > 0 || !scalar(list.element)) return null;
  const element = list.element.name;
  const names: string[] = [];
  for (const member of members)
    if (member === list) names.push(element);
    else if (scalar(member) && member.name !== element) names.push(member.name);
    else return null;
  return `(${names.join(" | ")})[]`;
}

function siteOf(file: number, span: SourceSpan): SourceSite {
  return { file, start: span.start.offset, end: span.end.offset };
}
