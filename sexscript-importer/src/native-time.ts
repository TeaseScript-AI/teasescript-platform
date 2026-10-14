import { helperDefinitionOrder } from "./helpers.ts";
import type { IrExpression, IrFunctionParameter, IrStatement, MigrationDiagnostic } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

type IrNode = IrStatement | IrExpression;
/** What declares a variable: a `let` or a parameter (a loop's variable keeps its numbers). */
type Owner = IrStatement | IrFunctionParameter;

function isIrNode(value: unknown): value is IrNode {
  return typeof value === "object" && value !== null && "kind" in value;
}

/**
 * Legacy Unix time as TeaseScript's time model (owner decision 2026-10-13). Legacy getTime() gave the Unix seconds and
 * currentTimeMillis() the milliseconds, which the lowering reads as `getAbsoluteDateTime().toSeconds()` and
 * `.toMilliseconds()`. Where a variable or a storage key only ever holds such a moment, or the difference of two, it
 * holds the moment or the duration itself: `let start = getAbsoluteDateTime()`, `let took = getAbsoluteDateTime() -
 * start`, and `if took > 45 s`. A number added to a moment, or compared with or added to a duration, counts seconds
 * (milliseconds for millisecond time): `getAbsoluteDateTime() + sessionLength * 1 min`. A duration divided by a number
 * gives a number of those units, `took / 1 min`, and a duration where only a number can stand, in text, a call, or a
 * result, gives its whole seconds, `round(took / 1 s)`, as the legacy number held whole seconds. A key keeps its name
 * and holds the moment or the duration (no saved value of the old Unix number is converted).
 *
 * Legacy moments were whole seconds, rounded, so their differences were too; a moment and a duration are exact, so a
 * comparison such as `took > 45 s` holds from 45.001 seconds, where legacy waited for 46 (or 45.5 rounded). A moment
 * variable that legacy started at a number, `def start = 0`, starts at the current moment. Where a moment meets a
 * plain number in any other way, such as a comparison with 0, arithmetic it has no meaning in, text, or a function's
 * parameter or result, the variable or the key keeps the Unix number, as do the variables a script shares with other
 * files, and the keys a computed key may name.
 */
export function withNativeTime(programs: readonly TimeProgram[]): IrStatement[][] {
  const variables = new Map<Owner, Variable>();
  const declared = new Map<IrStatement, Variable>();
  const keys = new Map<string, Variable>();
  const open = computedKeyPrefixes(programs.map((program) => program.statements));
  const keyFor = (name: string): Variable | undefined => {
    let key = keys.get(name);
    if (key === undefined) {
      key = {
        name,
        native: open !== null && !open.some((prefix) => name.startsWith(prefix)),
        time: null,
        writes: [],
      };
      keys.set(name, key);
    }
    return key;
  };
  // Rounds until no variable or key changes what it holds or loses its time: each round reads the times of the round
  // before. Each change only moves a record one way (a time it gains, or its numbers), so the rounds end; a package
  // that has not settled after many keeps its Unix numbers.
  let settled = false;
  for (let round = 0; round < 1000 && !settled; round += 1) {
    const all = [...variables.values(), ...keys.values()];
    const before = all.map(signature).join(";");
    // Writes are read anew each round; that a record may hold null only grows.
    for (const record of all) record.writes = [];
    for (const program of programs)
      analyse(program.statements, program.shared, variables, declared, keyFor);
    for (const record of [...variables.values(), ...keys.values()]) {
      record.time = record.native ? joined(record.writes) : null;
      if (record.time === "mixed") {
        record.native = false;
        record.time = null;
      }
    }
    settled = [...variables.values(), ...keys.values()].map(signature).join(";") === before;
  }
  if (!settled) return programs.map((program) => program.statements);
  return programs.map((program) =>
    mentionsClock(program.statements) || mentionsKey(program.statements, keys)
      ? rewrite(program.statements, variables, declared, keyFor, program.diagnostics)
      : program.statements,
  );
}

export interface TimeProgram {
  readonly statements: IrStatement[];
  /** Whether other files may use its script variables (a module), which then keep their numbers. */
  readonly shared: boolean;
  /** Where the notes of the variables and keys that hold a time go. */
  readonly diagnostics: MigrationDiagnostic[];
}

type Unit = "s" | "ms";
interface Time {
  kind: "moment" | "duration";
  unit: Unit;
}
/**
 * What a value holds: a moment, a duration, a plain number (or any value that is no time), or null; `placeholder` is
 * the number a declaration starts with before its later writes, `def start = 0`.
 */
type Kind = Time | "plain" | "null" | "fail" | "placeholder" | "other";

/** A variable or a storage key, as far as it could hold a moment or a duration. */
interface Variable {
  name: string;
  /** False once it keeps its numbers. */
  native: boolean;
  /** What its writes of the round before gave: a time, none, or several that do not join (`mixed`). */
  time: Time | null | "mixed";
  /** What each write of the current round gives. */
  writes: Kind[];
  /** Whether a write reads a key that may be missing, so that the variable may hold null. */
  nullable?: boolean;
}

function signature(variable: Variable): string {
  const time = variable.time;
  return `${variable.native}:${variable.nullable === true}:${time === null || time === "mixed" ? String(time) : `${time.kind}/${time.unit}`}`;
}

