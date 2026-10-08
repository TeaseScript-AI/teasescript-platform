import { isRecord } from "./ast.ts";

/**
 * Forward time for the explorer's search (`ExploreOptions.later`): the comparisons in conditions that read the clock,
 * what they come to in an explored state at a later wall clock, and the smallest forward gap after which one comes out
 * the other way. A comparison is read through the variables and temporaries it reads: one set from a value computed
 * from the clock (`hour = getDateTime().hour`, `took = getTimestamp().toSeconds() - start`) is computed again at that
 * wall clock, as the code would compute it then; everything else comes from the state, its variables and stored values,
 * such as a time a variable keeps to measure from (`start = getTimestamp().toSeconds()`). A helper function that reads
 * one part of the date or time counts as that part: exactly when it only returns it (`return getTime().hour`), and as an
 * approximation otherwise (`getLateHour()`, which adjusts it), which keeps the search's fallback for the comparison.
 * What cannot be read leaves the comparison unknown. The model only steers the search: a step it suggests is played in
 * the runtime like any other, so a wrong guess costs a step, not a false result.
 */

type Data = Readonly<Record<string, unknown>>;

function record(value: unknown): Data {
  return isRecord(value) ? value : {};
}

function list(value: unknown): Data[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

const CLOCK_GETTERS = new Set(["getDate", "getTime", "getDateTime", "getTimestamp"]);
const PARTS = new Set(["year", "month", "day", "hour", "minute", "second", "weekdayNumber"]);
const COMPARISONS = new Set(["==", "!=", "<", "<=", ">", ">=", "in"]);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The furthest a time step goes, and the margin a step goes past the moment a comparison changes. */
const HORIZON = 400 * DAY;
const MARGIN = MINUTE;

/** A comparison in a condition that reads the clock. */
export interface ClockComparison {
  readonly instruction: number;
  readonly operator: string;
  readonly left: Data;
  readonly right: Data;
  /** What the temporaries it reads were produced from before the condition. */
  readonly temporaries: ReadonlyMap<number, Data>;
  /** The parts of the date or time it reads (`hour`, `day`, ...), which come back; none when only the timestamp. */
  readonly parts: ReadonlySet<string>;
  /** Whether it reads no helper that only approximately returns a part of the date or time. */
  readonly exact: boolean;
}

/**
 * A value a variable is computed from, with what the temporaries it reads were produced from there; `prior` is what
 * the variable it reads itself was computed from just before (`took = took / 1000` right after `took = now - start`).
 */
interface Definition {
  readonly value: Data;
  readonly temporaries: ReadonlyMap<number, Data>;
  readonly prior: Definition | null;
}

/** Instructions that leave the next one to run right after them, with no way around it. */
const STRAIGHT = new Set([
  "storeTemporary",
  "clearTemporary",
  "clearTemporaries",
  "say",
  "declareBinding",
  "assign",
]);

/** A helper function that returns a part of the date or time, exactly or approximately. */
interface Helper {
  readonly part: string;
  readonly exact: boolean;
}

/**
 * The clock comparisons of a plan, by condition; the values computed from the clock that variables are set to, by
 * name; and the helper functions that read one part of the date or time, with that part.
 */
export interface ClockModel {
  readonly comparisons: ReadonlyMap<number, readonly ClockComparison[]>;
  readonly definitions: ReadonlyMap<string, Definition>;
  /**
   * Variables computed from the clock in more than one way, or updated from themselves, which cannot be computed again:
   * they read as unknown.
   */
  readonly ambiguous: ReadonlySet<string>;
  readonly helpers: ReadonlyMap<string, Helper>;
}

function calleeName(call: Data): string | null {
  const callee = record(call.callee);
  if (callee.kind === "identifier" && typeof callee.name === "string") return callee.name;
  if (callee.kind === "property" && typeof callee.name === "string") return callee.name;
  return null;
}

/** Whether a node is a call of a clock getter, or a method of one (`getTimestamp().toSeconds()`). */
function clockCall(node: Data): boolean {
  if (node.kind !== "call") return false;
  const callee = record(node.callee);
  if (callee.kind === "identifier") return CLOCK_GETTERS.has(calleeName(node) ?? "");
  const object = record(callee.object);
  return object.kind === "call" && CLOCK_GETTERS.has(calleeName(object) ?? "");
}

/**
 * The clock reads of an expression, also through variables and temporaries set from the clock: `timestamp` for a
 * getter of the current moment, each part of the date or time it reads (`hour` for `.hour` or a helper), and
 * `approximate` for a helper that only approximately returns its part.
 */
function clockReads(
  expression: unknown,
  model: ClockModel,
  temporaries: ReadonlyMap<number, Data>,
  found: Set<string> = new Set(),
  seen: Set<unknown> = new Set(),
): Set<string> {
  if (Array.isArray(expression)) {
    for (const item of expression) clockReads(item, model, temporaries, found, seen);
    return found;
  }
  if (!isRecord(expression) || seen.has(expression)) return found;
  seen.add(expression);
  if (expression.kind === "call") {
    const name = calleeName(expression) ?? "";
    const plain = record(expression.callee).kind === "identifier";
    const helper = plain ? model.helpers.get(name) : undefined;
    if (helper !== undefined) {
      found.add(helper.part);
      if (!helper.exact) found.add("approximate");
    }
    if (plain && CLOCK_GETTERS.has(name)) found.add("timestamp");
  }
  if (expression.kind === "property" && PARTS.has(String(expression.name)))
    if (clockCall(record(expression.object))) found.add(String(expression.name));
  if (expression.kind === "identifier" && typeof expression.name === "string") {
    if (model.ambiguous.has(expression.name)) found.add("timestamp");
    // Through each value it was computed from, the updates from itself and the computation they follow.
    for (
      let defined = model.definitions.get(expression.name) ?? null;
      defined !== null;
      defined = defined.prior
    )
      clockReads(defined.value, model, defined.temporaries, found, seen);
  }
  if (expression.kind === "temporary" && typeof expression.temporaryId === "number") {
    const stored = temporaries.get(expression.temporaryId);
    if (stored !== undefined) clockReads(stored, model, temporaries, found, seen);
  }
  for (const [key, item] of Object.entries(expression))
    if (key !== "span") clockReads(item, model, temporaries, found, seen);
  return found;
}

/** An expression without its source spans, to tell expressions apart. */
function shape(expression: Data): string {
  return JSON.stringify(expression, (key, value: unknown) => (key === "span" ? undefined : value));
}

/** The temporaries an expression reads. */
function temporariesOf(expression: unknown, found: number[] = []): number[] {
  if (Array.isArray(expression)) for (const item of expression) temporariesOf(item, found);
  else if (isRecord(expression)) {
    if (expression.kind === "temporary" && typeof expression.temporaryId === "number")
      found.push(expression.temporaryId);
    for (const [key, item] of Object.entries(expression))
      if (key !== "span") temporariesOf(item, found);
  }
  return found;
}

/** The variables an expression reads. */
function namesOf(expression: unknown, names: Set<string> = new Set()): Set<string> {
  if (Array.isArray(expression)) for (const item of expression) namesOf(item, names);
  else if (isRecord(expression)) {
    if (expression.kind === "identifier" && typeof expression.name === "string")
      names.add(expression.name);
    for (const [key, item] of Object.entries(expression)) if (key !== "span") namesOf(item, names);
  }
  return names;
}

/**
 * The clock comparisons of a plan: in each condition and `while` loop, every comparison (also `in` a range) one of
 * whose sides reads the clock, also through variables and temporaries set from it.
 */
export function clockModel(plan: Data, instructions: readonly Data[]): ClockModel {
  const functions = list(plan.functions);
  // The instructions that produce each temporary, in order: a stored value, or a call's result.
  const producers = new Map<number, number[]>();
  instructions.forEach((instruction, index) => {
    const id =
      instruction.kind === "storeTemporary"
        ? instruction.temporaryId
        : instruction.kind === "callFunction"
          ? instruction.destinationTemporary
          : null;
    if (typeof id !== "number") return;
    const indices = producers.get(id);
    if (indices === undefined) producers.set(id, [index]);
    else indices.push(index);
  });
  /** What a temporary was last produced from before `at`. */
  const producedFrom = (id: number, at: number): Data | null => {
    const indices = producers.get(id) ?? [];
    let low = 0;
    let high = indices.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (indices[middle]! < at) low = middle + 1;
      else high = middle;
    }
    const index = indices[low - 1];
    if (index === undefined) return null;
    const producer = instructions[index]!;
    if (producer.kind === "storeTemporary") return record(producer.value);
    const name = record(functions[Number(producer.functionId) - 1]).name;
    return { kind: "call", callee: { kind: "identifier", name: String(name) }, arguments: [] };
  };
  /** The temporaries an expression at `at` reads, with what produced them, also those those read. */
  const temporariesAt = (expression: unknown, at: number): Map<number, Data> => {
    const found = new Map<number, Data>();
    const wanted = temporariesOf(expression);
    for (let id = wanted.pop(); id !== undefined; id = wanted.pop()) {
      if (found.has(id)) continue;
      const value = producedFrom(id, at);
      if (value === null) continue;
      found.set(id, value);
      for (const read of temporariesOf(value)) wanted.push(read);
    }
    return found;
  };
  // Helpers that read exactly one part of the date or time; exact when their only return is that part itself.
  const helpers = new Map<string, Helper>();
  for (const definition of functions) {
    if (typeof definition.name !== "string") continue;
    const parts = new Set<string>();
    const returns: Data[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (isRecord(value)) {
        if (value.kind === "property" && PARTS.has(String(value.name)))
          if (clockCall(record(value.object))) parts.add(String(value.name));
        for (const [key, item] of Object.entries(value)) if (key !== "span") walk(item);
      }
    };
    const end = Number(definition.endInstruction);
    for (let index = Number(definition.entryInstruction); index <= end; index += 1) {
      walk(instructions[index]);
      if (instructions[index]?.kind === "returnValue")
        returns.push(record(instructions[index]!.value));
    }
    if (parts.size !== 1) continue;
    const part = [...parts][0]!;
    const only = returns.length === 1 ? returns[0]! : null;
    const exact =
      only !== null &&
      only.kind === "property" &&
      only.name === part &&
      clockCall(record(only.object));
    helpers.set(definition.name, { part, exact });
  }
  const comparisons = new Map<number, ClockComparison[]>();
  const definitions = new Map<string, Definition>();
  const ambiguous = new Set<string>();
  const model: ClockModel = { comparisons, definitions, ambiguous, helpers };
  // What each variable is computed from, when every value it is set to but literals is computed from the clock (also
  // through variables computed so), and is not a bare clock read, which is a time kept to measure from. Updates of the
  // variable from itself (`took = took / 1000`) that follow its one computation straight on compose with it. When the
  // computations differ, or an update may or may not run, the variable cannot be computed again: it is ambiguous.
  // Rounds until no variable is added.
  const assigned = new Map<string, (Definition & { readonly at: number })[]>();
  /** Where each variable is set to a literal, which an update from itself does not compose across. */
  const literalAt = new Map<string, number[]>();
  instructions.forEach((instruction, index) => {
    const target = record(instruction.target);
    const name =
      instruction.kind === "assign" && target.kind === "identifier"
        ? target.name
        : instruction.kind === "declareBinding" || instruction.kind === "declareGlobal"
          ? instruction.name
          : null;
    const value = record(instruction.value);
    if (typeof name === "string" && value.kind === "literal")
      literalAt.set(name, [...(literalAt.get(name) ?? []), index]);
    if (typeof name !== "string" || value.kind === "literal") return;
    const definition = { value, temporaries: temporariesAt(value, index), prior: null, at: index };
    assigned.set(name, [...(assigned.get(name) ?? []), definition]);
  });
  for (let added = true; added;) {
    added = false;
    for (const [name, values] of assigned) {
      if (definitions.has(name) || ambiguous.has(name)) continue;
      if (
        !values.every(
          ({ value, temporaries }) =>
            namesOf(value).has(name) ||
            (!clockCall(value) && clockReads(value, model, temporaries).size > 0),
        )
      )
        continue;
      const composed = compose(name, values);
      if (composed === null) ambiguous.add(name);
      else definitions.set(name, composed);
      added = true;
    }
  }
  /**
   * One definition of a variable from its assignments: its one computation, with the updates from itself that follow
   * it straight on composed in; null when the computations differ or an update could be skipped.
   */
  function compose(
    name: string,
    values: readonly (Definition & { readonly at: number })[],
  ): Definition | null {
    const computed = values.filter(({ value }) => !namesOf(value).has(name));
    if (new Set(computed.map(({ value }) => shape(value))).size !== 1) return null;
    // Updates compose with one computation only, which they follow.
    if (computed.length > 1 && computed.length < values.length) return null;
    let definition: Definition = computed[0]!;
    let last = -1;
    for (const { value, temporaries, at } of values) {
      if (!namesOf(value).has(name)) {
        last = at;
        continue;
      }
      for (let between = last + 1; between < at; between += 1)
        if (last < 0 || !STRAIGHT.has(String(instructions[between]?.kind))) return null;
      if ((literalAt.get(name) ?? []).some((index) => index > last && index < at)) return null;
      definition = { value, temporaries, prior: definition };
      last = at;
    }
    return definition;
  }
  instructions.forEach((instruction, index) => {
    const conditional =
      instruction.kind === "jumpIfFalse" ||
      (instruction.kind === "loopStart" && instruction.loopKind === "while");
    if (!conditional) return;
    const condition = instruction.condition ?? instruction.expression;
    const temporaries = temporariesAt(condition, index);
    const found: ClockComparison[] = [];
    const walk = (value: unknown): void => {
      const node = record(value);
      if (node.kind === "group") walk(node.expression);
      if (node.kind === "unary") walk(node.operand);
      if (node.kind === "temporary" && typeof node.temporaryId === "number")
        walk(temporaries.get(node.temporaryId));
      if (node.kind !== "binary") return;
      if (node.operator === "and" || node.operator === "or") {
        walk(node.left);
        walk(node.right);
        return;
      }
      if (!COMPARISONS.has(String(node.operator))) return;
      const left = record(node.left);
      const right = record(node.right);
      const parts = clockReads([left, right], model, temporaries);
      if (parts.size === 0) return;
      const exact = !parts.has("approximate");
      parts.delete("timestamp");
      parts.delete("approximate");
      found.push({
        instruction: index,
        operator: String(node.operator),
        left,
        right,
        temporaries,
        parts,
        exact,
      });
    };
    walk(condition);
    if (found.length > 0) comparisons.set(index, found);
  });
  return model;
}

