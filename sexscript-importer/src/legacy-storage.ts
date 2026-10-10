import { helperDefinitionOrder, helperStatements, STORED_LOAD, STORED_SAVE } from "./helpers.ts";
import type { IrExpression, IrStatement, MigrationProgram } from "./ir.ts";
import { SENT_IMAGE_PREFIX } from "./lower.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

/**
 * Legacy storage (PropertiesWorker) kept a list or a map as one key per element, `key.0` or `key.name`: a save removed
 * the key with all its elements before it stored the new value, and `load()` rebuilt a key that was not stored itself
 * from its elements. TeaseScript stores each value under its own key, so where the package's keys can be one another's
 * elements, its saves and its `load()` reads go through helpers that do the same (storedSave, storedLoad); typed reads,
 * such as `loadString()`, read the key itself in legacy too and stay as they are, and so do keys that no other key can
 * be an element of.
 *
 * Keys are compared by shape, their literal text with one name without a dot for each computed part
 * (`toy.availability.*`); a key that is a parameter, or a parameter's part of it (`"toy.$i"`), takes the shapes the calls
 * of its function give it, and a script variable that only its declaration sets to a text (`tempText`) that text. A
 * key with no literal text at all is unknown and stays as it is, and so are the references of photos the conversion
 * keeps under their paths.
 */