function timeOf(variable: Variable | undefined): Time | null {
  return variable !== undefined &&
    variable.native &&
    variable.time !== null &&
    variable.time !== "mixed"
    ? variable.time
    : null;
}

/**
 * The time the writes of a variable give: a moment where they give moments of one unit or null, a duration where they
 * give durations of one unit and plain numbers (seconds), none where no write gives a time, and `mixed` otherwise.
 */
function joined(writes: readonly Kind[]): Time | null | "mixed" {
  const times = writes.filter((kind): kind is Time => typeof kind === "object");
  if (times.length === 0) return null;
  const first = times[0]!;
  if (writes.includes("fail")) return "mixed";
  if (times.some((time) => time.kind !== first.kind || time.unit !== first.unit)) return "mixed";
  if (first.kind === "moment" && writes.includes("plain")) return "mixed";
  if (first.kind === "duration" && writes.includes("null")) return "mixed";
  return first;
}

/** A written number a declaration starts with, which a moment variable replaces with the current moment. */
function isPlaceholder(value: IrExpression): boolean {
  return numberLiteral(value) !== null;
}

type KeyFor = (name: string) => Variable | undefined;

class Scope {
  readonly names = new Map<string, Variable>();
  readonly parent: Scope | null;
  readonly keys: KeyFor;
  constructor(parent: Scope | null, keys?: KeyFor) {
    this.parent = parent;
    this.keys = keys ?? parent!.keys;
  }
  resolve(name: string): Variable | undefined {
    return this.names.get(name) ?? this.parent?.resolve(name);
  }
}

/** `getAbsoluteDateTime().toSeconds()` or `.toMilliseconds()`: the legacy clock, in its unit. */
function clockUnit(value: IrNode): Unit | null {
  if (
    value.kind !== "methodCall" ||
    value.arguments.length !== 0 ||
    value.target.kind !== "call" ||
    value.target.name !== "getAbsoluteDateTime" ||
    value.target.positional.length !== 0
  )
    return null;
  return value.name === "toSeconds" ? "s" : value.name === "toMilliseconds" ? "ms" : null;
}

function mentionsClock(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(mentionsClock);
  if (typeof value !== "object" || value === null) return false;
  if (isIrNode(value) && clockUnit(value) !== null) return true;
  return Object.values(value).some(mentionsClock);
}

function mentionsKey(value: unknown, keys: ReadonlyMap<string, Variable>): boolean {
  if (Array.isArray(value)) return value.some((item) => mentionsKey(item, keys));
  if (typeof value !== "object" || value === null) return false;
  if ("kind" in value) {
    const key = isIrNode(value) ? storedKey(value) : null;
    if (key !== null && timeOf(keys.get(key)) !== null) return true;
  }
  return Object.values(value).some((item) => mentionsKey(item, keys));
}

/** Helpers that read a stored number (parsed-loads.ts), whose first argument is the key and second the missing value. */
const NUMBER_LOADS = new Set([
  "sexscriptLegacyLoadInteger",
  "sexscriptLegacyLoadIntegerOr",
  "sexscriptLegacyLoadFloat",
]);

/** The key a save, a deletion, a read, or a number-reading helper names, or undefined. */
function keyExpression(value: IrNode): IrExpression | undefined {
  if (value.kind === "save" || value.kind === "delete" || value.kind === "load") return value.key;
  if (value.kind === "call" && NUMBER_LOADS.has(value.name)) return value.positional[0];
  return undefined;
}

/** The written key a save, a deletion, a read, or a number-reading helper names, or null. */
function storedKey(value: IrNode): string | null {
  const key = keyExpression(value);
  return key?.kind === "literal" && typeof key.value === "string" ? key.value : null;
}

/** A read of a key whose missing value is null. */
function mayBeMissing(value: IrExpression): boolean {
  if (storedKey(value) === null) return false;
  const missing = missingValue(value);
  return missing === undefined || (missing.kind === "literal" && missing.value === null);
}

/** The value a read gives for a missing key, or undefined for none (null). */
function missingValue(value: IrExpression): IrExpression | undefined {
  if (value.kind === "load") return value.defaultValue;
  if (value.kind === "call" && NUMBER_LOADS.has(value.name)) return value.positional[1];
  return undefined;
}

/**
 * The written beginnings of the keys that saves and reads compute, `"toy.${name}"` as `toy.`, whose written keys may be
 * the same key: they keep their numbers. Null where one has no written beginning, which may be any key.
 */
function computedKeyPrefixes(programs: readonly IrStatement[][]): string[] | null {
  const prefixes = new Set<string>();
  let any = false;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value !== "object" || value === null) return;
    // A generated helper reads the key its caller gives.
    if (isIrNode(value) && value.kind === "function" && helperDefinitionOrder(value) >= 0) return;
    const key = isIrNode(value) ? keyExpression(value) : undefined;
    if (key !== undefined && !(key.kind === "literal" && typeof key.value === "string")) {
      const prefix = writtenPrefix(key);
      if (prefix === "") any = true;
      else prefixes.add(prefix);
    }
    Object.values(value).forEach(visit);
  };
  programs.forEach(visit);
  return any ? null : [...prefixes];
}