/** A value as the time evaluator reads it; `undefined` for one it cannot read. */
type Value =
  | number
  | string
  | boolean
  | null
  | { readonly kind: "timestamp" | "duration" | "datetime"; readonly milliseconds: number }
  | { readonly kind: "data"; readonly data: Data }
  | undefined;

/** A state to evaluate in: its variables by innermost binding, and its stored values by key. */
export interface TimeContext {
  readonly bindings: ReadonlyMap<string, unknown>;
  readonly storage: ReadonlyMap<string, unknown>;
}

/** A stored or bound runtime value as the evaluator reads it. */
function runtimeValue(value: unknown): Value {
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === null
  )
    return value;
  const data = record(value);
  if (data.kind === "duration" && typeof data.milliseconds === "number")
    return data.months === undefined && data.days === undefined
      ? { kind: "duration", milliseconds: data.milliseconds }
      : undefined;
  if (data.kind === "timestamp" && typeof data.epochMilliseconds === "number")
    return { kind: "timestamp", milliseconds: data.epochMilliseconds };
  return isRecord(value) ? { kind: "data", data: value } : undefined;
}

/** A part of the date or time at a wall clock, in the player's zone, which the explorer leaves at UTC. */
function part(name: string, milliseconds: number): number | undefined {
  const date = new Date(milliseconds);
  switch (name) {
    case "year":
      return date.getUTCFullYear();
    case "month":
      return date.getUTCMonth() + 1;
    case "day":
      return date.getUTCDate();
    case "hour":
      return date.getUTCHours();
    case "minute":
      return date.getUTCMinutes();
    case "second":
      return date.getUTCSeconds();
    case "weekdayNumber":
      return ((date.getUTCDay() + 6) % 7) + 1;
    default:
      return undefined;
  }
}

