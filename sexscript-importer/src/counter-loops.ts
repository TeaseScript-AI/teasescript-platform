import type { IrExpression, IrStatement } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

/**
 * Idiomatic output (owner direction 2026-10-08): a counter loop, a Java `for (int i = 0; i < n; i++)` or a `while` loop
 * the legacy author wrote in that shape, `let i = 0` then `while i < n { ...; i += 1 }`, goes through a range,
 * `for i in 0..n { ... }` (`..=` for `<=`). That holds where it visits the same values: the counter starts at a whole
 * number, nothing in the loop sets it but the step at its end, which every `continue` of the loop takes first, and the
 * bound is a whole number that nothing in the loop changes, which a range reads once where the condition read it on every
 * pass. A range counts up only, so a loop that counts down stays a `while`. The counter is its loops' own: the `let`
 * that declares it starts one, and the rest of its block names it only in counter loops, which a later loop of the
 * same counter is too; for the file's top level, no function names it without declaring its own.
 */
export function withCounterLoops(statements: IrStatement[]): IrStatement[] {
  // The loops that go through ranges: those of a counter that a `let` declares, where every use of that counter in the
  // rest of the `let`'s block lies in its counter loops, and, for a counter of the file's top level, no function that
  // does not declare one of its own uses it.
  const ranged = new Set<IrStatement>();
  const functions = statements.filter(
    (item): item is Extract<IrStatement, { kind: "function" }> => item.kind === "function",
  );
  const visit = (items: readonly IrStatement[], locals: ReadonlySet<string>): void => {
    items.forEach((item, index) => {
      const loop = counterLoop(items, index + 1, statements, locals);
      if (item.kind === "let" && loop !== null && items[index + 1] !== undefined) {
        const scope = items.slice(index);
        const loops: IrStatement[] = [];
        let inLoops = 0;
        const collect = (block: readonly IrStatement[]): void => {
          block.forEach((statement, position) => {
            const found = counterLoop(block, position, statements, locals);
            if (found !== null && found.counter === loop.counter) {
              loops.push(statement);
              inLoops += nameUses([block[position - 1]!, statement]).get(loop.counter) ?? 0;
            }
            if (statement.kind !== "function")
              withNestedBlocks(statement, (body) => {
                collect(body);
                return body;
              });
          });
        };
        collect(scope);
        const outside =
          items === statements
            ? functions
                .filter((fn) => !functionLocals(fn).has(loop.counter))
                .reduce((sum, fn) => sum + (nameUses(fn.body).get(loop.counter) ?? 0), 0)
            : 0;
        const uses = nameUses(scope.filter((statement) => statement.kind !== "function"));
        if (outside === 0 && (uses.get(loop.counter) ?? 0) === inLoops)
          for (const statement of loops) ranged.add(statement);
      }
      if (item.kind === "function") visit(item.body, functionLocals(item));
      else
        withNestedBlocks(item, (body) => {
          visit(body, locals);
          return body;
        });
    });
  };
  visit(statements, new Set());
  const rewrite = (items: IrStatement[], locals: ReadonlySet<string>): IrStatement[] => {
    const result: IrStatement[] = [];
    items.forEach((item, index) => {
      const loop = ranged.has(item) ? counterLoop(items, index, statements, locals) : null;
      if (loop !== null) {
        result.pop();
        result.push({
          kind: "for",
          variable: loop.counter,
          collection: { kind: "range", from: loop.from, to: loop.to, inclusive: loop.inclusive },
          body: rewrite(loop.body, locals),
          span: item.span,
        });
        return;
      }
      if (item.kind === "function") {
        result.push({ ...item, body: rewrite(item.body, functionLocals(item)) });
        return;
      }
      result.push(withNestedBlocks(item, (body) => rewrite(body, locals)));
    });
    return result;
  };
  return rewrite(statements, new Set());
}

/**
 * How often the statements name each variable: reading or setting it, or declaring it. A `for` loop's variables are its
 * own, apart from any other of their names, so the loop's uses of them count for none.
 */
function nameUses(statements: readonly IrStatement[]): Map<string, number> {
  const uses = new Map<string, number>();
  const visit = (items: readonly IrStatement[], own: ReadonlySet<string>): void => {
    const add = (name: string): void => {
      if (!own.has(name)) uses.set(name, (uses.get(name) ?? 0) + 1);
    };
    const value = (child: IrExpression): IrExpression => {
      if (child.kind === "variable") add(child.name);
      return mapChildren(child, value);
    };
    for (const item of items) {
      if (item.kind === "let") add(item.name);
      mapOwnExpressions(item, value);
      const inner =
        item.kind === "for"
          ? new Set([
              ...own,
              item.variable,
              ...(item.valueVariable === undefined ? [] : [item.valueVariable]),
            ])
          : own;
      withNestedBlocks(item, (body) => {
        visit(body, inner);
        return body;
      });
    }
  };
  visit(statements, new Set());
  return uses;
}