function writtenPrefix(key: IrExpression): string {
  if (key.kind === "template") {
    const first = key.parts[0];
    return first !== undefined && "text" in first ? first.text : "";
  }
  if (key.kind === "binary" && key.operator === "+") return writtenPrefix(key.left);
  if (key.kind === "literal" && typeof key.value === "string") return key.value;
  return "";
}

const ROUNDINGS = new Set(["toInteger", "round", "floor", "ceil"]);
const COMPARISONS = new Set(["<", "<=", ">", ">=", "==", "!="]);
const ARITHMETIC = new Set(["+", "-", "*", "/"]);

/** The value a whole-number conversion such as `toInteger(...)` wraps, or null. */
function rounded(value: IrExpression): IrExpression | null {
  return value.kind === "call" &&
    value.local !== true &&
    ROUNDINGS.has(value.name) &&
    value.positional.length === 1 &&
    Object.keys(value.named).length === 0
    ? value.positional[0]!
    : null;
}

/** `sexscriptLegacyCompare(a, b)`, the ordering helper of values that may be null, or null. */
function compared(value: IrExpression): [IrExpression, IrExpression] | null {
  return value.kind === "call" &&
    value.name === "sexscriptLegacyCompare" &&
    value.positional.length === 2
    ? [value.positional[0]!, value.positional[1]!]
    : null;
}

/** What a value holds, with the times the variables and keys held in the round before. */
function kindOf(value: IrExpression, scope: Scope): Kind {
  const unit = clockUnit(value);
  if (unit !== null) return { kind: "moment", unit };
  const rebuilt = rebuiltMoment(value, scope);
  if (rebuilt !== null) return { kind: "moment", unit: "s" };
  // A TeaseScript time value already, which no legacy number arithmetic combines with.
  if (
    value.kind === "duration" ||
    (value.kind === "call" &&
      TEMPORAL_GETTERS.has(value.name) &&
      value.local !== true &&
      value.positional.length === 0)
  )
    return "other";
  if (value.kind === "variable") return timeOf(scope.resolve(value.name)) ?? "plain";
  const key = storedKey(value);
  if (key !== null) return timeOf(scope.keys(key)) ?? "plain";
  if (value.kind === "literal") return value.value === null ? "null" : "plain";
  // A whole number of a time is the time itself, which legacy held in whole seconds already; of a duration scaled by a
  // number, `Math.floor(took * 0.5)`, it is a number, that rounding of the duration's seconds.
  const inner = rounded(value);
  if (inner !== null) {
    const kind = kindOf(inner, scope);
    if (kind === "fail") return kind;
    return typeof kind === "object" && !scaled(inner) ? kind : "plain";
  }
  if (value.kind === "unary" && value.operator === "-") {
    const kind = kindOf(value.value, scope);
    return typeof kind === "object" && kind.kind === "moment" ? "fail" : kind;
  }
  if (value.kind === "binary" && ARITHMETIC.has(value.operator)) {
    const right = kindOf(value.right, scope);
    // A number taken from a moment is an offset where it is computed from written numbers, `getTime() - 7200`; one
    // read from a variable or a call may be a moment kept as a number, whose difference would be a duration.
    return arithmetic(
      value.operator,
      kindOf(value.left, scope),
      right === "plain" && offsetLike(value.right) ? "offset" : right,
    );
  }
  return "plain";
}

const TEMPORAL_GETTERS = new Set(["getAbsoluteDateTime", "getDate", "getTime", "getDateTime"]);
/** Methods of a moment that show it or convert it, which a moment value takes as it is. */
const MOMENT_METHODS = new Set([
  "formatDate",
  "formatTime",
  "formatDateTime",
  "toDateTime",
  "toISO",
]);

/** `moment.formatDate()` and the other methods a moment value has, on a value that holds a moment. */
function momentMethod(value: IrExpression, scope: Scope): boolean {
  if (value.kind !== "methodCall" || !MOMENT_METHODS.has(value.name) || value.arguments.length > 0)
    return false;
  const kind = kindOf(value.target, scope);
  return typeof kind === "object" && kind.kind === "moment";
}

/**
 * The moment of a legacy Unix number that the lowering rebuilt as `getAbsoluteDateTime() - (getAbsoluteDateTime()
 * .toSeconds() - seconds) * 1 s` (unixDate in lower.ts), where those seconds are a moment now: the moment itself.
 */
function rebuiltMoment(value: IrExpression, scope: Scope): IrExpression | null {
  if (
    value.kind !== "binary" ||
    value.operator !== "-" ||
    value.left.kind !== "call" ||
    value.left.name !== "getAbsoluteDateTime" ||
    value.left.positional.length !== 0 ||
    value.right.kind !== "binary" ||
    value.right.operator !== "*" ||
    value.right.right.kind !== "duration" ||
    value.right.right.value !== 1 ||
    value.right.right.unit !== "s" ||
    value.right.left.kind !== "binary" ||
    value.right.left.operator !== "-" ||
    clockUnit(value.right.left.left) !== "s"
  )
    return null;
  let seconds = value.right.left.right;
  seconds = rounded(seconds) ?? seconds;
  const kind = kindOf(seconds, scope);
  return typeof kind === "object" && kind.kind === "moment" && kind.unit === "s" ? seconds : null;
}

