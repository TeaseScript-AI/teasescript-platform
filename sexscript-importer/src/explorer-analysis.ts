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

/**
 * The milliseconds of an exact duration, a literal or value of kind `duration` without calendar months or days; null for
 * a calendar one, whose length depends on the date: a `calendarDuration` (`1 calendar day`), or a `duration` with months
 * or days, as plans wrote `1 day` and `1 month` before the time model made a day 24 hours.
 */
export function exactMilliseconds(value: unknown): number | null {
  const duration = record(value);
  return duration.kind === "duration" &&
    typeof duration.milliseconds === "number" &&
    duration.months === undefined &&
    duration.days === undefined
    ? duration.milliseconds
    : null;
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
export function successors(
  plan: Data,
  instructions: readonly Data[],
  dead: ReadonlyMap<number, boolean>,
): number[][] {
  const functions = list(plan.functions);
  const entry = (id: unknown) => functions[Number(id) - 1]?.entryInstruction;
  const functionOf = new Map<number, number>();
  for (const definition of functions) {
    // A function's instructions run from its entry up to, not including, its end.
    const end = Number(definition.endInstruction);
    for (let index = Number(definition.entryInstruction); index < end; index += 1)
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
  // Every `end` goes to the same places: one list for all of them.
  const endTargets = numbers([...fileReturns, ...fallbacks]);
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
        return endTargets;
      case "transfer":
        return numbers([
          ...destinationTargets(instruction.destination, plan),
          ...(instruction.mode === "call" ? [index + 1] : []),
        ]);
      case "callFunction":
        return numbers([entry(instruction.functionId)]);
      case "prepareParameterDefault":
        // A supplied argument skips the default.
        return numbers([index + 1, instruction.target]);
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
// getTimestamp is the name before #759, getAbsoluteDateTime the one after it.
const CLOCK_GETTERS = new Set([
  "getDate",
  "getTime",
  "getDateTime",
  "getTimestamp",
  "getAbsoluteDateTime",
]);

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
export interface LoadAlias {
  readonly key: string;
  readonly fallback: SavedScalar | null;
}

/** Stands for a computed part of a storage key pattern. */
export const KEY_PLACEHOLDER = "\u0000";

/**
 * A function's own code: its loads with a key template, its calls of functions, the variables it reads and those it
 * assigns, declares, or loops over, and the literal keys it loads.
 */
interface Code {
  readonly loads: Data[];
  readonly calls: Data[];
  readonly names: Set<string>;
  readonly bound: Set<string>;
  readonly keys: Set<string>;
}

/** How many helper calls deep a key template's parts are followed to the arguments of the call a condition reads. */
const HELPER_DEPTH = 3;

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
export function namesIn(expression: unknown): Set<string> {
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
  /** The function each instruction of a function body belongs to, by its ID. */
  readonly #functionOf = new Map<number, number>();
  /** Variables whose every assignment is the same literal, by name; null for any other variable. */
  readonly #literals = new Map<string, SavedScalar | null>();
  readonly #instructions: readonly Data[];
  /** The instructions a jump, condition, or loop goes to. */
  readonly #jumpTargets = new Set<number>();
  /** Each function's own code, by its ID ({@link Code}); made when first needed. */
  #code: Map<number, Code> | null = null;
  /**
   * The values assigned to each variable, by name, its declaration's included, with their instructions: for a parameter
   * `{ kind: "parameter" }`, which reads no key, for a loop variable `{ kind: "element", of }` and for an assignment to
   * a part of it `{ kind: "part", of }`, which read the keys of what they come from but are none of its values.
   */
  readonly #assigned = new Map<string, { value: Data; index: number }[]>();
  /** The variables, temporaries, and functions that hold a stored key's value, by them, the key, and the kind needed. */
  readonly #holds = new Set<string>();
  /** Each function's `returnValue` instructions, by its ID. */
  readonly #returns = new Map<number, number[]>();
  /** The stores of each temporary, by its ID: its `storeTemporary`s and the calls whose result it takes, in order. */
  readonly #stores = new Map<number, number[]>();

  /**
   * `computedPrompts` also counts an ask whose prompt the code computes (`askText "Type: ${line}"`, a prepared UI) as
   * the typed ask it is; without it, only an ask with a fixed prompt is.
   */
  constructor(
    plan: Data,
    instructions: readonly Data[],
    settings: { computedPrompts?: boolean } = {},
  ) {
    this.#instructions = instructions;
    const functions = list(plan.functions);
    const functionOf = this.#functionOf;
    for (const definition of functions) {
      const end = Number(definition.endInstruction);
      for (let index = Number(definition.entryInstruction); index < end; index += 1)
        functionOf.set(index, Number(definition.id));
    }
    for (const instruction of instructions)
      for (const target of [instruction.target, instruction.continueTarget])
        if (typeof target === "number") this.#jumpTargets.add(target);
    instructions.forEach((instruction, index) => {
      if (instruction.kind !== "returnValue") return;
      const owner = this.functionAt(index);
      const known = this.#returns.get(owner) ?? [];
      known.push(index);
      this.#returns.set(owner, known);
    });
    instructions.forEach((instruction, index) => {
      const stored =
        instruction.kind === "storeTemporary"
          ? instruction.temporaryId
          : instruction.kind === "callFunction"
            ? instruction.destinationTemporary
            : null;
      if (typeof stored !== "number") return;
      const known = this.#stores.get(stored) ?? [];
      known.push(index);
      this.#stores.set(stored, known);
    });
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

  /**
   * The load a variable only ever holds (`let ready = load("ready", default: true)`): its key and default; null for
   * another variable.
   */
  loadAlias(name: string): LoadAlias | null {
    return this.#loads.get(name) ?? null;
  }

  /**
   * Whether an expression's value is a stored key's value (`key` as {@link sourcesOf} names it, a pattern for a
   * template): its load, a whole number of an integer load (`toInteger`), a truth of a boolean load compared with
   * `true`, a variable whose every assignment that reads the key is such (a value from elsewhere, such as a random draw,
   * may also be assigned), a temporary that holds such at instruction `at` (a `switch` on a load), or a call's result
   * whose every returned value that reads the key is such. A load of an open type may hold a truth or a whole number. A
   * comparison of such a value with a constant compares the stored value; of anything else computed from it, such as
   * `todo - done` or a count added to, it does not. A variable, temporary, or function met again while this is worked
   * out (`x = x`, a function that calls itself) holds what its other values hold: the greatest answer that holds
   * together; those found to hold are kept for later questions.
   */
  holdsStored(expression: unknown, key: string, at: number | undefined): boolean {
    type Need = "value" | "truth" | "integer";
    // Each variable, temporary, and function is gone through once: one met again is being or was gone through without
    // a value that is not the stored one, as the search stops at the first such. When none is found, all of them hold.
    const visited = new Set<string>();
    const node = (
      name: string,
      need: Need,
      values: { value: unknown; at: number | undefined }[],
    ) => {
      const id = `${name}\u0000${key}\u0000${need}`;
      if (this.#holds.has(id) || visited.has(id)) return true;
      visited.add(id);
      const reading = values.filter((each) => this.flowOf(each.value).keys.has(key));
      return reading.length > 0 && reading.every((each) => holdsAt(each.value, each.at, need));
    };
    // A load's declared type that can hold the kind needed; an open one can.
    const fits = (type: Data, need: Need): boolean =>
      need === "value" ||
      typeof type.kind !== "string" ||
      type.kind === (need === "truth" ? "boolean" : "integer") ||
      (type.kind === "union" && list(type.members).some((member) => fits(member, need)));
    const holdsAt = (expression: unknown, at: number | undefined, need: Need): boolean => {
      const value = record(expression);
      if (value.kind === "group") return holdsAt(value.expression, at, need);
      if (value.kind === "storageLoad")
        return fits(record(value.type), need) && keyText(value.key) === key;
      if (value.kind === "identifier" && typeof value.name === "string")
        return node(
          `variable ${value.name}`,
          need,
          (this.#assigned.get(value.name) ?? []).map((each) => ({
            value: each.value,
            at: each.index,
          })),
        );
      // A whole number is no truth.
      if (value.kind === "call" && calleeName(value) === "toInteger") {
        const [only, ...rest] = list(value.arguments);
        return (
          need !== "truth" &&
          only !== undefined &&
          rest.length === 0 &&
          holdsAt(only.value, at, "integer")
        );
      }
      // A truth compared with `true` is that truth (`load(k) == true`).
      if (value.kind === "binary" && (value.operator === "==" || value.operator === "!=")) {
        const truth = value.operator === "==";
        const [left, right] = [record(value.left), record(value.right)];
        const side =
          right.kind === "literal" && right.value === truth
            ? left
            : left.kind === "literal" && left.value === truth
              ? right
              : null;
        return side !== null && holdsAt(side, at, "truth");
      }
      if (value.kind === "temporary" && typeof value.temporaryId === "number" && at !== undefined) {
        const held = this.heldAt(value.temporaryId, at);
        return (
          held !== null &&
          node(
            `temporary ${value.temporaryId} at ${at}`,
            need,
            held.map((store) => ({ value: store.value, at: store.index })),
          )
        );
      }
      // A call's result: what the function returns.
      if (value.kind === "callResult" && typeof value.functionId === "number") {
        const id = value.functionId;
        return node(
          `function ${id}`,
          need,
          (this.#returns.get(id) ?? []).map((index) => ({
            value: this.#instructions[index]!.value,
            at: index,
          })),
        );
      }
      return false;
    };
    const holds = holdsAt(expression, at, "value");
    if (holds) for (const id of visited) this.#holds.add(id);
    return holds;
  }

  /** The function an instruction is in, by its ID; 0 for a file's own code. */
  functionAt(index: number): number {
    return this.#functionOf.get(index) ?? 0;
  }

  /**
   * What a temporary may hold at an instruction, with the index of the store that put it there: the expression of the
   * nearest store of it before the instruction, and of earlier stores too while a jump between the earlier store and the
   * later one goes past the later one (a condition `a and b` lowers to a temporary that holds `a`, then `b` only when
   * `a` holds; `load(k, default: f())` to one that holds the load, then `f()`'s result only when the load gives
   * nothing). A temporary lives within one expression, from its first store on, so no jump goes past that one. A call's
   * result is `{ kind: "callResult", functionId, call }` with the call's index, which {@link flowOf} reads as the
   * function's result. Null when there is no store before the instruction in its function.
   */
  heldAt(temporaryId: number, at: number): { value: Data; index: number }[] | null {
    const stores = this.#stores.get(temporaryId) ?? [];
    const owner = this.functionAt(at);
    const held: { value: Data; index: number }[] = [];
    let nearest = stores.length - 1;
    while (nearest >= 0 && stores[nearest]! >= at) nearest -= 1;
    for (let store = nearest; store >= 0; store -= 1) {
      const index = stores[store]!;
      if (this.functionAt(index) !== owner) return null;
      const instruction = this.#instructions[index]!;
      held.push({
        value:
          instruction.kind === "callFunction"
            ? { kind: "callResult", functionId: instruction.functionId, call: index }
            : record(instruction.value),
        index,
      });
      if (store === 0 || !this.#jumpedOver(stores[store - 1]!, index, at)) return held;
    }
    return null;
  }

  /** Whether a jump after instruction `from` and before `index` goes past `index` to at most `at`. */
  #jumpedOver(from: number, index: number, at: number): boolean {
    for (let jump = from + 1; jump < index; jump += 1) {
      const target = this.#instructions[jump]!.target;
      if (typeof target === "number" && target > index && target <= at) return true;
    }
    return false;
  }

  /**
   * The one stored key that a key pattern a condition at instruction `at` reads stands for, when every read of it there
   * names that key with constants: a load whose template's computed parts are literals or variables that only ever hold
   * one literal, or a load in a helper whose result the condition reads, with the helper's parameters that its code
   * does not assign as the arguments of the call that gave that result right before (also in the helpers it calls, a
   * few calls deep), also through a variable, as each of its assignments that reads the pattern names it. The pattern
   * otherwise, also when the pattern can come another way: through a parameter, a loop variable, a stored value, or a
   * helper call that names no key.
   */
  keyAt(pattern: string, condition: unknown, at: number): string {
    if (!pattern.includes(KEY_PLACEHOLDER)) return pattern;
    const keys = new Set<string | null>();
    const followed = new Set<string>();
    const walk = (value: unknown, at: number): void => {
      if (Array.isArray(value)) value.forEach((item) => walk(item, at));
      if (!isRecord(value)) return;
      if (value.kind === "storageLoad" && keyText(value.key) === pattern)
        keys.add(this.#keyNamed(value.key, new Map()));
      else if (value.kind === "storageLoad") {
        if (this.#stored.get(keyText(value.key) ?? "")?.keys.has(pattern) === true) keys.add(null);
      } else if (value.kind === "identifier" && typeof value.name === "string") {
        if (this.#variables.get(value.name)?.keys.has(pattern) !== true || followed.has(value.name))
          return;
        followed.add(value.name);
        for (const assigned of this.#assigned.get(value.name) ?? []) {
          if (!this.flowOf(assigned.value).keys.has(pattern)) continue;
          const kind = assigned.value.kind;
          if (kind === "parameter" || kind === "element" || kind === "part") keys.add(null);
          else walk(assigned.value, assigned.index);
        }
      } else if (value.kind === "temporary" && typeof value.temporaryId === "number") {
        if (this.#temporaries.get(value.temporaryId)?.keys.has(pattern) !== true) return;
        const call = this.#callBefore(value.temporaryId, at);
        const named = call === null ? [] : this.#keysCalled(call, pattern, new Map(), HELPER_DEPTH);
        if (named.length === 0) keys.add(null);
        for (const key of named) keys.add(key);
      } else if (value.kind === "callResult" && typeof value.call === "number") {
        if (this.#functions.get(Number(value.functionId))?.keys.has(pattern) !== true) return;
        const named = this.#keysCalled(
          this.#instructions[value.call]!,
          pattern,
          new Map(),
          HELPER_DEPTH,
        );
        if (named.length === 0) keys.add(null);
        for (const key of named) keys.add(key);
      }
      for (const [key, item] of Object.entries(value)) if (key !== "span") walk(item, at);
    };
    walk(condition, at);
    const [key] = keys;
    return keys.size === 1 && typeof key === "string" ? key : pattern;
  }

  /**
   * The keys of a key pattern that a helper call loads: in the helper's own code, with its parameters that the code
   * does not assign as the call's arguments (`passed` gives the caller's own parameters theirs), and in the helpers it
   * calls, `depth` calls deep; null for a load that names no one key, and for the pattern coming another way: through a
   * variable the code does not assign, a stored value, or a call that names no key.
   */
  #keysCalled(
    call: Data,
    pattern: string,
    passed: ReadonlyMap<unknown, unknown>,
    depth: number,
  ): (string | null)[] {
    const code = this.#codeOf(Number(call.functionId));
    const parameters = new Map(
      list(call.arguments)
        .filter((argument) => !code.bound.has(String(argument.parameterName)))
        .map((argument) => {
          const value = record(argument.value);
          const outer = value.kind === "identifier" && passed.has(value.name);
          return [argument.parameterName, outer ? passed.get(value.name) : argument.value];
        }),
    );
    const keys = code.loads
      .filter((load) => keyText(load.key) === pattern)
      .map((load) => this.#keyNamed(load.key, parameters));
    for (const name of code.names)
      if (!code.bound.has(name) && this.#variables.get(name)?.keys.has(pattern) === true)
        keys.push(null);
    for (const key of code.keys)
      if (this.#stored.get(key)?.keys.has(pattern) === true) keys.push(null);
    for (const inner of code.calls) {
      if (this.#functions.get(Number(inner.functionId))?.keys.has(pattern) !== true) continue;
      const named = depth === 0 ? [] : this.#keysCalled(inner, pattern, parameters, depth - 1);
      keys.push(...(named.length === 0 ? [null] : named));
    }
    return keys;
  }

  /**
   * The key a load's template names, with `passed` giving the helper's parameters their call's arguments; null when a
   * computed part is not a constant: a literal text or whole number, or a variable that only ever holds one.
   */
  #keyNamed(key: unknown, passed: ReadonlyMap<unknown, unknown>): string | null {
    let text = "";
    for (const part of list(record(key).parts)) {
      if (part.kind === "text" && typeof part.value === "string") {
        text += part.value;
        continue;
      }
      const expression = record(part.expression);
      const parameter = expression.kind === "identifier" && passed.has(expression.name);
      const value = record(parameter ? passed.get(expression.name) : expression);
      const constant =
        value.kind === "literal"
          ? value.value
          : value.kind === "identifier" && typeof value.name === "string"
            ? this.#literals.get(value.name)
            : undefined;
      if (typeof constant !== "string" && !Number.isSafeInteger(constant)) return null;
      text += String(constant);
    }
    return text;
  }

  /**
   * The helper call that gives temporary `id` its value for instruction `at`: the write of it right before, in the same
   * code with no jump going between; null when that is no call, or there is none.
   */
  #callBefore(id: number, at: number): Data | null {
    const owner = this.functionAt(at);
    for (let index = at - 1; index >= 0 && this.functionAt(index) === owner; index -= 1) {
      if (this.#jumpTargets.has(index + 1)) return null;
      const instruction = this.#instructions[index]!;
      if (instruction.destinationTemporary === id)
        return instruction.kind === "callFunction" ? instruction : null;
      if (instruction.temporaryId === id) return null;
    }
    return null;
  }

  /** A function's own code ({@link Code}). */
  #codeOf(functionId: number): Code {
    const empty = (): Code => ({
      loads: [],
      calls: [],
      names: new Set(),
      bound: new Set(),
      keys: new Set(),
    });
    if (this.#code === null) {
      const found = new Map<number, Code>();
      const walk = (value: unknown, code: Code): void => {
        if (Array.isArray(value)) value.forEach((item) => walk(item, code));
        if (!isRecord(value)) return;
        const key = value.kind === "storageLoad" ? record(value.key) : null;
        if (key?.kind === "template") code.loads.push(value);
        else if (key?.kind === "literal" && typeof key.value === "string") code.keys.add(key.value);
        if (value.kind === "identifier" && typeof value.name === "string")
          code.names.add(value.name);
        for (const [field, item] of Object.entries(value)) if (field !== "span") walk(item, code);
      };
      this.#instructions.forEach((instruction, index) => {
        const owner = this.functionAt(index);
        const code = found.get(owner) ?? empty();
        found.set(owner, code);
        if (instruction.kind === "callFunction") code.calls.push(instruction);
        const bound =
          instruction.kind === "assign"
            ? [targetName(instruction.target)]
            : instruction.kind === "declareBinding" || instruction.kind === "declareGlobal"
              ? [instruction.name]
              : instruction.kind === "loopStart"
                ? [instruction.variable, instruction.valueVariable]
                : [];
        for (const name of bound) if (typeof name === "string") code.bound.add(name);
        walk(instruction, code);
      });
      this.#code = found;
    }
    return this.#code.get(functionId) ?? empty();
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
      } else if (value.kind === "callResult" && typeof value.functionId === "number") {
        const known = this.#functions.get(value.functionId);
        if (known !== undefined) merge(flow, known);
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
    const assigned = (name: string, value: Data, index: number) => {
      const known = this.#assigned.get(name) ?? [];
      known.push({ value, index });
      this.#assigned.set(name, known);
    };
    const assign = (name: string, value: unknown, index: number) => {
      const expression = record(value);
      assigned(name, expression, index);
      const key = expression.kind === "storageLoad" ? literalText(expression.key) : null;
      const fallback = record(expression.default);
      const literal = expression.default == null ? null : scalar(fallback.value);
      const load =
        key === null ||
        (expression.default != null && fallback.kind !== "literal") ||
        literal === undefined
          ? null
          : { key, fallback: literal };
      const only = expression.kind === "literal" ? (scalar(expression.value) ?? null) : null;
      const fixed = this.#literals.get(name);
      this.#literals.set(name, fixed === undefined || fixed === only ? only : null);
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
        if (typeof parameter.name === "string") {
          this.#loads.set(parameter.name, null);
          this.#literals.set(parameter.name, null);
          assigned(parameter.name, { kind: "parameter" }, Number(definition.entryInstruction));
        }
    instructions.forEach((instruction, index) => {
      if (instruction.kind === "loopStart")
        for (const name of [instruction.variable, instruction.valueVariable])
          if (typeof name === "string") {
            this.#loads.set(name, null);
            this.#literals.set(name, null);
            assigned(name, { kind: "element", of: instruction.expression }, index);
          }
      if (
        (instruction.kind === "declareBinding" || instruction.kind === "declareGlobal") &&
        typeof instruction.name === "string"
      )
        assign(instruction.name, instruction.value, index);
      if (instruction.kind === "assign") {
        const target = record(instruction.target);
        const name = targetName(instruction.target);
        if (name === null) return;
        if (target.kind === "identifier") assign(name, instruction.value, index);
        else {
          this.#loads.set(name, null);
          this.#literals.set(name, null);
          assigned(name, { kind: "part", of: instruction.value }, index);
        }
      }
    });
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

/**
 * One comparison in a condition between a source expression and a constant, wanted true or false; or, with `against`,
 * between two expressions, `subject operator against`, with 0 as the constant.
 */
interface Atom {
  readonly subject: unknown;
  readonly operator: string;
  readonly constant: string | number | boolean | null;
  readonly wanted: boolean;
  readonly against?: unknown;
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

/** Whether an expression is a truth the code computes: a comparison, a text test, or `and`, `or`, or `not` of such. */
function comparesTruth(expression: unknown): boolean {
  const value = record(expression);
  if (value.kind === "group") return comparesTruth(value.expression);
  if (value.kind === "unary") return value.operator === "not";
  if (value.kind === "binary")
    return (
      String(value.operator) in FLIP ||
      value.operator === "and" ||
      value.operator === "or" ||
      value.operator === "in"
    );
  return value.kind === "call" && TEXT_TESTS.has(calleeName(value) ?? "");
}

/**
 * The comparisons a condition must make for it to have the value `wanted`, as alternatives: each one alone is a way to
 * get there (for `and` wanted true, all of its parts are listed, and a value is checked against the whole condition).
 * With `pairs`, a comparison of two expressions neither of which is a constant is listed too.
 */
function atomsFor(expression: unknown, wanted: boolean, pairs = false): Atom[] {
  const value = record(expression);
  if (value.kind === "group") return atomsFor(value.expression, wanted, pairs);
  if (value.kind === "unary" && value.operator === "not")
    return atomsFor(value.operand, !wanted, pairs);
  if (value.kind === "binary" && (value.operator === "and" || value.operator === "or"))
    return [...atomsFor(value.left, wanted, pairs), ...atomsFor(value.right, wanted, pairs)];
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
    return pairs
      ? [
          {
            subject: value.left,
            operator: value.operator,
            constant: 0,
            wanted,
            against: value.right,
          },
        ]
      : [];
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
   * constant is measured as 0 or 1; `shown` keeps the constant as the condition writes it, for notes. With `against`,
   * the variable is compared with another value instead, a variable or a stored value (`text` names it), and their
   * difference, the variable's value less that value, is measured against `constant` 0.
   */
  readonly comparison: {
    readonly operator: string;
    readonly constant: number;
    readonly shown: number | boolean;
    readonly against?: { readonly subject: unknown; readonly text: string };
  } | null;
}

/**
 * The goals for taking a condition's missed way: `wanted` is the condition value of that way. A subject that applies
 * `length` to a source turns a length into a text of that length; `toInteger` and the like keep the number. With the
 * condition's instruction `at`, a stored key read through a key template is the one key it names there, if it names
 * one ({@link DataFlow.keyAt}).
 */
export function goalsFor(flow: DataFlow, condition: unknown, wanted: boolean, at?: number): Goal[] {
  const goals: Goal[] = [];
  const keyed = (source: Source, expression: unknown): Source =>
    source.kind === "storage" && at !== undefined
      ? { kind: "storage", key: flow.keyAt(source.key, expression, at) }
      : source;
  // A temporary's truth compared with `true` or `false` is read through what the stores before the condition that can
  // reach it put there, also through temporaries copied into it, as the temporary itself merges every value it ever
  // held. A truth the code computes, as a short-circuit `a and b` or `a or b` lowers to, holds what the way taken left
  // there: no stored value to make true, so it is left out and what it reads stays a dependency (below). A value the code
  // tests (`load(...) and f()`), or a call's result, is an atom's subject instead. A temporary copied further than
  // followed is left out too, and stays a dependency as it is.
  let readThrough = false;
  const leaves = (temporaryId: number, before: number, depth: number): Data[] | "deep" | null => {
    if (depth === 0) return "deep";
    const held = flow.heldAt(temporaryId, before);
    if (held === null) return null;
    const found: Data[] = [];
    for (const { value, index } of held) {
      if (value.kind !== "temporary" || typeof value.temporaryId !== "number") {
        found.push(value);
        continue;
      }
      const inner = leaves(value.temporaryId, index, depth - 1);
      if (inner === null || inner === "deep") return inner;
      found.push(...inner);
    }
    return found;
  };
  const atoms = atomsFor(condition, wanted, true).flatMap((atom): Atom[] => {
    const subject = record(atom.subject);
    if (
      at === undefined ||
      atom.against !== undefined ||
      typeof atom.constant !== "boolean" ||
      subject.kind !== "temporary" ||
      typeof subject.temporaryId !== "number"
    )
      return [atom];
    const found = leaves(subject.temporaryId, at, 8);
    if (found === null) return [atom];
    if (found === "deep") return [];
    readThrough = true;
    return found
      .filter((value) => !comparesTruth(value))
      .map((value) => ({ ...atom, subject: value }));
  });
  for (const atom of atoms) {
    if (atom.against !== undefined) {
      const goal = differenceGoal(flow, atom);
      if (goal !== null) goals.push(goal);
      continue;
    }
    const values = solve(atom);
    const subject = record(atom.subject);
    const lengthOf = subject.kind === "property" && subject.name === "length";
    const holds = atom.wanted ? atom.operator : negate(atom.operator);
    // A key template that names one key may name a key the condition also reads by its text: one goal for both, which
    // compares the stored value only when every read of it is the value itself.
    const keys = new Set<string>();
    const sources = flow
      .sourcesOf(atom.subject)
      .map((found) => ({ found, source: keyed(found, atom.subject) }));
    for (const { source } of sources) {
      if (source.kind === "storage" && keys.has(source.key)) continue;
      if (source.kind === "storage") keys.add(source.key);
      // A stored value is measured, and its values tried, only where the condition compares the value itself, not one
      // computed from it; closeness of a variable, where it reads the variable itself.
      const itself =
        (source.kind === "variable" &&
          subject.kind === "identifier" &&
          subject.name === source.name) ||
        (source.kind === "storage" &&
          sources.every(
            (each) =>
              each.source.kind !== "storage" ||
              each.source.key !== source.key ||
              (each.found.kind === "storage" && flow.holdsStored(atom.subject, each.found.key, at)),
          ));
      const candidates =
        source.kind === "storage" && !itself
          ? []
          : source.kind === "ask"
            ? values
                .filter((value) => typeof value !== "object")
                .map((value) =>
                  lengthOf && typeof value === "number"
                    ? "x".repeat(Math.max(1, Math.min(value, 200)))
                    : String(value),
                )
            : values;
      const constant =
        typeof atom.constant === "number"
          ? atom.constant
          : typeof atom.constant === "boolean"
            ? Number(atom.constant)
            : null;
      const comparison =
        constant !== null && itself
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
  // Stored keys and clock reads of comparisons with no constant side, such as `now < start + period`. Of a condition
  // whose truth was read through: of what its temporaries hold, also nested ones (`not (a or f())`), each value apart,
  // so that keys one names are not taken for keys another names.
  const parts: unknown[] = [];
  const split = (value: Data, before: number, depth: number): void => {
    const inner: { value: Data; index: number }[] = [];
    const masked = (item: Data): Data => {
      const held =
        item.kind === "temporary" && typeof item.temporaryId === "number" && depth > 0
          ? flow.heldAt(item.temporaryId, before)
          : null;
      if (held !== null) inner.push(...held);
      return held !== null
        ? { kind: "literal", value: null }
        : Object.fromEntries(
            Object.entries(item).map(([key, each]) => [
              key,
              Array.isArray(each)
                ? each.map((one: unknown) => (isRecord(one) ? masked(one) : one))
                : isRecord(each)
                  ? masked(each)
                  : each,
            ]),
          );
    };
    parts.push(masked(value));
    for (const store of inner) split(store.value, store.index, depth - 1);
  };
  if (!readThrough || !isRecord(condition) || at === undefined) parts.push(condition);
  else split(condition, at, 8);
  for (const [found, expression] of parts.flatMap((part) =>
    flow.sourcesOf(part).map((found) => [found, part] as const),
  )) {
    const source = keyed(found, expression);
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
 * The goal of a comparison of two values (`reps >= target`): a variable of one side that the code counts, measured by
 * its difference from the other side, a variable or a stored value with a literal key. Only a counter, which holds a
 * number, as directed search measures few comparisons at once, and two texts (`typed == line`) have no difference. No
 * value is solved for, as it depends on the other side. Null when neither side is such a pair.
 */
function differenceGoal(flow: DataFlow, atom: Atom): Goal | null {
  const holds = atom.wanted ? atom.operator : negate(atom.operator);
  const sides: [unknown, unknown, string][] = [
    [atom.subject, atom.against, holds],
    [atom.against, atom.subject, FLIP[holds]!],
  ];
  for (const [side, other, operator] of sides) {
    const name = record(side).kind === "identifier" ? record(side).name : null;
    const text = valueText(other);
    if (typeof name !== "string" || text === null || text === name) continue;
    const source = flow
      .sourcesOf(side)
      .find((found) => found.kind === "variable" && found.name === name && found.counter);
    if (source !== undefined)
      return {
        source,
        candidates: [],
        comparison: { operator, constant: 0, shown: 0, against: { subject: other, text } },
      };
  }
  return null;
}

/** How a value a state holds is named: a variable by its name, a stored value with a literal key as `stored key`. */
function valueText(expression: unknown): string | null {
  const value = record(expression);
  if (value.kind === "identifier" && typeof value.name === "string") return value.name;
  const key = value.kind === "storageLoad" ? literalText(value.key) : null;
  return key === null ? null : `stored ${key}`;
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
    const milliseconds = exactMilliseconds(constant);
    if (typeof constant === "number") known.numbers.add(constant);
    else if (typeof constant === "string") known.strings.add(constant);
    else if (milliseconds !== null) known.durations.add(milliseconds);
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
/** The expressions kept per typed ask or timed button that the code compares its answer or time with. */
const MAX_COMPARED = 4;

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
  /**
   * Per interaction, at most {@link MAX_COMPARED} expressions found, by shape. A timed button's are the first ones after
   * it. A typed ask's are those nearest it, those in its own function first: a name other code also uses (`answer`)
   * brings in theirs.
   */
  const found = new Map<
    number,
    Map<string, { expression: unknown; rank: readonly [number, number] }>
  >();
  const worse = (left: readonly [number, number], right: readonly [number, number]) =>
    left[0] - right[0] || left[1] - right[1];
  // How near a comparison is to an ask counts the instructions with a comparison between them, so that code without
  // comparisons (a list, a loop of `say`s) does not move them: per instruction, how many such come before it.
  const comparing: number[] = [];
  /** The instructions with a comparison strictly between two instructions. */
  const between = (one: number, other: number) =>
    one === other ? 0 : comparing[Math.max(one, other)]! - comparing[Math.min(one, other) + 1]!;
  instructions.reduce((count, instruction, index) => {
    comparing[index] = count;
    return count + (hasComparison(instruction) ? 1 : 0);
  }, 0);
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
        found.get(source) ??
        new Map<string, { expression: unknown; rank: readonly [number, number] }>();
      found.set(source, known);
      const key = JSON.stringify(compared, (name, item: unknown) =>
        name === "span" ? undefined : item,
      );
      if (kind === "timed") {
        if (known.size < MAX_COMPARED) known.set(key, { expression: compared, rank: [0, 0] });
        continue;
      }
      const rank = [
        flow.functionAt(at) === flow.functionAt(source) ? 0 : 1,
        between(at, source),
      ] as const;
      const before = known.get(key);
      if (before !== undefined) {
        if (worse(rank, before.rank) < 0) known.set(key, { expression: compared, rank });
        continue;
      }
      if (known.size < MAX_COMPARED) {
        known.set(key, { expression: compared, rank });
        continue;
      }
      const [last, kept] = [...known].reduce((most, entry) =>
        worse(entry[1].rank, most[1].rank) > 0 ? entry : most,
      );
      if (worse(rank, kept.rank) < 0) {
        known.delete(last);
        known.set(key, { expression: compared, rank });
      }
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
  return new Map(
    [...found].map(([ask, expressions]) => [
      ask,
      [...expressions.values()]
        .sort((left, right) => worse(left.rank, right.rank))
        .map(({ expression }) => expression),
    ]),
  );
}

/** Whether an instruction compares (`<`, `==`, ...) or tests text (`contains`, ...), as {@link comparedWith} reads it. */
function hasComparison(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasComparison);
  if (!isRecord(value)) return false;
  if (value.kind === "binary" && COMPARED.has(String(value.operator))) return true;
  const callee = record(value.callee);
  if (value.kind === "call" && callee.kind === "property" && TEXT_TESTS.has(String(callee.name)))
    return true;
  return Object.entries(value).some(([key, item]) => key !== "span" && hasComparison(item));
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
  const divisor = exactMilliseconds(expression.right);
  if (expression.kind === "binary" && expression.operator === "/" && divisor !== null)
    return divisor;
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
  /**
   * The conditions that compare it with constants or values not from the clock: they time what happens between the
   * reads, not when the player comes back.
   */
  readonly conditions: number[];
}

/**
 * Whether the condition at `index` is the one the compiler adds for a load whose default calls a function
 * (`load(k, default: f())`): the load without its default into a temporary, then whether that gave nothing, before the
 * default is computed. The author wrote no such condition: whether the default is used shows in the lines of what it
 * calls.
 */
export function loadDefaultCheck(instructions: readonly Data[], index: number): boolean {
  const instruction = instructions[index];
  const before = instructions[index - 1];
  if (instruction?.kind !== "jumpIfFalse" || before?.kind !== "storeTemporary") return false;
  const condition = record(instruction.condition);
  const [left, right, loaded] = [
    record(condition.left),
    record(condition.right),
    record(before.value),
  ];
  const span = record(condition.span);
  const same = (other: Data) =>
    isRecord(other.span) && other.span.so === span.so && other.span.eo === span.eo;
  return (
    condition.kind === "binary" &&
    condition.operator === "==" &&
    left.kind === "temporary" &&
    left.temporaryId === before.temporaryId &&
    right.kind === "literal" &&
    right.value === null &&
    same(right) &&
    loaded.kind === "storageLoad" &&
    loaded.default === null &&
    same(loaded)
  );
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
  /** Conditions that also compare a difference with a value from the clock: not only how long the player took. */
  const unmeasured = new Set<number>();
  const add = (difference: ClockDifference, constant: unknown, condition: number) => {
    if (!difference.conditions.includes(condition)) difference.conditions.push(condition);
    const milliseconds = exactMilliseconds(constant);
    if (typeof constant === "number" && !difference.numbers.includes(constant))
      difference.numbers.push(constant);
    if (milliseconds !== null && !difference.durations.includes(milliseconds))
      difference.durations.push(milliseconds);
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
        // Against a value that does not come from the clock (`took <= limit`), only how long the player took varies.
        for (const [subject, other] of [
          [value.left, value.right],
          [value.right, value.left],
        ] as const) {
          if (!flow.flowOf(other).clock) compared(subject, undefined);
          // Both sides from the clock: not only how long the player took.
          else if (flow.flowOf(subject).clock) unmeasured.add(index);
        }
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
      conditions: conditions.filter((condition) => !unmeasured.has(condition)),
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
  const parts = pattern.split(KEY_PLACEHOLDER);
  const matcher = new RegExp(
    `^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`,
    "u",
  );
  // The parts in order, without a regular expression, which many keys and patterns make slow: the first at the start,
  // the last at the end, each other one after the one before. A key with a line break is left to the expression.
  const first = parts[0]!;
  const last = parts.at(-1)!;
  const middle = parts.slice(1, -1);
  const least = parts.reduce((length, part) => length + part.length, 0);
  return (key) => {
    if (/[\n\r\u2028\u2029]/u.test(key)) return matcher.test(key);
    if (key.length < least || !key.startsWith(first) || !key.endsWith(last)) return false;
    const end = key.length - last.length;
    let at = first.length;
    for (const part of middle) {
      const found = key.indexOf(part, at);
      if (found < 0 || found + part.length > end) return false;
      at = found + part.length;
    }
    return true;
  };
}

/** Whether a save's key (text or pattern) may be the key a load reads (text). */
function keysMayMatch(saved: string, read: string): boolean {
  return keyMatcher(saved)(read);
}

/** A value a condition's atom compares, as {@link conditionDistance} reads it; undefined when it cannot be read. */
export type AtomValue = string | number | boolean | null | undefined;

/** How far values are from making a condition come out a way: atoms not satisfied, and their summed distances. */
export interface ConditionDistance {
  readonly unsatisfied: number;
  readonly sum: number;
}

/**
 * Whether a condition's way needs all of its parts (`and` for true, `or` for false), each of which counts for the
 * branch distance ({@link conditionDistance}).
 */
export function conjunctive(condition: unknown, wanted: boolean): boolean {
  const value = record(condition);
  if (value.kind === "group") return conjunctive(value.expression, wanted);
  if (value.kind === "unary" && value.operator === "not")
    return conjunctive(value.operand, !wanted);
  return (
    value.kind === "binary" &&
    ((value.operator === "and" && wanted) || (value.operator === "or" && !wanted))
  );
}

/** `left - right` for two numbers, or two booleans as 0 and 1; undefined for other values or no finite difference. */
export function difference(left: unknown, right: unknown): number | undefined {
  if (typeof left !== typeof right || (typeof left !== "number" && typeof left !== "boolean"))
    return undefined;
  const gap = Number(left) - Number(right);
  return Number.isFinite(gap) ? gap : undefined;
}

/**
 * The branch distance of a condition from coming out `wanted`, with each atom's value read by `read`: an `and` that
 * needs all of its parts sums them, one that needs any takes the nearest (fewest atoms unsatisfied, then least
 * distance); an atom compared with a literal counts 0 when it holds, else its numeric {@link distance}, or 1 for
 * another value; one that compares two values counts as their {@link difference} compared with 0. An atom that cannot
 * be read counts as neither.
 */
export function conditionDistance(
  condition: unknown,
  wanted: boolean,
  read: (subject: unknown) => AtomValue,
): ConditionDistance {
  const value = record(condition);
  const none = { unsatisfied: 0, sum: 0 };
  if (value.kind === "group") return conditionDistance(value.expression, wanted, read);
  if (value.kind === "unary" && value.operator === "not")
    return conditionDistance(value.operand, !wanted, read);
  if (value.kind === "binary" && (value.operator === "and" || value.operator === "or")) {
    const parts = [
      conditionDistance(value.left, wanted, read),
      conditionDistance(value.right, wanted, read),
    ];
    if ((value.operator === "and") === wanted)
      return {
        unsatisfied: parts[0]!.unsatisfied + parts[1]!.unsatisfied,
        sum: parts[0]!.sum + parts[1]!.sum,
      };
    return parts[0]!.unsatisfied < parts[1]!.unsatisfied ||
      (parts[0]!.unsatisfied === parts[1]!.unsatisfied && parts[0]!.sum <= parts[1]!.sum)
      ? parts[0]!
      : parts[1]!;
  }
  // A text test (`name.contains("shirt")`) holds as the text method says.
  if (value.kind === "call" && TEXT_TESTS.has(calleeName(value) ?? "")) {
    const text = read(record(value.callee).object);
    const argument = list(value.arguments)
      .map((entry) => literalText(entry.value))
      .find((item) => item !== null);
    if (typeof text !== "string" || argument === undefined || argument === null) return none;
    return textTest(calleeName(value) ?? "", text, argument) === wanted
      ? none
      : { unsatisfied: 1, sum: 1 };
  }
  const [atom] = atomsFor(condition, wanted, true);
  if (atom === undefined) return none;
  const actual =
    atom.against === undefined
      ? read(atom.subject)
      : difference(read(atom.subject), read(atom.against));
  if (actual === undefined) return none;
  const holds = atom.wanted ? atom.operator : negate(atom.operator);
  // Whether it holds, as the runtime compares (`1` is not `true`), then how far it is when it does not: at least
  // something, and at most FAR_AWAY, also past what a number can tell.
  const satisfied = compares(actual, holds, atom.constant);
  if (satisfied === undefined || satisfied) return none;
  const numeric = typeof actual === "boolean" ? Number(actual) : actual;
  const constant = typeof atom.constant === "boolean" ? Number(atom.constant) : atom.constant;
  const away =
    typeof numeric === "number" && typeof constant === "number"
      ? distance(numeric, holds, constant)
      : 1;
  return { unsatisfied: 1, sum: Number.isNaN(away) || away <= 0 ? 1 : Math.min(away, FAR_AWAY) };
}

/** The distance an atom that does not hold counts at most, so that sums stay exact enough to compare. */
const FAR_AWAY = 1e12;

/** Whether `left operator right` holds for numbers, or texts, booleans, and null compared for equality or order. */
function compares(left: AtomValue, operator: string, right: AtomValue): boolean | undefined {
  if (left === undefined || right === undefined) return undefined;
  if (operator === "==") return left === right;
  if (operator === "!=") return left !== right;
  const both =
    (typeof left === "number" && typeof right === "number") ||
    (typeof left === "string" && typeof right === "string");
  if (!both) return undefined;
  switch (operator) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    default:
      return undefined;
  }
}

/** What a text method that tests a text (`contains`, `startsWith`, ...) gives for `text` and its argument. */
function textTest(method: string, text: string, argument: string): boolean {
  switch (method) {
    case "contains":
      return text.includes(argument);
    case "startsWith":
      return text.startsWith(argument);
    case "endsWith":
      return text.endsWith(argument);
    case "equalsIgnoreCase":
      return text.toLowerCase() === argument.toLowerCase();
    default:
      return text === argument;
  }
}

/**
 * A branch distance as one number that orders as the pair does: fewer atoms unsatisfied first, then a smaller sum, up
 * to {@link FAR_AWAY}, below the weight of one atom more, and exact to well under one for the atoms a condition has.
 */
export function branchDistance(found: ConditionDistance): number {
  return found.unsatisfied * 2 * FAR_AWAY + Math.min(found.sum, FAR_AWAY);
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
