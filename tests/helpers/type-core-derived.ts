import type { Expression, Statement, TypeAnnotation } from "../../src/ast.js";
import {
  booleanFromText,
  CONVERSIONS,
  isConversion,
  numberFromText,
} from "../../src/conversions.js";
import { escapeMarkup } from "../../src/message-markup.js";
import { listMethod, listProperty } from "../../src/list-methods.js";
import { parse } from "../../src/parser.js";
import { VALUE_KIND_NAMES } from "../../src/value-kinds.js";
import {
  DEFAULT_TEMPORAL_CONTEXT,
  formatIsoDate,
  formatIsoDateTime,
  formatIsoTime,
  formatIsoTimestamp,
  localFields,
  parseIsoDate,
  parseIsoDateTime,
  parseIsoTime,
  parseIsoTimestamp,
  presentDate,
  presentDateTime,
  presentTime,
} from "../../src/temporal.js";
import { binaryFromBase64, binaryFromDataUrl } from "../../src/runtime/host-data/stored-files.js";
import { RuntimeFault } from "../../src/runtime/errors.js";
import { jsonText } from "../../src/runtime/values/json-base64.js";
import { readCollection, sortOrder } from "../../src/runtime/values/collection-operations.js";
import { callStringMethod } from "../../src/runtime/values/string-operations.js";
import {
  isDict,
  isList as isRuntimeList,
  isRange,
  isSet,
  isTemporal,
} from "../../src/runtime/values/value-predicates.js";
import { joinedText } from "../../src/runtime/values/value-text.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import type { CompactRecord } from "./type-core-records.js";

/*
 * The reached fixture's derivation (S6-CARRIERS revision 5, §5.2; TABLE r4.59; the lead's answer 3): what a record's
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

/** Where a record's obligation is discharged: by a checked store, or by the runtime itself (S3 §4). */
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
        | "argument";
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

