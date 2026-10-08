import { isRecord } from "./ast.ts";
import { successors } from "./explorer-analysis.ts";

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
/**
 * The helper every converted script has to compare two values as legacy SexScript did: -1, 0, or 1, with null before
 * everything else. Its calls are read with their arguments; other functions of a script are not.
 */
const COMPARE_HELPER = "sexscriptLegacyCompare";
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
  /**
   * The script's functions that only compute a value ({@link pureFunctions}), which the model runs; with the plan's
   * functions and instructions to run them from.
   */
  readonly pure: ReadonlySet<number>;
  /** Those of them that read the clock, also through such functions they call. */
  readonly clockFunctions: ReadonlySet<number>;
  readonly functions: readonly Data[];
  readonly instructions: readonly Data[];
  /**
   * Variables set once, and never otherwise: to a literal (`let scriptText = "dc"`), or to another value that is not
   * computed from the clock (`let last = sexscriptLegacyLoadInteger("${scriptText}.last")`); read from these where a
   * state has no value for them yet, such as at the start of a session.
   */
  readonly once: ReadonlyMap<string, Definition>;
}

/** A definition no variable has, to look up a missing one. */
const NO_DEFINITION: Definition = { value: {}, temporaries: new Map(), prior: null };

/** The most instructions, and calls within calls, the model runs of a script's function for one value. */
const FUNCTION_STEPS = 500;
const FUNCTION_DEPTH = 4;
/** Instructions a function that only computes a value may have. */
const PURE_INSTRUCTIONS = new Set([
  "bindSuppliedParameter",
  "beginFunctionDefaults",
  "prepareParameterDefault",
  "bindDefaultParameter",
  "enterFunctionBody",
  "enterScope",
  "leaveScope",
  "clearTemporary",
  "clearTemporaries",
  "declareBinding",
  "assign",
  "storeTemporary",
  "jumpIfFalse",
  "jump",
  "callFunction",
  "returnValue",
  "returnVoid",
]);
/** Methods of a value, and functions, an expression of such a function may call. */
const PURE_CALLS = new Set(["toSeconds", "toMilliseconds", ...CLOCK_GETTERS]);

/**
 * The functions of a plan that only compute a value: their instructions bind, assign their own parameters and variables,
 * branch, call such functions, and return; their expressions call no function but numeric ones and the clock. Storage
 * loads are reads. With those of them that read the clock, also through such functions they call.
 */
function pureFunctions(
  functions: readonly Data[],
  instructions: readonly Data[],
): { pure: Set<number>; clock: Set<number> } {
  const calls = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every(calls);
    if (!isRecord(value)) return true;
    if (value.kind === "call") {
      const name = calleeName(value) ?? "";
      if (!NUMERIC.has(name) && !PURE_CALLS.has(name)) return false;
    }
    return Object.entries(value).every(([key, item]) => key === "span" || calls(item));
  };
  const candidates = new Map<number, number[]>();
  const clock = new Set<number>();
  for (const definition of functions) {
    const id = Number(definition.id);
    // A function's instructions run from its entry up to, not including, its end.
    const end = Math.min(Number(definition.endInstruction), instructions.length);
    const entry = Number(definition.entryInstruction);
    const own = new Set(
      list(definition.parameters).flatMap((parameter) =>
        typeof parameter.name === "string" ? [parameter.name] : [],
      ),
    );
    for (let index = entry; index < end; index += 1)
      if (
        instructions[index]?.kind === "declareBinding" &&
        typeof instructions[index]!.name === "string"
      )
        own.add(String(instructions[index]!.name));
    const callees: number[] = [];
    let ok = definition.handler == null;
    for (let index = entry; ok && index < end; index += 1) {
      const instruction = instructions[index]!;
      const target = record(instruction.target);
      if (!PURE_INSTRUCTIONS.has(String(instruction.kind))) ok = false;
      // Only its own variables: an assignment to another changes what the code outside reads.
      else if (
        instruction.kind === "assign" &&
        !(target.kind === "identifier" && own.has(String(target.name)))
      )
        ok = false;
      else if (!calls(instruction)) ok = false;
      if (callsClock(instruction)) clock.add(id);
      if (instruction.kind === "callFunction") callees.push(Number(instruction.functionId));
    }
    if (ok) candidates.set(id, callees);
  }
  // A function that calls one that is not is not either; one that calls one that reads the clock reads it too.
  const callers = new Map<number, number[]>();
  for (const [id, callees] of candidates)
    for (const callee of callees) callers.set(callee, [...(callers.get(callee) ?? []), id]);
  const rejected = [...candidates].flatMap(([id, callees]) =>
    callees.some((callee) => !candidates.has(callee)) ? [id] : [],
  );
  for (let id = rejected.pop(); id !== undefined; id = rejected.pop()) {
    if (!candidates.delete(id)) continue;
    rejected.push(...(callers.get(id) ?? []).filter((caller) => candidates.has(caller)));
  }
  const reading = [...clock].filter((id) => candidates.has(id));
  const readsClock = new Set<number>();
  for (let id = reading.pop(); id !== undefined; id = reading.pop()) {
    if (readsClock.has(id) || !candidates.has(id)) continue;
    readsClock.add(id);
    reading.push(...(callers.get(id) ?? []));
  }
  return { pure: new Set(candidates.keys()), clock: readsClock };
}

