// What a record's plan checks, derived from the record and its source (`derive`): its checked stores, its discharges,
// its content, and the type each fallback obligation checks.

import type { Expression, Statement } from "../../../../src/ast.js";
import { listProperty } from "../../../../src/list-methods.js";
import type { CompactRecord } from "../../type-core-records.js";
import {
  Underivable,
  type DerivedType,
  type DerivedStore,
  type Discharge,
  type DerivedContent,
  site,
  derivedText,
  repairsRecord,
  type Syntax,
  allStatements,
  storeOf,
  targetName,
  unwrap,
  selected,
  partOf,
  unionTypes,
  withoutNull,
  type DefaultOwner,
  fallbackOf,
  expressions,
} from "./type-core-derived.js";
import { expectedType, writtenLanding } from "./type-core-derived-defaults.js";
import { sourceShape, typeOf } from "./type-core-derived-shapes.js";
import { snapshotsOf } from "./type-core-derived-snapshots.js";

/**
 * Whether `at` is the site of an operand of a unary or binary operator but `otherwise`, of such an operation itself, or of
 * an `if` condition, inside its parentheses.
 */
function operatorOperand(
  all: readonly Expression[],
  statements: readonly Statement[],
  at: string,
): boolean {
  return (
    all.some(
      (expression) =>
        (expression.kind === "unaryExpression" && site(unwrap(expression.operand)) === at) ||
        (expression.kind === "binaryExpression" &&
          expression.operator !== "otherwise" &&
          [expression, expression.left, expression.right].some(
            (part) => site(unwrap(part)) === at,
          )),
    ) ||
    statements.some(
      (statement) => statement.kind === "ifStatement" && site(unwrap(statement.condition)) === at,
    )
  );
}

/** Whether a type holds `null`. */
function holdsNull(type: DerivedType): boolean {
  return type.kind === "kinds"
    ? type.kinds.includes("null")
    : type.kind === "union" && type.members.some(holdsNull);
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
  const at = (
    shape: DerivedType | null,
    remaining: readonly string[],
    literal: Expression | null,
  ): DerivedType => {
    if (remaining.length === 0) {
      const kinds = nullable && !against.includes("null") ? [...against, "null"] : against;
      // (C10 publishes a collection's own kind alone where no literal holds the value: #1538 checks it whole)
      return literal === null && kinds.some(isCollectionKind)
        ? completedType(owner, path, kinds, statements)
        : { kind: "kinds", kinds };
    }
    const [step, ...rest] = remaining;
    if (step !== "element")
      return {
        kind: "object",
        properties: [{ name: step!, type: at(partOf(shape, step!), rest, null) }],
      };
    const collection =
      shape?.kind === "union"
        ? shape.members.find(
            (member) => member.kind === "list" || member.kind === "set" || member.kind === "dict",
          )
        : shape;
    if (collection?.kind !== "list" && collection?.kind !== "set" && collection?.kind !== "dict")
      throw new Underivable("a fallback element check without a source-carried collection");
    const first =
      (literal?.kind === "listLiteral" || literal?.kind === "setLiteral") &&
      literal.elements.length > 0
        ? collectionLiteral(literal.elements[0]!)
        : null;
    return { kind: collection.kind, element: at(collection.element, rest, first) };
  };
  return at(root, path, collectionLiteral(value));
}

function isCollectionKind(kind: string): boolean {
  return kind === "list" || kind === "set" || kind === "dict";
}

/** The collection literal a value is, through parentheses and constant indexes of list literals, or `null`. */
function collectionLiteral(expression: Expression): Expression | null {
  const at = selected(expression);
  return at?.kind === "listLiteral" || at?.kind === "setLiteral" || at?.kind === "dictLiteral"
    ? at
    : null;
}

/**
 * #1538 (ADR 0021 7.2): a fallback level no literal holds, at which C10 publishes a collection's own kind alone, is
 * checked against the whole structure of the value the default stands in for (a `get`'s receiver's element, an
 * `otherwise`'s left without `null`), C10's scalars and `null` beside it; whole numbers there are numbers too
 * except at a level a written type reaches (`writtenAt`).
 */
function completedType(
  owner: DefaultOwner,
  path: readonly string[],
  kinds: readonly string[],
  statements: readonly Statement[],
): DerivedType {
  if (path.some((step) => step !== "element"))
    throw new Underivable("a completed fallback below a property");
  const callee = owner.kind === "callExpression" ? unwrap(owner.callee) : null;
  const [value, steps] =
    owner.kind === "binaryExpression"
      ? [owner.left, path]
      : callee?.kind === "propertyAccessExpression" && callee.property.name === "get"
        ? [callee.object, ["element", ...path]]
        : [null, path];
  if (value === null) throw new Underivable("a completed fallback of another owner");
  let shape = sourceShape(value, statements);
  for (const step of steps) shape = partOf(shape, step);
  if (shape !== null && owner.kind === "binaryExpression" && path.length === 0)
    shape = withoutNull(shape);
  const held = (shape?.kind === "union" ? shape.members : shape === null ? [] : [shape]).filter(
    (member) => isCollectionKind(member.kind),
  );
  if (held.length === 0) throw new Underivable("a completed fallback without a collection");
  const family = (type: DerivedType, below: readonly string[]): DerivedType => {
    if (type.kind === "kinds")
      return type.kinds.includes("integer") &&
        !type.kinds.includes("number") &&
        !writtenAt(value, [...steps, ...below], statements)
        ? { kind: "kinds", kinds: [...type.kinds, "number"] }
        : type;
    if (type.kind === "union")
      return unionTypes(type.members.map((member) => family(member, below)));
    if (type.kind === "object")
      return {
        ...type,
        properties: type.properties.map((property) => ({
          name: property.name,
          type: family(property.type, [...below, property.name]),
        })),
      };
    return {
      kind: type.kind,
      element: type.element === null ? null : family(type.element, [...below, "element"]),
    };
  };
  const scalars = kinds.filter((kind) => !isCollectionKind(kind));
  return unionTypes([
    ...held.map((member) => family(member, [])),
    ...(scalars.length > 0 ? [{ kind: "kinds", kinds: scalars } as const] : []),
  ]);
}