/** A time value multiplied or divided by a number somewhere, as `took * 0.5`. */
function scaled(value: IrExpression): boolean {
  if (value.kind === "binary" && (value.operator === "*" || value.operator === "/")) return true;
  if (value.kind === "binary" && (value.operator === "+" || value.operator === "-"))
    return scaled(value.left) || scaled(value.right);
  if (value.kind === "unary") return scaled(value.value);
  const inner = rounded(value);
  return inner !== null && scaled(inner);
}

/** A number computed from written numbers, apart from factors of them: `7200`, `days * 86400`, `(n + 1) * 60`. */
function offsetLike(value: IrExpression): boolean {
  if (value.kind === "literal") return typeof value.value === "number";
  if (value.kind === "unary") return offsetLike(value.value);
  if (value.kind === "binary" && (value.operator === "*" || value.operator === "/"))
    return numberLiteral(value.left) !== null || numberLiteral(value.right) !== null
      ? true
      : offsetLike(value.left) && offsetLike(value.right);
  if (value.kind === "binary" && (value.operator === "+" || value.operator === "-"))
    return offsetLike(value.left) && offsetLike(value.right);
  return false;
}

/** What an arithmetic operation of two kinds gives; `offset` is a plain number computed from written numbers. */
function arithmetic(operator: string, left: Kind, rightKind: Kind | "offset"): Kind {
  const right: Kind = rightKind === "offset" ? "plain" : rightKind;
  if (left === "fail" || right === "fail") return "fail";
  if (left === "other" || right === "other")
    return typeof left === "object" || typeof right === "object" ? "fail" : "plain";
  if (left === "null" || right === "null") {
    return typeof left === "object" || typeof right === "object" ? "fail" : "plain";
  }
  if (left === "plain" && right === "plain") return "plain";
  const same = (a: Time, b: Time): boolean => a.unit === b.unit;
  const moment = (kind: Kind): kind is Time => typeof kind === "object" && kind.kind === "moment";
  const duration = (kind: Kind): kind is Time =>
    typeof kind === "object" && kind.kind === "duration";
  switch (operator) {
    case "+":
      if (moment(left) && (right === "plain" || (duration(right) && same(left, right))))
        return left;
      if (moment(right) && (left === "plain" || (duration(left) && same(left, right))))
        return right;
      if (duration(left) && (right === "plain" || (duration(right) && same(left, right))))
        return left;
      if (duration(right) && left === "plain") return right;
      return "fail";
    case "-":
      if (moment(left) && moment(right) && same(left, right))
        return { kind: "duration", unit: left.unit };
      if (moment(left) && (rightKind === "offset" || (duration(right) && same(left, right))))
        return left;
      if (duration(left) && (right === "plain" || (duration(right) && same(left, right))))
        return left;
      if (duration(right) && left === "plain") return right;
      return "fail";
    case "*":
      if (duration(left) && right === "plain") return left;
      if (duration(right) && left === "plain") return right;
      return "fail";
    case "/":
      if (duration(left) && (right === "plain" || (duration(right) && same(left, right))))
        return "plain";
      return "fail";
    default:
      return "fail";
  }
}

/** Whether two kinds compare: two moments or two durations of one unit, a duration and a number, or null. */
function comparable(operator: string, left: Kind, right: Kind): boolean {
  if (left === "fail" || right === "fail") return false;
  if (left === "other" || right === "other")
    return typeof left !== "object" && typeof right !== "object";
  if (typeof left !== "object" && typeof right !== "object") return true;
  if (left === "null" || right === "null") return operator === "==" || operator === "!=";
  if (typeof left === "object" && typeof right === "object")
    return left.kind === right.kind && left.unit === right.unit;
  const time = typeof left === "object" ? left : typeof right === "object" ? right : null;
  return time?.kind === "duration";
}

/** The variables and keys of a value that hold a time, which keep their numbers where the value cannot be a time. */
function demote(value: IrExpression, scope: Scope): void {
  if (value.kind === "variable") {
    const variable = scope.resolve(value.name);
    if (variable !== undefined && timeOf(variable) !== null) variable.native = false;
    return;
  }
  const key = storedKey(value);
  if (key !== null) {
    const record = scope.keys(key);
    if (record !== undefined && timeOf(record) !== null) record.native = false;
  }
  mapChildren(value, (child) => {
    demote(child, scope);
    return child;
  });
}