/** The parameters and `let`s of a function, which no other function can set. */
function functionLocals(item: Extract<IrStatement, { kind: "function" }>): Set<string> {
  const locals = new Set(item.parameters.map((parameter) => parameter.name));
  const visit = (items: readonly IrStatement[]): void => {
    for (const statement of items) {
      if (statement.kind === "let") locals.add(statement.name);
      if (statement.kind === "function") continue;
      withNestedBlocks(statement, (body) => {
        visit(body);
        return body;
      });
    }
  };
  visit(item.body);
  return locals;
}

interface CounterLoop {
  counter: string;
  from: IrExpression;
  to: IrExpression;
  inclusive: boolean;
  /** The body without its steps. */
  body: IrStatement[];
}

/** The counter loop that `items[index]` is with the statement before it, which starts its counter; else null. */
function counterLoop(
  items: readonly IrStatement[],
  index: number,
  file: readonly IrStatement[],
  locals: ReadonlySet<string>,
): CounterLoop | null {
  const loop = items[index];
  const start = index > 0 ? items[index - 1] : undefined;
  if (loop?.kind !== "while" || start === undefined) return null;
  const condition = loop.condition;
  if (
    condition.kind !== "binary" ||
    (condition.operator !== "<" && condition.operator !== "<=") ||
    condition.left.kind !== "variable"
  )
    return null;
  const counter = condition.left.name;
  const from =
    start.kind === "let" && start.name === counter && start.type === undefined
      ? start.value
      : start.kind === "assign" &&
          start.operator === "=" &&
          start.target.kind === "variable" &&
          start.target.name === counter
        ? start.value
        : null;
  if (from === null || !isWhole(from, file) || names(from).has(counter)) return null;
  const to = condition.right;
  const last = loop.body.at(-1);
  if (last === undefined || !isStep(last, counter)) return null;
  const body = withoutSteps(loop.body.slice(0, -1), counter);
  if (body === null || setsName(body, counter) || hasBlockAction(body)) return null;
  // The bound is read once: whole, free of effects, and kept by the loop.
  if (!isWhole(to, file) || !keepsBound(to, body, locals) || names(to).has(counter)) return null;
  return { counter, from, to, inclusive: condition.operator === "<=", body };
}

/** `i += 1` or `i = i + 1`. */
function isStep(statement: IrStatement, counter: string): boolean {
  if (statement.kind !== "assign" || statement.target.kind !== "variable") return false;
  if (statement.target.name !== counter) return false;
  const one = (value: IrExpression): boolean => value.kind === "literal" && value.value === 1;
  if (statement.operator === "+=") return one(statement.value);
  return (
    statement.operator === "=" &&
    statement.value.kind === "binary" &&
    statement.value.operator === "+" &&
    statement.value.left.kind === "variable" &&
    statement.value.left.name === counter &&
    one(statement.value.right)
  );
}

/**
 * The loop body without the step before each of its own `continue`s, which a range takes by itself; null where a
 * `continue` of the loop comes without it.
 */
function withoutSteps(body: readonly IrStatement[], counter: string): IrStatement[] | null {
  let complete = true;
  const strip = (items: readonly IrStatement[]): IrStatement[] => {
    const result: IrStatement[] = [];
    for (const item of items) {
      if (item.kind === "continue") {
        const before = result.at(-1);
        if (before === undefined || !isStep(before, counter)) complete = false;
        else result.pop();
        result.push(item);
        continue;
      }
      // A nested loop's own `continue`s go on with that loop.
      if (item.kind === "while" || item.kind === "for" || item.kind === "repeat") {
        result.push(item);
        continue;
      }
      result.push(withNestedBlocks(item, strip));
    }
    return result;
  };
  const stripped = strip(body);
  return complete ? stripped : null;
}

/** Whether a statement, or one in it, sets or declares the name. */
function setsName(statements: readonly IrStatement[], name: string): boolean {
  let found = false;
  const visit = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      if (item.kind === "let" && item.name === name) found = true;
      if (item.kind === "assign" && item.target.kind === "variable" && item.target.name === name)
        found = true;
      if (item.kind === "for" && (item.variable === name || item.valueVariable === name))
        found = true;
      withNestedBlocks(item, (body) => {
        visit(body);
        return body;
      });
    }
  };
  visit(statements);
  return found;
}

