// What the derivation's parts share: the record's checked types, stores and content, the source's syntax as the rules
// read it, and the type helpers each part applies.

import type { Expression, Statement, TypeAnnotation } from "../../../../src/ast.js";
import { parse } from "../../../../src/parser.js";
import { VALUE_KIND_NAMES } from "../../../../src/value-kinds.js";

/*
 * The reached fixture's derivation (S6-CARRIERS revision 5; the lead's answer 3): what a record's
 * plan checks, where, and how its runs end, derived from the record and its source alone, never from the plan.
 *
 * The derivation covers the fixture's S6/S7 constructs, including objects, members, lazy defaults, conversions,
 * JSON and absent storage. Anything else throws `Underivable`, so a construct the
 * slice grows to reach fails visibly until a rule covers it. Every run it predicts is compared with the real engine.
 */

/** A record, or a part of one, outside what the rules derive. */
export class Underivable extends Error {}

/** A checked type as the plan's `TypePlan` is compared: its kinds at a path, or a collection of them. */
export type DerivedType =
  | { readonly kind: "kinds"; readonly kinds: readonly string[] }
  | { readonly kind: "list" | "set" | "dict"; readonly element: DerivedType | null }
  | {
      readonly kind: "object";
      readonly properties: readonly { readonly name: string; readonly type: DerivedType }[];
      /** A typed parse's or load's reading at or below a written `object`: every other key kept (#1223). */
      readonly keepExtra?: true;
    }
  | { readonly kind: "union"; readonly members: readonly DerivedType[] };

/** A store the plan checks: its statement's target, the statement's span, its value's span, and the type it checks. */
export interface DerivedStore {
  readonly target: string;
  readonly so: number;
  readonly eo: number;
  readonly valueSo: number;
  readonly valueEo: number;
  readonly type: DerivedType;
}

/** Where a record's obligation is discharged: by a checked store, or by the runtime itself (S3). */
export type Discharge =
  | { readonly by: "store"; readonly store: DerivedStore }
  | {
      readonly by: "native";
      readonly what:
        | "integer-use"
        | "representable"
        | "member"
        | "empty"
        | "fallback"
        | "typed-ingress"
        | "iteration"
        | "argument"
        | "operator";
      /** The obligation's site, `start:end`: the use, or the ingress. */
      readonly site: string;
    };

/** S7 content, independently owed by the source and the record, identified by its source owner. */
export interface DerivedContent {
  readonly requireExisting: readonly { readonly target: string; readonly site: string }[];
  readonly indexes: readonly string[];
  readonly fallbacks: readonly {
    readonly owner: string;
    readonly site: string;
    readonly type: DerivedType;
  }[];
  readonly expected: readonly { readonly owner: string; readonly type: DerivedType }[];
  readonly loads: readonly {
    readonly owner: string;
    readonly type: DerivedType | null;
    readonly repair: boolean;
  }[];
}

export function site(expression: { readonly span: Expression["span"] }): string {
  return `${expression.span.start.offset}:${expression.span.end.offset}`;
}

/** A checked type in full, as the candidate test writes a plan's: `integer`, `list<integer>`, `integer|string`. */
export function derivedText(type: DerivedType): string {
  if (type.kind === "kinds")
    return [...type.kinds]
      .map((kind) =>
        kind === "object" ? "{}" : ["list", "set", "dict"].includes(kind) ? `${kind}<any>` : kind,
      )
      .sort()
      .join("|");
  if (type.kind === "union") return type.members.map(derivedText).sort().join("|");
  if (type.kind === "object")
    return `{${[...type.properties.map(({ name, type }) => `${name}: ${derivedText(type)}`), ...(type.keepExtra === true ? ["..."] : [])].join(", ")}}`;
  return `${type.kind}<${type.element === null ? "any" : derivedText(type.element)}>`;
}

/** Whether a typed parse or load reads a record of this type per field: an object type, or a union with one. */
export function repairsRecord(type: DerivedType): boolean {
  return (
    type.kind === "object" ||
    (type.kind === "union" && type.members.some((member) => member.kind === "object"))
  );
}

/** A source as the rules read it: its text and its statements, parsed once for all its derivations and runs. */
export interface Syntax {
  readonly source: string;
  readonly statements: readonly Statement[];
}

/** `source`'s syntax for the rules; nothing here changes it, so each evaluation starts afresh from the same statements. */
export function syntaxOf(source: string): Syntax {
  const parsed = parse(source);
  if (parsed.diagnostics.length > 0) throw new Underivable("the source does not parse");
  return { source, statements: parsed.program.statements };
}