const NUMERIC = new Map<string, (value: number) => number>([
  ["round", Math.round],
  ["floor", Math.floor],
  ["ceil", Math.ceil],
  ["abs", Math.abs],
  ["toInteger", Math.trunc],
]);

/** How a comparison reads its variables and temporaries at one wall clock. */
interface Reading {
  /** What the temporaries read here were produced from. */
  readonly temporaries: ReadonlyMap<number, Data>;
  readonly model: ClockModel;
  readonly context: TimeContext;
  readonly now: number;
  /**
   * The variables being computed again, with what they read of themselves inside their own computation: what they were
   * computed from just before, or the state (null).
   */
  readonly inside: ReadonlyMap<string, Definition | null>;
  /** The values of definitions computed in this reading, each computed once. */
  readonly memo: Map<Definition, Value>;
}

/** An expression's value in a reading, or undefined when it cannot be read. */
function valueAt(expression: unknown, reading: Reading): Value {
  const node = record(expression);
  const { model, context } = reading;
  switch (node.kind) {
    case "literal":
      return runtimeValue(node.value);
    case "duration":
      return typeof node.milliseconds === "number"
        ? { kind: "duration", milliseconds: node.milliseconds }
        : undefined;
    case "group":
      return valueAt(node.expression, reading);
    case "identifier": {
      if (typeof node.name !== "string") return undefined;
      const within = reading.inside.has(node.name);
      if (model.ambiguous.has(node.name) && !within) return undefined;
      const defined = within ? reading.inside.get(node.name) : model.definitions.get(node.name);
      if (defined == null) return runtimeValue(context.bindings.get(node.name));
      if (reading.memo.has(defined)) return reading.memo.get(defined);
      const value = valueAt(defined.value, {
        ...reading,
        temporaries: defined.temporaries,
        inside: new Map([...reading.inside, [node.name, defined.prior]]),
      });
      reading.memo.set(defined, value);
      return value;
    }
    case "temporary": {
      const stored =
        typeof node.temporaryId === "number"
          ? reading.temporaries.get(node.temporaryId)
          : undefined;
      return stored === undefined ? undefined : valueAt(stored, reading);
    }
    case "storageLoad": {
      const key = record(node.key);
      if (key.kind !== "literal" || typeof key.value !== "string") return undefined;
      if (context.storage.has(key.value)) return runtimeValue(context.storage.get(key.value));
      return node.default == null ? null : valueAt(node.default, reading);
    }
    case "unary": {
      const operand = valueAt(node.operand, reading);
      if (node.operator === "-" && typeof operand === "number") return -operand;
      if (node.operator === "not" && typeof operand === "boolean") return !operand;
      return undefined;
    }
    case "call":
      return callAt(node, reading);
    case "property": {
      const object = valueAt(node.object, reading);
      if (typeof object !== "object" || object === null) return undefined;
      if (object.kind === "datetime") return part(String(node.name), object.milliseconds);
      if (object.kind !== "data") return undefined;
      const properties = object.data.kind === "object" ? list(object.data.properties) : [];
      return runtimeValue(properties.find((property) => property.name === node.name)?.value);
    }
    case "binary":
      return binaryAt(node, reading);
    default:
      return undefined;
  }
}