/** Whether an expression calls a getter of the current date or time. */
function callsClock(expression: unknown): boolean {
  if (Array.isArray(expression)) return expression.some(callsClock);
  if (!isRecord(expression)) return false;
  if (expression.kind === "call" && CLOCK_GETTERS.has(calleeName(expression) ?? "")) return true;
  return Object.entries(expression).some(([key, item]) => key !== "span" && callsClock(item));
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
    if (
      typeof expression.functionId === "number" &&
      model.clockFunctions.has(expression.functionId)
    )
      found.add("timestamp");
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

/** The variable an assignment to a part of it changes (`items[0] = 1` changes `items`); null for another target. */
function targetRoot(target: Data): string | null {
  if (target.kind === "identifier" && typeof target.name === "string") return target.name;
  if (target.kind === "index" || target.kind === "property")
    return targetRoot(record(target.object));
  return null;
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
  const { pure, clock: clockFunctions } = pureFunctions(functions, instructions);
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
    const name = String(record(functions[Number(producer.functionId) - 1]).name);
    const runs = name === COMPARE_HELPER || pure.has(Number(producer.functionId));
    return {
      kind: "call",
      callee: { kind: "identifier", name },
      ...(runs ? { functionId: Number(producer.functionId) } : {}),
      arguments: runs
        ? list(producer.arguments).map((argument) => ({
            parameterName: argument.parameterName,
            value: argument.value,
          }))
        : [],
    };
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
  const once = new Map<string, Definition>();
  const model: ClockModel = {
    comparisons,
    definitions,
    ambiguous,
    helpers,
    pure,
    clockFunctions,
    functions,
    instructions,
    once,
  };
  // What each variable is computed from, when every value it is set to but literals is computed from the clock (also
  // through variables computed so), and is not a bare clock read, which is a time kept to measure from. Updates of the
  // variable from itself (`took = took / 1000`) that follow its one computation straight on compose with it. When the
  // computations differ, or an update may or may not run, the variable cannot be computed again: it is ambiguous.
  // Rounds until no variable is added.
  const assigned = new Map<string, (Definition & { readonly at: number })[]>();
  /** Where each variable is set to a literal, which an update from itself does not compose across. */
  const literalAt = new Map<string, number[]>();
  // The variables set by exactly one instruction, and never as a parameter or a loop's variable.
  const setBy = new Map<string, number[]>();
  const elsewhere = new Set<string>();
  for (const definition of functions)
    for (const parameter of list(definition.parameters))
      if (typeof parameter.name === "string") elsewhere.add(parameter.name);
  instructions.forEach((instruction, index) => {
    if (instruction.kind === "loopStart")
      for (const variable of [instruction.variable, instruction.valueVariable])
        if (typeof variable === "string") elsewhere.add(variable);
    const target = record(instruction.target);
    const name =
      instruction.kind === "assign"
        ? target.kind === "identifier"
          ? target.name
          : targetRoot(target)
        : instruction.kind === "declareBinding" || instruction.kind === "declareGlobal"
          ? instruction.name
          : null;
    if (typeof name === "string") setBy.set(name, [...(setBy.get(name) ?? []), index]);
  });
  // Where something may have been saved before: a variable set there may read a stored value saved since a state was
  // left, so it is not read from that value.
  const next = successors(plan, instructions, new Map());
  const afterSave = new Uint8Array(instructions.length);
  const queue = instructions.flatMap((instruction, index) =>
    instruction.kind === "storageWrite" ? [index] : [],
  );
  for (let at = queue.pop(); at !== undefined; at = queue.pop())
    for (const target of next[at] ?? [])
      if (target >= 0 && target < instructions.length && afterSave[target] === 0) {
        afterSave[target] = 1;
        queue.push(target);
      }
  for (const [name, indices] of setBy) {
    if (indices.length !== 1 || elsewhere.has(name) || afterSave[indices[0]!] === 1) continue;
    const value = record(instructions[indices[0]!]!.value);
    once.set(name, { value, temporaries: temporariesAt(value, indices[0]!), prior: null });
  }
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
  // Half away from zero, as the runtime rounds.
  ["round", (value) => Math.sign(value) * Math.round(Math.abs(value))],
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
  /** Inside a script's function the model runs: its variables, its temporaries' values, and how deep the call is. */
  readonly frame?: Frame | undefined;
  /** The instructions left for the script's functions it runs, shared by all of them for one value. */
  readonly steps?: { left: number } | undefined;
}

/** A script's function the model runs: its variables, its temporaries' values, how deep the call is, steps left. */
interface Frame {
  readonly locals: Map<string, Value>;
  readonly values: Map<number, Value>;
  readonly depth: number;
  readonly steps: { left: number };
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
      if (reading.frame?.locals.has(node.name) === true) return reading.frame.locals.get(node.name);
      const within = reading.inside.has(node.name);
      if (model.ambiguous.has(node.name) && !within) return undefined;
      const defined = within ? reading.inside.get(node.name) : model.definitions.get(node.name);
      if (defined == null) {
        if (context.bindings.has(node.name)) return runtimeValue(context.bindings.get(node.name));
        // Not set yet in the state: from the one value it is set to, as the session will set it.
        const set = model.once.get(node.name);
        if (set === undefined || reading.memo.has(set))
          return reading.memo.get(set ?? NO_DEFINITION);
        reading.memo.set(set, undefined);
        const value = valueAt(set.value, {
          ...reading,
          temporaries: set.temporaries,
          frame: undefined,
          steps: reading.frame?.steps ?? reading.steps,
        });
        reading.memo.set(set, value);
        return value;
      }
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
      if (typeof node.temporaryId === "number" && reading.frame?.values.has(node.temporaryId))
        return reading.frame.values.get(node.temporaryId);
      const stored =
        typeof node.temporaryId === "number"
          ? reading.temporaries.get(node.temporaryId)
          : undefined;
      return stored === undefined ? undefined : valueAt(stored, reading);
    }
    case "storageLoad": {
      // A key the code computes is read too, such as one from a variable set once (`"${scriptText}.last"`).
      const key = valueAt(node.key, reading);
      if (typeof key !== "string") return undefined;
      if (context.storage.has(key)) return runtimeValue(context.storage.get(key));
      return node.default == null ? null : valueAt(node.default, reading);
    }
    case "template": {
      let text = "";
      for (const piece of list(node.parts)) {
        const value = piece.kind === "text" ? piece.value : valueAt(piece.expression, reading);
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
          return undefined;
        text += String(value);
      }
      return text;
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
  if (typeof node.functionId === "number" && reading.model.pure.has(node.functionId))
    return runFunction(node.functionId, list(node.arguments), reading);
  if (callee.kind === "identifier" && name === COMPARE_HELPER) {
    const [left, right] = list(node.arguments).map((argument) => valueAt(argument.value, reading));
    if (left === undefined || right === undefined) return undefined;
    if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1;
    // Values of one kind only, as the runtime compares them: numbers, texts, or moments or durations alike.
    const kindOf = (value: Value) =>
      typeof value === "object" && value !== null ? value.kind : typeof value;
    if (kindOf(left) !== kindOf(right)) return undefined;
    const a = typeof left === "string" ? left : magnitude(left);
    const b = typeof right === "string" ? right : magnitude(right);
    if (a === undefined || b === undefined) return undefined;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (callee.kind === "property") {
    const object = valueAt(callee.object, reading);
    if (typeof object === "object" && object !== null && object.kind === "timestamp") {
      if (name === "toSeconds") return Math.floor(object.milliseconds / 1000);
      if (name === "toMilliseconds") return object.milliseconds;
    }
    return undefined;
  }
  // One plain argument only: another one (`decimals:`) changes what the function does.
  const transform = NUMERIC.get(name);
  const args = list(node.arguments);
  if (transform === undefined || args.length !== 1 || typeof args[0]!.name === "string")
    return undefined;
  const argument = valueAt(args[0]!.value, reading);
  return typeof argument === "number" ? transform(argument) : undefined;
}

/**
 * A script's function that only computes a value, run on its arguments: binding its parameters (their defaults where an
 * argument is missing), its variables, branches, calls of such functions, and its return. Undefined when it reads what
 * cannot be read, or takes more than {@link FUNCTION_STEPS} instructions or {@link FUNCTION_DEPTH} calls within calls.
 */
function runFunction(id: number, args: readonly Data[], reading: Reading): Value {
  const { model } = reading;
  const definition = model.functions[id - 1];
  const depth = (reading.frame?.depth ?? 0) + 1;
  if (definition === undefined || depth > FUNCTION_DEPTH) return undefined;
  const parameters = list(definition.parameters);
  const frame: Frame = {
    locals: new Map(),
    values: new Map(),
    depth,
    steps: reading.frame?.steps ?? reading.steps ?? { left: FUNCTION_STEPS },
  };
  const supplied = new Set<number>();
  for (const argument of args) {
    const index = parameters.findIndex((parameter) => parameter.name === argument.parameterName);
    if (index < 0) return undefined;
    const value = valueAt(argument.value, reading);
    if (value === undefined) return undefined;
    frame.locals.set(String(parameters[index]!.name), value);
    supplied.add(index);
  }
  const inside: Reading = { ...reading, frame };
  const end = Math.min(Number(definition.endInstruction), model.instructions.length);
  for (let at = Number(definition.entryInstruction); at < end;) {
    if ((frame.steps.left -= 1) < 0) return undefined;
    const instruction = model.instructions[at]!;
    const set = (name: unknown, expression: unknown): boolean => {
      const value = valueAt(expression, inside);
      if (typeof name !== "string" || value === undefined) return false;
      frame.locals.set(name, value);
      return true;
    };
    switch (instruction.kind) {
      case "prepareParameterDefault":
        at = supplied.has(Number(instruction.parameterIndex)) ? Number(instruction.target) : at + 1;
        continue;
      case "bindDefaultParameter":
        if (!set(parameters[Number(instruction.parameterIndex)]?.name, instruction.value))
          return undefined;
        break;
      case "declareBinding":
        if (!set(instruction.name, instruction.value)) return undefined;
        break;
      case "assign":
        if (!set(record(instruction.target).name, instruction.value)) return undefined;
        break;
      case "storeTemporary": {
        const value = valueAt(instruction.value, inside);
        if (value === undefined) return undefined;
        frame.values.set(Number(instruction.temporaryId), value);
        break;
      }
      case "callFunction": {
        const value = runFunction(
          Number(instruction.functionId),
          list(instruction.arguments),
          inside,
        );
        if (value === undefined) return undefined;
        if (typeof instruction.destinationTemporary === "number")
          frame.values.set(instruction.destinationTemporary, value);
        at = Number(instruction.returnInstruction);
        continue;
      }
      case "jumpIfFalse": {
        const holds = valueAt(instruction.condition, inside);
        if (typeof holds !== "boolean") return undefined;
        at = holds ? at + 1 : Number(instruction.target);
        continue;
      }
      case "jump":
        at = Number(instruction.target);
        continue;
      case "returnValue":
        return valueAt(instruction.value, inside);
      case "returnVoid":
        return null;
      default:
        break;
    }
    at += 1;
  }
  return undefined;
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
  // Any value equals null only when it is null.
  if (
    (operator === "==" || operator === "!=") &&
    (left === null || right === null) &&
    left !== undefined &&
    right !== undefined
  )
    return operator === "==" ? left === right : left !== right;
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
  // The converter's compare helper against 0 changes where its two values meet: measure those instead.
  const compared = helperOperands(comparison);
  const subject = compared?.[0] ?? comparison.left;
  const apart = (at: number, right: unknown) => {
    const then = { ...reading, now: at, memo: new Map<Definition, Value>() };
    const left = magnitude(valueAt(subject, then));
    const bound = magnitude(valueAt(right, then));
    return left === undefined || bound === undefined ? undefined : left - bound;
  };
  const range = record(comparison.right);
  const bounds =
    compared !== null
      ? [compared[1]]
      : comparison.operator === "in"
        ? [range.start, range.end]
        : [comparison.right];
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

/**
 * The two values of a comparison of the converter's compare helper with 0 (`sexscriptLegacyCompare(a, b) <= 0`, also
 * through the temporary that holds its result), which come out as `a <= b`; null for another comparison.
 */
function helperOperands(comparison: ClockComparison): [unknown, unknown] | null {
  const call = (side: Data): Data | null => {
    const value =
      side.kind === "temporary" && typeof side.temporaryId === "number"
        ? record(comparison.temporaries.get(side.temporaryId))
        : side;
    return value.kind === "call" && calleeName(value) === COMPARE_HELPER ? value : null;
  };
  const zero = (side: Data) => side.kind === "literal" && side.value === 0;
  const found = zero(comparison.right) ? call(comparison.left) : null;
  const args = found === null ? [] : list(found.arguments);
  return args.length === 2 ? [args[0]!.value, args[1]!.value] : null;
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
    pure: new Set(),
    clockFunctions: new Set(),
    functions: [],
    instructions: [],
    once: new Map(),
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