/** One round over a program: what each variable's and key's writes give, and the uses that need their numbers. */
function analyse(
  statements: IrStatement[],
  shared: boolean,
  variables: Map<Owner, Variable>,
  declared: Map<IrStatement, Variable>,
  keys: KeyFor,
): void {
  const root = new Scope(null, keys);
  const functions: Array<Extract<IrStatement, { kind: "function" }>> = [];
  const variableFor = (key: Owner, name: string, native: boolean): Variable => {
    let variable = variables.get(key);
    if (variable === undefined) {
      variable = { name, native, time: null, writes: [] };
      variables.set(key, variable);
    }
    return variable;
  };

  // A value read where its kind must be a plain number (a duration gives its seconds there).
  const plain = (value: IrExpression, scope: Scope): void => {
    const kind = kindOf(value, scope);
    if (kind === "fail" || (typeof kind === "object" && kind.kind === "moment")) {
      demote(value, scope);
      inner(value, scope);
      return;
    }
    if (typeof kind === "object") {
      operands(value, scope);
      return;
    }
    inner(value, scope);
  };
  // The operands of a time value, which combine as times; any other part of them is read as a number.
  const operands = (value: IrExpression, scope: Scope): void => {
    const wrapped = rounded(value);
    if (wrapped !== null) return operands(wrapped, scope);
    const rebuilt = rebuiltMoment(value, scope);
    if (rebuilt !== null) return operands(rebuilt, scope);
    if (value.kind === "binary" && ARITHMETIC.has(value.operator)) {
      for (const side of [value.left, value.right]) {
        const kind = kindOf(side, scope);
        if (typeof kind === "object") operands(side, scope);
        else plain(side, scope);
      }
      return;
    }
    if (value.kind === "unary") return operands(value.value, scope);
    const key = storedKey(value);
    if (key !== null) missing(value, scope.keys(key), scope);
  };
  // The value a read of a key that holds a time gives for a missing key: null, a time of that kind, or seconds.
  const missing = (read: IrExpression, key: Variable | undefined, scope: Scope): void => {
    const held = timeOf(key);
    const value = missingValue(read);
    if (held === null || value === undefined) return;
    const kind = kindOf(value, scope);
    const fits =
      kind === "null" ||
      (typeof kind === "object" && kind.kind === held.kind && kind.unit === held.unit) ||
      (kind === "plain" && held.kind === "duration");
    if (!fits) {
      key!.native = false;
      plain(value, scope);
    } else if (typeof kind === "object") operands(value, scope);
    else plain(value, scope);
  };
  // A value that is no time itself: its parts are read as numbers, apart from comparisons, which compare times.
  const inner = (value: IrExpression, scope: Scope): void => {
    const pair =
      value.kind === "binary" && COMPARISONS.has(value.operator)
        ? ([value.left, value.right] as const)
        : compared(value);
    if (pair !== null) {
      const operator = value.kind === "binary" ? value.operator : "<";
      const left = kindOf(pair[0], scope);
      const right = kindOf(pair[1], scope);
      if (!comparable(operator, left, right)) {
        demote(pair[0], scope);
        demote(pair[1], scope);
        inner(pair[0], scope);
        inner(pair[1], scope);
        return;
      }
      for (const side of pair) {
        const kind = kindOf(side, scope);
        if (typeof kind === "object") operands(side, scope);
        else plain(side, scope);
      }
      return;
    }
    if (value.kind === "binary" && ARITHMETIC.has(value.operator)) {
      plain(value.left, scope);
      plain(value.right, scope);
      return;
    }
    if (momentMethod(value, scope)) {
      if (value.kind === "methodCall") operands(value.target, scope);
      return;
    }
    mapChildren(value, (child) => {
      plain(child, scope);
      return child;
    });
  };

  const write = (variable: Variable | undefined, value: IrExpression, scope: Scope): void => {
    if (variable === undefined || !variable.native) {
      plain(value, scope);
      return;
    }
    const kind = kindOf(value, scope);
    variable.writes.push(kind);
    // A read of a key that may be missing, or of a variable that may hold its null, may be null.
    if (
      mayBeMissing(value) ||
      (value.kind === "variable" && scope.resolve(value.name)?.nullable === true)
    )
      variable.nullable = true;
    if (typeof kind === "object") operands(value, scope);
    else if (kind === "fail") {
      demote(value, scope);
      inner(value, scope);
    } else inner(value, scope);
  };

  const statement = (item: IrStatement, scope: Scope): void => {
    switch (item.kind) {
      case "let": {
        const native =
          item.global !== true &&
          item.loopCounter !== true &&
          !(shared && scope === root) &&
          (item.type === undefined || /^(integer|number)\??$/u.test(item.type));
        const variable = variableFor(item, item.name, native);
        declared.set(item, variable);
        if (variable.native && isPlaceholder(item.value)) variable.writes.push("placeholder");
        else write(variable, item.value, scope);
        scope.names.set(item.name, variable);
        return;
      }
      case "assign": {
        const variable =
          item.target.kind === "variable" ? scope.resolve(item.target.name) : undefined;
        if (variable === undefined) {
          plain(item.target, scope);
          plain(item.value, scope);
          return;
        }
        if (item.operator === "=") write(variable, item.value, scope);
        else
          write(
            variable,
            {
              kind: "binary",
              operator: item.operator === "+=" ? "+" : "-",
              left: item.target,
              right: item.value,
            },
            scope,
          );
        return;
      }
      case "save": {
        const key = storedKey(item);
        if (key === null) break;
        write(scope.keys(key), item.value, scope);
        return;
      }
      case "wait": {
        // A wait of seconds takes a duration as it is.
        const kind = kindOf(item.duration, scope);
        if (typeof kind === "object" && kind.kind === "duration") operands(item.duration, scope);
        else plain(item.duration, scope);
        return;
      }
      case "function":
        // A script's functions see all its variables, also those declared after them; a nested one sees its own.
        if (scope === root) functions.push(item);
        else body(item, new Scope(scope));
        return;
      case "for": {
        plain(item.collection, scope);
        const loop = new Scope(scope);
        loop.names.set(item.variable, unknownVariable(item.variable));
        if (item.valueVariable !== undefined)
          loop.names.set(item.valueVariable, unknownVariable(item.valueVariable));
        walk(item.body, loop);
        return;
      }
      default:
        break;
    }
    mapOwnExpressions(item, (value) => {
      plain(value, scope);
      return value;
    });
    withNestedBlocks(item, (items) => {
      walk(items, new Scope(scope));
      return items;
    });
  };
  const walk = (items: readonly IrStatement[], scope: Scope): void => {
    for (const item of items) statement(item, scope);
  };
  const body = (item: Extract<IrStatement, { kind: "function" }>, scope: Scope): void => {
    for (const parameter of item.parameters) {
      if (parameter.defaultValue !== null) plain(parameter.defaultValue, scope);
      scope.names.set(parameter.name, variableFor(parameter, parameter.name, false));
    }
    walk(item.body, scope);
  };
  walk(statements, root);
  for (const item of functions) body(item, new Scope(root));
}

