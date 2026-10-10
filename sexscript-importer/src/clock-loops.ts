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
  // The functions whose results the clock gives, `def now = { -> getTime() }`.
  const clockFunctions = fixedPoint(functions, (body, found) =>
    some(body, (node) => node.kind === "return" && readsClock(node.value, found)),
  );
  // The functions whose calls may wait, also through others; a call of one the file does not define may.
  const mayWait = fixedPoint(functions, (body, found) =>
    some(body, (node) => waitsHere(node, { known: found, unknown: true }, functions)),
  );
  // The functions every way through which, to its end or a return, passes something that may wait.
  const surely = fixedPoint(
    functions,
    (body, found) =>
      passEnd(body, "return", { known: found, unknown: false }, functions) === "waits",
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
      const called = calledFunctions(nested.body, functions);
      for (const name of called) callees.add(name);
      // A loop whose condition or every way back to it passes something that may wait, or that can end otherwise than
      // by time passing, as when its body changes another value the condition reads, keeps its waits, which a text's
      // reading time would not replace.
      const surelyWaiting = { known: surely, unknown: false };
      const others = [...variablesRead(nested.condition)].filter((name) => !clocked.has(name));
      if (
        some(nested.condition, (node) => waitsHere(node, surelyWaiting, functions)) ||
        others.some((name) =>
          changes([nested.body, ...[...called].map((callee) => functions.get(callee))], name),
        ) ||
        passEnd(nested.body, "continue", surelyWaiting, functions) === "waits"
      )
        return [{ ...nested, body: clockWaits(nested.body) }];
      // Only a loop that waits nowhere only redraws its texts, which become one message.
      const redraws = !some(nested.body, (node) =>
        waitsHere(node, { known: mayWait, unknown: true }, functions),
      );
      const message = `The legacy loop polled the clock until the time was up${redraws ? ", redrawing its text as fast as it could," : ", with a way through a pass that waits for nothing,"} at any number of passes; a TeaseScript clock advances only at waits, so each pass starts with a wait of a tenth of a second, which also sets how many passes it makes${redraws ? ", and the texts the loop says are one message that changes in place" : ""}.`;
      diagnostics.push({ code: "SX_CLOCK_LOOP", severity: "warning", message, span: nested.span });
      const note: IrStatement = {
        kind: "comment",
        text: `// NOTE SX_CLOCK_LOOP${nested.span === null ? "" : ` line ${nested.span.line}`}: ${message}`,
        trailing: false,
        span: nested.span,
      };
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
      if (!redraws || says(body).length === 0 || speakers.size !== 1)
        return [note, { ...nested, body }];
      const frame = fresh("frame");
      return [
        note,
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

/** The variables a value reads. */
function variablesRead(value: unknown): Set<string> {
  const names = new Set<string>();
  some(value, (node) => {
    if (node.kind === "variable" && typeof node.name === "string") names.add(node.name);
    return false;
  });
  return names;
}

/**
 * Whether statements may change a variable: set it or a part of it, call a method on it, such as a list's `add`, or
 * pass it to a call, whose function may change what it holds.
 */
function changes(statements: unknown, name: string): boolean {
  const rooted = (target: unknown): boolean => {
    let node = target as Record<string, unknown> | undefined;
    while (node !== undefined && (node.kind === "property" || node.kind === "index"))
      node = node.target as Record<string, unknown> | undefined;
    return node?.kind === "variable" && node.name === name;
  };
  return some(statements, (node) => {
    if (
      (node.kind === "assign" && rooted(node.target)) ||
      (node.kind === "let" && node.name === name)
    )
      return true;
    if (node.kind === "methodCall" && rooted(node.target)) return true;
    return (
      node.kind === "call" &&
      Array.isArray(node.positional) &&
      node.positional.some((argument) => rooted(argument))
    );
  });
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

/** The functions whose calls count as waiting (`known`), and whether a call of one the file does not define does. */
interface Waiting {
  known: ReadonlySet<string>;
  unknown: boolean;
}

/**
 * How the ways through a loop pass, or a function body, end: every way to the end, or to a `continue` (of a pass) or
 * `return` (of a function), passes something that may wait (`waits`), or one reaches that jump before
 * (`continues`) or the end (`falls`). Leaving the loop otherwise, by `break`, a `return` from a pass, or a transfer,
 * comes not back. A wait inside a nested loop may not run, and that loop's own `continue` stays inside it.
 */
function passEnd(
  statements: readonly IrStatement[],
  jump: "continue" | "return",
  waiting: Waiting,
  functions: ReadonlyMap<string, IrStatement[]>,
): "waits" | "continues" | "falls" {
  for (const statement of statements) {
    if (statementWaits(statement, waiting, functions)) return "waits";
    switch (statement.kind) {
      case "continue":
      case "return":
        return statement.kind === jump ? "continues" : "waits";
      case "break":
      case "exit":
      case "goto":
        return "waits";
      case "if":
      case "switch": {
        const ends = (
          statement.kind === "if"
            ? [statement.then, statement.else]
            : [...statement.cases.map((item) => item.body), statement.default]
        ).map((body) => passEnd(body, jump, waiting, functions));
        if (ends.includes("continues")) return "continues";
        if (ends.every((end) => end === "waits")) return "waits";
        break;
      }
      default:
        break;
    }
  }
  return "falls";
}

/** Whether a statement's own values or action may wait, not those of the blocks it holds. */
function statementWaits(
  statement: IrStatement,
  waiting: Waiting,
  functions: ReadonlyMap<string, IrStatement[]>,
): boolean {
  switch (statement.kind) {
    // A condition, value, or collection runs before the block it leads to.
    case "if":
    case "while":
      return some(statement.condition, (node) => waitsHere(node, waiting, functions));
    case "switch":
      return some(statement.value, (node) => waitsHere(node, waiting, functions));
    case "for":
      return some(statement.collection, (node) => waitsHere(node, waiting, functions));
    case "repeat":
      return some(statement.count, (node) => waitsHere(node, waiting, functions));
    case "wait":
    case "showButton":
    case "playAudio":
      return waitsHere(statement, waiting, functions);
    case "let":
    case "say":
      return some(statement.value, (node) => waitsHere(node, waiting, functions));
    case "assign":
      return some([statement.target, statement.value], (node) =>
        waitsHere(node, waiting, functions),
      );
    case "expression":
      return some(statement.expression, (node) => waitsHere(node, waiting, functions));
    default:
      return false;
  }
}

/**
 * Whether a node may wait by itself: a wait of a time other than a known zero, a button, an ask or a choice, audio
 * played to its end, or a call of a function that counts as waiting (`waiting`).
 */
function waitsHere(
  node: Record<string, unknown> | IrStatement,
  waiting: Waiting,
  functions: ReadonlyMap<string, IrStatement[]>,
): boolean {
  const item = node as Record<string, unknown>;
  switch (item.kind) {
    case "wait": {
      const duration = item.duration as IrExpression;
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
      return item.async !== true;
    case "call":
      return (
        item.local === true &&
        typeof item.name === "string" &&
        (functions.has(item.name) ? waiting.known.has(item.name) : waiting.unknown)
      );
    default:
      return false;
  }
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