function callAt(node: Data, reading: Reading): Value {
  const name = calleeName(node) ?? "";
  const callee = record(node.callee);
  if (callee.kind === "identifier" && CLOCK_GETTERS.has(name))
    return { kind: name === "getTimestamp" ? "timestamp" : "datetime", milliseconds: reading.now };
  const helper = callee.kind === "identifier" ? reading.model.helpers.get(name) : undefined;
  if (helper !== undefined) return part(helper.part, reading.now);
  if (callee.kind === "property") {
    const object = valueAt(callee.object, reading);
    if (typeof object === "object" && object !== null && object.kind === "timestamp") {
      if (name === "toSeconds") return Math.floor(object.milliseconds / 1000);
      if (name === "toMilliseconds") return object.milliseconds;
    }
    return undefined;
  }
  const transform = NUMERIC.get(name);
  const argument = valueAt(list(node.arguments)[0]?.value, reading);
  return transform !== undefined && typeof argument === "number" ? transform(argument) : undefined;
}

function binaryAt(node: Data, reading: Reading): Value {
  const operator = String(node.operator);
  if (operator === "in") {
    const value = valueAt(node.left, reading);
    const range = record(node.right);
    const start = valueAt(range.start, reading);
    const end = valueAt(range.end, reading);
    if (range.kind !== "range" || typeof value !== "number") return undefined;
    if (typeof start !== "number" || typeof end !== "number") return undefined;
    return value >= start && (range.inclusive === true ? value <= end : value < end);
  }
  const left = valueAt(node.left, reading);
  const right = valueAt(node.right, reading);
  if (operator === "and" || operator === "or") {
    if (typeof left !== "boolean" || typeof right !== "boolean") return undefined;
    return operator === "and" ? left && right : left || right;
  }
  const kindOf = (value: Value) =>
    typeof value === "object" && value !== null ? value.kind : typeof value;
  const amount = (value: Value) =>
    typeof value === "number"
      ? value
      : typeof value === "object" && value !== null && value.kind !== "data"
        ? value.milliseconds
        : undefined;
  const [a, b] = [amount(left), amount(right)];
  if (a === undefined || b === undefined) {
    const scalar = (value: Value) =>
      typeof value === "string" || typeof value === "boolean" || value === null;
    if (operator === "==" && scalar(left) && scalar(right)) return left === right;
    if (operator === "!=" && scalar(left) && scalar(right)) return left !== right;
    return undefined;
  }
  const [leftKind, rightKind] = [kindOf(left), kindOf(right)];
  const numbers = leftKind === "number" && rightKind === "number";
  // A moment moves by a duration rounded to whole milliseconds, half away from zero, as the runtime moves it.
  const whole = (milliseconds: number) =>
    Math.sign(milliseconds) * Math.round(Math.abs(milliseconds));
  const moment = (from: number, by: number): Value => ({
    kind: "timestamp",
    milliseconds: from + whole(by),
  });
  const duration = (milliseconds: number): Value => ({ kind: "duration", milliseconds });
  switch (operator) {
    case "+":
      if (leftKind === "timestamp" && rightKind === "duration") return moment(a, b);
      if (leftKind === "duration" && rightKind === "duration") return duration(a + b);
      return numbers ? a + b : undefined;
    case "-":
      if (leftKind === "timestamp" && rightKind === "timestamp") return duration(a - b);
      if (leftKind === "timestamp" && rightKind === "duration") return moment(a, -b);
      if (leftKind === "duration" && rightKind === "duration") return duration(a - b);
      return numbers ? a - b : undefined;
    case "*":
      if (leftKind === "duration" && rightKind === "number") return duration(a * b);
      if (leftKind === "number" && rightKind === "duration") return duration(a * b);
      return numbers ? a * b : undefined;
    case "/":
      if (b === 0) return undefined;
      if (leftKind === "duration" && rightKind === "duration") return a / b;
      if (leftKind === "duration" && rightKind === "number") return duration(a / b);
      return numbers ? a / b : undefined;
    case "%":
      return numbers && b !== 0 ? a % b : undefined;
  }
  // Comparisons need operands of one kind: numbers, durations, or moments.
  if (leftKind !== rightKind) return undefined;
  switch (operator) {
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    default:
      return undefined;
  }
}

