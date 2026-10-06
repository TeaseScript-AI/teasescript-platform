import { isRecord } from "./ast.ts";

/**
 * Static analysis of a compiled plan for the explorer's directed search: which instructions no execution can reach,
 * and, for a condition that play reached but left one way, which answers, stored values, clock, or variables it
 * depends on and which of their values take the missed way. The analysis reads the plan only; it is a heuristic
 * except for unreachability, which over-approximates every way execution can continue.
 */

/** A plan or expression record read field by field. */
type Data = Readonly<Record<string, unknown>>;

function record(value: unknown): Data {
  return isRecord(value) ? value : {};
}

function list(value: unknown): Data[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function numbers(values: readonly unknown[]): number[] {
  return values.filter((value): value is number => typeof value === "number");
}

/** The instructions a transfer or fallback destination may start at; a computed one may start at any file or label. */
function destinationTargets(destination: unknown, plan: Data): unknown[] {
  const value = record(destination);
  if ("target" in value) return [value.target];
  if (Array.isArray(value.pick)) return list(value.pick).map((pick) => pick.target);
  if ("value" in value)
    return list(plan.files).flatMap((file) => [
      file.entryInstruction,
      ...list(file.labels).map((label) => label.instruction),
    ]);
  return [];
}

/**
 * Where execution may continue after each instruction, over-approximated: both ways of a condition or loop (except a
 * way that `dead` cuts), a called function's entry, from a function's returns the return points of all its calls,
 * every destination of a transfer, from every `end` the return point of every file `call` and every fallback, and the
 * entries of the timer, cue, and button blocks an instruction sets up. Interactions continue after their answer;
 * `exit` continues nowhere.
 */
function successors(plan: Data, instructions: readonly Data[], dead: ReadonlyMap<number, boolean>): number[][] {
  const functions = list(plan.functions);
  const entry = (id: unknown) => functions[Number(id) - 1]?.entryInstruction;
  const functionOf = new Map<number, number>();
  for (const definition of functions) {
    const end = Number(definition.endInstruction);
    for (let index = Number(definition.entryInstruction); index <= end; index += 1)
      functionOf.set(index, Number(definition.id));
  }
  const returnPoints = new Map<number, number[]>();
  const fileReturns: unknown[] = [];
  const fallbacks: unknown[] = [];
  instructions.forEach((instruction, index) => {
    if (instruction.kind === "callFunction") {
      const id = Number(instruction.functionId);
      const points = returnPoints.get(id) ?? [];
      points.push(Number(instruction.returnInstruction));
      returnPoints.set(id, points);
    }
    if (instruction.kind === "transfer" && instruction.mode === "call") fileReturns.push(index + 1);
    if (instruction.kind === "setFallback")
      fallbacks.push(...destinationTargets(instruction.destination, plan));
  });
  return instructions.map((instruction, index) => {
    const constant = dead.get(index);
    switch (instruction.kind) {
      case "jump":
      case "loopControl":
      case "goto":
        return numbers([instruction.target]);
      case "jumpIfFalse":
      case "loopStart":
        // A constant condition takes only one way: `true` continues with the next instruction.
        return numbers(
          constant === undefined ? [index + 1, instruction.target] : [constant ? index + 1 : instruction.target],
        );
      case "exit":
        return [];
      case "returnValue":
      case "returnVoid":
        return returnPoints.get(functionOf.get(index) ?? 0) ?? [];
      case "end":
        return numbers([...fileReturns, ...fallbacks]);
      case "transfer":
        return numbers([
          ...destinationTargets(instruction.destination, plan),
          ...(instruction.mode === "call" ? [index + 1] : []),
        ]);
      case "callFunction":
        return numbers([entry(instruction.functionId)]);
      case "startTimer":
      case "showPermanentButton":
        return numbers([index + 1, entry(instruction.handlerFunctionId)]);
      case "playMedia":
        return numbers([
          index + 1,
          entry(instruction.finishFunctionId),
          ...list(instruction.cues).map((cue) => entry(cue.functionId)),
        ]);
      default:
        return [index + 1];
    }
  });
}

/** A compiler diagnostic with its file path and source offsets. */
export interface PlanDiagnostic {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly code: string;
  readonly message: string;
}

/** Plan spans are compact: zero-based start/end line and column, and offsets into the file's source. */
function offsets(span: unknown): { start: number; end: number } | null {
  const value = record(span);
  return typeof value.so === "number" && typeof value.eo === "number"
    ? { start: value.so, end: value.eo }
    : null;
}

/**
 * The conditions with a constant value: a literal (`while true`), or a comparison or test the compiler proves always
 * true or false (`TSV046`), by the condition's whole span. Maps the instruction to its value.
 */
export function constantConditions(
  instructions: readonly Data[],
  files: readonly string[],
  diagnostics: readonly PlanDiagnostic[],
): Map<number, boolean> {
  const proven = new Map<string, boolean>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== "TSV046") continue;
    const value = /always true\.?$/u.test(diagnostic.message)
      ? true
      : /always false\.?$/u.test(diagnostic.message)
        ? false
        : null;
    if (value !== null) proven.set(`${diagnostic.path}:${diagnostic.start}:${diagnostic.end}`, value);
  }
  const constants = new Map<number, boolean>();
  instructions.forEach((instruction, index) => {
    if (instruction.kind !== "jumpIfFalse" && instruction.kind !== "loopStart") return;
    if (instruction.kind === "loopStart" && instruction.loopKind !== "while") return;
    const condition = record(instruction.condition ?? instruction.expression);
    if (condition.kind === "literal" && typeof condition.value === "boolean") {
      constants.set(index, condition.value);
      return;
    }
    const span = offsets(condition.span);
    const value = span === null ? undefined : proven.get(`${files[index]}:${span.start}:${span.end}`);
    if (value !== undefined) constants.set(index, value);
  });
  return constants;
}