export function withLegacyStorage(
  programs: readonly MigrationProgram[],
  /** The package's main.tease among the programs, which holds the helpers as global functions for all; else null. */
  main: number | null,
): MigrationProgram[] {
  const calls = new Map<string, Array<{ call: CallExpression; caller: Scope }>>();
  const keys: Array<{ key: IrExpression; caller: Scope }> = [];
  // The keys of the saves, deletes, and legacy `load()` reads, which the helpers would take over.
  const routable = new Set<IrExpression>();
  for (const program of programs) {
    const constants = constantTexts(program.statements);
    const scopes = new Map<Caller, Scope>();
    const scopeOf = (caller: Caller): Scope => {
      const found = scopes.get(caller) ?? {
        function: caller,
        constants,
        locals: localNames(caller),
      };
      scopes.set(caller, found);
      return found;
    };
    eachStatement(program.statements, null, (statement, function_) => {
      const caller = scopeOf(function_);
      if (statement.kind === "save" || statement.kind === "delete") {
        keys.push({ key: statement.key, caller });
        routable.add(statement.key);
      }
      mapOwnExpressions(statement, (value) => {
        eachExpression(value, (expression) => {
          if (expression.kind === "load") {
            keys.push({ key: expression.key, caller });
            if (expression.rebuilds === true) routable.add(expression.key);
          }
          if (expression.kind !== "call") return;
          if (expression.local === true)
            calls.set(expression.name, [
              ...(calls.get(expression.name) ?? []),
              { call: expression, caller },
            ]);
          // The typed reads that parse what they read name their key first.
          if (LOAD_HELPERS.has(expression.name) && expression.positional[0] !== undefined)
            keys.push({ key: expression.positional[0], caller });
        });
        return value;
      });
    });
  }

  // A parameter takes the shapes its calls give it, and a script's variable that only its declaration sets to a text
  // that text.
  const variableShapes = (name: string, scope: Scope, depth: number): string[] | null => {
    const from = scope.function;
    const index = from === null ? -1 : from.parameters.findIndex((item) => item.name === name);
    if (from === null || index < 0) {
      const text = scope.locals.has(name) ? undefined : scope.constants.get(name);
      return text === undefined ? null : [text];
    }
    if (depth > 3) return null;
    const found: string[] = [];
    for (const { call, caller } of calls.get(from.name) ?? []) {
      const argument = call.positional[index] ?? from.parameters[index]!.defaultValue;
      const given = argument === null ? null : shapes(argument, caller, depth + 1, variableShapes);
      if (given === null) return null;
      found.push(...given);
    }
    return found.length === 0 ? null : found;
  };
  // The shapes of each key; the references of photos the conversion keeps under their paths are no legacy keys, so a
  // key that is only such a reference has none, and an unresolved key null.
  const known = new Map<IrExpression, string[] | null>();
  for (const { key, caller } of keys) {
    const found = shapes(key, caller, 0, variableShapes);
    known.set(key, found?.filter((shape) => !shape.startsWith(SENT_IMAGE_PREFIX)) ?? null);
  }
  const all = [...new Set([...known.values()].flatMap((found) => found ?? []))];
  // The shapes that can be an element of another shape of the package, or have one.
  const hierarchical = new Set<string>();
  for (const parent of all)
    for (const child of all)
      if (parent !== child && mayBeElement(parent, child)) {
        hierarchical.add(parent);
        hierarchical.add(child);
      }
  if (hierarchical.size === 0) return [...programs];
  // A key that may be one of them goes through the helpers, and so does a key no shape resolves, which may be one too:
  // they store and read every key as legacy did, so that all accesses see one layout.
  // A save, delete, or legacy `load()` of a key no shape resolves may be of any key, so where there is one, all of them go
  // through the helpers, which keeps one layout for every key; photo references stay as they are.
  const unresolved = [...routable].some((key) => known.get(key) === null);
  const routed = (key: IrExpression): boolean => {
    const found = known.get(key);
    if (found === null) return true;
    if (found === undefined || found.length === 0) return false;
    return unresolved || found.some((shape) => hierarchical.has(shape));
  };

  // The helpers' own names may not be those of a file's variables or functions, which they would hide.
  const taken = new Set(
    programs.flatMap((program) =>
      program.statements.flatMap((statement) =>
        statement.kind === "let" || statement.kind === "function" ? [statement.name] : [],
      ),
    ),
  );
  const helpers = helperStatements(new Set(["storedSave", "storedLoad"] as const)).map(
    (helper): IrStatement => ({
      ...withFreshNames(helper, taken),
      ...(main !== null ? { global: true } : {}),
    }),
  );
  const withHelpers = (statements: IrStatement[]): IrStatement[] => {
    const order = helperDefinitionOrder(helpers[0]!);
    const at = statements.findIndex((statement) => {
      const position = helperDefinitionOrder(statement);
      return position < 0 || position > order;
    });
    const place = at < 0 ? statements.length : at;
    return [...statements.slice(0, place), ...helpers, ...statements.slice(place)];
  };
  let usedAnywhere = false;
  const rewritten = programs.map((program) => {
    let used = false;
    const expression = (value: IrExpression): IrExpression => {
      const routes = value.kind === "load" && value.rebuilds === true && routed(value.key);
      const next = mapChildren(value, expression);
      if (!routes || next.kind !== "load") return next;
      used = true;
      return {
        kind: "call",
        name: STORED_LOAD,
        positional: [next.key, ...(next.defaultValue === undefined ? [] : [next.defaultValue])],
        named: {},
      };
    };
    const block = (statements: IrStatement[]): IrStatement[] =>
      statements.map((statement): IrStatement => {
        if (helperDefinitionOrder(statement) >= 0) return statement;
        const next = mapOwnExpressions(withNestedBlocks(statement, block), expression);
        // A rebuilt value may hold elements of other types than the saves wrote, such as a null element, so the
        // variable it starts takes it open, without the type that the saves gave the read.
        if (
          next.kind === "let" &&
          statement.kind === "let" &&
          statement.value.kind === "load" &&
          statement.value.rebuilds === true &&
          routed(statement.value.key)
        ) {
          const { type: _type, ...open } = next;
          return open;
        }
        if (
          (statement.kind !== "save" && statement.kind !== "delete") ||
          (next.kind !== "save" && next.kind !== "delete") ||
          !routed(statement.key)
        )
          return next;
        used = true;
        return {
          kind: "expression",
          expression: {
            kind: "call",
            name: STORED_SAVE,
            positional: [
              next.key,
              next.kind === "save" ? next.value : { kind: "literal", value: null },
            ],
            named: {},
          },
          span: next.span,
        };
      });
    const statements = block(program.statements);
    if (!used) return program;
    usedAnywhere = true;
    return { ...program, statements: main !== null ? statements : withHelpers(statements) };
  });
  if (main === null || !usedAnywhere) return rewritten;
  return rewritten.map((program, index) =>
    index === main ? { ...program, statements: withHelpers(program.statements) } : program,
  );
}

