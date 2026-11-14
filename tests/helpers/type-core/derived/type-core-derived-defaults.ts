// A typed call's default as the rules read it (F18): its value at the call's snapshot (#1760), the type a typed parse
// or load reads where it lands, and the sites of defaults lowered to instructions.

import type { Expression, Statement } from "../../../../src/ast.js";
import { VALUE_KIND_NAMES } from "../../../../src/value-kinds.js";
import { functionLandings } from "./derived-functions.js";
import {
  Underivable,
  declaredIn,
  type DerivedType,
  site,
  syntaxOf,
  allStatements,
  storeOf,
  unwrap,
  selected,
  admittedShape,
  partOf,
  nodesIn,
  unionTypes,
  writtenType,
  withoutNull,
  type DefaultOwner,
  fallbackOf,
  expressions,
} from "./type-core-derived.js";

/**
 * A default's value at its typed call (F18): literal data, typed ingress calls, and reads of variables at the call's
 * snapshot (`resolve`, #1760); never a place's joined shape (`sourceShape`). `null` is no structure (host data, a value
 * with none); an unmodelled expression that reads a variable is refused, never taken as open.
 */
export function literalType(
  expression: Expression,
  statements: readonly Statement[],
  seen = new Set<string>(),
  resolve: Resolve | null = null,
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
          : literalType(item, statements, seen, resolve),
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
          type: literalType(property.value, statements, seen, resolve) ?? {
            kind: "kinds",
            kinds: VALUE_KIND_NAMES,
          },
        })),
      };
    case "identifier":
    case "propertyAccessExpression":
    case "indexExpression":
      return readDefault(at, statements, resolve);
    case "loadExpression":
      return expectedType(at, statements, seen, resolve);
    case "callExpression":
      if (at.callee.kind === "identifier" && at.callee.name === "fromJson")
        return expectedType(at, statements, seen, resolve);
      return refuseVariableRead(at, statements, "a default that computes from a variable");
    default:
      return refuseVariableRead(at, statements, "a default that computes from a variable");
  }
}

/** No structure for an unmodelled expression, or its refusal when it reads a variable (`why`). */
function refuseVariableRead(
  expression: Expression,
  statements: readonly Statement[],
  why: string,
): null {
  if (variableReads(expression, statements)) throw new Underivable(why);
  return null;
}

/** Whether an expression reads a variable the program declares: an identifier in a value's place, not a name. */
function variableReads(expression: Expression, statements: readonly Statement[]): boolean {
  const nodes = nodesIn(expression, false);
  const names = new Set<unknown>();
  for (const node of nodes) {
    if (node.kind === "propertyAccessExpression") names.add(node.property);
    if (node.kind === "objectLiteral")
      for (const property of node.properties) names.add(property.name);
    if (node.kind === "callExpression")
      for (const argument of node.arguments)
        if (argument.kind === "namedArgument") names.add(argument.name);
  }
  return nodes.some(
    (node) =>
      node.kind === "identifier" &&
      !names.has(node) &&
      declaredIn(statements, node, node.name) !== undefined,
  );
}

/**
 * A typed default that reads a value (F18): a host value has no structure; a variable's (a `let`'s) value is its state at
 * the typed call, which `resolve` reads from the program's snapshots (`snapshotsOf`, #1760). Without a
 * call to read at (another rule's literal) such a read is underivable, as it is wherever the reader refuses.
 */
