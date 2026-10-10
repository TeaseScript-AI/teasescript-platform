import type { IrExpression, IrStatement, MigrationDiagnostic } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

/**
 * Legacy getImage() gave null where neither the webcam nor the file chooser gave a picture, and a script that then used
 * the picture without testing it, `file.toLowerCase()`, failed there. takePhoto() returns null in that case too; where
 * the file reads a method, property, or element of the variable that keeps the photo and never tests it for null, the
 * session ends where the legacy script stopped (owner decision 2026-10-10), with a note: right after a photo that did
 * not come, and before a later use that a test there does not cover. A file that tests the variable keeps its own
 * handling, and one that only passes the photo on or shows it stays as it is.
 */
export function withPhotoEnds(
  statements: IrStatement[],
  note: (statement: IrStatement) => MigrationDiagnostic,
): IrStatement[] {
  const { tested, dereferenced, photos } = photoUses(statements);
  const ended = new Set([...photos].filter((name) => !tested.has(name) && dereferenced.has(name)));
  if (ended.size === 0) return statements;
  const guard = (name: string, at: IrStatement): IrStatement[] => {
    const diagnostic = note(at);
    return [
      {
        kind: "comment",
        text: `// NOTE ${diagnostic.code}${at.span === null ? "" : ` line ${at.span.line}`}: ${diagnostic.message}`,
        trailing: false,
        span: at.span,
      },
      {
        kind: "if",
        condition: {
          kind: "binary",
          operator: "==",
          left: { kind: "variable", name },
          right: { kind: "literal", value: null },
        },
        then: [{ kind: "exit", span: at.span }],
        else: [],
        span: at.span,
      },
    ];
  };
  // `known` holds the photo variables that a guard has shown to hold a photo where the block starts.
  const block = (items: IrStatement[], known: ReadonlySet<string>): IrStatement[] => {
    const safe = new Set(known);
    const result: IrStatement[] = [];
    for (const item of items) {
      for (const name of ownDereferences(item))
        if (ended.has(name) && !safe.has(name)) {
          result.push(...guard(name, item));
          safe.add(name);
        }
      // A loop's body may run again after a change of the variable that its end left untested.
      const loop = item.kind === "while" || item.kind === "for" || item.kind === "repeat";
      const assigned = assignedNames(item);
      // A function's body runs where it is called, which shows nothing about its photo variables.
      const inner =
        item.kind === "function"
          ? new Set<string>()
          : loop
            ? new Set([...safe].filter((name) => !assigned.has(name)))
            : safe;
      const next = withNestedBlocks(item, (body) => block(body, inner));
      result.push(next);
      for (const name of assigned) safe.delete(name);
      const photo = photoTarget(next);
      if (photo !== null && ended.has(photo)) {
        result.push(...guard(photo, next));
        safe.add(photo);
      }
    }
    return result;
  };
  return block(statements, new Set());
}

/** The variables whose method, property, or element a statement's own expressions read. */
function ownDereferences(statement: IrStatement): Set<string> {
  const names = new Set<string>();
  const visit = (value: IrExpression): IrExpression => {
    if (
      (value.kind === "methodCall" || value.kind === "property" || value.kind === "index") &&
      value.target.kind === "variable"
    )
      names.add(value.target.name);
    return mapChildren(value, visit);
  };
  mapOwnExpressions(statement, visit);
  return names;
}

/** The variables that a statement or the blocks inside it set. */
function assignedNames(statement: IrStatement): Set<string> {
  const names = new Set<string>();
  const visit = (item: IrStatement): void => {
    if (item.kind === "let") names.add(item.name);
    if (item.kind === "assign" && item.target.kind === "variable") names.add(item.target.name);
    withNestedBlocks(item, (body) => {
      for (const inner of body) visit(inner);
      return body;
    });
  };
  visit(statement);
  return names;
}

/** The variable a statement stores a photo in, `file = takePhoto()`; null for any other statement. */
function photoTarget(statement: IrStatement): string | null {
  const value = statement.kind === "let" || statement.kind === "assign" ? statement.value : null;
  if (value?.kind !== "call" || value.name !== "takePhoto" || value.local === true) return null;
  if (statement.kind === "let") return statement.name;
  return statement.kind === "assign" &&
    statement.operator === "=" &&
    statement.target.kind === "variable"
    ? statement.target.name
    : null;
}

/**
 * The variables that the statements compare with null or test for truth (a condition of the variable alone, `not`, or
 * the truth helper), anywhere, which may be the script's own handling of a missing photo; and those whose method,
 * property, or element they read, which fails on null.
 */
function photoUses(statements: readonly IrStatement[]): {
  tested: Set<string>;
  dereferenced: Set<string>;
  photos: Set<string>;
} {
  const names = new Set<string>();
  const dereferenced = new Set<string>();
  const photos = new Set<string>();
  const nameOf = (value: IrExpression | undefined): string | null =>
    value?.kind === "variable" ? value.name : null;
  const isNull = (value: IrExpression): boolean => value.kind === "literal" && value.value === null;
  const expression = (value: IrExpression, condition: boolean): void => {
    if (condition && nameOf(value) !== null) names.add(nameOf(value)!);
    if (value.kind === "binary" && (value.operator === "==" || value.operator === "!=")) {
      if (isNull(value.right) && nameOf(value.left) !== null) names.add(nameOf(value.left)!);
      if (isNull(value.left) && nameOf(value.right) !== null) names.add(nameOf(value.right)!);
    }
    const receiver =
      value.kind === "methodCall" || value.kind === "property" || value.kind === "index"
        ? nameOf(value.target)
        : null;
    if (receiver !== null) dereferenced.add(receiver);
    if (value.kind === "unary" && value.operator === "not" && nameOf(value.value) !== null)
      names.add(nameOf(value.value)!);
    if (
      value.kind === "call" &&
      value.name === "sexscriptLegacyTruth" &&
      nameOf(value.positional[0]) !== null
    )
      names.add(nameOf(value.positional[0])!);
    const logical =
      value.kind === "binary" && (value.operator === "and" || value.operator === "or");
    mapChildren(value, (child) => {
      expression(child, logical || (value.kind === "unary" && value.operator === "not"));
      return child;
    });
  };
  const block = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      const photo = photoTarget(item);
      if (photo !== null) photos.add(photo);
      mapOwnExpressions(item, (value) => {
        expression(
          value,
          (item.kind === "if" || item.kind === "while") && value === item.condition,
        );
        return value;
      });
      withNestedBlocks(item, (body) => {
        block(body);
        return body;
      });
    }
  };
  block(statements);
  return { tested: names, dereferenced, photos };
}