type FunctionStatement = Extract<IrStatement, { kind: "function" }>;
type CallExpression = Extract<IrExpression, { kind: "call" }>;
type Caller = FunctionStatement | null;
/** Where a key is computed: its function, the texts of the file's constant variables, and the function's own names. */
interface Scope {
  function: Caller;
  constants: ReadonlyMap<string, string>;
  locals: ReadonlySet<string>;
}

/** The script variables of a file that only their declaration sets, to a text: `let tempText = "DCAfterDarkTMP"`. */
function constantTexts(statements: readonly IrStatement[]): Map<string, string> {
  const declared = new Map<string, number>();
  const assigned = new Set<string>();
  const texts = new Map<string, string>();
  for (const statement of statements)
    if (
      statement.kind === "let" &&
      statement.value.kind === "literal" &&
      typeof statement.value.value === "string"
    )
      texts.set(statement.name, statement.value.value);
  eachStatement(statements, null, (statement) => {
    if (statement.kind === "let")
      declared.set(statement.name, (declared.get(statement.name) ?? 0) + 1);
    if (statement.kind === "assign" && statement.target.kind === "variable")
      assigned.add(statement.target.name);
  });
  for (const name of [...texts.keys()])
    if (assigned.has(name) || declared.get(name) !== 1) texts.delete(name);
  return texts;
}

/** The parameters and variables a function declares, which hide the file's variables of their names. */
function localNames(function_: Caller): Set<string> {
  const names = new Set(function_?.parameters.map((parameter) => parameter.name) ?? []);
  if (function_ !== null)
    eachStatement(function_.body, null, (statement) => {
      if (statement.kind === "let") names.add(statement.name);
      if (statement.kind === "for") names.add(statement.variable);
    });
  return names;
}

/** The generated typed reads whose first argument is the key (helpers.ts parsedLoad). */
const LOAD_HELPERS = new Set([
  "sexscriptLegacyLoadInteger",
  "sexscriptLegacyLoadIntegerOr",
  "sexscriptLegacyLoadFloat",
]);

/**
 * A helper whose parameters and variables that one of the `taken` names has are renamed apart from them, `nameValue`;
 * every copy gets the same names from the same `taken`.
 */
function withFreshNames(helper: IrStatement, taken: ReadonlySet<string>): IrStatement {
  if (helper.kind !== "function") return helper;
  const own = new Set(helper.parameters.map((parameter) => parameter.name));
  eachStatement(helper.body, null, (statement) => {
    if (statement.kind === "let") own.add(statement.name);
    if (statement.kind === "for") {
      own.add(statement.variable);
      if (statement.valueVariable !== undefined) own.add(statement.valueVariable);
    }
  });
  const renamed = new Map<string, string>();
  for (const name of own) {
    if (!taken.has(name)) continue;
    let fresh = `${name}Value`;
    for (let suffix = 2; taken.has(fresh) || own.has(fresh); suffix += 1)
      fresh = `${name}Value${suffix}`;
    renamed.set(name, fresh);
  }
  if (renamed.size === 0) return helper;
  const name = (old: string): string => renamed.get(old) ?? old;
  const expression = (value: IrExpression): IrExpression => {
    const next = mapChildren(value, expression);
    return next.kind === "variable" ? { ...next, name: name(next.name) } : next;
  };
  const block = (statements: IrStatement[]): IrStatement[] =>
    statements.map((statement): IrStatement => {
      const next = mapOwnExpressions(withNestedBlocks(statement, block), expression);
      if (next.kind === "let") return { ...next, name: name(next.name) };
      if (next.kind === "for")
        return {
          ...next,
          variable: name(next.variable),
          ...(next.valueVariable === undefined ? {} : { valueVariable: name(next.valueVariable) }),
        };
      return next;
    });
  return {
    ...helper,
    parameters: helper.parameters.map((parameter) => ({
      ...parameter,
      name: name(parameter.name),
    })),
    body: block(helper.body),
  };
}

