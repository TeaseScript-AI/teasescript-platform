// S3's store shapes: a place's source structure, joined from its sources and stores, and the checked type at each path
// of a store's destination (`typeOf`).

import type { Expression, Statement } from "../../../../src/ast.js";
import { VALUE_KIND_NAMES } from "../../../../src/value-kinds.js";
import {
  Underivable,
  declaredIn,
  type DerivedType,
  storeOf,
  unwrap,
  admittedShape,
  partOf,
  unionTypes,
  writtenType,
  fallbackOf,
} from "./type-core-derived.js";
import { literalType, expectedType } from "./type-core-derived-defaults.js";

/**
 * Source structure carried by a selection: the joined shape of a place's sources and stores, as the rule records read it;
 * unknown operands contribute no settled structure. It is never a value at a typed call's snapshot: a default's value at
 * its call is `literalType`'s, which reads variables through the snapshot reader (#1760).
 */
export function sourceShape(
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
      // (the name's declaration in its scope, and only the stores into that one)
      const declared = declaredIn(statements, at, at.name);
      if (declared?.kind === "letStatement" && declared.typeAnnotation !== null)
        return writtenType(declared.typeAnnotation);
      const same = (statement: Statement): boolean =>
        declaredIn(statements, statement, at.name) === declared;
      let shape = admittedShape(
        statements.flatMap((statement) => {
          const store = storeOf(statement);
          return store?.name === at.name && same(statement)
            ? [sourceShape(store.value, statements, next)]
            : [];
        }),
      );
      for (const statement of statements) {
        const store = storeOf(statement);
        if (store?.name.startsWith(`${at.name}.`) && same(statement))
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
      if (callee.kind === "identifier" && callee.name === "fromJson") {
        // (its value is the JSON read at its expected type or its default, each as the call reads the default: its
        // snapshot there, which the expected type is where it has one, not the default variable's joined stores)
        const expected = expectedType(at, statements, seen);
        return admittedShape([
          expected,
          fallbackOf(at) === null || expected !== null
            ? null
            : sourceShape(fallbackOf(at)!, statements, seen),
        ]);
      }
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
  // (a store into a property the object does not have yet adds it, as both compilers' plans type the object)
  const added = type.properties.some((property) => property.name === path[0])
    ? null
    : updatedShape(null, path.slice(1), value);
  return {
    kind: "object",
    properties: [
      ...type.properties.map((property) => ({
        name: property.name,
        type:
          property.name === path[0]
            ? updatedShape(property.type, path.slice(1), value)!
            : property.type,
      })),
      ...(added === null ? [] : [{ name: path[0]!, type: added }]),
    ],
  };
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
 * S3's lowering of a store's checks by rule: the destination's structure at each target path (its written type,
 * else its value's literal structure), with the record's required kinds at each, `null` kept.
 */
export function typeOf(
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
