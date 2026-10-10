import { allHelperStatements, SYSTEM_SPEAKER } from "./helpers.ts";
import type { IrExpression, IrStatement, MigrationDiagnostic } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";

/** The wait each pass of a clock loop takes: short enough to keep a redrawn animation moving. */
const TICK_SECONDS = 0.1;

/** Calls that read the clock. */
const CLOCK_CALLS = new Set(["getAbsoluteDateTime", "getDateTime", "getDate", "getTime"]);

/**
 * A loop that polls the clock until a time passes, with nothing that surely waits on each pass, such as ZapEdgeStrip's
 * dice roll, `while t1 < t2 { r = …; say …; t1 = now }`: the legacy player spun on real time while its display showed
 * the texts, but a TeaseScript clock advances only at waits, so the loop runs out of its instruction budget (TSR037).
 * Each pass starts with a wait of a tenth of a second, which a `continue` cannot skip, and the texts the loop says are
 * one message that changes in place, as the legacy display redrew one text (V30 "Updatable messages"). The clock is
 * read directly or through a function that reads it, also through a variable the body sets. The waits of a clock loop,
 * and of the functions it calls, stay rather than become a text's reading time, which passes no clock time
 * (withReadingTimes). Display-only countdowns became timers before (withVisibleCountdowns in lower.ts).
 */