/** Visits each statement, also those in blocks, with the function it is in; generated helpers are left out. */
function eachStatement(
  statements: readonly IrStatement[],
  caller: Caller,
  visit: (statement: IrStatement, caller: Caller) => void,
): void {
  for (const statement of statements) {
    if (helperDefinitionOrder(statement) >= 0) continue;
    visit(statement, caller);
    const inner = statement.kind === "function" ? statement : caller;
    withNestedBlocks(statement, (body) => {
      eachStatement(body, inner, visit);
      return body;
    });
  }
}

/** Visits an expression and every expression inside it. */
function eachExpression(value: IrExpression, visit: (expression: IrExpression) => void): void {
  visit(value);
  mapChildren(value, (child) => {
    eachExpression(child, visit);
    return child;
  });
}

/** A computed part of a key: one name, without a dot. */
const PART = "\u0001";

/**
 * The shapes a key can have: its literal text with PART for each computed part, and a variable's part replaced by what
 * `variable` resolves it to. Null for a key without literal text that nothing resolves.
 */
function shapes(
  value: IrExpression,
  caller: Scope,
  depth: number,
  variable: (name: string, caller: Scope, depth: number) => string[] | null,
): string[] | null {
  const part = (item: IrExpression): string[] => {
    if (item.kind === "literal") return [String(item.value)];
    if (item.kind === "variable") return variable(item.name, caller, depth) ?? [PART];
    const whole = shapes(item, caller, depth, variable);
    return whole ?? [PART];
  };
  const joined = (pieces: string[][]): string[] =>
    pieces.reduce<string[]>(
      (combined, piece) =>
        combined.length * piece.length > 32
          ? combined.map((text) => `${text}${PART}`)
          : combined.flatMap((text) => piece.map((next) => `${text}${next}`)),
      [""],
    );
  if (value.kind === "literal") return typeof value.value === "string" ? [value.value] : null;
  if (value.kind === "variable") return variable(value.name, caller, depth);
  if (value.kind === "template")
    return joined(value.parts.map((item) => ("text" in item ? [item.text] : part(item.value))));
  if (value.kind === "binary" && value.operator === "+")
    return joined([part(value.left), part(value.right)]);
  if (value.kind === "call" && value.name === "toString" && value.positional.length === 1)
    return shapes(value.positional[0]!, caller, depth, variable);
  return null;
}

/**
 * Whether some key of shape `child` can be an element of some key of shape `parent`, `parent.<name>...`: whether the
 * two patterns have a text in common, a computed part being one or more characters other than a dot.
 */
function mayBeElement(parent: string, child: string): boolean {
  // A character, or a class of them (`char` null): any character, or any but a dot, once or repeated.
  type Token = { char: string | null; any: boolean; repeat: boolean };
  const tokens = (shape: string): Token[] =>
    [...shape].flatMap((char): Token[] =>
      char === PART
        ? [
            { char: null, any: false, repeat: false },
            { char: null, any: false, repeat: true },
          ]
        : [{ char, any: false, repeat: false }],
    );
  const left: Token[] = [
    ...tokens(parent),
    { char: ".", any: false, repeat: false },
    { char: null, any: true, repeat: false },
    { char: null, any: true, repeat: true },
  ];
  const right = tokens(child);
  const allows = (token: Token, char: string): boolean =>
    token.char === null ? token.any || char !== "." : token.char === char;
  const meets = (a: Token, b: Token): boolean =>
    a.char !== null ? allows(b, a.char) : b.char !== null ? allows(a, b.char) : true;
  const seen = new Set<string>();
  const pending: Array<[number, number]> = [[0, 0]];
  while (pending.length > 0) {
    const [i, j] = pending.pop()!;
    const state = `${i},${j}`;
    if (seen.has(state)) continue;
    seen.add(state);
    if (i === left.length && j === right.length) return true;
    const a = left[i];
    const b = right[j];
    if (a?.repeat === true) pending.push([i + 1, j]);
    if (b?.repeat === true) pending.push([i, j + 1]);
    if (a === undefined || b === undefined || !meets(a, b)) continue;
    pending.push([a.repeat ? i : i + 1, b.repeat ? j : j + 1]);
  }
  return false;
}