/** Whether a clock comparison holds in a state at the wall clock `now`; undefined when it cannot be read. */
export function holdsAt(
  comparison: ClockComparison,
  model: ClockModel,
  context: TimeContext,
  now: number,
): boolean | undefined {
  const value = binaryAt(
    {
      kind: "binary",
      operator: comparison.operator,
      left: comparison.left,
      right: comparison.right,
    },
    {
      temporaries: comparison.temporaries,
      model,
      context,
      now,
      inside: new Map(),
      memo: new Map(),
    },
  );
  return typeof value === "boolean" ? value : undefined;
}

/**
 * The moments after `now` at which a comparison of these parts of the date or time can come out another way: each
 * second of the next minute for `second`, each minute of the next day for `minute`, each hour of the next eight days
 * for `hour` and `weekdayNumber`, each day of the horizon for `day`, `month`, and `year`; just after each, by
 * {@link MARGIN} (by a second for seconds), and none past the horizon.
 */
function boundaries(parts: ReadonlySet<string>, now: number): number[] {
  const found: number[] = [];
  const every = (unit: number, count: number, margin: number) => {
    const next = Math.ceil((now + 1) / unit) * unit;
    for (let index = 0; index < count; index += 1) found.push(next + index * unit + margin);
  };
  if (parts.has("second")) every(1000, 61, 0);
  if (parts.has("minute")) every(MINUTE, 25 * 60, 1000);
  if (parts.has("hour") || parts.has("weekdayNumber")) every(HOUR, 8 * 24, MARGIN);
  if (parts.has("day") || parts.has("month") || parts.has("year"))
    every(DAY, HORIZON / DAY, MARGIN);
  const within = found.map((at) => Math.min(at, now + HORIZON));
  return [...new Set(within)].sort((left, right) => left - right);
}