function readDefault(
  read: Expression,
  statements: readonly Statement[],
  resolve: Resolve | null,
): DerivedType | null {
  const steps: string[] = [];
  let root = unwrap(read);
  while (root.kind === "propertyAccessExpression" || root.kind === "indexExpression") {
    steps.unshift(root.kind === "propertyAccessExpression" ? root.property.name : INDEX);
    root = unwrap(root.object);
  }
  if (root.kind !== "identifier")
    return refuseVariableRead(root, statements, "a read through an unmodelled value");
  const declared = declaredIn(statements, root, root.name);
  if (declared === undefined) return null;
  // (a parameter's value is its call's: its written type, as the rules check it there; without one, underivable)
  if (declared?.kind === "functionParameter") {
    if (declared.typeAnnotation === null || steps.length > 0)
      throw new Underivable(
        "a default that reads a parameter without a written type, or a part of one",
      );
    return writtenType(declared.typeAnnotation);
  }
  if (resolve === null) throw new Underivable("a default that reads a variable");
  const snap = resolve(root.name);
  // (a bare read takes its written type where its syntax gives one, a read through a part the snapshot's)
  if (steps.length > 0 || snap.chain === undefined) return valueType(partAt(snap, steps));
  return snap.chain.t === "whole" ? snap.chain.type : chained(valueType(snap), snap.chain);
}

/** Whether a default is a read rooted at a variable the program declares. */
function readsVariable(expression: Expression, statements: readonly Statement[]): boolean {
  let root = selected(expression);
  while (root?.kind === "propertyAccessExpression" || root?.kind === "indexExpression")
    root = unwrap(root.object);
  return root?.kind === "identifier" && declaredIn(statements, root, root.name) !== undefined;
}

/**
 * A variable's abstract value in the snapshot reader (#1760): a checked type, `null` alone, no structure (`open`: host
 * data, or a value no source structure settles), or refused with why the reader does not model it.
 */
export type Snap = (
  | { readonly t: "type"; readonly type: DerivedType }
  | { readonly t: "open" }
  | { readonly t: "refused"; readonly why: string }
) & {
  /** A typed call's capture of a variable: its default's written type where its syntax gives one (`chainOf`). */
  readonly chain?: Chain;
};

/**
 * A default's written type as its syntax gives it (ADR 0021 rule 2.6, "its default's type"; #1072 step 0), derived
 * apart from the core's `writtenDefault`: a written binding's type, at every level (`whole`); an unwritten `let`'s start
 * value's; a list or set literal's elements, or an object literal's properties, where every cell gives the same
 * (`null`: none there, the level and those below it read as the snapshot reads them).
 */
export type Chain =
  | { readonly t: "whole"; readonly type: DerivedType }
  | { readonly t: "list" | "set"; readonly element: Chain | null }
  | {
      readonly t: "object";
      readonly properties: readonly { readonly name: string; readonly chain: Chain | null }[];
    };

/** A snapshot's type with a chain's levels over it: the chain's where it gives one, the snapshot's elsewhere. */
function chained(type: DerivedType | null, chain: Chain | null): DerivedType | null {
  if (chain === null) return type;
  if (chain.t === "whole") return chain.type;
  if (type === null) return null;
  if (chain.t === "object")
    return type.kind !== "object"
      ? type
      : {
          ...type,
          properties: type.properties.map((property) => ({
            ...property,
            type:
              chained(
                property.type,
                chain.properties.find((each) => each.name === property.name)?.chain ?? null,
              ) ?? ALL,
          })),
        };
  return type.kind === "list" || type.kind === "set"
    ? { ...type, element: chained(type.element, chain.element) }
    : type;
}
export type Resolve = (name: string) => Snap;
/** An index step of a snapshot's path, apart from every property name (a property may be named `element`). */
export const INDEX = "[]";
export type State = ReadonlyMap<string, Snap>;
export const OPEN: Snap = { t: "open" };
export const NULL: DerivedType = { kind: "kinds", kinds: ["null"] };

export const ALL: DerivedType = { kind: "kinds", kinds: VALUE_KIND_NAMES };
export const isAll = (type: DerivedType) =>
  type.kind === "kinds" && type.kinds.length === VALUE_KIND_NAMES.length;

/**
 * The snapshot's value as the call's default takes it, as a default's own structure (`literalType`): `null` beside other
 * kinds kept; `null` alone or no structure open at the root, every kind as a part.
 */
