import { isRecord } from "./ast.ts";

/**
 * Forward time for the explorer's search (`ExploreOptions.later`): the comparisons in conditions that read the clock,
 * what they come to in an explored state at a later wall clock, and the smallest forward gap after which one comes out
 * the other way. A comparison is read through the variables and temporaries it reads: one set from a value computed
 * from the clock (`hour = getDateTime().hour`, `took = getTimestamp().toSeconds() - start`) is computed again at that
 * wall clock, as the code would compute it then; everything else comes from the state, its variables and stored values,
 * such as a time a variable keeps to measure from (`start = getTimestamp().toSeconds()`). A helper function that reads
 * one part of the date or time counts as that part (`getLateHour()` as the hour). What cannot be read leaves the
 * comparison unknown.
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
  /** What the temporaries it reads were stored from, just before the condition. */
  readonly temporaries: ReadonlyMap<number, Data>;
  /** The parts of the date or time it reads (`hour`, `day`, ...), which come back; none when only the timestamp. */
  readonly parts: ReadonlySet<string>;
}

/**
 * The clock comparisons of a plan, by condition; the values computed from the clock that variables are set to, by
 * name; and the helper functions that read one part of the date or time, with that part.
 */
export interface ClockModel {
  readonly comparisons: ReadonlyMap<number, readonly ClockComparison[]>;
  readonly definitions: ReadonlyMap<string, Data>;
  /** Variables computed from the clock in more than one way, which cannot be computed again: they read as unknown. */
  readonly ambiguous: ReadonlySet<string>;
  readonly helpers: ReadonlyMap<string, string>;
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
 * getter of the current moment, and each part of the date or time it reads (`hour` for `.hour` or a helper).
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
    if (plain && model.helpers.has(name)) found.add(model.helpers.get(name)!);
    if (plain && CLOCK_GETTERS.has(name)) found.add("timestamp");
  }
  if (expression.kind === "property" && PARTS.has(String(expression.name)))
    if (clockCall(record(expression.object))) found.add(String(expression.name));
  if (expression.kind === "identifier" && typeof expression.name === "string") {
    if (model.ambiguous.has(expression.name)) found.add("timestamp");
    const defined = model.definitions.get(expression.name);
    if (defined !== undefined) clockReads(defined, model, temporaries, found, seen);
  }
  if (expression.kind === "temporary" && typeof expression.temporaryId === "number") {
    const stored = temporaries.get(expression.temporaryId);
    if (stored !== undefined) clockReads(stored, model, temporaries, found, seen);
  }
  for (const [key, item] of Object.entries(expression))
    if (key !== "span") clockReads(item, model, temporaries, found, seen);
  return found;
}