/** Every statement of a program, nested blocks included, in source order. */
export function allStatements(statements: readonly Statement[]): Statement[] {
  return statements.flatMap((statement) => {
    if (statement.kind === "repeatStatement" || statement.kind === "forStatement")
      return [statement, ...allStatements(statement.body.statements)];
    if (statement.kind === "ifStatement") {
      return [
        statement,
        ...allStatements(statement.thenBlock.statements),
        ...(statement.elseBlock === null
          ? []
          : allStatements(
              statement.elseBlock.kind === "ifStatement"
                ? [statement.elseBlock]
                : statement.elseBlock.statements,
            )),
      ];
    }
    return [statement];
  });
}

/** A store statement's target name and value, or `null` for any other statement. */
export function storeOf(
  statement: Statement,
): { readonly name: string; readonly value: Expression } | null {
  if (statement.kind === "letStatement")
    return { name: statement.name.name, value: statement.initializer };
  if (
    statement.kind === "assignmentStatement" &&
    statement.operator === "=" &&
    (statement.target.kind === "identifier" || statement.target.kind === "propertyAccessExpression")
  )
    return { name: targetName(statement.target), value: statement.value };
  return null;
}

export function targetName(expression: Expression): string {
  const at = unwrap(expression);
  if (at.kind === "identifier") return at.name;
  if (at.kind === "propertyAccessExpression") return `${targetName(at.object)}.${at.property.name}`;
  if (at.kind === "indexExpression" && unwrap(at.index).kind === "numberLiteral")
    return `${targetName(at.object)}[${site(unwrap(at.index))}]`;
  throw new Underivable(`a store target ${at.kind}`);
}

export function unwrap(expression: Expression): Expression {
  return expression.kind === "parenthesizedExpression" ? unwrap(expression.expression) : expression;
}

/** A value as its literal structure stands: a constant index of a list literal is the element it selects. */
export function selected(expression: Expression | null): Expression | null {
  let at = expression === null ? null : unwrap(expression);
  while (at?.kind === "indexExpression") {
    const list = unwrap(at.object);
    const index = unwrap(at.index);
    if (list.kind !== "listLiteral" || index.kind !== "numberLiteral") break;
    const element = list.elements[index.value];
    if (element === undefined) break;
    at = unwrap(element);
  }
  return at;
}

/** A place settles one family; numeric and nullable stores widen that family's admitted contract. */
export function admittedShape(types: readonly (DerivedType | null)[]): DerivedType | null {
  const flatten = (type: DerivedType | null): DerivedType[] =>
    type === null ? [] : type.kind === "union" ? type.members.flatMap(flatten) : [type];
  const parts = types.flatMap(flatten);
  const known = parts.filter(
    (part) => !(part.kind === "kinds" && part.kinds.length === VALUE_KIND_NAMES.length),
  );
  if (known.length === 0) return parts[0] ?? null;
  if (known.some((part) => part.kind === "kinds" && part.kinds.includes("null"))) {
    const nonNull = admittedShape(
      known.flatMap((part): DerivedType[] => {
        if (part.kind !== "kinds") return [part];
        const kinds = part.kinds.filter((kind) => kind !== "null");
        return kinds.length === 0 ? [] : [{ kind: "kinds", kinds }];
      }),
    );
    return nonNull === null
      ? { kind: "kinds", kinds: ["null"] }
      : unionTypes([nonNull, { kind: "kinds", kinds: ["null"] }]);
  }
  const objects = known.filter((part) => part.kind === "object");
  if (objects.length === known.length)
    return {
      kind: "object",
      properties: [
        ...new Set(objects.flatMap((part) => part.properties.map((property) => property.name))),
      ].map((name) => ({
        name,
        type: admittedShape(
          objects.flatMap((part) =>
            part.properties
              .filter((property) => property.name === name)
              .map((property) => property.type),
          ),
        )!,
      })),
    };
  const first = known[0]!;
  if (first.kind === "list" || first.kind === "set" || first.kind === "dict") {
    if (!known.every((part) => part.kind === first.kind)) return unionTypes(known);
    return {
      kind: first.kind,
      element: admittedShape(
        known.map((part) =>
          part.kind === "list" || part.kind === "set" || part.kind === "dict" ? part.element : null,
        ),
      ),
    };
  }
  if (known.every((part) => part.kind === "kinds")) {
    const kinds = [...new Set(known.flatMap((part) => part.kinds))];
    return {
      kind: "kinds",
      kinds: kinds.filter((kind) => kind !== "integer" || !kinds.includes("number")),
    };
  }
  return unionTypes(known);
}

export function partOf(type: DerivedType | null, step: string): DerivedType | null {
  if (type === null) return null;
  if (type.kind === "union") {
    const parts = type.members
      .map((member) => partOf(member, step))
      .filter((part) => part !== null);
    return parts.length === 0 ? null : unionTypes(parts);
  }
  if (type.kind === "object")
    return type.properties.find((property) => property.name === step)?.type ?? null;
  return step === "element" && type.kind !== "kinds" ? type.element : null;
}

/**
 * Every parser node at and below `node`, `span`s left out. With `nested` false a statement or block below is listed but
 * not entered: what runs when that node runs, beside what runs later or elsewhere.
 */