/**
 * The smallest forward gap, within {@link HORIZON}, after which a clock comparison comes out the other way in a state
 * whose wall clock is `now`; null when it cannot be read or does not change. A comparison of parts of the date or time
 * is tried at the moments one of them changes ({@link boundaries}). One of the timestamp alone is tried after a minute
 * and each doubling of that up to the horizon, and the first change found is narrowed by halving to the minute; the gap
 * goes {@link MARGIN} past it when that keeps the outcome.
 */
export function flipGap(
  comparison: ClockComparison,
  model: ClockModel,
  context: TimeContext,
  now: number,
): number | null {
  const holds = holdsAt(comparison, model, context, now);
  if (holds === undefined) return null;
  const flipped = (at: number) => holdsAt(comparison, model, context, at) === !holds;
  if (comparison.parts.size > 0) {
    const at = boundaries(comparison.parts, now).find(flipped);
    return at === undefined ? null : at - now;
  }
  // Where the compared sides meet, from how far apart they are now and an hour later (they move with time at one
  // rate): an equality, or a range's bounds, change only there.
  const reading = {
    temporaries: comparison.temporaries,
    model,
    context,
    inside: new Map<string, Definition | null>(),
  };
  const apart = (at: number, right: unknown) => {
    const then = { ...reading, now: at, memo: new Map<Definition, Value>() };
    const left = magnitude(valueAt(comparison.left, then));
    const bound = magnitude(valueAt(right, then));
    return left === undefined || bound === undefined ? undefined : left - bound;
  };
  const range = record(comparison.right);
  const bounds = comparison.operator === "in" ? [range.start, range.end] : [comparison.right];
  const meetings: number[] = [];
  for (const bound of bounds) {
    const before = apart(now, bound);
    const after = apart(now + HOUR, bound);
    if (before === undefined || after === undefined || before === after) continue;
    const at = now - (before / (after - before)) * HOUR;
    for (const near of [at, at + 1000, at + MINUTE])
      if (near > now && near <= now + HORIZON) meetings.push(Math.ceil(near));
  }
  const met = meetings.sort((left, right) => left - right).find(flipped);
  if (met !== undefined) return met - now;
  // Otherwise the first doubling of a minute (up to the horizon) at which the outcome is the other one, narrowed.
  let low = 0;
  let first: number | undefined;
  for (let gap = MINUTE; first === undefined; gap = Math.min(gap * 2, HORIZON)) {
    if (flipped(now + gap)) first = gap;
    else if (gap === HORIZON) return null;
    else low = gap;
  }
  let high = first;
  while (high - low > MINUTE) {
    const middle: number = Math.floor((low + high) / 2 / MINUTE) * MINUTE;
    if (middle <= low) break;
    if (flipped(now + middle)) high = middle;
    else low = middle;
  }
  return high + MARGIN <= HORIZON && flipped(now + high + MARGIN) ? high + MARGIN : high;
}