/** A program's statements with the times the analysis settled written as moments and durations. */
function rewrite(
  statements: IrStatement[],
  variables: Map<Owner, Variable>,
  declared: Map<IrStatement, Variable>,
  keys: KeyFor,
  diagnostics: MigrationDiagnostic[],
): IrStatement[] {
  const root = new Scope(null, keys);
  const notes = new Map<IrStatement, string>();
  // Moments rebuilt from Unix seconds that this rewrite reads as the moment itself, and the lines of their notes.
  let rebuilds = 0;
  const dropped = new Set<number>();

  // A value where a plain number is needed: a duration gives its whole seconds (or milliseconds).
  const plain = (value: IrExpression, scope: Scope): IrExpression => {
    const kind = kindOf(value, scope);
    if (typeof kind === "object" && kind.kind === "duration") {
      // A missing key's null counts no seconds, where legacy showed null.
      const zero: IrExpression = { kind: "duration", value: 0, unit: "s" };
      let written = time(value, scope);
      if (written.kind === "load" && mayBeMissing(value))
        written = { ...written, defaultValue: zero };
      else if (value.kind === "variable" && scope.resolve(value.name)?.nullable === true)
        written = binary("otherwise", written, zero);
      return call("round", [binary("/", written, unitOf(kind.unit))]);
    }
    return inner(value, scope);
  };
  // A time value written as one.
  const time = (value: IrExpression, scope: Scope): IrExpression => {
    if (clockUnit(value) !== null) return call("getAbsoluteDateTime", []);
    const wrapped = rounded(value);
    if (wrapped !== null) return time(wrapped, scope);
    const rebuilt = rebuiltMoment(value, scope);
    if (rebuilt !== null) {
      rebuilds += 1;
      return time(rebuilt, scope);
    }
    if (value.kind === "unary") return { ...value, value: time(value.value, scope) };
    if (value.kind === "binary" && ARITHMETIC.has(value.operator)) {
      const left = kindOf(value.left, scope);
      const right = kindOf(value.right, scope);
      const unit =
        typeof left === "object" ? left.unit : typeof right === "object" ? right.unit : "s";
      const side = (part: IrExpression, kind: Kind): IrExpression =>
        typeof kind === "object"
          ? time(part, scope)
          : value.operator === "*"
            ? plain(part, scope)
            : durationOf(plain(part, scope), unit);
      // A moment comes first in a sum: `1800 + getTime()` is `getAbsoluteDateTime() + 30 min`.
      if (
        value.operator === "+" &&
        typeof right === "object" &&
        right.kind === "moment" &&
        !(typeof left === "object" && left.kind === "moment")
      )
        return { ...value, left: side(value.right, right), right: side(value.left, left) };
      return { ...value, left: side(value.left, left), right: side(value.right, right) };
    }
    const key = storedKey(value);
    if (key !== null) return read(value, key, scope);
    return value;
  };
  // A read of a key that holds a time: the plain read, with the value for a missing key in its kind.
  const read = (value: IrExpression, key: string, scope: Scope): IrExpression => {
    const held = timeOf(scope.keys(key))!;
    const missing = missingValue(value);
    const kind = missing === undefined ? null : kindOf(missing, scope);
    const defaultValue =
      missing === undefined || kind === "null"
        ? undefined
        : typeof kind === "object"
          ? time(missing, scope)
          : durationOf(plain(missing, scope), held.unit);
    return {
      kind: "load",
      key: { kind: "literal", value: key },
      ...(defaultValue === undefined ? {} : { defaultValue }),
    };
  };
  // A value that is no time: comparisons of times compare them; everything else reads numbers.
  const inner = (value: IrExpression, scope: Scope): IrExpression => {
    if (value.kind === "binary" && COMPARISONS.has(value.operator)) {
      const pair = comparedTimes(value.operator, value.left, value.right, scope);
      if (pair !== null) return { ...value, left: pair[0], right: pair[1] };
    }
    const pair = compared(value);
    if (pair !== null && value.kind === "call") {
      const times = comparedTimes("<", pair[0], pair[1], scope);
      if (times !== null) return { ...value, positional: [times[0], times[1]] };
    }
    if (value.kind === "binary" && value.operator === "/") {
      const left = kindOf(value.left, scope);
      if (typeof left === "object" && left.kind === "duration") {
        const right = kindOf(value.right, scope);
        return binary(
          "/",
          time(value.left, scope),
          typeof right === "object"
            ? time(value.right, scope)
            : durationOf(plain(value.right, scope), left.unit),
        );
      }
    }
    if (value.kind === "methodCall" && momentMethod(value, scope))
      return { ...value, target: time(value.target, scope) };
    // The rounding legacy wrote, of the duration's seconds.
    const wrapped = rounded(value);
    if (wrapped !== null && value.kind === "call") {
      const kind = kindOf(wrapped, scope);
      if (typeof kind === "object" && kind.kind === "duration")
        return { ...value, positional: [binary("/", time(wrapped, scope), unitOf(kind.unit))] };
    }
    return mapChildren(value, (child) => plain(child, scope));
  };
  const comparedTimes = (
    operator: string,
    leftValue: IrExpression,
    rightValue: IrExpression,
    scope: Scope,
  ): [IrExpression, IrExpression] | null => {
    const left = kindOf(leftValue, scope);
    const right = kindOf(rightValue, scope);
    if (typeof left !== "object" && typeof right !== "object") return null;
    if (!comparable(operator, left, right)) return null;
    const side = (part: IrExpression, kind: Kind, other: Kind): IrExpression =>
      typeof kind === "object"
        ? time(part, scope)
        : kind === "plain" && typeof other === "object"
          ? durationOf(plain(part, scope), other.unit)
          : plain(part, scope);
    return [side(leftValue, left, right), side(rightValue, right, left)];
  };
  // The value written to a variable or a key that holds a time, as one.
  const value = (held: Time | null, written: IrExpression, scope: Scope): IrExpression => {
    if (held === null) return plain(written, scope);
    const kind = kindOf(written, scope);
    if (typeof kind === "object") return time(written, scope);
    if (kind === "plain" && held.kind === "duration")
      return durationOf(plain(written, scope), held.unit);
    return plain(written, scope);
  };
  const note = (item: IrStatement, held: Time, what: string): void => {
    notes.set(
      item,
      held.kind === "moment"
        ? `Legacy time was Unix ${held.unit === "s" ? "seconds" : "milliseconds"}; ${what} holds the moment itself (an absoluteDateTime), exact to the millisecond.`
        : `Legacy time was Unix ${held.unit === "s" ? "seconds" : "milliseconds"}; ${what} holds the duration itself, exact to the millisecond where legacy counted whole ${held.unit === "s" ? "seconds" : "milliseconds"}, and its numbers count ${held.unit === "s" ? "seconds" : "milliseconds"}.`,
    );
  };

  const statement = (item: IrStatement, scope: Scope): IrStatement => {
    switch (item.kind) {
      case "let": {
        const variable = declared.get(item);
        const held = timeOf(variable);
        // A moment variable that legacy started at a number starts at the current moment.
        const start =
          held?.kind === "moment" && isPlaceholder(item.value)
            ? call("getAbsoluteDateTime", [])
            : value(held, item.value, scope);
        let next: IrStatement = { ...item, value: start };
        if (held !== null && next.kind === "let") {
          const { type: _type, integer: _integer, ...rest } = next;
          next = rest;
          // A moment that starts as null names its type, which no first value gives.
          if (held.kind === "moment" && item.value.kind === "literal" && item.value.value === null)
            next = { ...next, type: "absoluteDateTime?" };
          note(item, held, "this variable");
        }
        if (variable !== undefined) scope.names.set(item.name, variable);
        return next;
      }
      case "assign": {
        const variable =
          item.target.kind === "variable" ? scope.resolve(item.target.name) : undefined;
        const held = timeOf(variable);
        if (held === null) return mapOwnExpressions(item, (part) => plain(part, scope));
        if (item.operator === "=") return { ...item, value: value(held, item.value, scope) };
        const kind = kindOf(item.value, scope);
        return {
          ...item,
          value:
            typeof kind === "object"
              ? time(item.value, scope)
              : durationOf(plain(item.value, scope), held.unit),
        };
      }
      case "save": {
        const key = storedKey(item);
        const held = key === null ? null : timeOf(scope.keys(key));
        if (held === null) break;
        note(item, held, `the key "${key}"`);
        // The read stays open (storage-keys.ts): a read of a missing key gives null where legacy failed later.
        const { valueType: _type, ...rest } = item;
        return { ...rest, value: value(held, item.value, scope) };
      }
      case "wait": {
        const kind = kindOf(item.duration, scope);
        if (typeof kind === "object" && kind.kind === "duration")
          return { ...item, duration: time(item.duration, scope), unit: null };
        break;
      }
      case "function":
        return scope === root ? item : body(item, new Scope(scope));
      case "for": {
        const collection = plain(item.collection, scope);
        const loop = new Scope(scope);
        loop.names.set(item.variable, unknownVariable(item.variable));
        if (item.valueVariable !== undefined)
          loop.names.set(item.valueVariable, unknownVariable(item.valueVariable));
        return { ...item, collection, body: walk(item.body, loop) };
      }
      default:
        break;
    }
    const own = mapOwnExpressions(item, (part) => plain(part, scope));
    return withNestedBlocks(own, (items) => walk(items, new Scope(scope)));
  };
  // A note that the next statement rebuilds a moment from Unix seconds goes where it reads the moment itself.
  const walk = (items: readonly IrStatement[], scope: Scope): IrStatement[] => {
    const result: IrStatement[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if (item.kind === "comment" && item.text.includes("SX_DATE_FROM_SECONDS")) {
        const following = items[index + 1];
        rebuilds = 0;
        const next = following === undefined ? undefined : statement(following, scope);
        if (next !== undefined && rebuilds > 0) {
          const line = /line (\d+)/u.exec(item.text)?.[1];
          dropped.add(line === undefined ? -1 : Number(line));
        } else result.push(item);
        if (next !== undefined) result.push(next);
        index += 1;
        continue;
      }
      result.push(statement(item, scope));
    }
    return result;
  };
  const body = (
    item: Extract<IrStatement, { kind: "function" }>,
    scope: Scope,
  ): Extract<IrStatement, { kind: "function" }> => {
    for (const parameter of item.parameters)
      scope.names.set(parameter.name, variables.get(parameter) ?? unknownVariable(parameter.name));
    return { ...item, body: walk(item.body, scope) };
  };
  // The script's variables are all known before its functions, which may read them.
  for (const item of statements)
    if (item.kind === "let" && declared.has(item)) root.names.set(item.name, declared.get(item)!);
  const result = walk(statements, root).map((item) =>
    item.kind === "function" ? body(item, new Scope(root)) : item,
  );
  for (const [item, message] of notes)
    diagnostics.push({ code: "SX_TIME_NATIVE", severity: "info", message, span: item.span });
  for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
    const diagnostic = diagnostics[index]!;
    if (diagnostic.code === "SX_DATE_FROM_SECONDS" && dropped.has(diagnostic.span?.line ?? -1))
      diagnostics.splice(index, 1);
  }
  return result;
}

