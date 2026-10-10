import { allHelperStatements, SYSTEM_SPEAKER } from "./helpers.ts";
import type { IrExpression, IrStatement, MigrationDiagnostic } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";

/** The wait each pass of a clock loop takes: short enough to keep a redrawn animation moving. */
const TICK_SECONDS = 0.1;

/** Calls that read the clock. */
const CLOCK_CALLS = new Set(["getAbsoluteDateTime", "getDateTime", "getDate", "getTime"]);

/**
 * A loop that polls the clock until a time passes, with nothing in its body that waits, such as ZapEdgeStrip's dice
 * roll, `while t1 < t2 { r = …; say …; t1 = now }`: the legacy player spun on real time while its display showed the
 * texts, but a TeaseScript clock advances only at waits, so the loop runs out of its instruction budget (TSR037). Each
 * pass waits a tenth of a second where it reads the clock again, and the texts it says are one message that changes in
 * place, as the legacy display redrew one text (V30 "Updatable messages"). Display-only countdowns became timers before
 * (withVisibleCountdowns in lower.ts).
 */
export function withClockLoopTicks(
  statements: IrStatement[],
  diagnostics: MigrationDiagnostic[],
): IrStatement[] {
  const functions = new Map<string, IrStatement[]>();
  for (const statement of [...allHelperStatements(), ...statements])
    if (statement.kind === "function") functions.set(statement.name, statement.body);
  const blocking = blockingFunctions(functions);
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
      const clocked = clockVariables(nested.body);
      if (!(
        readsClock(nested.condition) || [...clocked].some((name) => reads(nested.condition, name))
      ))
        return [nested];
      // A loop that waits already keeps its waits, which a text's reading time would not replace (withReadingTimes).
      if (blocks(nested.body, blocking)) return [{ ...nested, body: clockWaits(nested.body) }];
      diagnostics.push({
        code: "SX_CLOCK_LOOP",
        severity: "warning",
        message:
          "The legacy loop polled the clock and redrew its text as fast as it could until the time was up; a TeaseScript clock advances only at waits, so each pass waits a tenth of a second, and the texts the loop says are one message that changes in place.",
        span: nested.span,
      });
      // The wait comes where the pass reads the clock again, else at its end.
      const at = nested.body.findIndex(
        (statement) =>
          setsClock(statement) && [...clocked].some((name) => assigns(statement, name)),
      );
      const tick: IrStatement = {
        kind: "wait",
        duration: { kind: "literal", value: TICK_SECONDS },
        visible: false,
        unit: "s",
        span: nested.span,
      };
      const body =
        at < 0
          ? [...nested.body, tick]
          : [...nested.body.slice(0, at), tick, ...nested.body.slice(at)];
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
  return block(statements);
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

/** The body with each of its texts shown in the message `frame`: said the first time, its text changed after. */
function inFrame(statements: IrStatement[], frame: string): IrStatement[] {
  return statements.map((item): IrStatement => {
    if (item.kind === "say" && item.speaker !== SYSTEM_SPEAKER && item.prose !== true) {
      const handle: IrExpression = { kind: "variable", name: frame };
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
            value: item.value,
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
function clockVariables(statements: readonly IrStatement[]): Set<string> {
  const names = new Set<string>();
  const visit = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      if (item.kind === "assign" && item.target.kind === "variable" && readsClock(item.value))
        names.add(item.target.name);
      if (item.kind === "let" && readsClock(item.value)) names.add(item.name);
      if (item.kind !== "function") withNestedBlocks(item, (body) => (visit(body), body));
    }
  };
  visit(statements);
  return names;
}

function setsClock(statement: IrStatement): boolean {
  return (statement.kind === "assign" || statement.kind === "let") && readsClock(statement.value);
}

function assigns(statement: IrStatement, name: string): boolean {
  return (
    (statement.kind === "assign" &&
      statement.target.kind === "variable" &&
      statement.target.name === name) ||
    (statement.kind === "let" && statement.name === name)
  );
}

function readsClock(value: unknown): boolean {
  return some(
    value,
    (node) => node.kind === "call" && typeof node.name === "string" && CLOCK_CALLS.has(node.name),
  );
}

function reads(value: unknown, name: string): boolean {
  return some(value, (node) => node.kind === "variable" && node.name === name);
}

/**
 * Whether running statements may wait: a wait, button, ask, choice, popup, audio that plays to its end, a transfer, a
 * part the conversion left out, or a call of a function that may (`blocking`).
 */
function blocks(statements: readonly IrStatement[], blocking: ReadonlySet<string>): boolean {
  return some(statements, (node) => {
    switch (node.kind) {
      case "wait":
      case "showButton":
      case "input":
      case "choice":
      case "listChoice":
      case "button":
      case "showPopup":
      case "goto":
      case "exit":
      // A part the conversion left out may have waited.
      case "unsupported":
        return true;
      case "playAudio":
        return node.async !== true;
      case "call":
        return node.local === true && (typeof node.name !== "string" || blocking.has(node.name));
      default:
        return false;
    }
  });
}

/** The functions whose calls may wait, also through the functions they call; a call of an unknown one may. */
function blockingFunctions(functions: ReadonlyMap<string, IrStatement[]>): Set<string> {
  const result = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, body] of functions) {
      if (result.has(name)) continue;
      const waits =
        blocks(body, result) ||
        some(
          body,
          (node) =>
            node.kind === "call" &&
            typeof node.name === "string" &&
            node.local === true &&
            !functions.has(node.name),
        );
      if (waits) {
        result.add(name);
        changed = true;
      }
    }
  }
  return result;
}

/** Whether `test` holds for a node of `value`, an IR statement or expression tree. */
function some(value: unknown, test: (node: Record<string, unknown>) => boolean): boolean {
  if (Array.isArray(value)) return value.some((item) => some(item, test));
  if (typeof value !== "object" || value === null) return false;
  const node = value as Record<string, unknown>;
  if (typeof node.kind === "string" && test(node)) return true;
  return Object.values(node).some((child) => some(child, test));
}

function usedNames(statements: readonly IrStatement[]): Set<string> {
  const names = new Set<string>();
  some(statements, (node) => {
    if (typeof node.name === "string") names.add(node.name);
    return false;
  });
  return names;
}
