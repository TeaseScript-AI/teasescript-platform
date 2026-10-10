import { allHelperStatements, SYSTEM_SPEAKER } from "./helpers.ts";
import type { IrExpression, IrStatement, MigrationDiagnostic } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";

/** The wait each pass of a clock loop takes: short enough to keep a redrawn animation moving. */
const TICK_SECONDS = 0.1;

/** Calls that read the clock. */
const CLOCK_CALLS = new Set(["getAbsoluteDateTime", "getDateTime", "getDate", "getTime"]);

/**
 * A loop that polls the clock until a time passes, such as ZapEdgeStrip's dice roll, `while t1 < t2 { r = …; say …; t1 =
 * now }`: the legacy player spun on real time while its display showed the texts, but a TeaseScript clock advances only
 * at waits, and a text's reading time passes none, so such a loop runs out of its instruction budget (TSR037). The
 * condition reads the clock directly, through a variable the body sets from it, or through a function that returns
 * it. Unless every pass surely makes the clock advance (a wait of a time known to be more than none, a button, an ask,
 * audio played to its end, or a call of a function every way through which does, not skipped by `continue` or by
 * the other operand of `and` or `or`), each pass starts with a wait of a tenth of a second, which a `continue` cannot
 * skip; where nothing in the loop may wait at all, it only redrew its texts, which become one message that changes in
 * place (V30 "Updatable messages"). The waits of a clock loop, and of the functions it calls, stay rather than become a
 * text's reading time (withReadingTimes). Display-only countdowns became timers before (withVisibleCountdowns).
 */