export function nodesIn(node: unknown, nested: boolean, top = true): (Statement | Expression)[] {
  if (Array.isArray(node)) return node.flatMap((each) => nodesIn(each, nested, top));
  if (node === null || typeof node !== "object" || !("kind" in node)) return [];
  const kind = node.kind;
  if (typeof kind !== "string") return [];
  // EVIDENCE: invariant: every node listed is a parser node, each read below only by a kind it is first checked to have.
  const found: (Statement | Expression)[] = [node as Statement | Expression];
  if (!top && !nested && (kind === "block" || kind.endsWith("Statement"))) return found;
  for (const [key, value] of Object.entries(node))
    if (key !== "span") found.push(...nodesIn(value, nested, false));
  return found;
}

/** Whether a node is a statement or a block (`nodesIn`). */
export function isBlockOrStatement(node: Statement | Expression): boolean {
  const kind: string = node.kind;
  return kind === "block" || kind.endsWith("Statement");
}

export function unionTypes(types: readonly DerivedType[]): DerivedType {
  const unique = new Map(types.map((type) => [derivedText(type), type]));
  const members = [...unique.values()];
  return members.length === 1 ? members[0]! : { kind: "union", members };
}

export function writtenType(annotation: TypeAnnotation): DerivedType {
  switch (annotation.kind) {
    case "namedType":
      return annotation.name === "object"
        ? { kind: "object", properties: [] }
        : annotation.name === "list" || annotation.name === "set" || annotation.name === "dict"
          ? { kind: annotation.name, element: null }
          : { kind: "kinds", kinds: [annotation.name] };
    case "optionalType":
      return unionTypes([writtenType(annotation.value), { kind: "kinds", kinds: ["null"] }]);
    case "unionType":
      return unionTypes(annotation.members.map(writtenType));
    default:
      return {
        kind:
          annotation.kind === "listType" ? "list" : annotation.kind === "setType" ? "set" : "dict",
        element: writtenType(annotation.element),
      };
  }
}

export function withoutNull(type: DerivedType): DerivedType | null {
  if (type.kind === "kinds") {
    const kinds = type.kinds.filter((kind) => kind !== "null");
    return kinds.length === 0 ? null : { kind: "kinds", kinds };
  }
  if (type.kind !== "union") return type;
  const members = type.members.map(withoutNull).filter((member) => member !== null);
  return members.length === 0 ? null : unionTypes(members);
}

export type DefaultOwner = Extract<
  Expression,
  { kind: "binaryExpression" | "callExpression" | "loadExpression" }
>;
export function fallbackOf(owner: Expression): Expression | null {
  if (owner.kind === "binaryExpression" && owner.operator === "otherwise") return owner.right;
  if (owner.kind === "loadExpression") return owner.defaultValue;
  if (owner.kind === "callExpression")
    return (
      owner.arguments.find(
        (argument) => argument.kind === "namedArgument" && argument.name.name === "default",
      )?.value ?? null
    );
  return null;
}

/** The expressions of a program, in source order. */
export function expressions(statements: readonly Statement[]): Expression[] {
  const out: Expression[] = [];
  const walk = (expression: Expression): void => {
    out.push(expression);
    if (expression.kind === "listLiteral" || expression.kind === "setLiteral")
      expression.elements.forEach(walk);
    else if (expression.kind === "objectLiteral")
      expression.properties.forEach((property) => walk(property.value));
    else if (expression.kind === "propertyAccessExpression") walk(expression.object);
    else if (expression.kind === "binaryExpression") {
      walk(expression.left);
      walk(expression.right);
    } else if (expression.kind === "callExpression") {
      walk(expression.callee);
      expression.arguments.forEach((argument) => walk(argument.value));
    } else if (expression.kind === "loadExpression") {
      walk(expression.key);
      if (expression.defaultValue !== null) walk(expression.defaultValue);
    } else if (expression.kind === "parenthesizedExpression") walk(expression.expression);
    else if (expression.kind === "unaryExpression") walk(expression.operand);
    else if (expression.kind === "indexExpression") {
      walk(expression.object);
      walk(expression.index);
    }
  };
  for (const statement of allStatements(statements)) {
    const store = storeOf(statement);
    if (store !== null) {
      if (
        statement.kind === "assignmentStatement" &&
        statement.target.kind === "propertyAccessExpression"
      )
        walk(statement.target.object);
      walk(store.value);
    } else if (statement.kind === "repeatStatement") walk(statement.count);
    else if (statement.kind === "ifStatement") walk(statement.condition);
    else if (statement.kind === "sayStatement") walk(statement.value);
    else if (statement.kind === "expressionStatement") walk(statement.expression);
    else if (statement.kind === "forStatement") walk(statement.iterable);
    else if (statement.kind === "gotoStatement" && statement.target.kind === "scriptTarget")
      walk(statement.target.expression);
  }
  return out;
}