/** A value's size as a number: a number itself, or the milliseconds of a duration or moment. */
function magnitude(value: Value): number | undefined {
  if (typeof value === "number") return value;
  return typeof value === "object" && value !== null && value.kind !== "data"
    ? value.milliseconds
    : undefined;
}

/**
 * Whether a condition holds on stored values alone (a load's default for an unset key), and the variables given in
 * `bindings`; undefined when it reads anything else, such as another variable, a call, or the clock.
 */
/** Whether a condition reads no clock, by condition, found once for each. */
const clockFreeConditions = new WeakMap<Data, boolean>();

export function storedHolds(
  condition: unknown,
  storage: ReadonlyMap<string, unknown>,
  bindings: ReadonlyMap<string, unknown> = new Map(),
): boolean | undefined {
  const model: ClockModel = {
    comparisons: new Map(),
    definitions: new Map(),
    ambiguous: new Set(),
    helpers: new Map(),
  };
  const none = new Map<number, Data>();
  if (!isRecord(condition)) return undefined;
  let clockFree = clockFreeConditions.get(condition);
  if (clockFree === undefined) {
    clockFree = clockReads(condition, model, none).size === 0;
    clockFreeConditions.set(condition, clockFree);
  }
  if (!clockFree) return undefined;
  const value = valueAt(condition, {
    temporaries: none,
    model,
    context: { bindings, storage },
    now: 0,
    inside: new Map(),
    memo: new Map(),
  });
  return typeof value === "boolean" ? value : undefined;
}

/** The context of a state's snapshot: its variables, innermost binding first, and its stored values. */
export function timeContext(snapshot: Data): TimeContext {
  const bindings = new Map<string, unknown>();
  for (const binding of list(snapshot.globals))
    if (typeof binding.name === "string") bindings.set(binding.name, binding.value);
  for (const frame of list(snapshot.frames))
    for (const binding of list(frame.bindings))
      if (typeof binding.name === "string") bindings.set(binding.name, binding.value);
  const storage = new Map<string, unknown>();
  for (const entry of list(snapshot.scriptStorage))
    if (typeof entry.key === "string") storage.set(entry.key, entry.value);
  return { bindings, storage };
}