/**
 * The instructions no execution can reach from the session start (instruction 0), when constant conditions take only
 * their one way.
 */
export function unreachableInstructions(
  plan: Data,
  instructions: readonly Data[],
  constants: ReadonlyMap<number, boolean>,
): Uint8Array {
  const next = successors(plan, instructions, constants);
  const reached = new Uint8Array(instructions.length);
  const queue = [0];
  reached[0] = 1;
  for (let position = 0; position < queue.length; position += 1) {
    for (const target of next[queue[position]!] ?? []) {
      if (target >= 0 && target < instructions.length && reached[target] === 0) {
        reached[target] = 1;
        queue.push(target);
      }
    }
  }
  return reached.map((value) => 1 - value);
}

/** What a value in a condition comes from, as far as the plan shows. */
export type Source =
  | { readonly kind: "ask"; readonly instruction: number }
  | { readonly kind: "storage"; readonly key: string }
  | { readonly kind: "clock" }
  /** A variable the code assigns; `counter` when an assignment adds to or subtracts from its own value. */
  | { readonly kind: "variable"; readonly name: string; readonly counter: boolean };

/** Getters of the current date and time. */
const CLOCK_GETTERS = new Set(["getDate", "getTime", "getDateTime", "getTimestamp"]);

interface Flow {
  asks: Set<number>;
  keys: Set<string>;
  clock: boolean;
}

function emptyFlow(): Flow {
  return { asks: new Set(), keys: new Set(), clock: false };
}

/** Adds `from` to `into`; whether anything was new. */
function merge(into: Flow, from: Flow): boolean {
  const before = into.asks.size + into.keys.size + Number(into.clock);
  for (const ask of from.asks) into.asks.add(ask);
  for (const key of from.keys) into.keys.add(key);
  into.clock ||= from.clock;
  return into.asks.size + into.keys.size + Number(into.clock) !== before;
}

/** The name of a variable that an assignment target writes, also through a property or an index. */
function targetName(target: unknown): string | null {
  const value = record(target);
  if (value.kind === "identifier" && typeof value.name === "string") return value.name;
  if (value.kind === "property" || value.kind === "index") return targetName(value.object);
  return null;
}

/** The literal text of an expression, such as a storage key. */
function literalText(expression: unknown): string | null {
  const value = record(expression);
  return value.kind === "literal" && typeof value.value === "string" ? value.value : null;
}

/** Stands for a computed part of a storage key pattern. */
export const KEY_PLACEHOLDER = "\u0000";

/**
 * A storage key: its text, or for a template such as `"script${i}.time"` a pattern with {@link KEY_PLACEHOLDER} for
 * each computed part.
 */
function keyText(expression: unknown): string | null {
  const literal = literalText(expression);
  if (literal !== null) return literal;
  const value = record(expression);
  if (value.kind !== "template") return null;
  return list(value.parts)
    .map((part) => (part.kind === "text" && typeof part.value === "string" ? part.value : KEY_PLACEHOLDER))
    .join("");
}