function site(expression: { readonly span: Expression["span"] }): string {
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
function allStatements(statements: readonly Statement[]): Statement[] {
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
function storeOf(
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

function targetName(expression: Expression): string {
  const at = unwrap(expression);
  if (at.kind === "identifier") return at.name;
  if (at.kind === "propertyAccessExpression") return `${targetName(at.object)}.${at.property.name}`;
  if (at.kind === "indexExpression" && unwrap(at.index).kind === "numberLiteral")
    return `${targetName(at.object)}[${site(unwrap(at.index))}]`;
  throw new Underivable(`a store target ${at.kind}`);
}

function unwrap(expression: Expression): Expression {
  return expression.kind === "parenthesizedExpression" ? unwrap(expression.expression) : expression;
}

/** A value as its literal structure stands: a constant index of a list literal is the element it selects. */
function selected(expression: Expression | null): Expression | null {
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

/** Source structure carried by a selection: unknown operands contribute no settled structure. */
function sourceShape(
  expression: Expression,
  statements: readonly Statement[],
  seen = new Set<string>(),
): DerivedType | null {
  const at = unwrap(expression);
  const combine = (values: readonly (DerivedType | null)[]): DerivedType | null => {
    const known = values.filter((type) => type !== null);
    return known.length === 0 ? null : unionTypes(known);
  };
  switch (at.kind) {
    case "listLiteral":
    case "setLiteral":
      return {
        kind: at.kind === "listLiteral" ? "list" : "set",
        element: combine(at.elements.map((element) => sourceShape(element, statements, seen))),
      };
    case "objectLiteral":
      return {
        kind: "object",
        properties: at.properties.map((property) => ({
          name: property.name.name,
          type: sourceShape(property.value, statements, seen) ?? {
            kind: "kinds",
            kinds: VALUE_KIND_NAMES,
          },
        })),
      };
    case "identifier": {
      if (seen.has(at.name)) return null;
      const next = new Set([...seen, at.name]);
      const written = statements.find(
        (statement) =>
          statement.kind === "letStatement" &&
          statement.name.name === at.name &&
          statement.typeAnnotation !== null,
      );
      if (written?.kind === "letStatement" && written.typeAnnotation !== null)
        return writtenType(written.typeAnnotation);
      let shape = admittedShape(
        statements.flatMap((statement) => {
          const store = storeOf(statement);
          return store?.name === at.name ? [sourceShape(store.value, statements, next)] : [];
        }),
      );
      for (const statement of statements) {
        const store = storeOf(statement);
        if (store?.name.startsWith(`${at.name}.`))
          shape = updatedShape(
            shape,
            store.name.slice(at.name.length + 1).split("."),
            sourceShape(store.value, statements, next),
          );
      }
      return settledShape(shape);
    }
    case "propertyAccessExpression":
      return partOf(sourceShape(at.object, statements, seen), at.property.name);
    case "indexExpression":
      return partOf(sourceShape(at.object, statements, seen), "element");
    case "binaryExpression":
      return at.operator === "otherwise"
        ? combine([sourceShape(at.left, statements, seen), sourceShape(at.right, statements, seen)])
        : null;
    case "callExpression": {
      const callee = unwrap(at.callee);
      if (callee.kind === "identifier" && callee.name === "fromJson")
        return admittedShape([
          expectedType(at, statements, seen),
          fallbackOf(at) === null ? null : sourceShape(fallbackOf(at)!, statements, seen),
        ]);
      if (callee.kind === "propertyAccessExpression" && callee.property.name === "get")
        return combine([
          partOf(sourceShape(callee.object, statements, seen), "element"),
          fallbackOf(at) === null ? null : sourceShape(fallbackOf(at)!, statements, seen),
        ]);
      return fallbackOf(at) === null ? null : sourceShape(fallbackOf(at)!, statements, seen);
    }
    case "loadExpression":
      return admittedShape([
        expectedType(at, statements, seen),
        at.defaultValue === null ? null : sourceShape(at.defaultValue, statements, seen),
      ]);
    case "nullLiteral":
      return { kind: "kinds", kinds: ["null"] };
    default:
      return literalType(at, statements);
  }
}

/** A place settles one family; numeric and nullable stores widen that family's admitted contract. */
function admittedShape(types: readonly (DerivedType | null)[]): DerivedType | null {
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

/** Null-only and unknown object fields settle no contract; retain null once another source settles their type. */
function settledShape(type: DerivedType | null): DerivedType | null {
  if (type === null || type.kind === "kinds") return type;
  if (type.kind === "union") return unionTypes(type.members.map((member) => settledShape(member)!));
  if (type.kind === "object")
    return {
      kind: "object",
      properties: type.properties
        .filter(
          (property) =>
            !(
              property.type.kind === "kinds" &&
              (property.type.kinds.length === VALUE_KIND_NAMES.length ||
                property.type.kinds.every((kind) => kind === "null"))
            ),
        )
        .map((property) => ({ name: property.name, type: settledShape(property.type)! })),
    };
  return { kind: type.kind, element: settledShape(type.element) };
}

function updatedShape(
  type: DerivedType | null,
  path: readonly string[],
  value: DerivedType | null,
): DerivedType | null {
  if (path.length === 0) return admittedShape([type, value]);
  if (type?.kind === "union")
    return admittedShape(type.members.map((member) => updatedShape(member, path, value)));
  if (type?.kind !== "object") return type;
  return {
    kind: "object",
    properties: type.properties.map((property) => ({
      name: property.name,
      type:
        property.name === path[0]
          ? updatedShape(property.type, path.slice(1), value)!
          : property.type,
    })),
  };
}

function partOf(type: DerivedType | null, step: string): DerivedType | null {
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

function structureAt(
  statement: Statement,
  value: Expression,
  path: readonly string[],
  statements: readonly Statement[],
): DerivedType | null {
  let type =
    statement.kind === "letStatement" && statement.typeAnnotation !== null
      ? writtenType(statement.typeAnnotation)
      : (sourceShape(
          statement.kind === "letStatement"
            ? statement.name
            : statement.kind === "assignmentStatement"
              ? statement.target
              : value,
          statements,
        ) ?? sourceShape(value, statements));
  for (const step of path) type = partOf(type, step);
  return type;
}

/**
 * S3 §4's lowering of a store's checks by rule: the destination's structure at each target path (its written type,
 * else its value's literal structure), with the record's required kinds at each, `null` kept.
 */
function typeOf(
  statement: Statement,
  value: Expression,
  checks: readonly { readonly path: readonly string[]; readonly against: readonly string[] }[],
  depth = 0,
  statements: readonly Statement[] = [],
): DerivedType {
  const here = checks.filter((check) => check.path.length === depth);
  const below = checks.filter((check) => check.path.length > depth);
  if (below.length === 0) {
    // S6: these describe one destination's admitted contract; C9 also carries its admitted null.
    const kinds = [...new Set(here.flatMap((check) => check.against))];
    const structure = structureAt(statement, value, checks[0]?.path ?? [], statements);
    const members = kinds.map((kind): DerivedType => {
      const candidates =
        structure?.kind === "union" ? structure.members : structure === null ? [] : [structure];
      return candidates.find((part) => part.kind === kind) ?? { kind: "kinds", kinds: [kind] };
    });
    return unionTypes(members);
  }
  if (below.some((check) => check.path[depth] !== "element")) {
    if (below.some((check) => check.path[depth] === "element"))
      throw new Underivable("a collection and properties at one path");
    const shape = structureAt(statement, value, below[0]!.path.slice(0, depth), statements);
    const object =
      shape?.kind === "union" ? shape.members.find((part) => part.kind === "object") : shape;
    const properties = object?.kind === "object" ? object.properties : [];
    return structuredType(
      {
        kind: "object",
        properties: [
          ...new Set([
            ...properties.map((property) => property.name),
            ...below.map((check) => check.path[depth]!),
          ]),
        ].map((name) => ({
          name,
          type: below.some((check) => check.path[depth] === name)
            ? typeOf(
                statement,
                value,
                below.filter((check) => check.path[depth] === name),
                depth + 1,
                statements,
              )
            : properties.find((property) => property.name === name)!.type,
        })),
      },
      here,
    );
  }
  const structure = structureAt(statement, value, below[0]!.path.slice(0, depth), statements);
  const collection =
    structure?.kind === "union"
      ? structure.members.find(
          (part) => part.kind === "list" || part.kind === "set" || part.kind === "dict",
        )
      : structure;
  if (collection?.kind !== "list" && collection?.kind !== "set" && collection?.kind !== "dict")
    throw new Underivable("an element step without a written or source-carried collection");
  return structuredType(
    { kind: collection.kind, element: typeOf(statement, value, below, depth + 1, statements) },
    here,
  );
}

function structuredType(
  type: DerivedType & { readonly kind: "object" | "list" | "set" | "dict" },
  checks: readonly { readonly against: readonly string[] }[],
): DerivedType {
  const kinds = [...new Set(checks.flatMap((check) => check.against))];
  if (kinds.length > 0 && !kinds.includes(type.kind))
    throw new Underivable("a structural check with an incompatible root kind");
  return unionTypes([
    type,
    ...kinds
      .filter((kind) => kind !== type.kind)
      .map((kind): DerivedType => ({ kind: "kinds", kinds: [kind] })),
  ]);
}

/** A default's source structure (F18), following admitted places and typed ingress calls. */
function literalType(
  expression: Expression,
  statements: readonly Statement[],
  seen = new Set<string>(),
): DerivedType | null {
  const at = selected(expression)!;
  switch (at.kind) {
    case "numberLiteral":
      return { kind: "kinds", kinds: [at.numericType] };
    case "stringLiteral":
      return at.parts.every((part) => part.kind === "stringText")
        ? { kind: "kinds", kinds: ["string"] }
        : null;
    case "booleanLiteral":
      return { kind: "kinds", kinds: ["boolean"] };
    case "nullLiteral":
      return null;
    case "listLiteral":
    case "setLiteral": {
      // ADR 0021 2.6: `[]` leaves the element type open, a `null` element is one of its values; the elements settle one
      // family as a place's stores do
      const elements = at.elements.map((item) =>
        unwrap(item).kind === "nullLiteral"
          ? ({ kind: "kinds", kinds: ["null"] } as const)
          : literalType(item, statements, seen),
      );
      return {
        kind: at.kind === "listLiteral" ? "list" : "set",
        element:
          elements.length === 0 || elements.some((item) => item === null)
            ? null
            : admittedShape(elements),
      };
    }
    case "objectLiteral":
      return {
        kind: "object",
        properties: at.properties.map((property) => ({
          name: property.name.name,
          type: literalType(property.value, statements, seen) ?? {
            kind: "kinds",
            kinds: VALUE_KIND_NAMES,
          },
        })),
      };
    case "identifier":
    case "propertyAccessExpression":
    case "indexExpression":
      // the candidate route leaves out a typed parse's or load's default that reads a variable
      throw new Underivable("a default that reads a variable");
    case "loadExpression":
      return expectedType(at, statements, seen);
    case "callExpression":
      return at.callee.kind === "identifier" && at.callee.name === "fromJson"
        ? expectedType(at, statements, seen)
        : null;
    default:
      return null;
  }
}

function unionTypes(types: readonly DerivedType[]): DerivedType {
  const unique = new Map(types.map((type) => [derivedText(type), type]));
  const members = [...unique.values()];
  return members.length === 1 ? members[0]! : { kind: "union", members };
}

function writtenType(annotation: TypeAnnotation): DerivedType {
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

function withoutNull(type: DerivedType): DerivedType | null {
  if (type.kind === "kinds") {
    const kinds = type.kinds.filter((kind) => kind !== "null");
    return kinds.length === 0 ? null : { kind: "kinds", kinds };
  }
  if (type.kind !== "union") return type;
  const members = type.members.map(withoutNull).filter((member) => member !== null);
  return members.length === 0 ? null : unionTypes(members);
}

type DefaultOwner = Extract<
  Expression,
  { kind: "binaryExpression" | "callExpression" | "loadExpression" }
>;
function fallbackOf(owner: Expression): Expression | null {
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

/** Source ownership for associating an instruction-lowered default with its original expression. */
export function defaultSites(
  source: string,
): readonly {
  readonly owner: string;
  readonly site: string;
  readonly written: string;
  readonly lowered: boolean;
}[] {
  return expressions(syntaxOf(source).statements)
    .flatMap((owner) => {
      const fallback = fallbackOf(owner);
      const at = unwrap(owner);
      return fallback === null
        ? []
        : [
            {
              owner: site(at),
              site: site(unwrap(fallback)),
              written: site(fallback),
              lowered:
                requiresInstructions(fallback) ||
                (at.kind === "callExpression" && callRequiresInstructions(at)),
            },
          ];
    })
    .filter(
      (entry, index, all) =>
        all.findIndex((candidate) => candidate.owner === entry.owner) === index,
    );
}

function callRequiresInstructions(call: Extract<Expression, { kind: "callExpression" }>): boolean {
  const callee = unwrap(call.callee);
  if (callee.kind !== "identifier") return false;
  if (["fileFromBase64", "decryptText", "decryptFile"].includes(callee.name)) return true;
  if (callee.name !== "fromJson") return false;
  const files = call.arguments.find(
    (argument) => argument.kind === "namedArgument" && argument.name.name === "files",
  );
  const written = files === undefined ? null : unwrap(files.value);
  return written?.kind !== "booleanLiteral" || written.value !== false;
}

function requiresInstructions(expression: Expression): boolean {
  const at = unwrap(expression);
  if (at.kind === "callExpression")
    return (
      callRequiresInstructions(at) ||
      requiresInstructions(at.callee) ||
      at.arguments.some((argument) => requiresInstructions(argument.value))
    );
  if (at.kind === "binaryExpression")
    return requiresInstructions(at.left) || requiresInstructions(at.right);
  if (at.kind === "loadExpression")
    return (
      requiresInstructions(at.key) ||
      (at.defaultValue !== null && requiresInstructions(at.defaultValue))
    );
  if (at.kind === "propertyAccessExpression") return requiresInstructions(at.object);
  if (at.kind === "indexExpression")
    return requiresInstructions(at.object) || requiresInstructions(at.index);
  if (at.kind === "listLiteral") return at.elements.some(requiresInstructions);
  if (at.kind === "objectLiteral")
    return at.properties.some((property) => requiresInstructions(property.value));
  return false;
}

function expectedType(
  owner: DefaultOwner,
  statements: readonly Statement[],
  seen = new Set<string>(),
): DerivedType | null {
  if (owner.kind === "loadExpression" && unwrap(owner.key).kind !== "stringLiteral") return null;
  const key = `ingress:${site(owner)}`;
  if (seen.has(key)) return null; // this contribution adds no source structure; an earlier store may decide it
  const next = new Set([...seen, key]);
  const written = writtenLanding(owner, [], statements);
  const fallback = fallbackOf(owner);
  // (a written type without an object takes nothing from the default)
  if (written !== undefined)
    return written === null
      ? null
      : writtenReading(
          written,
          fallback === null || !holdsObject(written)
            ? null
            : literalType(fallback, statements, next),
        );
  const literal = fallback === null ? null : literalType(fallback, statements, next);
  return literal === null ? null : withoutNull(literal);
}

/** Whether a type has an object at some level. */
function holdsObject(type: DerivedType): boolean {
  if (type.kind === "object") return true;
  if (type.kind === "union") return type.members.some(holdsObject);
  return type.kind !== "kinds" && type.element !== null && holdsObject(type.element);
}

/**
 * What a typed parse or load reads where it lands in a written type: that type, each level of it that is any object
 * (`object`) read as the default's object there, which names its properties with the default's types and keeps every
 * other key, there and at every level below (#1223, the lead's rulings 1 and 2).
 */
function writtenReading(written: DerivedType, literal: DerivedType | null): DerivedType {
  if (written.kind === "union")
    return unionTypes(written.members.map((member) => writtenReading(member, literal)));
  if (written.kind === "kinds") return written;
  if (written.kind === "object") {
    const object =
      literal?.kind === "union"
        ? literal.members.find((member) => member.kind === "object")
        : literal;
    return keepingKeys(object?.kind === "object" ? object : written);
  }
  return {
    kind: written.kind,
    element:
      written.element === null ? null : writtenReading(written.element, partOf(literal, "element")),
  };
}

/** `type` with every object in it keeping its other keys. */
function keepingKeys(type: DerivedType): DerivedType {
  if (type.kind === "kinds") return type;
  if (type.kind === "union") return unionTypes(type.members.map(keepingKeys));
  if (type.kind === "object")
    return {
      kind: "object",
      properties: type.properties.map((property) => ({
        name: property.name,
        type: keepingKeys(property.type),
      })),
      keepExtra: true,
    };
  return { kind: type.kind, element: type.element === null ? null : keepingKeys(type.element) };
}

/** Whether a type holds `null`. */
function holdsNull(type: DerivedType): boolean {
  return type.kind === "kinds"
    ? type.kinds.includes("null")
    : type.kind === "union" && type.members.some(holdsNull);
}

/**
 * The written type at `path` below the owner where the owner lands directly in a `let` or variable with a written type
 * (ADR 0021 7.3), through list and set elements, `otherwise` and the `default:` of a call or a load, which lands where
 * its result does; `undefined` where it lands in none.
 */
function writtenLanding(
  owner: Expression,
  path: readonly string[],
  statements: readonly Statement[],
): DerivedType | null | undefined {
  const landsIn = (
    expression: Expression,
    type: DerivedType | null,
  ): DerivedType | null | undefined => {
    const at = unwrap(expression);
    if (at === owner) return type;
    if (at.kind === "listLiteral" || at.kind === "setLiteral") {
      for (const element of at.elements) {
        const found = landsIn(element, partOf(type, "element"));
        if (found !== undefined) return found;
      }
    } else if (at.kind === "binaryExpression" && at.operator === "otherwise") {
      const left = landsIn(at.left, type);
      return left !== undefined ? left : landsIn(at.right, type);
    } else if (at.kind === "callExpression" || at.kind === "loadExpression") {
      const fallback = fallbackOf(at);
      if (fallback !== null) return landsIn(fallback, type);
    }
    return undefined;
  };
  for (const statement of statements) {
    const store = storeOf(statement);
    if (
      store === null ||
      (statement.kind === "assignmentStatement" && statement.target.kind !== "identifier")
    )
      continue;
    const declaration =
      statement.kind === "letStatement"
        ? statement
        : statements.find(
            (candidate) => candidate.kind === "letStatement" && candidate.name.name === store.name,
          );
    if (declaration?.kind !== "letStatement" || declaration.typeAnnotation === null) continue;
    const found = landsIn(store.value, writtenType(declaration.typeAnnotation));
    if (found !== undefined)
      return path.reduce<DerivedType | null>((type, step) => partOf(type, step), found);
  }
  return undefined;
}

/** A fallback obligation can name a part (`[hostValue].element`), checked at the whole selected operand. */
function fallbackType(
  owner: DefaultOwner,
  path: readonly string[],
  against: readonly string[],
  statements: readonly Statement[],
): DerivedType {
  const value = fallbackOf(owner)!;
  const root = sourceShape(value, statements) ?? sourceShape(owner, statements);
  // C10 (ADR 0021 7.2): below the fallback itself an element may also be null, unless the written type of a place
  // the owner lands in directly excludes it there
  const written = path.length === 0 ? undefined : writtenLanding(owner, path, statements);
  const nullable =
    path.length > 0 && (written === undefined || written === null || holdsNull(written));
  const at = (shape: DerivedType | null, remaining: readonly string[]): DerivedType => {
    if (remaining.length === 0)
      return {
        kind: "kinds",
        kinds: nullable && !against.includes("null") ? [...against, "null"] : against,
      };
    const [step, ...rest] = remaining;
    if (step !== "element")
      return {
        kind: "object",
        properties: [{ name: step!, type: at(partOf(shape, step!), rest) }],
      };
    const collection =
      shape?.kind === "union"
        ? shape.members.find(
            (member) => member.kind === "list" || member.kind === "set" || member.kind === "dict",
          )
        : shape;
    if (collection?.kind !== "list" && collection?.kind !== "set" && collection?.kind !== "dict")
      throw new Underivable("a fallback element check without a source-carried collection");
    return { kind: collection.kind, element: at(collection.element, rest) };
  };
  return at(root, path);
}

/** Every obligation is mapped by S3 §4; S7 content is owed by that map and F18, never by the emitted plan. */
export function derive(
  syntax: Syntax,
  record: CompactRecord,
): {
  readonly stores: readonly DerivedStore[];
  readonly discharges: readonly Discharge[];
  readonly content: DerivedContent;
} {
  const { source } = syntax;
  const statements = allStatements(syntax.statements);
  const all = expressions(syntax.statements).map(unwrap);
  const owners = all.filter(
    (expression): expression is DefaultOwner => fallbackOf(expression) !== null,
  );
  const content: {
    requireExisting: { target: string; site: string }[];
    indexes: string[];
    fallbacks: { owner: string; site: string; type: DerivedType }[];
    expected: { owner: string; type: DerivedType }[];
    loads: { owner: string; type: DerivedType | null; repair: boolean }[];
  } = { requireExisting: [], indexes: [], fallbacks: [], expected: [], loads: [] };
  for (const owner of new Set(owners)) {
    if (owner.kind === "loadExpression") {
      const type = expectedType(owner, statements);
      content.loads.push({
        owner: site(owner),
        type,
        repair: type !== null && repairsRecord(type),
      });
    } else if (
      owner.kind === "callExpression" &&
      owner.callee.kind === "identifier" &&
      owner.callee.name === "fromJson"
    ) {
      const type = expectedType(owner, statements);
      if (type !== null) content.expected.push({ owner: site(owner), type });
    }
  }
  const owed = new Map<Statement, { path: readonly string[]; against: readonly string[] }[]>();
  const discharges: ({ statement: Statement } | { native: Discharge & { by: "native" } })[] = [];
  const native = (what: (Discharge & { by: "native" })["what"], at: string): void => {
    discharges.push({ native: { by: "native", what, site: at } });
  };
  const reads = all.filter(
    (
      expression,
    ): expression is Extract<
      Expression,
      { kind: "propertyAccessExpression" | "indexExpression" }
    > => expression.kind === "propertyAccessExpression" || expression.kind === "indexExpression",
  );
  const readAt = (check: CompactRecord["checks"][number]) => {
    const at = `${check.site.offset}:${check.site.end}`;
    const named = reads.filter((expression) => {
      const receiver = unwrap(expression.object);
      return source.slice(receiver.span.start.offset, receiver.span.end.offset) === check.target;
    });
    const exact = (expression: (typeof reads)[number]): boolean =>
      site(unwrap(expression.object)) === at || site(expression) === at;
    return (
      named.find(exact) ??
      reads.find(exact) ??
      named.find((expression) => expression.span.start.offset === check.site.offset)
    );
  };
  for (const check of record.checks) {
    const at = `${check.site.offset}:${check.site.end}`;
    const fallback = owners.find((owner) => {
      const value = unwrap(fallbackOf(owner)!);
      const text = source.slice(value.span.start.offset, value.span.end.offset);
      return site(value) === at && (check.target === text || check.target.startsWith(`${text}.`));
    });
    if (
      check.kind === "copy-type" &&
      check.boundary &&
      check.against.length === 1 &&
      check.against[0] === "unknown"
    ) {
      native("representable", at);
    } else if (check.kind === "copy-type" && fallback !== undefined && !check.boundary) {
      if (fallback.kind !== "loadExpression") {
        const existing = content.fallbacks.find((entry) => entry.owner === site(fallback));
        const value = unwrap(fallbackOf(fallback)!);
        const text = source.slice(value.span.start.offset, value.span.end.offset);
        const path = check.target === text ? [] : check.target.slice(text.length + 1).split(".");
        const type = fallbackType(fallback, path, check.against, statements);
        if (existing !== undefined && derivedText(existing.type) !== derivedText(type))
          throw new Underivable("incompatible checks of one fallback");
        if (existing === undefined)
          content.fallbacks.push({ owner: site(fallback), site: at, type });
      }
      native("fallback", at);
    } else if (check.kind === "copy-type" && !check.against.includes("unknown")) {
      const statement = statements
        .filter(
          (candidate) =>
            storeOf(candidate) !== null &&
            candidate.span.start.offset <= check.site.offset &&
            check.site.offset < candidate.span.end.offset,
        )
        .sort(
          (a, b) =>
            a.span.end.offset - a.span.start.offset - (b.span.end.offset - b.span.start.offset),
        )[0];
      if (statement === undefined) {
        const ingress = owners.find(
          (owner) =>
            site(owner) === at &&
            (owner.kind === "loadExpression" ||
              (owner.kind === "callExpression" &&
                owner.callee.kind === "identifier" &&
                owner.callee.name === "fromJson")),
        );
        if (!check.boundary || ingress === undefined || expectedType(ingress, statements) === null)
          throw new Underivable(`${check.target}: no store or typed ingress holds its check`);
        native("typed-ingress", at);
        continue;
      }
      const store = storeOf(statement)!;
      const prefix = `${store.name}.`;
      if (check.target !== store.name && !check.target.startsWith(prefix)) {
        const ingress = owners.find(
          (owner) =>
            site(owner) === at &&
            (owner.kind === "loadExpression" ||
              (owner.kind === "callExpression" &&
                owner.callee.kind === "identifier" &&
                owner.callee.name === "fromJson")),
        );
        if (check.boundary && ingress !== undefined && expectedType(ingress, statements) !== null) {
          native("typed-ingress", at);
          continue;
        }
        throw new Underivable(`${check.target} is not ${store.name}'s`);
      }
      const path = check.target === store.name ? [] : check.target.slice(prefix.length).split(".");
      owed.set(statement, [...(owed.get(statement) ?? []), { path, against: check.against }]);
      discharges.push({ statement });
    } else if (check.kind === "integer-check") {
      const get = all.find(
        (expression) =>
          expression.kind === "callExpression" &&
          expression.callee.kind === "propertyAccessExpression" &&
          expression.callee.property.name === "get" &&
          expression.arguments[0] !== undefined &&
          site(unwrap(expression.arguments[0].value)) === at,
      );
      if (get !== undefined && !content.indexes.includes(site(get)))
        content.indexes.push(site(get));
      native("integer-use", at);
    } else if (check.kind === "empty-check") {
      const read = readAt(check);
      if (
        read?.kind !== "propertyAccessExpression" ||
        listProperty(read.property.name)?.gives !== "element"
      )
        throw new Underivable(`an empty obligation at ${at} without an element selection`);
      native("empty", site(read));
    } else if (
      (check.kind === "operand" || check.kind === "null-check") &&
      statements.some(
        (statement) => statement.kind === "forStatement" && site(unwrap(statement.iterable)) === at,
      )
    ) {
      // C13 (S9b): a `for` loop's iterable, which the loop's own check of its source takes (TSR044)
      native("iteration", at);
    } else if (check.kind === "operand") {
      // C13 (S9b): a method's argument or what `toJson` writes, which the call's own check takes at the call, or the
      // elements `join` or `sort` reads, whose obligation is the whole call's
      const call = all.find(
        (expression) =>
          expression.kind === "callExpression" &&
          (site(expression) === at ||
            expression.arguments.some((argument) => site(unwrap(argument.value)) === at)),
      );
      if (call === undefined)
        throw new Underivable(`an operand obligation at ${at} without a call`);
      native("argument", site(call));
    } else if (
      check.kind === "null-check" &&
      check.against.length === 1 &&
      check.against[0] === "non-null"
    ) {
      const store = statements.find(
        (statement) =>
          statement.kind === "assignmentStatement" &&
          statement.target.kind === "propertyAccessExpression" &&
          (site(unwrap(statement.target.object)) === at || site(statement.target) === at),
      );
      if (store?.kind === "assignmentStatement") {
        if (!content.requireExisting.some((entry) => entry.site === site(store)))
          content.requireExisting.push({ target: targetName(store.target), site: site(store) });
        native("member", site(store.target));
      } else {
        const read = readAt(check);
        if (read === undefined)
          throw new Underivable(`a member obligation at ${at} without a member`);
        native("member", site(read));
      }
    } else
      throw new Underivable(`${check.kind} ${check.target}: an obligation no discharge rule maps`);
  }
  const stores = new Map<Statement, DerivedStore>();
  for (const [statement, checks] of owed) {
    const { name, value } = storeOf(statement)!;
    stores.set(statement, {
      target: name,
      so: statement.span.start.offset,
      eo: statement.span.end.offset,
      valueSo: unwrap(value).span.start.offset,
      valueEo: unwrap(value).span.end.offset,
      type: typeOf(statement, value, checks, 0, statements),
    });
  }
  return {
    stores: [...stores.values()].sort((a, b) => a.so - b.so),
    content,
    discharges: discharges.map((entry) =>
      "native" in entry ? entry.native : { by: "store", store: stores.get(entry.statement)! },
    ),
  };
}

// ------------------------------------------------------------------------------------------------ the companions

/** A companion of a record's source: its text and the host globals it reads, each read its own input. */
export interface Companion {
  readonly label: string;
  readonly source: string;
  readonly globals: readonly string[];
  /** Whether `say "AFTER"` was inserted before the final `exit`: the next effect a fitting run reaches. */
  readonly after: boolean;
}

const HOST = "hostValue";

/** The expressions of a program, in source order. */
function expressions(statements: readonly Statement[]): Expression[] {
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
  }
  return out;
}

function replaced(source: string, edits: readonly (readonly [number, number, string])[]): string {
  let out = source;
  for (const [start, end, text] of [...edits].sort((a, b) => b[0] - a[0])) {
    if (text.length !== end - start) throw new Error("a companion keeps every span");
    out = out.slice(0, start) + text + out.slice(end);
  }
  return out;
}

/**
 * §5.2's companions, from the source alone: every host read after the first renamed to a same-length global
 * (`hostValu2`, …); every constant index of a list literal given each element index of the same width; every number
 * literal a store writes whole given a same-width whole-valued number spelling, `1.0` for `1.5` (the numeric kind
 * stays `number`, so the record's decisions stay the same); and `say "AFTER"` inserted before
 * a final `exit` where the program does not exit first. The original itself is not a companion: it runs as written.
 */
export function companions({ source, statements }: Syntax): readonly Companion[] {
  const all = expressions(statements);
  const hosts = all.filter(
    (expression) => expression.kind === "identifier" && expression.name === HOST,
  );
  const renames: (readonly [number, number, string])[] = hosts.slice(1).map((host, index) => {
    const name = `hostValu${index + 2}`;
    if (name.length !== HOST.length)
      throw new Underivable("more host reads than same-length names");
    return [host.span.start.offset, host.span.end.offset, name] as const;
  });
  const globals = [HOST, ...renames.map(([, , name]) => name)];
  const choices: (readonly (readonly [number, number, string] | null)[])[] = [];
  for (const expression of all) {
    if (expression.kind !== "indexExpression") continue;
    const list = unwrap(expression.object);
    const index = unwrap(expression.index);
    if (list.kind !== "listLiteral" || index.kind !== "numberLiteral") continue;
    const width = index.span.end.offset - index.span.start.offset;
    choices.push([
      null,
      ...list.elements
        .map((_, position) => String(position))
        .filter((text) => text.length === width && text !== index.raw)
        .map((text) => [index.span.start.offset, index.span.end.offset, text] as const),
    ]);
  }
  for (const expression of all) {
    if (
      expression.kind !== "numberLiteral" ||
      expression.numericType !== "number" ||
      !allStatements(statements).some((statement) => storeOf(statement)?.value === expression)
    )
      continue;
    if (Number.isInteger(expression.value)) continue;
    const spelling = `${Math.trunc(expression.value)}.0`;
    if (spelling.length !== expression.raw.length) continue;
    choices.push([
      null,
      [expression.span.start.offset, expression.span.end.offset, spelling] as const,
    ]);
  }
  const top = statements;
  const last = top.at(-1);
  const after = last?.kind === "exitStatement" && top[0]?.kind !== "exitStatement";
  const out: Companion[] = [];
  const product = (at: number, picked: readonly (readonly [number, number, string])[]): void => {
    if (at === choices.length) {
      let text = replaced(source, [...renames, ...picked]);
      if (after) {
        const exit = last!.span.start.offset;
        text = `${text.slice(0, exit)}say "AFTER"\n${text.slice(exit)}`;
      }
      out.push({
        label:
          [
            ...picked.map(([start, , spelled]) => `${start}:${spelled}`),
            ...(after ? ["AFTER"] : []),
          ].join(" ") || "renamed",
        source: text,
        globals,
        after,
      });
      return;
    }
    for (const choice of choices[at]!)
      product(at + 1, choice === null ? picked : [...picked, choice]);
  };
  product(0, []);
  return out;
}

// ------------------------------------------------------------------------------------------------- the evaluator

/** A run's end as the engine reports it: its status, its failure `CODE@start:end`, and what it said, with offsets. */
export interface PredictedRun {
  readonly status: "halted" | "failed";
  readonly failure: string | null;
  readonly said: readonly { readonly text: string; readonly at: number }[];
}

/** One check a run evaluates: its discharge's site, whether the value fits, and the host globals the value came from. */
export interface CheckEvent {
  readonly site: string;
  /** The code the check fails with, or `null` for a typed parse's or load's reading, which gives its default. */
  readonly code: string | null;
  readonly fits: boolean;
  readonly from: ReadonlySet<string>;
}

interface Value {
  readonly v: SerializableRuntimeValue;
  readonly from: ReadonlySet<string>;
}

class Stop {
  public constructor(readonly failure: string | null) {}
}

function fitsType(value: SerializableRuntimeValue, type: DerivedType): boolean {
  if (type.kind === "union") return type.members.some((member) => fitsType(value, member));
  if (type.kind === "kinds")
    return type.kinds.some(
      (kind) =>
        kind === "unknown" ||
        (value === null
          ? kind === "null"
          : typeof value === "number"
            ? kind === "number" || (kind === "integer" && Number.isInteger(value))
            : typeof value === "string"
              ? kind === "string"
              : typeof value === "boolean"
                ? kind === "boolean"
                : kind === value.kind),
    );
  if (type.kind === "object")
    return (
      value !== null &&
      typeof value === "object" &&
      value.kind === "object" &&
      type.properties.every((property) => {
        const held = value.properties.find((entry) => entry.name === property.name);
        // Object admissions constrain fields that are present; C5 checks a required member at its access.
        return held === undefined || fitsType(held.value, property.type);
      })
    );
  return (
    typeof value === "object" &&
    value !== null &&
    value.kind === type.kind &&
    (value.kind === "dict"
      ? value.entries.every((entry) => type.element === null || fitsType(entry.value, type.element))
      : "items" in value &&
        value.items.every((item) => type.element === null || fitsType(item, type.element)))
  );
}

/** JSON's scalar/list/dict values, prior to reading an expected object type. */
function jsonValue(raw: unknown): SerializableRuntimeValue {
  if (raw === null || typeof raw === "string" || typeof raw === "boolean") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (Array.isArray(raw)) return { kind: "list", items: raw.map(jsonValue) };
  if (typeof raw === "object" && raw !== null)
    return {
      kind: "dict",
      entries: Object.entries(raw).map(([key, value]) => ({ key, value: jsonValue(value) })),
    };
  throw new Underivable("unrepresentable JSON");
}

/** Read by kind and by field; `undefined` asks for the default, whose fields may repair an object. */
function readJson(
  value: SerializableRuntimeValue,
  type: DerivedType,
  fallback?: SerializableRuntimeValue,
): SerializableRuntimeValue | undefined {
  if (type.kind === "union") {
    for (const member of type.members) {
      const read = readJson(value, member, fallback);
      if (read !== undefined) return read;
    }
    return undefined;
  }
  if (type.kind === "object") {
    if (
      typeof value !== "object" ||
      value === null ||
      (value.kind !== "dict" && value.kind !== "object")
    )
      return undefined;
    const fields =
      value.kind === "dict"
        ? value.entries.map((entry) => ({ name: entry.key, value: entry.value }))
        : value.properties;
    const properties: { name: string; value: SerializableRuntimeValue }[] = [];
    for (const property of type.properties) {
      const held = fields.find((entry) => entry.name === property.name)?.value;
      const supplied =
        fallback !== null && typeof fallback === "object" && fallback?.kind === "object"
          ? fallback.properties.find((entry) => entry.name === property.name)?.value
          : undefined;
      const read = held === undefined ? undefined : readJson(held, property.type, supplied);
      if (read === undefined && supplied === undefined) return undefined;
      properties.push({ name: property.name, value: read === undefined ? supplied! : read });
    }
    if (type.keepExtra !== true) return { kind: "object", properties };
    // every key in the JSON's order, a listed one as read, those it lacks after them
    const read = (name: string) => properties.find((property) => property.name === name);
    return {
      kind: "object",
      properties: [
        ...fields.map((field) => read(field.name) ?? field),
        ...properties.filter((property) => !fields.some((field) => field.name === property.name)),
      ],
    };
  }
  if (
    type.kind !== "kinds" &&
    type.element !== null &&
    typeof value === "object" &&
    value !== null &&
    value.kind === type.kind
  ) {
    if (value.kind === "dict") {
      const entries = value.entries.map((entry) => ({
        key: entry.key,
        value: readJson(entry.value, type.element!),
      }));
      return entries.some((entry) => entry.value === undefined)
        ? undefined
        : {
            kind: "dict",
            entries: entries.map((entry) => ({ key: entry.key, value: entry.value! })),
          };
    }
    if ("items" in value) {
      const items = value.items.map((item) => readJson(item, type.element!));
      return items.some((item) => item === undefined)
        ? undefined
        : { kind: value.kind, items: items.filter((item) => item !== undefined) };
    }
  }
  return fitsType(value, type) ? value : undefined;
}

/** `say` uses scalars as text and other fixture values as escaped code-like notation (V30 §8). */
function shown(value: SerializableRuntimeValue, nested = false): string {
  if (value === null || typeof value !== "object")
    return typeof value === "string" && nested ? JSON.stringify(value) : String(value);
  if (value.kind === "list" || value.kind === "set")
    return `[${value.items.map((item) => shown(item, true)).join(", ")}]`;
  if (value.kind === "object")
    return value.properties.length === 0
      ? "{}"
      : `{ ${value.properties.map((property) => `${/^[A-Za-z_][A-Za-z0-9_]*$/u.test(property.name) ? property.name : JSON.stringify(property.name)}: ${shown(property.value, true)}`).join(", ")} }`;
  if (value.kind === "dict")
    return value.entries.length === 0
      ? "dict{}"
      : `dict{ ${value.entries.map((entry) => `${JSON.stringify(entry.key)}: ${shown(entry.value, true)}`).join(", ")} }`;
  if (value.kind === "date")
    return nested
      ? `<date ${formatIsoDate(value)}>`
      : presentDate(DEFAULT_TEMPORAL_CONTEXT.presentation, value);
  if (value.kind === "time")
    return nested
      ? `<time ${formatIsoTime(value)}>`
      : presentTime(DEFAULT_TEMPORAL_CONTEXT.presentation, value);
  if (value.kind === "datetime")
    return nested
      ? `<datetime ${formatIsoDateTime(value)}>`
      : presentDateTime(DEFAULT_TEMPORAL_CONTEXT.presentation, value);
  if (value.kind === "absoluteDateTime") {
    if (nested) return `<absoluteDateTime ${formatIsoTimestamp(value.epochMilliseconds)}>`;
    const fields = localFields(DEFAULT_TEMPORAL_CONTEXT.zone, value.epochMilliseconds);
    if (!fields.ok)
      throw new Underivable("a displayed absolute date outside the frozen zone rules");
    return presentDateTime(DEFAULT_TEMPORAL_CONTEXT.presentation, fields.value);
  }
  throw new Underivable(`the display of ${value.kind}`);
}

/**
 * A run of the source by the rules, with `inputs` the host globals' values: the plan's checked stores `stores` fail with
 * TSR058 at their value when it does not fit their type; a `repeat` count that is not a whole number of at least 0 fails
 * with TSR043 at the count, a list index that is not a whole number with TSR024, one the list does not have with
 * TSR025, both at the index. With `through`, a failing check is recorded and the run goes on, so a later check's value
 * is still seen (a preempted discharge).
 */
export function evaluate(
  { statements }: Syntax,
  stores: readonly DerivedStore[],
  inputs: Readonly<Record<string, SerializableRuntimeValue>>,
  through = false,
  content: DerivedContent = {
    requireExisting: [],
    indexes: [],
    fallbacks: [],
    expected: [],
    loads: [],
  },
): { readonly run: PredictedRun; readonly events: readonly CheckEvent[] } {
  const env = new Map<string, Value>();
  const said: { text: string; at: number }[] = [];
  const events: CheckEvent[] = [];
  let first: string | null = null;
  const fail = (
    code: string,
    start: number,
    end: number,
    from: ReadonlySet<string>,
    fits: boolean,
  ): void => {
    events.push({ site: `${start}:${end}`, code, fits, from });
    if (fits) return;
    const failure = `${code}@${start}:${end}`;
    first ??= failure;
    if (!through) throw new Stop(failure);
  };
  const checkedFallback = (owner: Expression, fallback: Expression): Value => {
    const selected = value(fallback);
    const check = content.fallbacks.find((entry) => entry.owner === site(unwrap(owner)));
    if (check !== undefined)
      fail(
        "TSR058",
        unwrap(fallback).span.start.offset,
        unwrap(fallback).span.end.offset,
        selected.from,
        selected.v === null || fitsType(selected.v, check.type),
      );
    return selected;
  };
  const value = (expression: Expression): Value => {
    const result = readValue(expression);
    const type =
      expression.kind === "loadExpression"
        ? content.loads.find((entry) => entry.owner === site(expression))?.type
        : content.expected.find((entry) => entry.owner === site(expression))?.type;
    // Expected reading filters/repairs at the ingress; its selected default has its own failure site.
    if (type !== null && type !== undefined)
      events.push({
        site: site(expression),
        code: null,
        fits: result.v === null || fitsType(result.v, type),
        from: result.from,
      });
    return result;
  };
  const readValue = (expression: Expression): Value => {
    switch (expression.kind) {
      case "numberLiteral":
      case "booleanLiteral":
      case "nullLiteral":
        return { v: expression.value, from: new Set() };
      case "stringLiteral":
        if (expression.parts.some((part) => part.kind !== "stringText"))
          throw new Underivable("an interpolation");
        return {
          v: expression.parts
            .map((part) => (part.kind === "stringText" ? part.value : ""))
            .join(""),
          from: new Set(),
        };
      case "parenthesizedExpression":
        return value(expression.expression);
      case "identifier": {
        if (Object.hasOwn(inputs, expression.name))
          return { v: inputs[expression.name]!, from: new Set([expression.name]) };
        const bound = env.get(expression.name);
        if (bound === undefined)
          throw new Underivable(`a read of ${expression.name} before its store`);
        return bound;
      }
      case "listLiteral": {
        const items = expression.elements.map(value);
        return {
          v: { kind: "list", items: items.map((item) => item.v) },
          from: new Set(items.flatMap((item) => [...item.from])),
        };
      }
      case "regexLiteral":
        return {
          v: { kind: "regex", source: expression.source, flags: expression.flags },
          from: new Set(),
        };
      case "rangeExpression": {
        // (a range of whole-number bounds; any other is the runtime's to reject)
        const [start, end] = [value(expression.start), value(expression.end)];
        if (!Number.isInteger(start.v) || !Number.isInteger(end.v))
          throw new Underivable("a range of other bounds");
        return {
          v: {
            kind: "range",
            start: Number(start.v),
            end: Number(end.v),
            inclusive: expression.inclusive,
          },
          from: new Set([...start.from, ...end.from]),
        };
      }
      case "objectLiteral": {
        const properties = expression.properties.map((property) => ({
          name: property.name.name,
          value: value(property.value),
        }));
        return {
          v: {
            kind: "object",
            properties: properties.map((property) => ({
              name: property.name,
              value: property.value.v,
            })),
          },
          from: new Set(properties.flatMap((property) => [...property.value.from])),
        };
      }
      case "propertyAccessExpression": {
        const object = value(expression.object);
        const name = expression.property.name;
        if (
          object.v !== null &&
          typeof object.v === "object" &&
          (object.v.kind === "list" || object.v.kind === "set")
        ) {
          const property = listProperty(name);
          if (property?.gives === "length") return { v: object.v.items.length, from: object.from };
          if (property?.gives === "element") {
            fail(
              property.empty,
              expression.span.start.offset,
              expression.span.end.offset,
              object.from,
              object.v.items.length > 0,
            );
            if (property.name === "random" && object.v.items.length > 1)
              throw new Underivable("a random selection from several elements");
            return {
              v: object.v.items[property.name === "last" ? object.v.items.length - 1 : 0] ?? null,
              from: object.from,
            };
          }
        }
        let held: SerializableRuntimeValue | undefined;
        if (object.v !== null && typeof object.v === "object" && object.v.kind === "object")
          held = object.v.properties.find((property) => property.name === name)?.value;
        else if (typeof object.v === "string" && name === "length") held = [...object.v].length;
        fail(
          "TSR017",
          expression.span.start.offset,
          expression.span.end.offset,
          object.from,
          held !== undefined,
        );
        return { v: held ?? null, from: object.from };
      }
      case "binaryExpression": {
        if (expression.operator !== "otherwise")
          throw new Underivable(`the operator ${expression.operator}`);
        const left = value(expression.left);
        return left.v !== null ? left : checkedFallback(expression, expression.right);
      }
      case "loadExpression": {
        const key = value(expression.key);
        if (typeof key.v !== "string") throw new Underivable("a load key that is not text");
        if (expression.defaultValue === null) return { v: null, from: new Set() };
        const fallback = value(expression.defaultValue);
        const type = content.loads.find((entry) => entry.owner === site(expression))?.type;
        if (type !== null && type !== undefined)
          fail(
            "TSR058",
            unwrap(expression.defaultValue).span.start.offset,
            unwrap(expression.defaultValue).span.end.offset,
            fallback.from,
            fallback.v === null || fitsType(fallback.v, type),
          );
        return fallback;
      }
      case "callExpression": {
        const callee = unwrap(expression.callee);
        const receiver = callee.kind === "propertyAccessExpression" ? value(callee.object) : null;
        const operands = expression.arguments
          .filter(
            (argument) => argument.kind !== "namedArgument" || argument.name.name !== "default",
          )
          .map((argument) => ({ argument, value: value(argument.value) }));
        const positional = operands
          .filter((operand) => operand.argument.kind === "positionalArgument")
          .map((operand) => operand.value);
        const named = (name: string): Value | undefined =>
          operands.find(
            (operand) =>
              operand.argument.kind === "namedArgument" && operand.argument.name.name === name,
          )?.value;
        const fallback = fallbackOf(expression);
        const useDefault = (): Value => {
          if (fallback === null) throw new Underivable("a call without its default");
          return checkedFallback(expression, fallback);
        };
        if (callee.kind === "propertyAccessExpression") {
          if (callee.property.name !== "get") {
            // a method of the slice (S9b) as the runtime calls it: text's (`callStringMethod`), a list's or a set's
            // that changes nothing (`readCollection`), and `sort`, which orders its list in place; the runtime's own
            // check of an argument or an element fails at the call (TSV043 stands for a check that passes), and a
            // receiver of another kind has no such method (TSR016, the call's member check)
            const method = callee.property.name;
            const from = new Set([
              ...receiver!.from,
              ...positional.flatMap((operand) => [...operand.from]),
            ]);
            const target = receiver!.v;
            const values = positional.map((operand) => operand.v);
            const { span } = expression;
            const called = (make: () => SerializableRuntimeValue | undefined): Value => {
              let made: SerializableRuntimeValue | undefined;
              try {
                made = make();
              } catch (error) {
                if (!(error instanceof RuntimeFault)) throw error;
                fail(error.code, error.span.start.offset, error.span.end.offset, from, false);
                return { v: null, from };
              }
              fail("TSV043", span.start.offset, span.end.offset, from, true);
              return made === undefined ? useDefault() : { v: made, from };
            };
            if (typeof target === "string")
              return called(() => callStringMethod(target, method, values, span));
            if (target !== null && (isRuntimeList(target) || isSet(target))) {
              if (method === "sort" && isRuntimeList(target))
                return called(() => {
                  const items = [...target.items];
                  const order = sortOrder(items, span);
                  target.items.splice(0, items.length, ...order.map((index) => items[index]!));
                  return null;
                });
              if (listMethod(method)?.changes !== undefined)
                throw new Underivable(`the method ${method}, which changes its receiver`);
              return called(() =>
                readCollection(target, method, values, {}, false, span, (item) =>
                  joinedText(item, span, DEFAULT_TEMPORAL_CONTEXT),
                ),
              );
            }
            if (target !== null && (isDict(target) || isRange(target) || isTemporal(target)))
              throw new Underivable(`the method ${method} of a ${target.kind}`);
            fail("TSR016", span.start.offset, span.end.offset, from, false);
            return { v: null, from };
          }
          const index = positional[0]!;
          const list = receiver!;
          const isList = typeof list.v === "object" && list.v !== null && list.v.kind === "list";
          fail(
            "TSR016",
            expression.span.start.offset,
            expression.span.end.offset,
            list.from,
            isList,
          );
          if (!isList || list.v === null || typeof list.v !== "object" || list.v.kind !== "list")
            return useDefault();
          const whole = typeof index.v === "number" && Number.isInteger(index.v);
          if (content.indexes.includes(site(expression))) {
            const operand = unwrap(expression.arguments[0]!.value);
            fail("TSR024", operand.span.start.offset, operand.span.end.offset, index.from, whole);
          }
          return whole && Number(index.v) >= 0 && Number(index.v) < list.v.items.length
            ? { v: list.v.items[Number(index.v)]!, from: list.from }
            : useDefault();
        }
        if (callee.kind !== "identifier") throw new Underivable("a non-name call");
        const name = callee.name;
        const input = positional[0] ?? named("value") ?? named("text");
        if (input === undefined) throw new Underivable(`the argument of ${name}`);
        if (name === "toJson") {
          // (the runtime's own writing, and its own check of what it writes, TSV043 at the call)
          let written: string | null = null;
          try {
            written = jsonText(input.v, () => [], expression.span);
          } catch (error) {
            if (!(error instanceof RuntimeFault)) throw error;
          }
          fail(
            "TSV043",
            expression.span.start.offset,
            expression.span.end.offset,
            input.from,
            written !== null,
          );
          return { v: written, from: input.from };
        }
        if (name === "fromJson") {
          if (typeof input.v !== "string") return useDefault();
          let parsed: SerializableRuntimeValue;
          try {
            parsed = jsonValue(JSON.parse(input.v));
          } catch (error) {
            if (error instanceof SyntaxError) return useDefault();
            throw error;
          }
          const type = content.expected.find((entry) => entry.owner === site(expression))?.type;
          if (type === undefined) return { v: parsed, from: input.from };
          const read = readJson(parsed, type);
          if (read !== undefined) return { v: read, from: input.from };
          const supplied = useDefault();
          return {
            v: readJson(parsed, type, supplied.v) ?? supplied.v,
            from: new Set([...input.from, ...supplied.from]),
          };
        }
        let converted: SerializableRuntimeValue | undefined;
        if (name === "toNumber" || name === "toInteger") {
          const number =
            typeof input.v === "number"
              ? input.v
              : typeof input.v === "string"
                ? numberFromText(input.v)
                : undefined;
          converted =
            number === undefined ? undefined : name === "toInteger" ? Math.trunc(number) : number;
        } else if (name === "toBoolean")
          converted =
            typeof input.v === "boolean"
              ? input.v
              : typeof input.v === "string"
                ? booleanFromText(input.v)
                : undefined;
        else if (["toDate", "toTime", "toDateTime", "toAbsoluteDateTime"].includes(name)) {
          const kind =
            name === "toDate"
              ? "date"
              : name === "toTime"
                ? "time"
                : name === "toDateTime"
                  ? "datetime"
                  : "absoluteDateTime";
          if (typeof input.v === "string") {
            if (kind === "date") {
              const parsed = parseIsoDate(input.v);
              if (parsed.ok) converted = { kind, ...parsed.value };
            } else if (kind === "time") {
              const parsed = parseIsoTime(input.v);
              if (parsed.ok) converted = { kind, ...parsed.value };
            } else if (kind === "datetime") {
              const parsed = parseIsoDateTime(input.v);
              if (parsed.ok) converted = { kind, ...parsed.value };
            } else {
              const parsed = parseIsoTimestamp(input.v);
              if (parsed.ok) converted = { kind, epochMilliseconds: parsed.value };
            }
          } else if (input.v !== null && typeof input.v === "object") {
            if (input.v.kind === kind) converted = structuredClone(input.v);
            else if (input.v.kind === "datetime" && kind === "date")
              converted = { kind, year: input.v.year, month: input.v.month, day: input.v.day };
            else if (input.v.kind === "datetime" && kind === "time")
              converted = {
                kind,
                hour: input.v.hour,
                minute: input.v.minute,
                second: input.v.second,
                millisecond: input.v.millisecond,
              };
          }
        } else if (name === "fileFromBase64") {
          if (
            typeof input.v === "string" &&
            (binaryFromDataUrl(input.v) ?? binaryFromBase64(input.v)) !== undefined
          )
            throw new Underivable("a fileFromBase64 result that needs a host file store");
        } else if (name === "decryptText" || name === "decryptFile") {
          for (const operand of operands)
            fail(
              "TSR059",
              expression.span.start.offset,
              expression.span.end.offset,
              operand.value.from,
              typeof operand.value.v === "string",
            );
          if (name === "decryptFile")
            fail(
              "TSR059",
              expression.span.start.offset,
              expression.span.end.offset,
              input.from,
              false,
            ); // no stored files in this oracle's runs
          if (
            name === "decryptText" &&
            typeof input.v === "string" &&
            binaryFromBase64(input.v) !== undefined
          )
            throw new Underivable("a decryptText result that needs a host lock action");
        } else throw new Underivable(`the conversion ${name}`);
        if (converted !== undefined) return { v: converted, from: input.from };
        const supplied = useDefault();
        if (
          !content.fallbacks.some((entry) => entry.owner === site(expression)) &&
          isConversion(name)
        ) {
          const conversion = CONVERSIONS[name];
          const fits =
            conversion.fallback?.type === "any" ||
            conversion.result === "unknown" ||
            (conversion.fallback?.type === "optional" && supplied.v === null) ||
            fitsType(supplied.v, { kind: "kinds", kinds: [conversion.result] });
          fail(
            "TSR058",
            unwrap(fallback!).span.start.offset,
            unwrap(fallback!).span.end.offset,
            supplied.from,
            fits,
          );
        }
        return supplied;
      }
      case "indexExpression": {
        const list = value(expression.object);
        const { start, end } = {
          start: unwrap(expression.index).span.start.offset,
          end: unwrap(expression.index).span.end.offset,
        };
        const collection = list.v !== null && typeof list.v === "object" ? list.v : null;
        const indexable = collection?.kind === "list" || collection?.kind === "dict";
        fail(
          collection?.kind === "set" ? "TSR004" : "TSR008",
          expression.span.start.offset,
          expression.span.end.offset,
          list.from,
          indexable,
        );
        if (!indexable) {
          return { v: null, from: list.from };
        }
        const index = value(expression.index);
        if (collection.kind === "dict") {
          const key = typeof index.v === "string";
          fail("TSR062", start, end, index.from, key);
          const held = collection.entries.find((entry) => entry.key === index.v)?.value;
          fail(
            "TSR061",
            expression.span.start.offset,
            expression.span.end.offset,
            new Set([...list.from, ...index.from]),
            !key || held !== undefined,
          );
          return { v: held ?? null, from: list.from };
        }
        const items: readonly SerializableRuntimeValue[] = collection.items;
        const whole = typeof index.v === "number" && Number.isInteger(index.v);
        fail("TSR024", start, end, index.from, whole);
        const position = Number(index.v);
        fail(
          "TSR025",
          start,
          end,
          index.from,
          !whole || (position >= 0 && position < items.length),
        );
        return { v: items[position] ?? null, from: list.from };
      }
      default:
        throw new Underivable(`a ${expression.kind}`);
    }
  };
  const run = (block: readonly Statement[]): void => {
    for (const statement of block) {
      const store = storeOf(statement);
      if (store !== null) {
        const target =
          statement.kind === "assignmentStatement" &&
          statement.target.kind === "propertyAccessExpression"
            ? statement.target
            : null;
        const receiver = target === null ? null : value(target.object);
        if (target !== null && receiver !== null)
          fail(
            "TSR003",
            target.span.start.offset,
            target.span.end.offset,
            receiver.from,
            receiver.v !== null && typeof receiver.v === "object" && receiver.v.kind === "object",
          );
        const stored = value(store.value);
        const checked = stores.find((candidate) => candidate.so === statement.span.start.offset);
        if (checked !== undefined)
          fail(
            "TSR058",
            checked.valueSo,
            checked.valueEo,
            stored.from,
            fitsType(stored.v, checked.type),
          );
        if (
          target !== null &&
          receiver !== null &&
          typeof receiver.v === "object" &&
          receiver.v !== null &&
          receiver.v.kind === "object"
        ) {
          const property = receiver.v.properties.find(
            (property) => property.name === target.property.name,
          );
          if (content.requireExisting.some((entry) => entry.site === site(statement)))
            fail(
              "TSR017",
              target.span.start.offset,
              target.span.end.offset,
              receiver.from,
              property !== undefined,
            );
          if (property !== undefined) property.value = structuredClone(stored.v);
          else
            receiver.v.properties.push({
              name: target.property.name,
              value: structuredClone(stored.v),
            });
        } else if (target === null)
          env.set(store.name, { v: structuredClone(stored.v), from: stored.from });
      } else if (statement.kind === "repeatStatement") {
        const count = value(statement.count);
        const fits = typeof count.v === "number" && Number.isInteger(count.v) && count.v >= 0;
        fail(
          "TSR043",
          unwrap(statement.count).span.start.offset,
          unwrap(statement.count).span.end.offset,
          count.from,
          fits,
        );
        for (let round = 0; round < (fits ? Number(count.v) : 0); round += 1)
          run(statement.body.statements);
      } else if (statement.kind === "ifStatement") {
        const condition = unwrap(statement.condition);
        if (condition.kind !== "booleanLiteral")
          throw new Underivable("an `if` on a value that is not literal");
        if (condition.value) run(statement.thenBlock.statements);
        else if (statement.elseBlock !== null)
          run(
            statement.elseBlock.kind === "ifStatement"
              ? [statement.elseBlock]
              : statement.elseBlock.statements,
          );
      } else if (statement.kind === "forStatement") {
        // (the loop's own check of its source, TSR044, then each element, key or entry as the loop visits them)
        const source = value(statement.iterable);
        const iterated = source.v;
        const pair = statement.valueVariable !== null;
        const kind = typeof iterated === "object" && iterated !== null ? iterated.kind : null;
        const iterable = pair
          ? kind === "dict"
          : kind === "list" || kind === "set" || kind === "dict" || kind === "range";
        fail(
          "TSR044",
          unwrap(statement.iterable).span.start.offset,
          unwrap(statement.iterable).span.end.offset,
          source.from,
          iterable,
        );
        if (!iterable || typeof iterated !== "object" || iterated === null) continue;
        const visits: [SerializableRuntimeValue, SerializableRuntimeValue | null][] =
          iterated.kind === "list" || iterated.kind === "set"
            ? iterated.items.map((item) => [item, null])
            : iterated.kind === "dict"
              ? iterated.entries.map((entry) => [entry.key, entry.value])
              : iterated.kind === "range"
                ? Array.from(
                    {
                      length: Math.max(
                        0,
                        iterated.end - iterated.start + (iterated.inclusive ? 1 : 0),
                      ),
                    },
                    (_, at) => [iterated.start + at, null],
                  )
                : [];
        for (const [element, entry] of visits) {
          env.set(statement.variable.name, { v: structuredClone(element), from: source.from });
          if (pair)
            env.set(statement.valueVariable!.name, {
              v: structuredClone(entry),
              from: source.from,
            });
          run(statement.body.statements);
        }
      } else if (statement.kind === "expressionStatement") value(statement.expression);
      else if (statement.kind === "sayStatement") {
        const text = value(statement.value);
        said.push({
          text:
            text.v !== null && typeof text.v === "object"
              ? escapeMarkup(shown(text.v))
              : shown(text.v),
          at: statement.span.start.offset,
        });
      } else if (statement.kind === "exitStatement") throw new Stop(null);
      else throw new Underivable(`a ${statement.kind}`);
    }
  };
  let failure: string | null = null;
  try {
    run(statements);
  } catch (stop) {
    if (!(stop instanceof Stop)) throw stop;
    failure = stop.failure;
  }
  failure ??= first;
  return { run: { status: failure === null ? "halted" : "failed", failure, said }, events };
}