export function withClockLoopTicks(
  statements: IrStatement[],
  diagnostics: MigrationDiagnostic[],
): IrStatement[] {
  const functions = new Map<string, IrStatement[]>();
  for (const statement of [...allHelperStatements(), ...statements])
    if (statement.kind === "function") functions.set(statement.name, statement.body);
  const clockFunctions = fixedPoint(functions, (body, found) => readsClock(body, found));
  const waiting = fixedPoint(functions, (body, found) => alwaysWaits(body, found));
  // The functions a clock loop calls, also through others, whose waits are its time.
  const callees = new Set<string>();
  const taken = usedNames(statements);
  const fresh = (base: string): string => {
    let name = base;
    for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}${suffix}`;
    taken.add(name);
    return name;
  };
  const block = (items: IrStatement[]): IrStatement[] =>
    items.flatMap((item): IrStatement[] => {
      const nested = withNestedBlocks(item, block);
      if (nested.kind !== "while") return [nested];
      const clocked = clockVariables(nested.body, clockFunctions);
      if (
        !readsClock(nested.condition, clockFunctions) &&
        ![...clocked].some((name) => reads(nested.condition, name))
      )
        return [nested];
      for (const name of calledFunctions(nested.body, functions)) callees.add(name);
      // A loop that surely waits on each pass keeps its waits, which a text's reading time would not replace.
      if (waitsEachPass(nested.body, waiting))
        return [{ ...nested, body: clockWaits(nested.body) }];
      diagnostics.push({
        code: "SX_CLOCK_LOOP",
        severity: "warning",
        message:
          "The legacy loop polled the clock until the time was up, redrawing its text as fast as it could, at any number of passes; a TeaseScript clock advances only at waits, so each pass starts with a wait of a tenth of a second, which also sets how many passes it makes, and the texts the loop says are one message that changes in place.",
        span: nested.span,
      });
      const tick: IrStatement = {
        kind: "wait",
        duration: { kind: "literal", value: TICK_SECONDS },
        visible: false,
        unit: "s",
        clock: true,
        span: nested.span,
      };
      const body = [tick, ...clockWaits(nested.body)];
      const speakers = new Set(says(body).map((say) => say.speaker));
      if (says(body).length === 0 || speakers.size !== 1) return [{ ...nested, body }];
      const frame = fresh("frame");
      return [
        {
          kind: "let",
          name: frame,
          value: { kind: "literal", value: null },
          type: "messageHandle?",
          span: nested.span,
        },
        { ...nested, body: inFrame(body, frame) },
      ];
    });
  return block(statements).map((statement) =>
    statement.kind === "function" && callees.has(statement.name)
      ? { ...statement, body: clockWaits(statement.body) }
      : statement,
  );
}

type Say = Extract<IrStatement, { kind: "say" }>;

/** The statements with their waits marked as the time a clock loop waits for. */
function clockWaits(statements: IrStatement[]): IrStatement[] {
  return statements.map((item) =>
    item.kind === "wait"
      ? { ...item, clock: true }
      : item.kind === "function"
        ? item
        : withNestedBlocks(item, clockWaits),
  );
}

/** The texts a loop body says itself, not those of functions it defines. */
function says(statements: readonly IrStatement[]): Say[] {
  const found: Say[] = [];
  const visit = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      if (item.kind === "say" && item.speaker !== SYSTEM_SPEAKER && item.prose !== true)
        found.push(item);
      if (item.kind !== "function") withNestedBlocks(item, (body) => (visit(body), body));
    }
  };
  visit(statements);
  return found;
}

/**
 * The body with each of its texts shown in the message `frame`: said the first time, its text changed after, as text,
 * since a message's text takes only text where `say` also shows a number.
 */
function inFrame(statements: IrStatement[], frame: string): IrStatement[] {
  return statements.map((item): IrStatement => {
    if (item.kind === "say" && item.speaker !== SYSTEM_SPEAKER && item.prose !== true) {
      const handle: IrExpression = { kind: "variable", name: frame };
      const text: IrExpression =
        item.value.kind === "template" ||
        (item.value.kind === "literal" && typeof item.value.value === "string")
          ? item.value
          : { kind: "template", parts: [{ value: item.value }] };
      return {
        kind: "if",
        condition: {
          kind: "binary",
          operator: "==",
          left: handle,
          right: { kind: "literal", value: null },
        },
        then: [
          {
            kind: "assign",
            target: handle,
            operator: "=",
            value: {
              kind: "message",
              value: item.value,
              instant: true,
              ...(item.speaker === undefined ? {} : { speaker: item.speaker }),
            },
            span: item.span,
          },
        ],
        else: [
          {
            kind: "assign",
            target: { kind: "property", target: handle, name: "text" },
            operator: "=",
            value: text,
            span: item.span,
          },
        ],
        span: item.span,
      };
    }
    return item.kind === "function" ? item : withNestedBlocks(item, (body) => inFrame(body, frame));
  });
}

/** The variables a loop body sets from the clock. */
function clockVariables(
  statements: readonly IrStatement[],
  clockFunctions: ReadonlySet<string>,
): Set<string> {
  const names = new Set<string>();
  const visit = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      if (
        item.kind === "assign" &&
        item.target.kind === "variable" &&
        readsClock(item.value, clockFunctions)
      )
        names.add(item.target.name);
      if (item.kind === "let" && readsClock(item.value, clockFunctions)) names.add(item.name);
      if (item.kind !== "function") withNestedBlocks(item, (body) => (visit(body), body));
    }
  };
  visit(statements);
  return names;
}

/** Whether a value reads the clock, directly or through a function that reads it (`clockFunctions`). */
function readsClock(value: unknown, clockFunctions: ReadonlySet<string>): boolean {
  return some(
    value,
    (node) =>
      node.kind === "call" &&
      typeof node.name === "string" &&
      (CLOCK_CALLS.has(node.name) || (node.local === true && clockFunctions.has(node.name))),
  );
}

function reads(value: unknown, name: string): boolean {
  return some(value, (node) => node.kind === "variable" && node.name === name);
}

/** The functions that statements call, also through the functions those call. */
function calledFunctions(
  statements: readonly IrStatement[],
  functions: ReadonlyMap<string, IrStatement[]>,
): Set<string> {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    some(value, (node) => {
      if (
        node.kind === "call" &&
        typeof node.name === "string" &&
        functions.has(node.name) &&
        !found.has(node.name)
      ) {
        found.add(node.name);
        visit(functions.get(node.name));
      }
      return false;
    });
  };
  visit(statements);
  return found;
}

/**
 * Whether a loop body surely waits on each pass: one of its own statements waits, or calls a function that surely
 * does (`waiting`), before any statement that may `continue` past it.
 */
function waitsEachPass(statements: readonly IrStatement[], waiting: ReadonlySet<string>): boolean {
  for (const statement of statements) {
    if (waitsSurely(statement, waiting)) return true;
    if (mayLeave(statement, "continue")) return false;
  }
  return false;
}

/** Whether a function body surely waits before it returns. */
function alwaysWaits(statements: readonly IrStatement[], waiting: ReadonlySet<string>): boolean {
  for (const statement of statements) {
    if (waitsSurely(statement, waiting)) return true;
    if (mayLeave(statement, "return")) return false;
  }
  return false;
}

/** Whether one statement waits whenever it runs: a wait, button, ask, choice, audio played to its end, or a call. */
function waitsSurely(statement: IrStatement, waiting: ReadonlySet<string>): boolean {
  switch (statement.kind) {
    case "wait":
    case "showButton":
      return true;
    case "playAudio":
      return !statement.async;
    case "let":
    case "assign":
      return asks(statement.value);
    case "expression":
      return (
        asks(statement.expression) ||
        (statement.expression.kind === "call" &&
          statement.expression.local === true &&
          waiting.has(statement.expression.name))
      );
    default:
      return false;
  }
}

/** Whether a value asks the player, which waits for the answer. */
function asks(value: IrExpression): boolean {
  return ["input", "choice", "listChoice", "button"].includes(value.kind);
}

/** Whether a statement may leave the pass early: a `continue` of the loop, or a `return`. */
function mayLeave(statement: IrStatement, jump: "continue" | "return"): boolean {
  if (statement.kind === jump) return true;
  if (statement.kind === "function") return false;
  // A loop's own `continue` stays inside it.
  if (
    jump === "continue" &&
    (statement.kind === "while" || statement.kind === "repeat" || statement.kind === "for")
  )
    return false;
  let found = false;
  withNestedBlocks(statement, (body) => {
    found ||= body.some((item) => mayLeave(item, jump));
    return body;
  });
  return found;
}

/** The names of `functions` for which `test` holds, growing until it holds for no other. */
function fixedPoint(
  functions: ReadonlyMap<string, IrStatement[]>,
  test: (body: IrStatement[], found: ReadonlySet<string>) => boolean,
): Set<string> {
  const found = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, body] of functions) {
      if (found.has(name) || !test(body, found)) continue;
      found.add(name);
      changed = true;
    }
  }
  return found;
}

/** Whether `test` holds for a node of `value`, an IR statement or expression tree. */
function some(value: unknown, test: (node: Record<string, unknown>) => boolean): boolean {
  if (Array.isArray(value)) return value.some((item) => some(item, test));
  if (typeof value !== "object" || value === null) return false;
  const node = value as Record<string, unknown>;
  if (typeof node.kind === "string" && test(node)) return true;
  return Object.values(node).some((child) => some(child, test));
}

/** Every name the statements bind or read, also a loop's variables, which a new name must not take. */
function usedNames(statements: readonly IrStatement[]): Set<string> {
  const names = new Set<string>();
  some(statements, (node) => {
    for (const field of ["name", "variable", "valueVariable"]) {
      const value = node[field];
      if (typeof value === "string") names.add(value);
    }
    return false;
  });
  return names;
}