/** The name a call calls, for a plain name or a method. */
function calleeName(call: Data): string | null {
  const callee = record(call.callee);
  if (callee.kind === "identifier" && typeof callee.name === "string") return callee.name;
  if (callee.kind === "property" && typeof callee.name === "string") return callee.name;
  return null;
}

/**
 * A flow-insensitive data flow over names: which asks, stored keys, and clock reads reach each variable, temporary,
 * function result, and stored key, through assignments, returns, and storage writes, with every scope of a name
 * merged. It decides what directed search tries; a wrong guess costs only a failed attempt.
 */
export class DataFlow {
  readonly #variables = new Map<string, Flow>();
  readonly #temporaries = new Map<number, Flow>();
  readonly #functions = new Map<number, Flow>();
  readonly #stored = new Map<string, Flow>();
  /** Variables an assignment adds to or subtracts from their own value. */
  readonly #counters = new Set<string>();
  /** The interaction instructions by kind of answer: typed asks (`text`, `number`, ...) only. */
  readonly #typedAsks = new Set<number>();

  constructor(plan: Data, instructions: readonly Data[]) {
    const functions = list(plan.functions);
    const functionOf = new Map<number, number>();
    for (const definition of functions) {
      const end = Number(definition.endInstruction);
      for (let index = Number(definition.entryInstruction); index <= end; index += 1)
        functionOf.set(index, Number(definition.id));
    }
    instructions.forEach((instruction, index) => {
      if (instruction.kind !== "interaction" || typeof instruction.destinationTemporary !== "number") return;
      const ui = record(instruction.ui);
      if (ui.kind === "text" || ui.kind === "number" || ui.kind === "temporal")
        this.#typedAsks.add(index);
      this.#temporary(instruction.destinationTemporary).asks.add(index);
    });
    // Propagate to a fixed point; each round only adds, so it ends.
    for (let round = 0; round < 50; round += 1) {
      let changed = false;
      instructions.forEach((instruction, index) => {
        switch (instruction.kind) {
          case "storeTemporary":
            changed =
              merge(this.#temporary(Number(instruction.temporaryId)), this.flowOf(instruction.value)) ||
              changed;
            break;
          case "callFunction":
            if (typeof instruction.destinationTemporary === "number")
              changed =
                merge(
                  this.#temporary(instruction.destinationTemporary),
                  this.#function(Number(instruction.functionId)),
                ) || changed;
            break;
          case "returnValue": {
            const owner = functionOf.get(index);
            if (owner !== undefined)
              changed = merge(this.#function(owner), this.flowOf(instruction.value)) || changed;
            break;
          }
          case "declareBinding":
          case "declareGlobal":
            if (typeof instruction.name === "string")
              changed = merge(this.#variable(instruction.name), this.flowOf(instruction.value)) || changed;
            break;
          case "assign": {
            const name = targetName(instruction.target);
            if (name === null) break;
            if (round === 0 && this.#addsToItself(name, instruction.value)) this.#counters.add(name);
            changed = merge(this.#variable(name), this.flowOf(instruction.value)) || changed;
            break;
          }
          case "storageWrite": {
            const key = keyText(instruction.key);
            if (key !== null && instruction.value !== null)
              changed = merge(this.#storedFlow(key), this.flowOf(instruction.value)) || changed;
            break;
          }
        }
      });
      if (!changed) break;
    }
  }

  /** The asks, stored keys, and clock reads an expression's value comes from. */
  flowOf(expression: unknown): Flow {
    const flow = emptyFlow();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (!isRecord(value)) return;
      if (value.kind === "identifier" && typeof value.name === "string") {
        const known = this.#variables.get(value.name);
        if (known !== undefined) merge(flow, known);
      } else if (value.kind === "temporary" && typeof value.temporaryId === "number") {
        const known = this.#temporaries.get(value.temporaryId);
        if (known !== undefined) merge(flow, known);
      } else if (value.kind === "storageLoad") {
        const key = keyText(value.key);
        if (key !== null) {
          flow.keys.add(key);
          const written = this.#stored.get(key);
          if (written !== undefined) merge(flow, written);
        }
      } else if (value.kind === "call" && CLOCK_GETTERS.has(calleeName(value) ?? "")) {
        flow.clock = true;
      }
      for (const [key, item] of Object.entries(value)) if (key !== "span" && key !== "typeCheck") walk(item);
    };
    walk(expression);
    return flow;
  }

  /** The sources of an expression in a condition: its asks, stored keys, the clock, and the variables it reads. */
  sourcesOf(expression: unknown): Source[] {
    const flow = this.flowOf(expression);
    const sources: Source[] = [
      ...[...flow.asks].filter((ask) => this.#typedAsks.has(ask)).map((instruction) => ({ kind: "ask" as const, instruction })),
      ...[...flow.keys].map((key) => ({ kind: "storage" as const, key })),
      ...(flow.clock ? [{ kind: "clock" as const }] : []),
    ];
    const names = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (isRecord(value)) {
        if (value.kind === "identifier" && typeof value.name === "string") names.add(value.name);
        for (const [key, item] of Object.entries(value)) if (key !== "span") walk(item);
      }
    };
    walk(expression);
    // A variable is a source of its own when the code assigns it: it counts, or no ask, key, or clock reaches it.
    for (const name of names) {
      const known = this.#variables.get(name);
      const external = known !== undefined && (known.asks.size > 0 || known.keys.size > 0 || known.clock);
      const counter = this.#counters.has(name);
      if (counter || !external) sources.push({ kind: "variable", name, counter });
    }
    return sources;
  }

  #addsToItself(name: string, value: unknown): boolean {
    const expression = record(value);
    if (expression.kind !== "binary" || (expression.operator !== "+" && expression.operator !== "-"))
      return false;
    return [expression.left, expression.right].some((side) => record(side).kind === "identifier" && record(side).name === name);
  }

  #variable(name: string): Flow {
    const known = this.#variables.get(name) ?? emptyFlow();
    this.#variables.set(name, known);
    return known;
  }

  #temporary(id: number): Flow {
    const known = this.#temporaries.get(id) ?? emptyFlow();
    this.#temporaries.set(id, known);
    return known;
  }

  #function(id: number): Flow {
    const known = this.#functions.get(id) ?? emptyFlow();
    this.#functions.set(id, known);
    return known;
  }

  #storedFlow(key: string): Flow {
    const known = this.#stored.get(key) ?? emptyFlow();
    this.#stored.set(key, known);
    return known;
  }
}