function reads(expression: unknown, model: ClockModel, temporaries: ReadonlyMap<number, Data>) {
  return clockReads(expression, model, temporaries).size > 0;
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
  // Helpers that read exactly one part of the date or time.
  const helpers = new Map<string, string>();
  for (const definition of list(plan.functions)) {
    if (typeof definition.name !== "string") continue;
    const parts = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (isRecord(value)) {
        if (value.kind === "property" && PARTS.has(String(value.name)))
          if (clockCall(record(value.object))) parts.add(String(value.name));
        for (const [key, item] of Object.entries(value)) if (key !== "span") walk(item);
      }
    };
    const end = Number(definition.endInstruction);
    for (let index = Number(definition.entryInstruction); index <= end; index += 1)
      walk(instructions[index]);
    if (parts.size === 1) helpers.set(definition.name, [...parts][0]!);
  }
  const comparisons = new Map<number, ClockComparison[]>();
  const definitions = new Map<string, Data>();
  const ambiguous = new Set<string>();
  const model: ClockModel = { comparisons, definitions, ambiguous, helpers };
  // What each variable is computed from, when every value it is set to but literals is computed from the clock (also
  // through variables computed so), and is not a bare clock read, which is a time kept to measure from. When those
  // values differ, the variable cannot be computed again: it is ambiguous. Rounds until no variable is added.
  const none = new Map<number, Data>();
  const assigned = new Map<string, Data[]>();
  for (const instruction of instructions) {
    const target = record(instruction.target);
    const name =
      instruction.kind === "assign" && target.kind === "identifier"
        ? target.name
        : instruction.kind === "declareBinding" || instruction.kind === "declareGlobal"
          ? instruction.name
          : null;
    const value = record(instruction.value);
    if (typeof name !== "string" || value.kind === "literal") continue;
    assigned.set(name, [...(assigned.get(name) ?? []), value]);
  }
  for (let added = true; added;) {
    added = false;
    for (const [name, values] of assigned) {
      if (definitions.has(name) || ambiguous.has(name)) continue;
      // A value that updates the variable from itself (`took += 60`) keeps what it is computed from.
      const updates = (value: Data) => namesOf(value).has(name);
      const computed = values.filter((value) => !updates(value));
      if (
        computed.length > 0 &&
        values.every((value) => updates(value) || (!clockCall(value) && reads(value, model, none)))
      ) {
        const distinct = new Set(computed.map(shape));
        if (distinct.size === 1) definitions.set(name, computed[0]!);
        else ambiguous.add(name);
        added = true;
      }
    }
  }
  instructions.forEach((instruction, index) => {
    const conditional =
      instruction.kind === "jumpIfFalse" ||
      (instruction.kind === "loopStart" && instruction.loopKind === "while");
    if (!conditional) return;
    // The temporaries the condition reads, as the latest instructions before it produced them: a stored value, or the
    // result of a call.
    const temporaries = new Map<number, Data>();
    const wanted = new Set(temporariesOf(instruction.condition ?? instruction.expression));
    for (let before = index - 1; before >= 0 && wanted.size > 0; before -= 1) {
      const producer = instructions[before]!;
      const id =
        producer.kind === "storeTemporary"
          ? producer.temporaryId
          : producer.kind === "callFunction"
            ? producer.destinationTemporary
            : null;
      if (typeof id !== "number" || !wanted.has(id)) continue;
      wanted.delete(id);
      const value =
        producer.kind === "storeTemporary"
          ? record(producer.value)
          : {
              kind: "call",
              callee: {
                kind: "identifier",
                name: String(record(list(plan.functions)[Number(producer.functionId) - 1]).name),
              },
              arguments: [],
            };
      temporaries.set(id, value);
      for (const more of temporariesOf(value)) if (!temporaries.has(more)) wanted.add(more);
    }
    const found: ClockComparison[] = [];
    const walk = (value: unknown): void => {
      const node = record(value);
      if (node.kind === "group") walk(node.expression);
      if (node.kind === "unary") walk(node.operand);
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
      parts.delete("timestamp");
      found.push({
        instruction: index,
        operator: String(node.operator),
        left,
        right,
        temporaries,
        parts,
      });
    };
    walk(instruction.condition ?? instruction.expression);
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
  readonly comparison: ClockComparison;
  readonly model: ClockModel;
  readonly context: TimeContext;
  readonly now: number;
  /** The variables being computed again, which are read from the state inside their own computation. */
  readonly inside: ReadonlySet<string>;
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
      if (model.ambiguous.has(node.name) && !reading.inside.has(node.name)) return undefined;
      const defined = reading.inside.has(node.name) ? undefined : model.definitions.get(node.name);
      return defined === undefined
        ? runtimeValue(context.bindings.get(node.name))
        : valueAt(defined, { ...reading, inside: new Set([...reading.inside, node.name]) });
    }
    case "temporary": {
      const stored =
        typeof node.temporaryId === "number"
          ? reading.comparison.temporaries.get(node.temporaryId)
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
  if (callee.kind === "identifier" && reading.model.helpers.has(name))
    return part(reading.model.helpers.get(name)!, reading.now);
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
  // A moment moved by a duration lands on a whole millisecond, as the runtime rounds it.
  const moment = (milliseconds: number): Value => ({
    kind: "timestamp",
    milliseconds: Math.sign(milliseconds) * Math.round(Math.abs(milliseconds)),
  });
  const duration = (milliseconds: number): Value => ({ kind: "duration", milliseconds });
  switch (operator) {
    case "+":
      if (leftKind === "timestamp" && rightKind === "duration") return moment(a + b);
      if (leftKind === "duration" && rightKind === "timestamp") return moment(a + b);
      if (leftKind === "duration" && rightKind === "duration") return duration(a + b);
      return numbers ? a + b : undefined;
    case "-":
      if (leftKind === "timestamp" && rightKind === "timestamp") return duration(a - b);
      if (leftKind === "timestamp" && rightKind === "duration") return moment(a - b);
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
    { comparison, model, context, now, inside: new Set() },
  );
  return typeof value === "boolean" ? value : undefined;
}

/**
 * The moments after `now` at which a comparison of these parts of the date or time can come out another way: each
 * second of the next minute for `second`, each minute of the next day for `minute`, each hour of the next eight days
 * for `hour` and `weekdayNumber`, each day of the horizon for `day`, `month`, and `year`; just after each, by
 * {@link MARGIN} (by a second for seconds).
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
  return [...new Set(found)].sort((left, right) => left - right);
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
  // The first doubling of a minute (up to the horizon) at which the outcome is the other one.
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
  return flipped(now + high + MARGIN) ? high + MARGIN : high;
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