/**
 * Whether a value's level (by its steps) is a written type's (A4, ADR 0021 1.3): a written declaration's, through
 * parentheses, element reads, `get`s, a literal's elements and copies; an `otherwise` chain's where any operand that
 * brings a collection is, all of one structure.
 */
function writtenAt(
  expression: Expression,
  steps: readonly string[],
  statements: readonly Statement[],
  seen: ReadonlySet<string> = new Set(),
): boolean {
  const at = unwrap(expression);
  switch (at.kind) {
    case "identifier": {
      if (seen.has(at.name)) return false;
      const declared = statements.some(
        (statement) =>
          statement.kind === "letStatement" &&
          statement.name.name === at.name &&
          statement.typeAnnotation !== null,
      );
      if (declared) return true;
      const values = statements.flatMap((statement) => {
        const store = storeOf(statement);
        return store?.name === at.name ? [store.value] : [];
      });
      const next = new Set([...seen, at.name]);
      return (
        values.length > 0 && values.every((value) => writtenAt(value, steps, statements, next))
      );
    }
    case "indexExpression":
      return writtenAt(at.object, ["element", ...steps], statements, seen);
    case "callExpression": {
      const callee = unwrap(at.callee);
      return (
        callee.kind === "propertyAccessExpression" &&
        callee.property.name === "get" &&
        writtenAt(callee.object, ["element", ...steps], statements, seen)
      );
    }
    case "listLiteral":
    case "setLiteral":
      return (
        steps[0] === "element" &&
        at.elements.length > 0 &&
        at.elements.every((element) => writtenAt(element, steps.slice(1), statements, seen))
      );
    case "binaryExpression": {
      if (at.operator !== "otherwise") return false;
      // (a level of a join is written where any operand that brings a collection is; the core admits a join of different
      // structures by its copies, which these rules do not derive)
      const operands = [at.left, at.right]
        .map((operand) => [operand, sourceShape(operand, statements)] as const)
        .filter(
          ([, shape]) =>
            shape === null ||
            (shape.kind === "union" ? shape.members : [shape]).some((member) =>
              isCollectionKind(member.kind),
            ),
        );
      const texts = new Set(
        operands.map(([, shape]) =>
          shape === null ? "" : derivedText(withoutNull(shape) ?? shape),
        ),
      );
      if (texts.size > 1) throw new Underivable("a join of different structures");
      return operands.some(([operand]) => writtenAt(operand, steps, statements, seen));
    }
    default:
      return false;
  }
}

/** Every obligation is mapped by S3; S7 content is owed by that map and F18, never by the emitted plan. */
export function derive(
  syntax: Syntax,
  record: CompactRecord,
): {
  readonly stores: readonly DerivedStore[];
  readonly discharges: readonly Discharge[];
  readonly content: DerivedContent;
} {
  const { source } = syntax;
  // (each typed call's snapshot, walked once over the program's own nesting before any default is read, #1760)
  snapshotsOf(syntax.statements);
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
    } else if (
      (check.kind === "copy-type" ||
        // (C1's check of a copied integer that may be null, at its store's value: the store's own, as a copy type's)
        (check.kind === "null-check" &&
          check.against.length > 0 &&
          check.against.every((kind) => kind === "integer") &&
          statements.some((candidate) => {
            const store = storeOf(candidate);
            return (
              store !== null &&
              site(unwrap(store.value)) === at &&
              (check.target === store.name || check.target.startsWith(`${store.name}.`))
            );
          }))) &&
      !check.against.includes("unknown")
    ) {
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
    } else if (
      check.kind === "integer-check" ||
      // (a count's or an index's possible null that a check on every route the compiler cannot keep leaves to the run,
      // V30 §13, #1073 PR 4: the runtime's own check of the count or the index takes it at the use, as an integer's)
      (check.kind === "null-check" &&
        check.against.length > 0 &&
        check.against.every((kind) => kind === "integer"))
    ) {
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
    } else if (
      (check.kind === "operand" || check.kind === "null-check") &&
      operatorOperand(all, statements, at)
    ) {
      // C3, C4: an operand of an operator or a condition, or the operation where no operand alone offends, which the
      // operation's own check takes where it runs (`derived-operators.ts`)
      native("operator", at);
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
        // (a method's receiver that may be null, `xs[0].sort()`: the runtime's own check of the call's receiver, at the call)
        const method =
          read === undefined
            ? all.find(
                (expression) =>
                  expression.kind === "callExpression" &&
                  expression.callee.kind === "propertyAccessExpression" &&
                  (site(unwrap(expression.callee.object)) === at || site(expression) === at),
              )
            : undefined;
        if (read === undefined && method?.kind === "callExpression") native("member", site(method));
        else if (read === undefined)
          throw new Underivable(`a member obligation at ${at} without a member`);
        else native("member", site(read));
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
