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

/** A position of a written type: its outermost union, and its members through its unions and `?` besides `null`. */
interface Level {
  readonly position: TypeAnnotation;
  readonly union: UnionType | null;
  readonly members: readonly (NamedType | CollectionType)[];
  /** Whether `null` is a member: written, or by a `?` (`T?` is `T | null`). */
  readonly nullable: boolean;
}

function levelOf(position: TypeAnnotation): Level {
  let union: UnionType | null = null;
  let nullable = false;
  const members: (NamedType | CollectionType)[] = [];
  const pending: TypeAnnotation[] = [position];
  for (let member = pending.pop(); member !== undefined; member = pending.pop())
    switch (member.kind) {
      case "unionType":
        union ??= member;
        for (const inner of member.members) pending.push(inner);
        break;
      case "optionalType":
        nullable = true;
        pending.push(member.value);
        break;
      case "namedType":
        if (member.name === "null") nullable = true;
        else members.push(member);
        break;
      default:
        members.push(member);
    }
  return { position, union, members, nullable };
}

/**
 * The error of one written type: its first union in source order that holds a whole collection beside another type.
 * The same type written twice is one type, so `integer[] | integer[]` and `integer[]? | integer[]` hold one collection.
 */
function unionError(file: number, type: TypeAnnotation): WrittenTypeError | null {
  // the positions of the type, each before its parts: the whole type, and the element type of each collection in it
  const levels: Level[] = [];
  const pending: TypeAnnotation[] = [type];
  for (let position = pending.pop(); position !== undefined; position = pending.pop()) {
    const level = levelOf(position);
    levels.push(level);
    for (const member of level.members)
      if (member.kind !== "namedType") pending.push(member.element);
  }
  // each position's type as a number, its parts' first: one per distinct text of its members' sorted keys and `null`,
  // where a collection's key holds its element's number, so a key stays as short as its level (the work: the walk, and
  // a sort of each level's distinct keys)
  const types = new Map<string, number>();
  const typeOf = new Map<TypeAnnotation, number>();
  let first: UnionType | null = null;
  for (let at = levels.length - 1; at >= 0; at -= 1) {
    const { position, union, members, nullable } = levels[at]!;
    const distinct = new Set(
      members.map((member) =>
        member.kind === "namedType" ? member.name : `${member.kind} ${typeOf.get(member.element)}`,
      ),
    );
    const text = [...distinct, ...(nullable ? ["null"] : [])].sort().join(" | ");
    let known = types.get(text);
    if (known === undefined) types.set(text, (known = types.size));
    typeOf.set(position, known);
    if (
      union !== null &&
      distinct.size > 1 &&
      members.some((member) => member.kind !== "namedType" || COLLECTION_NAMES.has(member.name)) &&
      (first === null || union.span.start.offset < first.span.start.offset)
    )
      first = union;
  }
  return first === null
    ? null
    : {
        class: "compile-error",
        kind: "written-type",
        code: "TSV075",
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
