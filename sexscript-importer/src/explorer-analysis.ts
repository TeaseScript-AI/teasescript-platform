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
function successors(
  plan: Data,
  instructions: readonly Data[],
  dead: ReadonlyMap<number, boolean>,
): number[][] {
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
          constant === undefined
            ? [index + 1, instruction.target]
            : [constant ? index + 1 : instruction.target],
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
    if (value !== null)
      proven.set(`${diagnostic.path}:${diagnostic.start}:${diagnostic.end}`, value);
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
    const value =
      span === null ? undefined : proven.get(`${files[index]}:${span.start}:${span.end}`);
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

/** A literal value a save writes. */
type SavedScalar = string | number | boolean;
/** A save whose value is computed, not a literal. */
const COMPUTED = Symbol("computed");
type SavedValue = SavedScalar | typeof COMPUTED;
/** A key with no stored value. */
const ABSENT = Symbol("absent");

function scalar(value: unknown): SavedScalar | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

/** A variable whose every assignment is one `load` of a literal key, with no default or a literal one. */
interface LoadAlias {
  readonly key: string;
  readonly fallback: SavedScalar | null;
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
    .map((part) =>
      part.kind === "text" && typeof part.value === "string" ? part.value : KEY_PLACEHOLDER,
    )
    .join("");
}

/** The variables an expression reads; a called function's name is no variable. */
function namesIn(expression: unknown): Set<string> {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (isRecord(value)) {
      if (value.kind === "identifier" && typeof value.name === "string") names.add(value.name);
      const callee = value.kind === "call" && record(value.callee).kind === "identifier";
      for (const [key, item] of Object.entries(value))
        if (key !== "span" && !(callee && key === "callee")) walk(item);
    }
  };
  walk(expression);
  return names;
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
  /** Every save, by key or key pattern: the literal it writes, or {@link COMPUTED}. */
  readonly #saves = new Map<string, SavedValue[]>();
  /** Variables whose every assignment is the same `load`, by name; null for any other variable. */
  readonly #loads = new Map<string, LoadAlias | null>();

  /**
   * `computedPrompts` also counts an ask whose prompt the code computes (`askText "Type: ${line}"`, a prepared UI) as
   * the typed ask it is; without it, only an ask with a fixed prompt is.
   */
  constructor(
    plan: Data,
    instructions: readonly Data[],
    settings: { computedPrompts?: boolean } = {},
  ) {
    const functions = list(plan.functions);
    const functionOf = new Map<number, number>();
    for (const definition of functions) {
      const end = Number(definition.endInstruction);
      for (let index = Number(definition.entryInstruction); index <= end; index += 1)
        functionOf.set(index, Number(definition.id));
    }
    instructions.forEach((instruction, index) => {
      if (
        instruction.kind !== "interaction" ||
        typeof instruction.destinationTemporary !== "number"
      )
        return;
      const ui = record(
        instruction.ui ?? (settings.computedPrompts === true ? instruction.preparedUi : undefined),
      );
      if (ui.kind === "text" || ui.kind === "number" || ui.kind === "temporal")
        this.#typedAsks.add(index);
      this.#temporary(instruction.destinationTemporary).asks.add(index);
    });
    this.#recordSaves(instructions);
    this.#recordLoads(plan, instructions);
    // Propagate to a fixed point; each round only adds, so it ends.
    for (let round = 0; round < 50; round += 1) {
      let changed = false;
      instructions.forEach((instruction, index) => {
        switch (instruction.kind) {
          case "storeTemporary":
            changed =
              merge(
                this.#temporary(Number(instruction.temporaryId)),
                this.flowOf(instruction.value),
              ) || changed;
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
              changed =
                merge(this.#variable(instruction.name), this.flowOf(instruction.value)) || changed;
            break;
          case "assign": {
            const name = targetName(instruction.target);
            if (name === null) break;
            if (round === 0 && this.#addsToItself(name, instruction.value))
              this.#counters.add(name);
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
      for (const [key, item] of Object.entries(value))
        if (key !== "span" && key !== "typeCheck") walk(item);
    };
    walk(expression);
    return flow;
  }

  /** The sources of an expression in a condition: its asks, stored keys, the clock, and the variables it reads. */
  sourcesOf(expression: unknown): Source[] {
    const flow = this.flowOf(expression);
    const sources: Source[] = [
      ...[...flow.asks]
        .filter((ask) => this.#typedAsks.has(ask))
        .map((instruction) => ({ kind: "ask" as const, instruction })),
      ...[...flow.keys].map((key) => ({ kind: "storage" as const, key })),
      ...(flow.clock ? [{ kind: "clock" as const }] : []),
    ];
    // A variable is a source of its own when the code assigns it: it counts, or no ask, key, or clock reaches it.
    for (const name of namesIn(expression)) {
      const known = this.#variables.get(name);
      const external =
        known !== undefined && (known.asks.size > 0 || known.keys.size > 0 || known.clock);
      const counter = this.#counters.has(name);
      if (counter || !external) sources.push({ kind: "variable", name, counter });
    }
    return sources;
  }

  /**
   * The value a condition always has because it reads only stored keys whose values the package fixes: a key no save
   * writes is never stored, and a key every save writes as a literal holds one of those literals or nothing. Null when
   * the condition reads anything else, or can come out either way.
   */
  constantFromStorage(condition: unknown): { value: boolean; reason: string } | null {
    const keys = new Set<string>();
    if (!this.#readsOnlyStorage(condition, keys) || keys.size === 0) return null;
    const possible: [string, (SavedScalar | typeof ABSENT)[]][] = [];
    let saved = false;
    for (const key of keys) {
      const saves = [...this.#saves]
        .filter(([pattern]) => keysMayMatch(pattern, key))
        .flatMap(([, values]) => values);
      if (saves.some((value) => value === COMPUTED)) return null;
      saved ||= saves.length > 0;
      const literals = saves.filter((value): value is SavedScalar => value !== COMPUTED);
      possible.push([key, [ABSENT, ...new Set(literals)]]);
    }
    // Every combination of the keys' possible values; few keys and saves make few combinations.
    let combinations: Map<string, SavedScalar | typeof ABSENT>[] = [new Map()];
    for (const [key, values] of possible) {
      combinations = combinations.flatMap((known) =>
        values.map((value) => new Map([...known, [key, value]])),
      );
      if (combinations.length > 256) return null;
    }
    const results = new Set<boolean>();
    for (const values of combinations) {
      const value = this.#evaluate(condition, values);
      if (typeof value !== "boolean") return null;
      results.add(value);
    }
    if (results.size !== 1) return null;
    const names = [...keys].join(", ");
    return {
      value: [...results][0]!,
      reason: saved
        ? `every save of ${names} is a literal, and none makes the condition take this way`
        : `key never saved in this package: ${names}`,
    };
  }

  /** Whether an expression reads nothing but literals and stored keys with a literal key; collects the keys. */
  #readsOnlyStorage(expression: unknown, keys: Set<string>): boolean {
    const value = record(expression);
    switch (value.kind) {
      case "literal":
        return true;
      case "group":
        return this.#readsOnlyStorage(value.expression, keys);
      case "unary":
        return this.#readsOnlyStorage(value.operand, keys);
      case "binary":
        return (
          this.#readsOnlyStorage(value.left, keys) && this.#readsOnlyStorage(value.right, keys)
        );
      case "identifier": {
        const load = typeof value.name === "string" ? this.#loads.get(value.name) : undefined;
        if (load == null) return false;
        keys.add(load.key);
        return true;
      }
      case "storageLoad": {
        const key = literalText(value.key);
        const fallback = record(value.default);
        if (key === null || (value.default != null && fallback.kind !== "literal")) return false;
        keys.add(key);
        return true;
      }
      default:
        return false;
    }
  }

  /** An expression's value with the stored keys holding `values`; undefined where the runtime would fail or differ. */
  #evaluate(
    expression: unknown,
    values: ReadonlyMap<string, SavedScalar | typeof ABSENT>,
  ): SavedScalar | null | undefined {
    const value = record(expression);
    switch (value.kind) {
      case "literal":
        return value.value === null ? null : scalar(value.value);
      case "group":
        return this.#evaluate(value.expression, values);
      case "identifier": {
        const load = typeof value.name === "string" ? this.#loads.get(value.name) : undefined;
        if (load == null) return undefined;
        const stored = values.get(load.key);
        return stored === undefined ? undefined : stored === ABSENT ? load.fallback : stored;
      }
      case "storageLoad": {
        const stored = values.get(literalText(value.key) ?? "");
        if (stored === undefined) return undefined;
        if (stored !== ABSENT) return stored;
        const fallback = record(value.default);
        return value.default == null
          ? null
          : fallback.value === null
            ? null
            : scalar(fallback.value);
      }
      case "unary": {
        const operand = this.#evaluate(value.operand, values);
        if (value.operator === "not") return typeof operand === "boolean" ? !operand : undefined;
        if (value.operator === "-") return typeof operand === "number" ? -operand : undefined;
        return typeof operand === "number" ? operand : undefined;
      }
      case "binary": {
        const left = this.#evaluate(value.left, values);
        const right = this.#evaluate(value.right, values);
        if (left === undefined || right === undefined) return undefined;
        switch (value.operator) {
          case "and":
            return typeof left === "boolean" && typeof right === "boolean"
              ? left && right
              : undefined;
          case "or":
            return typeof left === "boolean" && typeof right === "boolean"
              ? left || right
              : undefined;
          case "==":
            return left === right;
          case "!=":
            return left !== right;
          case "<":
          case "<=":
          case ">":
          case ">=": {
            const comparable =
              (typeof left === "number" && typeof right === "number") ||
              (typeof left === "string" && typeof right === "string");
            if (!comparable) return undefined;
            return value.operator === "<"
              ? left < right
              : value.operator === "<="
                ? left <= right
                : value.operator === ">"
                  ? left > right
                  : left >= right;
          }
          case "+":
          case "-":
          case "*":
            if (typeof left !== "number" || typeof right !== "number") return undefined;
            return value.operator === "+"
              ? left + right
              : value.operator === "-"
                ? left - right
                : left * right;
          default:
            return undefined;
        }
      }
      default:
        return undefined;
    }
  }

  #recordSaves(instructions: readonly Data[]): void {
    for (const instruction of instructions) {
      if (instruction.kind !== "storageWrite" || instruction.value === null) continue;
      const key = keyText(instruction.key);
      // A save to a key no one can read off the plan could be any key.
      const pattern = key ?? KEY_PLACEHOLDER;
      const written = record(instruction.value);
      const literal = written.kind === "literal" ? scalar(written.value) : undefined;
      const saves = this.#saves.get(pattern) ?? [];
      saves.push(literal ?? COMPUTED);
      this.#saves.set(pattern, saves);
    }
  }

  #recordLoads(plan: Data, instructions: readonly Data[]): void {
    const assign = (name: string, value: unknown) => {
      const expression = record(value);
      const key = expression.kind === "storageLoad" ? literalText(expression.key) : null;
      const fallback = record(expression.default);
      const literal = expression.default == null ? null : scalar(fallback.value);
      const load =
        key === null ||
        (expression.default != null && fallback.kind !== "literal") ||
        literal === undefined
          ? null
          : { key, fallback: literal };
      const known = this.#loads.get(name);
      if (known === undefined) this.#loads.set(name, load);
      else if (
        known !== null &&
        (load === null || known.key !== load.key || known.fallback !== load.fallback)
      )
        this.#loads.set(name, null);
    };
    // Parameters and loop variables get their values elsewhere.
    for (const definition of list(plan.functions))
      for (const parameter of list(definition.parameters))
        if (typeof parameter.name === "string") this.#loads.set(parameter.name, null);
    for (const instruction of instructions) {
      if (instruction.kind === "loopStart" && typeof instruction.variable === "string")
        this.#loads.set(instruction.variable, null);
      if (
        (instruction.kind === "declareBinding" || instruction.kind === "declareGlobal") &&
        typeof instruction.name === "string"
      )
        assign(instruction.name, instruction.value);
      if (instruction.kind === "assign") {
        const target = record(instruction.target);
        const name = targetName(instruction.target);
        if (name === null) continue;
        if (target.kind === "identifier") assign(name, instruction.value);
        else this.#loads.set(name, null);
      }
    }
  }

  #addsToItself(name: string, value: unknown): boolean {
    const expression = record(value);
    if (
      expression.kind !== "binary" ||
      (expression.operator !== "+" && expression.operator !== "-")
    )
      return false;
    return [expression.left, expression.right].some(
      (side) => record(side).kind === "identifier" && record(side).name === name,
    );
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

const FLIP: Readonly<Record<string, string>> = {
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
  "==": "==",
  "!=": "!=",
};
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
      (typeof side.value === "string" ||
        typeof side.value === "number" ||
        typeof side.value === "boolean" ||
        side.value === null);
    if (constant(right))
      return [
        {
          subject: value.left,
          operator: value.operator,
          constant: toConstant(right.value),
          wanted,
        },
      ];
    if (constant(left))
      return [
        {
          subject: value.right,
          operator: FLIP[value.operator]!,
          constant: toConstant(left.value),
          wanted,
        },
      ];
    return [];
  }
  if (value.kind === "call" && TEXT_TESTS.has(calleeName(value) ?? "")) {
    const text = list(value.arguments)
      .map((argument) => literalText(argument.value))
      .find((item) => item !== null);
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
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
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
  return (
    { "==": "!=", "!=": "==", "<": ">=", "<=": ">", ">": "<=", ">=": "<" }[operator] ?? operator
  );
}

/** What a missed way of a condition depends on, with the values that may take it. */
export interface Goal {
  readonly source: Source;
  /** For an ask, answer texts; for a stored key, values; for a variable, the constant and comparison to approach. */
  readonly candidates: readonly Candidate[];
  /**
   * For a variable: the comparison that takes the missed way, for measuring how close a state is to it. A boolean
   * constant is measured as 0 or 1; `shown` keeps the constant as the condition writes it, for notes.
   */
  readonly comparison: {
    readonly operator: string;
    readonly constant: number;
    readonly shown: number | boolean;
  } | null;
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
              .map((value) =>
                lengthOf && typeof value === "number"
                  ? "x".repeat(Math.max(1, Math.min(value, 200)))
                  : String(value),
              )
          : values;
      // Closeness is measured where the comparison reads the variable itself, or a stored value.
      const constant =
        typeof atom.constant === "number"
          ? atom.constant
          : typeof atom.constant === "boolean"
            ? Number(atom.constant)
            : null;
      const comparison =
        constant !== null &&
        ((source.kind === "variable" &&
          subject.kind === "identifier" &&
          subject.name === source.name) ||
          source.kind === "storage")
          ? {
              operator: holds,
              constant,
              shown: typeof atom.constant === "boolean" ? atom.constant : constant,
            }
          : null;
      // A stored value or the clock is worth trying even unsolved: with storage sessions left, or other times.
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
        (source.kind === "clock" ||
          (goal.source.kind === "storage" && goal.source.key === source.key)),
    );
    if (!known) goals.push({ source, candidates: [], comparison: null });
  }
  return goals;
}

/**
 * A value that the plan's conditions compare with constants: a named binding, or a stored key by its text or a pattern
 * with {@link KEY_PLACEHOLDER} parts; or its `length`, for `name.length`; with those constants.
 */
export interface Slot {
  readonly kind: "binding" | "storage";
  readonly name: string;
  readonly length: boolean;
  /** The numbers, the durations in milliseconds (`t < 15 s`), each ascending, and the texts it is compared with. */
  readonly numbers: readonly number[];
  readonly durations: readonly number[];
  readonly strings: ReadonlySet<string>;
}

/**
 * The slots of every condition and `while` loop: in each of their comparisons with a constant (a literal or a duration),
 * the bindings the compared side names and the stored keys its value comes from (`DataFlow.flowOf`), each with the
 * constant; for `x.length`, the length of `x` and of the keys `x` comes from. A value compared with no constant is no
 * slot, as nothing tells which of its values differ.
 */
export function comparedSlots(flow: DataFlow, instructions: readonly Data[]): Slot[] {
  const slots = new Map<
    string,
    { slot: Slot; numbers: Set<number>; durations: Set<number>; strings: Set<string> }
  >();
  const add = (kind: Slot["kind"], name: string, length: boolean, constant: unknown) => {
    const id = JSON.stringify([kind, name, length]);
    let known = slots.get(id);
    if (known === undefined) {
      const strings = new Set<string>();
      known = {
        slot: { kind, name, length, numbers: [], durations: [], strings },
        numbers: new Set(),
        durations: new Set(),
        strings,
      };
      slots.set(id, known);
    }
    const duration = record(constant);
    if (typeof constant === "number") known.numbers.add(constant);
    else if (typeof constant === "string") known.strings.add(constant);
    else if (duration.kind === "duration" && typeof duration.milliseconds === "number")
      known.durations.add(duration.milliseconds);
  };
  const compared = (subject: unknown, constant: unknown) => {
    const value = record(subject);
    const length = value.kind === "property" && value.name === "length";
    const object = length ? value.object : subject;
    if (length && record(object).kind === "identifier")
      add("binding", String(record(object).name), true, constant);
    else if (!length) for (const name of namesIn(subject)) add("binding", name, false, constant);
    for (const key of flow.flowOf(object).keys) add("storage", key, length, constant);
  };
  for (const instruction of instructions) {
    const conditional =
      instruction.kind === "jumpIfFalse" ||
      (instruction.kind === "loopStart" && instruction.loopKind === "while");
    if (!conditional) continue;
    const condition = instruction.condition ?? instruction.expression;
    for (const atom of atomsFor(condition, true)) compared(atom.subject, atom.constant);
    // Comparisons with a duration, which `atomsFor` leaves to the clock and the asks.
    const walk = (expression: unknown): void => {
      const value = record(expression);
      if (value.kind === "group") walk(value.expression);
      if (value.kind === "unary") walk(value.operand);
      if (value.kind !== "binary") return;
      const comparison = String(value.operator) in FLIP;
      if (comparison && record(value.right).kind === "duration") compared(value.left, value.right);
      else if (comparison && record(value.left).kind === "duration")
        compared(value.right, value.left);
      else {
        walk(value.left);
        walk(value.right);
      }
    };
    walk(condition);
  }
  return [...slots.values()].map(({ slot, numbers, durations }) => ({
    ...slot,
    numbers: [...numbers].sort((left, right) => left - right),
    durations: [...durations].sort((left, right) => left - right),
  }));
}

/** Comparison operators whose sides the explorer reads as compared values. */
const COMPARED = new Set(["==", "!=", "<", "<=", ">", ">="]);
const ARITHMETIC = new Set(["+", "-", "*", "/", "%"]);

/**
 * Whether the explorer can read an expression's value from a state: it reads variables, through properties, indices,
 * and arithmetic, and is no literal of its own.
 */
function readable(expression: unknown, top = true): boolean {
  const value = record(expression);
  switch (value.kind) {
    case "literal":
      return !top;
    case "identifier":
      return true;
    case "group":
      return readable(value.expression, top);
    case "unary":
      return value.operator === "-" && readable(value.operand, top);
    case "binary":
      return (
        ARITHMETIC.has(String(value.operator)) &&
        readable(value.left, false) &&
        readable(value.right, false) &&
        (!top || namesIn(value).size > 0)
      );
    case "property":
      return readable(value.object, false) && namesIn(value).size > 0;
    case "index":
      return (
        readable(value.object, false) && readable(value.index, false) && namesIn(value).size > 0
      );
    default:
      return false;
  }
}

/** Instructions after a timed button or a clock read within which the code that times it is looked for. */
const TIMING_WINDOW = 40;

/**
 * The expressions the code compares the results of interactions with, by the instruction of the interaction, when their
 * value can be read from a state (variables, properties, indices, and arithmetic), the four nearest the interaction:
 *
 * - `asks`: typed asks (text and number, also when the code computes the prompt), in each comparison or text test
 *   (`answer == line`, `answer.contains(word)`) whose one side comes from the answer (`DataFlow.flowOf`);
 * - `timed`: buttons whose result is the time the player took, in each comparison shortly after the button that
 *   compares that result itself (`(showButton "Done") / 1 s > count`).
 */
export function comparedWith(
  flow: DataFlow,
  instructions: readonly Data[],
  kind: "asks" | "timed",
): Map<number, unknown[]> {
  const typed = (index: number) => {
    const instruction = record(instructions[index]);
    const ui = record(instruction.ui ?? instruction.preparedUi);
    return kind === "asks"
      ? ui.kind === "text" || ui.kind === "number"
      : ui.kind === "button" && instruction.expectedResult === "duration";
  };
  /** The temporaries that hold a button's result as it was given, by temporary, as of the instruction looked at. */
  const results = new Map<number, number>();
  const sources = (answer: unknown, at: number): number[] => {
    if (kind === "asks") return [...flow.flowOf(answer).asks].filter(typed);
    return temporariesIn(answer).flatMap((temporary) => {
      const button = results.get(temporary);
      return button !== undefined && at - button <= TIMING_WINDOW && typed(button) ? [button] : [];
    });
  };
  /** Per interaction, the expressions found, by shape, with how far from it the comparison is. */
  const found = new Map<number, Map<string, { expression: unknown; distance: number }>>();
  const pair = (answer: unknown, other: unknown, at: number) => {
    if (!readable(other)) return;
    // A timed button's result divided by a duration (`/ 10 s`) is compared in that unit: the other side, read in
    // seconds, is scaled by it.
    const unit = kind === "timed" ? divisorOf(answer) : null;
    const compared =
      unit === null
        ? other
        : {
            kind: "binary",
            operator: "*",
            left: other,
            right: { kind: "literal", value: unit / 1000 },
          };
    for (const source of sources(answer, at)) {
      const known =
        found.get(source) ?? new Map<string, { expression: unknown; distance: number }>();
      const key = JSON.stringify(compared, (name, item: unknown) =>
        name === "span" ? undefined : item,
      );
      const distance = Math.abs(at - source);
      if ((known.get(key)?.distance ?? Infinity) > distance)
        known.set(key, { expression: compared, distance });
      found.set(source, known);
    }
  };
  const walk = (value: unknown, at: number): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, at);
      return;
    }
    if (!isRecord(value)) return;
    if (value.kind === "binary" && COMPARED.has(String(value.operator))) {
      pair(value.left, value.right, at);
      pair(value.right, value.left, at);
    }
    const callee = record(value.callee);
    if (
      value.kind === "call" &&
      callee.kind === "property" &&
      TEXT_TESTS.has(String(callee.name))
    ) {
      for (const argument of list(value.arguments)) {
        pair(callee.object, argument.value, at);
        pair(argument.value, callee.object, at);
      }
    }
    for (const [key, item] of Object.entries(value)) if (key !== "span") walk(item, at);
  };
  instructions.forEach((instruction, index) => {
    walk(instruction, index);
    if (instruction.kind === "interaction" && typeof instruction.destinationTemporary === "number")
      results.set(instruction.destinationTemporary, index);
    const value = record(instruction.value);
    const held = typeof value.temporaryId === "number" ? results.get(value.temporaryId) : undefined;
    if (
      instruction.kind === "storeTemporary" &&
      value.kind === "temporary" &&
      typeof instruction.temporaryId === "number" &&
      held !== undefined
    )
      results.set(instruction.temporaryId, held);
  });
  // The comparisons nearest the interaction first: a name other code also uses (`answer`) brings in theirs.
  return new Map(
    [...found].map(([ask, expressions]) => [
      ask,
      [...expressions.values()]
        .sort((left, right) => left.distance - right.distance)
        .slice(0, 4)
        .map(({ expression }) => expression),
    ]),
  );
}