export function withClockLoopTicks(
  statements: IrStatement[],
  diagnostics: MigrationDiagnostic[],
): IrStatement[] {
  const functions = new Map<string, IrStatement[]>();
  for (const statement of [...allHelperStatements(), ...statements])
    if (statement.kind === "function") functions.set(statement.name, statement.body);
  // The functions whose results the clock gives, also through a local set from it: `def now = { -> getTime() }`.
  const clockFunctions = fixedPoint(functions, (body, found) => {
    const locals = clockVariables(body, found);
    return some(
      body,
      (node) =>
        node.kind === "return" &&
        (readsClock(node.value, found) || [...locals].some((name) => reads(node.value, name))),
    );
  });
  // The functions whose calls may wait, also through others; a call of one the file does not define may.
  const mayWait = fixedPoint(functions, (body, found) =>
    some(body, (node) => mayWaitHere(node, found, functions)),
  );
  // The functions every way through which, to its end or a return, surely makes the clock advance.
  const advancing = fixedPoint(
    functions,
    (body, found) => passEnd(body, "return", found) === "advances",
  );
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
      // A loop whose condition, or every way back to it, surely makes the clock advance keeps its waits, which a
      // text's reading time would not replace.
      if (
        advancesIn(nested.condition, advancing) ||
        passEnd(nested.body, "continue", advancing) === "advances"
      )
        return [{ ...nested, body: clockWaits(nested.body) }];
      // Only a loop that waits nowhere only redraws its texts, which become one message.
      const redraws = !some(nested.body, (node) => mayWaitHere(node, mayWait, functions));
      const message = redraws
        ? "The legacy loop polled the clock until the time was up, redrawing its text as fast as it could, at any number of passes; a TeaseScript clock advances only at waits, so a pass after one in which the clock did not advance starts with a wait of a tenth of a second, which also sets how many passes it makes, and the texts the loop says are one message that changes in place."
        : "The legacy loop polled the clock until the time was up, and a pass of it may wait for nothing; a TeaseScript clock advances only at waits, so a pass after one in which the clock did not advance starts with a wait of a tenth of a second.";
      diagnostics.push({ code: "SX_CLOCK_LOOP", severity: "warning", message, span: nested.span });
      const note: IrStatement = {
        kind: "comment",
        text: `// NOTE SX_CLOCK_LOOP${nested.span === null ? "" : ` line ${nested.span.line}`}: ${message}`,
        trailing: false,
        span: nested.span,
      };
      // The clock at the start of the last pass: a pass after one in which it did not advance waits first.
      const passClock = fresh("passClock");
      const now: IrExpression = {
        kind: "call",
        name: "getAbsoluteDateTime",
        positional: [],
        named: {},
      };
      const last: IrExpression = { kind: "variable", name: passClock };
      const tick: IrStatement[] = [
        {
          kind: "if",
          condition: { kind: "binary", operator: "==", left: last, right: now },
          then: [
            {
              kind: "wait",
              duration: { kind: "literal", value: TICK_SECONDS },
              visible: false,
              unit: "s",
              clock: true,
              span: nested.span,
            },
          ],
          else: [],
          span: nested.span,
        },
        { kind: "assign", target: last, operator: "=", value: now, span: nested.span },
      ];
      const start: IrStatement = {
        kind: "let",
        name: passClock,
        value: { kind: "literal", value: null },
        type: "absoluteDateTime?",
        span: nested.span,
      };
      const body = [...tick, ...clockWaits(nested.body)];
      const speakers = new Set(says(body).map((say) => say.speaker));
      if (!redraws || says(body).length === 0 || speakers.size !== 1)
        return [note, start, { ...nested, body }];
      const frame = fresh("frame");
      return [
        note,
        start,
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

/**
 * How the ways through a loop pass, or a function body, end: every way to the end, or to a `continue` (of a pass) or
 * `return` (of a function), surely makes the clock advance (`advances`), or one reaches that jump before
 * (`skips`) or the end (`falls`). Leaving the loop otherwise, by `break`, a `return` from a pass, or a transfer, comes
 * not back. A loop inside may run no pass, and its own `continue` stays inside it.
 */
function passEnd(
  statements: readonly IrStatement[],
  jump: "continue" | "return",
  advancing: ReadonlySet<string>,
): "advances" | "skips" | "falls" {
  for (const statement of statements) {
    if (statementAdvances(statement, advancing)) return "advances";
    switch (statement.kind) {
      case "continue":
      case "return":
        return statement.kind === jump ? "skips" : "advances";
      case "break":
      case "exit":
      case "goto":
        return "advances";
      case "if":
      case "switch": {
        const ends = (
          statement.kind === "if"
            ? [statement.then, statement.else]
            : [...statement.cases.map((item) => item.body), statement.default]
        ).map((body) => passEnd(body, jump, advancing));
        if (ends.includes("skips")) return "skips";
        if (ends.every((end) => end === "advances")) return "advances";
        break;
      }
      default:
        break;
    }
  }
  return "falls";
}

/** Whether a statement surely makes the clock advance by itself or by the values it always computes. */
function statementAdvances(statement: IrStatement, advancing: ReadonlySet<string>): boolean {
  switch (statement.kind) {
    case "wait":
      return positive(statement.duration);
    case "showButton":
      return true;
    case "playAudio":
      return !statement.async;
    case "let":
    case "say":
      return advancesIn(statement.value, advancing);
    case "assign":
      return advancesIn(statement.value, advancing);
    case "expression":
      return advancesIn(statement.expression, advancing);
    case "return":
      return statement.value !== null && advancesIn(statement.value, advancing);
    // A condition, value, or collection runs before the block it leads to.
    case "if":
    case "while":
      return advancesIn(statement.condition, advancing);
    case "switch":
      return advancesIn(statement.value, advancing);
    case "for":
      return advancesIn(statement.collection, advancing);
    case "repeat":
      return advancesIn(statement.count, advancing);
    default:
      return false;
  }
}

/**
 * Whether computing a value surely makes the clock advance: an ask, a choice, or a button, or a call of a function
 * that surely does (`advancing`), in a part that always runs, not the right side of `and` or `or`.
 */
function advancesIn(value: IrExpression, advancing: ReadonlySet<string>): boolean {
  switch (value.kind) {
    case "input":
    case "choice":
    case "listChoice":
    case "button":
      return true;
    case "binary":
      return value.operator === "and" || value.operator === "or"
        ? advancesIn(value.left, advancing)
        : advancesIn(value.left, advancing) || advancesIn(value.right, advancing);
    case "call":
      return (
        (value.local === true && advancing.has(value.name)) ||
        value.positional.some((argument) => advancesIn(argument, advancing)) ||
        Object.values(value.named).some((argument) => advancesIn(argument, advancing))
      );
    default:
      return childExpressions(value).some((child) => advancesIn(child, advancing));
  }
}

/** The expressions directly inside an expression, also the values of a text's parts and an object's properties. */
function childExpressions(value: IrExpression): IrExpression[] {
  const children: IrExpression[] = [];
  const add = (item: unknown): void => {
    if (typeof item !== "object" || item === null) return;
    if (Array.isArray(item)) {
      for (const element of item) add(element);
      return;
    }
    const node = item as Record<string, unknown>;
    if (typeof node.kind === "string") children.push(node as unknown as IrExpression);
    else add(node.value);
  };
  for (const child of Object.values(value)) add(child);
  return children;
}

/** Whether a duration is surely more than none: a positive number, a random count from a positive start, or a sum. */
function positive(value: IrExpression): boolean {
  if (value.kind === "literal") return typeof value.value === "number" && value.value > 0;
  if (value.kind === "duration") return value.value > 0;
  if (value.kind === "binary" && value.operator === "+")
    return (
      (positive(value.left) && notNegative(value.right)) ||
      (notNegative(value.left) && positive(value.right))
    );
  if (value.kind === "binary" && value.operator === "*")
    return positive(value.left) && positive(value.right);
  return false;
}

/** Whether a value is surely not negative: a number of at least 0, a random integer from such a start, or a sum. */
function notNegative(value: IrExpression): boolean {
  if (positive(value)) return true;
  if (value.kind === "literal") return value.value === 0;
  if (value.kind === "call" && value.name === "randomInteger") {
    const range = value.positional[0];
    return (
      range?.kind === "range" &&
      range.from.kind === "literal" &&
      typeof range.from.value === "number" &&
      range.from.value >= 0
    );
  }
  if (value.kind === "binary" && value.operator === "+")
    return notNegative(value.left) && notNegative(value.right);
  return false;
}

/**
 * Whether a node may wait by itself: a wait of a time other than a known zero, a button, an ask or a choice, a popup,
 * audio played to its end, or a call of a function that may wait (`mayWait`) or that the file does not define.
 */
function mayWaitHere(
  node: Record<string, unknown>,
  mayWait: ReadonlySet<string>,
  functions: ReadonlyMap<string, IrStatement[]>,
): boolean {
  switch (node.kind) {
    case "wait": {
      const duration = node.duration as IrExpression;
      return !(
        (duration.kind === "literal" && duration.value === 0) ||
        (duration.kind === "duration" && duration.value === 0)
      );
    }
    case "showButton":
    case "input":
    case "choice":
    case "listChoice":
    case "button":
    case "showPopup":
      return true;
    case "playAudio":
      return node.async !== true;
    case "call":
      return (
        node.local === true &&
        typeof node.name === "string" &&
        (functions.has(node.name) ? mayWait.has(node.name) : true)
      );
    default:
      return false;
  }
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