/** A value directed search tries for a source: a JSON-safe value, or `absent` for a key that is not stored. */
export type Candidate = string | number | boolean | { readonly absent: true };

/** One comparison in a condition between a source expression and a constant, wanted true or false. */
interface Atom {
  readonly subject: unknown;
  readonly operator: string;
  readonly constant: string | number | boolean | null;
  readonly wanted: boolean;
}

const FLIP: Readonly<Record<string, string>> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==", "!=": "!=" };
const TEXT_TESTS = new Set(["contains", "startsWith", "endsWith", "equals", "equalsIgnoreCase"]);

/**
 * The comparisons a condition must make for it to have the value `wanted`, as alternatives: each one alone is a way to
 * get there (for `and` wanted true, all of its parts are listed, and a value is checked against the whole condition).
 */
function atomsFor(expression: unknown, wanted: boolean): Atom[] {
  const value = record(expression);
  if (value.kind === "group") return atomsFor(value.expression, wanted);
  if (value.kind === "unary" && value.operator === "not") return atomsFor(value.operand, !wanted);
  if (value.kind === "binary" && (value.operator === "and" || value.operator === "or"))
    return [...atomsFor(value.left, wanted), ...atomsFor(value.right, wanted)];
  if (value.kind === "binary" && typeof value.operator === "string" && value.operator in FLIP) {
    const left = record(value.left);
    const right = record(value.right);
    const constant = (side: Data) =>
      side.kind === "literal" &&
      (typeof side.value === "string" || typeof side.value === "number" || typeof side.value === "boolean" || side.value === null);
    if (constant(right))
      return [{ subject: value.left, operator: value.operator, constant: toConstant(right.value), wanted }];
    if (constant(left))
      return [{ subject: value.right, operator: FLIP[value.operator]!, constant: toConstant(left.value), wanted }];
    return [];
  }
  if (value.kind === "call" && TEXT_TESTS.has(calleeName(value) ?? "")) {
    const text = list(value.arguments).map((argument) => literalText(argument.value)).find((item) => item !== null);
    const object = record(value.callee).object;
    return text === undefined || text === null || object === undefined
      ? []
      : [{ subject: object, operator: wanted ? "==" : "!=", constant: text, wanted: true }];
  }
  if (value.kind === "identifier" || value.kind === "temporary" || value.kind === "storageLoad")
    return [{ subject: expression, operator: "==", constant: true, wanted }];
  return [];
}