function valueType(snap: Snap): DerivedType | null {
  if (snap.t === "refused") throw new Underivable(snap.why);
  if (snap.t === "open" || isAll(snap.type)) return null;
  // (a part that is only `null`: every kind as a property, no element type as a collection's element)
  const nullOnly = (type: DerivedType) =>
    type.kind === "kinds" && type.kinds.every((kind) => kind === "null");
  const part = (type: DerivedType): DerivedType => {
    if (type.kind === "object")
      return {
        ...type,
        properties: type.properties.map((each) => ({
          ...each,
          type: nullOnly(each.type) ? ALL : part(each.type),
        })),
      };
    if (type.kind === "union") return { ...type, members: type.members.map(part) };
    if (type.kind === "kinds") return type;
    return {
      ...type,
      element: type.element === null || nullOnly(type.element) ? null : part(type.element),
    };
  };
  return snap.type.kind === "kinds" && snap.type.kinds.every((kind) => kind === "null")
    ? null
    : part(snap.type);
}

/** The part of a value at `steps` (property names, `INDEX`): open where the value holds no such part. */
export function partAt(snap: Snap, steps: readonly string[]): Snap {
  if (snap.t !== "type" || steps.length === 0) return snap;
  const [step, ...rest] = steps;
  const parts = (type: DerivedType): DerivedType[] => {
    if (type.kind === "union") return type.members.flatMap(parts);
    if (step === INDEX && type.kind !== "kinds" && type.kind !== "object")
      return type.element === null ? [] : [type.element];
    if (type.kind === "object") {
      const property = type.properties.find((each) => each.name === step);
      return property === undefined ? [] : [property.type];
    }
    return [];
  };
  const found = parts(snap.type);
  if (found.length === 0) return OPEN;
  return partAt({ t: "type", type: unionTypes(found) }, rest);
}
/** Each walked typed call's snapshot, by its node (`atCall`). */
export const snapshotAt = new WeakMap<Expression, Resolve>();

/** How the defaults of a typed call read the program's variables: at the call's snapshot. */
function atCall(owner: Expression): Resolve {
  return (name) => {
    const resolve = snapshotAt.get(owner);
    if (resolve === undefined)
      throw new Underivable("a typed call the snapshot reader does not reach");
    return resolve(name);
  };
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

export function expectedType(
  owner: DefaultOwner,
  statements: readonly Statement[],
  seen = new Set<string>(),
  given: Resolve | null = null,
): DerivedType | null {
  // (a default's reads read the program at this call: in the walk, the walk's state; elsewhere, the call's snapshot)
  const resolve = given ?? atCall(owner);
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
            : literalType(fallback, statements, next, resolve),
        );
  const literal = fallback === null ? null : literalType(fallback, statements, next, resolve);
  // (a variable's snapshot keeps its null beside its other kinds, r3's B2 on #1755; a literal's null is dropped)
  return literal === null
    ? null
    : readsVariable(fallback!, statements)
      ? literal
      : withoutNull(literal);
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

/**
 * The written type at `path` below the owner where the owner lands directly in a `let` or variable with a written type
 * (ADR 0021 7.3), through list and set elements, `otherwise` and the `default:` of a call or a load, which lands where
 * its result does; `undefined` where it lands in none.
 */
export function writtenLanding(
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
      statement.kind === "letStatement" ? statement : declaredIn(statements, statement, store.name);
    if (declaration === null || declaration === undefined || declaration.typeAnnotation === null)
      continue;
    const found = landsIn(store.value, writtenType(declaration.typeAnnotation));
    if (found !== undefined)
      return path.reduce<DerivedType | null>((type, step) => partOf(type, step), found);
  }
  for (const { value, written } of functionLandings(statements)) {
    const found = landsIn(value, writtenType(written));
    if (found !== undefined)
      return path.reduce<DerivedType | null>((type, step) => partOf(type, step), found);
  }
  return undefined;
}