/** The duration in milliseconds an expression divides by (`took / 10 s`), the first one found; null without one. */
function divisorOf(expression: unknown): number | null {
  if (Array.isArray(expression)) {
    for (const item of expression) {
      const found = divisorOf(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isRecord(expression)) return null;
  const right = record(expression.right);
  if (
    expression.kind === "binary" &&
    expression.operator === "/" &&
    right.kind === "duration" &&
    typeof right.milliseconds === "number"
  )
    return right.milliseconds;
  for (const [key, item] of Object.entries(expression)) {
    if (key === "span") continue;
    const found = divisorOf(item);
    if (found !== null) return found;
  }
  return null;
}

/** The temporaries an expression reads. */
function temporariesIn(expression: unknown): number[] {
  const found: number[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (isRecord(value)) {
      if (value.kind === "temporary" && typeof value.temporaryId === "number")
        found.push(value.temporaryId);
      for (const [key, item] of Object.entries(value)) if (key !== "span") walk(item);
    }
  };
  walk(expression);
  return found;
}

/** Constants a condition compares with: numbers, and durations in milliseconds. */
export interface Constants {
  readonly numbers: number[];
  readonly durations: number[];
}

/** A difference of two clock reads, from the instruction of the first to the one that takes the difference. */
export interface ClockDifference extends Constants {
  readonly from: number;
  readonly at: number;
  /** The conditions that compare it: they time what happens between the reads, not when the player comes back. */
  readonly conditions: number[];
}

/**
 * The differences of clock reads the code times something with (`start = getTimestamp().toSeconds()`, a button, then
 * `took = getTimestamp().toSeconds() - start`), with the conditions shortly after that compare the difference and the
 * constants they compare it with (`took < 5`); also a difference a condition takes itself.
 */
export function clockDifferences(flow: DataFlow, instructions: readonly Data[]): ClockDifference[] {
  /** The clock read each variable holds, by name, as of the instruction looked at: where it was read. */
  const reads = new Map<string, number>();
  /** Where a side of a difference read the clock: here, or where the variable it names got its clock read. */
  const readAt = (side: unknown, here: number): number | null => {
    const value = record(side);
    if (value.kind === "group") return readAt(value.expression, here);
    if (value.kind === "identifier" && typeof value.name === "string")
      return reads.get(value.name) ?? null;
    return value.kind === "call" && callsClock(value) ? here : null;
  };
  /** The two reads of a difference of clock reads (`now - start`), earlier first; null for another value. */
  const readsOf = (expression: unknown, here: number): { from: number; at: number } | null => {
    const value = record(expression);
    if (value.kind === "group") return readsOf(value.expression, here);
    if (value.kind !== "binary" || value.operator !== "-") return null;
    const at = readAt(value.left, here);
    let from: number | null = null;
    for (const name of namesIn(value.right)) from ??= reads.get(name) ?? null;
    return at === null || from === null || from >= at ? null : { from, at };
  };
  const differences: (ClockDifference & { readonly name: string | null })[] = [];
  /** The difference each variable holds, by name, as of the instruction looked at; another value ends it. */
  const held = new Map<string, ClockDifference>();
  /** The variables whose difference was updated from itself since (`took = took / 1000`): in other units. */
  const transformed = new Set<string>();
  const add = (difference: ClockDifference, constant: unknown, condition: number) => {
    if (!difference.conditions.includes(condition)) difference.conditions.push(condition);
    const duration = record(constant);
    if (typeof constant === "number" && !difference.numbers.includes(constant))
      difference.numbers.push(constant);
    if (
      duration.kind === "duration" &&
      typeof duration.milliseconds === "number" &&
      !difference.durations.includes(duration.milliseconds)
    )
      difference.durations.push(duration.milliseconds);
  };
  instructions.forEach((instruction, index) => {
    const name =
      instruction.kind === "assign"
        ? targetName(instruction.target)
        : (instruction.kind === "declareBinding" || instruction.kind === "declareGlobal") &&
            typeof instruction.name === "string"
          ? instruction.name
          : null;
    if (name !== null) {
      // A variable holds a clock read from a bare read on, and a difference until it is set to a value not computed from
      // itself (`took = took / 1000` keeps it).
      const difference = readsOf(instruction.value, index);
      if (difference !== null) {
        const taken = { name, ...difference, numbers: [], durations: [], conditions: [] };
        differences.push(taken);
        held.set(name, taken);
        transformed.delete(name);
      } else if (!namesIn(instruction.value).has(name)) {
        held.delete(name);
        transformed.delete(name);
      } else if (held.has(name)) transformed.add(name);
      if (difference === null && readAt(instruction.value, index) === index) reads.set(name, index);
      else reads.delete(name);
    }
    const conditional =
      instruction.kind === "jumpIfFalse" ||
      (instruction.kind === "loopStart" && instruction.loopKind === "while");
    if (!conditional) return;
    const condition = instruction.condition ?? instruction.expression;
    const compared = (subject: unknown, constant: unknown) => {
      const taken = readsOf(subject, index);
      if (taken !== null) {
        const own = { name: null, ...taken, numbers: [], durations: [], conditions: [] };
        differences.push(own);
        add(own, constant, index);
      }
      // A condition further on, or after an update in other units, still compares the difference, but its constant is
      // not taken for the button.
      for (const name of namesIn(subject)) {
        const difference = held.get(name);
        if (difference !== undefined && index > difference.at)
          add(
            difference,
            index - difference.at <= TIMING_WINDOW && !transformed.has(name) ? constant : undefined,
            index,
          );
      }
    };
    for (const atom of atomsFor(condition, true)) compared(atom.subject, atom.constant);
    // A comparison with a duration gives its constant; one with another value (`took <= limit`) only the condition.
    const walk = (expression: unknown): void => {
      const value = record(expression);
      if (value.kind === "group") walk(value.expression);
      if (value.kind === "unary") walk(value.operand);
      if (value.kind !== "binary") return;
      const left = record(value.left);
      const right = record(value.right);
      if (!(String(value.operator) in FLIP)) {
        walk(value.left);
        walk(value.right);
      } else if (right.kind === "duration") compared(value.left, value.right);
      else if (left.kind === "duration") compared(value.right, value.left);
      else if (left.kind !== "literal" && right.kind !== "literal") {
        compared(value.left, undefined);
        compared(value.right, undefined);
      }
    };
    walk(condition);
  });
  return differences
    .filter((difference) => difference.conditions.length > 0)
    .map(({ from, at, numbers, durations, conditions }) => ({
      from,
      at,
      numbers,
      durations,
      conditions,
    }));
}

/** Whether an expression reads the clock itself: calls a getter of the current date or time. */
export function callsClock(expression: unknown): boolean {
  if (Array.isArray(expression)) return expression.some(callsClock);
  if (!isRecord(expression)) return false;
  if (expression.kind === "call" && CLOCK_GETTERS.has(calleeName(expression) ?? "")) return true;
  return Object.entries(expression).some(([key, item]) => key !== "span" && callsClock(item));
}

/** Whether a stored key, given by its text or a pattern with {@link KEY_PLACEHOLDER} parts, matches a key. */
export function keyMatcher(pattern: string): (key: string) => boolean {
  if (!pattern.includes(KEY_PLACEHOLDER)) return (key) => key === pattern;
  const parts = pattern
    .split(KEY_PLACEHOLDER)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const matcher = new RegExp(`^${parts.join(".*")}$`, "u");
  return (key) => matcher.test(key);
}

/** Whether a save's key (text or pattern) may be the key a load reads (text). */
function keysMayMatch(saved: string, read: string): boolean {
  return keyMatcher(saved)(read);
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