function toConstant(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

/** Values of `subject` that make `subject operator constant` come out `wanted`. */
function solve(atom: Atom): Candidate[] {
  const { operator, constant, wanted } = atom;
  const holds = wanted ? operator : negate(operator);
  if (constant === null) return holds === "==" ? [{ absent: true }] : holds === "!=" ? [] : [];
  if (typeof constant === "boolean") {
    if (holds === "==") return [constant];
    return holds === "!=" ? [!constant] : [];
  }
  if (typeof constant === "string") {
    if (holds === "==") return [constant];
    return holds === "!=" ? [constant === "x" ? "y" : "x"] : [];
  }
  switch (holds) {
    case "==":
      return [constant];
    case "!=":
      return [constant + 1];
    case "<":
      return [constant - 1];
    case "<=":
      return [constant];
    case ">":
      return [constant + 1];
    case ">=":
      return [constant];
    default:
      return [];
  }
}

function negate(operator: string): string {
  return { "==": "!=", "!=": "==", "<": ">=", "<=": ">", ">": "<=", ">=": "<" }[operator] ?? operator;
}

/** What a missed way of a condition depends on, with the values that may take it. */
export interface Goal {
  readonly source: Source;
  /** For an ask, answer texts; for a stored key, values; for a variable, the constant and comparison to approach. */
  readonly candidates: readonly Candidate[];
  /** For a variable: the comparison that takes the missed way, for measuring how close a state is to it. */
  readonly comparison: { readonly operator: string; readonly constant: number } | null;
}

/**
 * The goals for taking a condition's missed way: `wanted` is the condition value of that way. A subject that applies
 * `length` to a source turns a length into a text of that length; `toInteger` and the like keep the number.
 */
export function goalsFor(flow: DataFlow, condition: unknown, wanted: boolean): Goal[] {
  const goals: Goal[] = [];
  for (const atom of atomsFor(condition, wanted)) {
    const values = solve(atom);
    const subject = record(atom.subject);
    const lengthOf = subject.kind === "property" && subject.name === "length";
    const holds = atom.wanted ? atom.operator : negate(atom.operator);
    for (const source of flow.sourcesOf(atom.subject)) {
      const candidates =
        source.kind === "ask"
          ? values
              .filter((value) => typeof value !== "object")
              .map((value) => (lengthOf && typeof value === "number" ? "x".repeat(Math.max(1, Math.min(value, 200))) : String(value)))
          : values;
      // Closeness is measured only where the comparison reads the variable itself.
      const comparison =
        source.kind === "variable" &&
        subject.kind === "identifier" &&
        subject.name === source.name &&
        typeof atom.constant === "number"
          ? { operator: holds, constant: atom.constant }
          : null;
      // A stored value or the clock is worth trying even unsolved: with values play stored, or other times.
      if (candidates.length === 0 && source.kind !== "storage" && source.kind !== "clock") continue;
      goals.push({ source, candidates, comparison });
    }
  }
  // Stored keys and clock reads of comparisons with no constant side, such as `now < start + period`.
  for (const source of flow.sourcesOf(condition)) {
    if (source.kind !== "storage" && source.kind !== "clock") continue;
    const known = goals.some(
      (goal) =>
        goal.source.kind === source.kind &&
        (source.kind === "clock" || (goal.source.kind === "storage" && goal.source.key === source.key)),
    );
    if (!known) goals.push({ source, candidates: [], comparison: null });
  }
  return goals;
}

/**
 * The concrete keys to seed for a key pattern: the stored keys play saw that match it, else the pattern with small
 * numbers for its computed parts.
 */
export function concreteKeys(pattern: string, observed: Iterable<string>): string[] {
  if (!pattern.includes(KEY_PLACEHOLDER)) return [pattern];
  const parts = pattern.split(KEY_PLACEHOLDER).map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const matcher = new RegExp(`^${parts.join(".*")}$`, "u");
  const matching = [...observed].filter((key) => matcher.test(key));
  if (matching.length > 0) return matching.slice(0, 3);
  return ["0", "1"].map((number) => pattern.split(KEY_PLACEHOLDER).join(number));
}

/** How far a variable's value is from making `value operator constant` true: 0 when it holds. */
export function distance(value: number, operator: string, constant: number): number {
  switch (operator) {
    case "==":
      return Math.abs(value - constant);
    case "!=":
      return value === constant ? 1 : 0;
    case "<":
      return Math.max(0, value - constant + 1);
    case "<=":
      return Math.max(0, value - constant);
    case ">":
      return Math.max(0, constant - value + 1);
    case ">=":
      return Math.max(0, constant - value);
    default:
      return Infinity;
  }
}