function unknownVariable(name: string): Variable {
  return { name, native: false, time: null, writes: [] };
}

function call(name: string, positional: IrExpression[]): IrExpression {
  return { kind: "call", name, positional, named: {} };
}

function binary(operator: string, left: IrExpression, right: IrExpression): IrExpression {
  return { kind: "binary", operator, left, right };
}

function unitOf(unit: Unit): IrExpression {
  return { kind: "duration", value: 1, unit };
}

/** Units of whole seconds, largest first, that a literal number of seconds is written in. */
const SECOND_UNITS: ReadonlyArray<[number, "day" | "h" | "min" | "s"]> = [
  [86400, "day"],
  [3600, "h"],
  [60, "min"],
  [1, "s"],
];

/**
 * A number of seconds (or milliseconds) as a duration: a literal in its largest whole unit, `3600` as `1 h`, a product
 * with such a number of seconds in that unit, `minutes * 60` as `minutes * 1 min`, and any other number times one unit.
 */
function durationOf(number: IrExpression, unit: Unit): IrExpression {
  const scale = unit === "ms" ? 1000 : 1;
  const literal = constantNumber(number);
  if (literal !== null) {
    if (unit === "ms" && literal % 1000 !== 0)
      return { kind: "duration", value: literal, unit: "ms" };
    const seconds = literal / scale;
    if (Number.isInteger(seconds) && seconds !== 0) {
      const [size, name] = SECOND_UNITS.find(([size]) => seconds % size === 0) ?? [1, "s"];
      return { kind: "duration", value: seconds / size, unit: name };
    }
    return { kind: "duration", value: literal, unit };
  }
  if (number.kind === "binary" && number.operator === "*") {
    const factor = numberLiteral(number.right);
    if (factor !== null && factor % scale === 0) {
      const seconds = factor / scale;
      const named = SECOND_UNITS.find(([size]) => size > 1 && size === seconds);
      if (named !== undefined)
        return binary("*", number.left, { kind: "duration", value: 1, unit: named[1] });
    }
  }
  return binary("*", number, unitOf(unit));
}

/** The value of a number written from literals with `+`, `-`, `*`, and `/`, `365 * 24 * 3600`, or null. */
function constantNumber(value: IrExpression): number | null {
  const literal = numberLiteral(value);
  if (literal !== null) return literal;
  if (value.kind === "unary" && value.operator === "-") {
    const inner = constantNumber(value.value);
    return inner === null ? null : -inner;
  }
  if (value.kind !== "binary" || !ARITHMETIC.has(value.operator)) return null;
  const left = constantNumber(value.left);
  const right = constantNumber(value.right);
  if (left === null || right === null) return null;
  const result =
    value.operator === "+"
      ? left + right
      : value.operator === "-"
        ? left - right
        : value.operator === "*"
          ? left * right
          : right === 0
            ? null
            : left / right;
  return result !== null && Number.isFinite(result) ? result : null;
}

function numberLiteral(value: IrExpression): number | null {
  return value.kind === "literal" && typeof value.value === "number" && Number.isFinite(value.value)
    ? value.value
    : null;
}