/** Whether the body creates a block that runs later, such as a button's action, which keeps its pass's counter. */
function hasBlockAction(statements: readonly IrStatement[]): boolean {
  return JSON.stringify(statements).includes('"kind":"permanentButton"');
}

/** The variable names a value reads. */
function names(value: IrExpression): Set<string> {
  const found = new Set<string>();
  const visit = (child: IrExpression): IrExpression => {
    if (child.kind === "variable") found.add(child.name);
    return mapChildren(child, visit);
  };
  visit(value);
  return found;
}

/**
 * Whether a value is a whole number: a whole literal, a list's or text's length, a whole number built-in, arithmetic
 * that keeps whole numbers, or a variable that the file only ever sets to such values.
 */
function isWhole(
  value: IrExpression,
  file: readonly IrStatement[],
  seen = new Set<string>(),
): boolean {
  switch (value.kind) {
    case "literal":
      return (
        typeof value.value === "number" && Number.isInteger(value.value) && value.decimal !== true
      );
    case "property":
      return value.name === "length";
    case "call":
      return ["toInteger", "floor", "ceil", "round"].includes(value.name);
    case "unary":
      return value.operator === "-" && isWhole(value.value, file, seen);
    case "binary":
      return (
        ["+", "-", "*"].includes(value.operator) &&
        isWhole(value.left, file, seen) &&
        isWhole(value.right, file, seen)
      );
    case "variable": {
      if (seen.has(value.name)) return true;
      const values = assignedValues(file, value.name);
      if (values === null || values.length === 0) return false;
      const next = new Set([...seen, value.name]);
      return values.every((assigned) => isWhole(assigned, file, next));
    }
    default:
      return false;
  }
}

/**
 * The values the file sets the name to, by `let` or `=`; null where it changes it otherwise, by a compound assignment
 * of something else than a whole number, or a loop goes through values into it.
 */
function assignedValues(file: readonly IrStatement[], name: string): IrExpression[] | null {
  const values: IrExpression[] = [];
  let other = false;
  const visit = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      if (item.kind === "let" && item.name === name) {
        if (item.type !== undefined && item.type !== "integer") other = true;
        values.push(item.value);
      }
      if (item.kind === "assign" && item.target.kind === "variable" && item.target.name === name) {
        if (item.operator === "=") values.push(item.value);
        else if (item.operator === "+=" || item.operator === "-=" || item.operator === "*=")
          values.push(item.value);
        else other = true;
      }
      if (item.kind === "for" && (item.variable === name || item.valueVariable === name))
        other = item.collection.kind !== "range";
      if (item.kind === "function" && item.parameters.some((parameter) => parameter.name === name))
        other = true;
      withNestedBlocks(item, (body) => {
        visit(body);
        return body;
      });
    }
  };
  visit(file);
  return other ? null : values;
}

/** Methods that change the length of the list they are called on. */
const RESIZING_METHODS = new Set([
  "add",
  "addAll",
  "insert",
  "remove",
  "removeAt",
  "removeAll",
  "clear",
  "push",
  "pop",
  "shift",
]);

/**
 * Whether the loop body keeps the bound's value: it sets none of its variables, changes the length of no list it reads
 * the length of, and calls no script function, which could, where a variable of the bound is no function's own.
 */
function keepsBound(
  bound: IrExpression,
  body: readonly IrStatement[],
  locals: ReadonlySet<string>,
): boolean {
  const read = names(bound);
  if ([...read].some((name) => setsName(body, name))) return false;
  let kept = true;
  let calls = false;
  const lengths = new Set<string>();
  const findLengths = (value: IrExpression): IrExpression => {
    if (value.kind === "property" && value.name === "length" && value.target.kind === "variable")
      lengths.add(value.target.name);
    return mapChildren(value, findLengths);
  };
  findLengths(bound);
  const visit = (value: IrExpression): IrExpression => {
    if (value.kind === "call" && value.local === true) calls = true;
    if (value.kind === "methodCall" && value.target.kind === "variable") {
      if (lengths.has(value.target.name) && RESIZING_METHODS.has(value.name)) kept = false;
    }
    // A list passed to anything may be changed there.
    const args =
      value.kind === "call" ? value.positional : value.kind === "methodCall" ? value.arguments : [];
    for (const argument of args)
      if (argument.kind === "variable" && lengths.has(argument.name)) kept = false;
    return mapChildren(value, visit);
  };
  const statements = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      mapOwnExpressions(item, visit);
      withNestedBlocks(item, (nested) => {
        statements(nested);
        return nested;
      });
    }
  };
  statements(body);
  return kept && (!calls || [...read].every((name) => locals.has(name)));
}
