import { isRecord } from "./ast.ts";
import type { IrExpression, IrStatement } from "./ir.ts";
import { usedNames } from "./message-handles.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

/** The next step of a legacy recursion between functions, its arguments, and the function that runs the steps. */
export const STEP_VARIABLE = "sexscriptLegacyStep";
export const STEP_ARGUMENTS_VARIABLE = "sexscriptLegacyStepArguments";
export const STEP_DRIVER = "sexscriptLegacyRunSteps";
const OPEN_VALUE = "sexscriptLegacyValue";

type FunctionStatement = Extract<IrStatement, { kind: "function" }>;
type CallExpression = Extract<IrExpression, { kind: "call" }>;

/**
 * Legacy closures that call themselves or each other as their last step grew the call stack by a level each time,
 * which Groovy's deep stack allowed; a TeaseScript session allows fewer levels, and a deep stack slows the Player. A
 * call in tail position, `return next(x)`, or a call that ends a function that returns nothing, leaves nothing of its
 * caller to run, so:
 *
 * - a function that calls itself so loops instead: the arguments are computed, the parameters take them, and the
 *   next pass starts (rule 1);
 * - functions that call each other so, a cycle of the call graph, record the next step and return, and one driver
 *   runs the steps one after another (rule 2); every other call of them goes through the driver.
 *
 * A call that is not in tail position stays a call. A cycle with a global function, a function kept as a value (an
 * action) or a module's function may be called where the driver does not run, so it stays as it is.
 */
export function withLoopedTailCalls(statements: IrStatement[]): IrStatement[] {
  const functions = new Map<string, FunctionStatement>();
  for (const statement of statements)
    if (statement.kind === "function") functions.set(statement.name, statement);
  if (functions.size === 0) return statements;
  const actions = actionNames(statements);
  const graph = new Map<string, Set<string>>();
  for (const [name, fn] of functions) graph.set(name, calledLocals(fn.body, functions));
  const quiet = quietFunctions(functions);
  let result = statements;
  const cycles: string[][] = [];
  for (const members of stronglyConnected(graph)) {
    const first = members[0]!;
    if (members.length === 1 && !graph.get(first)!.has(first)) continue;
    const fns = members.map((name) => functions.get(name)!);
    const names = new Set(members);
    const sites = fns.flatMap((fn) =>
      tailCalls(fn, quiet, functions).filter((site) => names.has(site.call.name)),
    );
    if (sites.length === 0) continue;
    // A function that calls only itself in tail position, outside a loop of its own, loops, wherever it is called.
    if (members.length === 1 && sites.every((site) => !site.inLoop)) {
      const taken = usedNames(result);
      result = result.map((statement) =>
        statement === functions.get(first)
          ? selfLooped(functions.get(first)!, sites, taken)
          : statement,
      );
      continue;
    }
    if (fns.some((fn) => fn.global === true || fn.origin !== undefined || actions.has(fn.name)))
      continue;
    // A call that leaves out a parameter whose default reads another parameter cannot pass its values as a step.
    if (
      localCalls(statements, names).some(
        (call) => passedValues(functions.get(call.name)!, call) === null,
      )
    )
      continue;
    cycles.push(members);
  }
  return cycles.length === 0 ? result : withSteps(result, cycles, quiet, functions);
}

/** A tail call of a function, the statement that makes it, and whether a loop of the function surrounds it. */
interface TailCall {
  call: CallExpression;
  statement: IrStatement;
  inLoop: boolean;
}

const isLoop = (statement: IrStatement): boolean =>
  statement.kind === "while" || statement.kind === "repeat" || statement.kind === "for";

const isBareReturn = (statement: IrStatement | undefined): boolean =>
  statement?.kind === "return" &&
  (statement.value === null ||
    (statement.value.kind === "literal" && statement.value.value === null));

/**
 * The calls of the file's functions in tail position of a function: returned, `return next(x)`, anywhere; and, in a
 * function that returns nothing (quiet), a call of another such function that ends a path to its end or that a bare
 * `return` follows. A call whose parameter values the caller cannot compute (passedValues) is left out.
 */
function tailCalls(
  fn: FunctionStatement,
  quiet: ReadonlySet<string>,
  functions: ReadonlyMap<string, FunctionStatement>,
): TailCall[] {
  const found: TailCall[] = [];
  const localCall = (value: IrExpression | null): CallExpression | null => {
    if (value?.kind !== "call" || value.local !== true) return null;
    const callee = functions.get(value.name);
    return callee !== undefined && passedValues(callee, value) !== null ? value : null;
  };
  const quietCall = (statement: IrStatement | undefined): CallExpression | null => {
    if (statement?.kind !== "expression" || !quiet.has(fn.name)) return null;
    const call = localCall(statement.expression);
    return call !== null && quiet.has(call.name) ? call : null;
  };
  const visit = (items: readonly IrStatement[], inLoop: boolean): void => {
    items.forEach((item, index) => {
      if (item.kind === "function") return;
      const call =
        item.kind === "return"
          ? localCall(item.value)
          : isBareReturn(items[index + 1])
            ? quietCall(item)
            : null;
      if (call !== null) found.push({ call, statement: item, inLoop });
      for (const body of nestedBodies(item)) visit(body, inLoop || isLoop(item));
    });
  };
  visit(fn.body, false);
  // The last statements on the paths to the end of the function.
  const ends = (items: readonly IrStatement[]): void => {
    const last = items.at(-1);
    if (last?.kind === "if") {
      ends(last.then);
      ends(last.else);
    } else if (last?.kind === "switch") {
      for (const switchCase of last.cases) ends(switchCase.body);
      ends(last.default);
    } else {
      const call = quietCall(last);
      if (call !== null && last !== undefined) found.push({ call, statement: last, inLoop: false });
    }
  };
  ends(fn.body);
  return found;
}

/** The statement blocks directly inside a statement, other than a function's body. */
function nestedBodies(statement: IrStatement): IrStatement[][] {
  switch (statement.kind) {
    case "if":
      return [statement.then, statement.else];
    case "while":
    case "repeat":
    case "for":
      return [statement.body];
    case "switch":
      return [...statement.cases.map((switchCase) => switchCase.body), statement.default];
    default:
      return [];
  }
}

/** The statement with the blocks directly inside it mapped, other than a function's body. */
function mapBodies(
  statement: IrStatement,
  map: (body: IrStatement[]) => IrStatement[],
): IrStatement {
  switch (statement.kind) {
    case "if":
      return { ...statement, then: map(statement.then), else: map(statement.else) };
    case "while":
    case "repeat":
    case "for":
      return { ...statement, body: map(statement.body) };
    case "switch":
      return {
        ...statement,
        cases: statement.cases.map((switchCase) => ({ ...switchCase, body: map(switchCase.body) })),
        default: map(statement.default),
      };
    default:
      return statement;
  }
}

/** The calls of the named functions anywhere in the statements. */
function localCalls(
  statements: readonly IrStatement[],
  names: ReadonlySet<string>,
): CallExpression[] {
  const calls: CallExpression[] = [];
  const expression = (value: IrExpression): IrExpression => {
    if (value.kind === "call" && value.local === true && names.has(value.name)) calls.push(value);
    mapChildren(value, expression);
    return value;
  };
  const block = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      mapOwnExpressions(item, expression);
      if (item.kind === "function") {
        for (const parameter of item.parameters)
          if (parameter.defaultValue !== null) expression(parameter.defaultValue);
        block(item.body);
      } else if (item.kind === "permanentButton" && item.body !== undefined) block(item.body);
      else for (const body of nestedBodies(item)) block(body);
    }
  };
  block(statements);
  return calls;
}

/** The functions of the file that a value calls. */
function calledLocals(
  value: unknown,
  functions: ReadonlyMap<string, FunctionStatement>,
): Set<string> {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;
    if (
      node.kind === "call" &&
      node.local === true &&
      typeof node.name === "string" &&
      functions.has(node.name)
    )
      names.add(node.name);
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return names;
}

/** The functions kept as values, action IDs, which run where the driver does not. */
function actionNames(statements: readonly IrStatement[]): Set<string> {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;
    if (node.kind === "literal" && node.action === true && typeof node.value === "string")
      names.add(node.value);
    for (const child of Object.values(node)) visit(child);
  };
  visit(statements);
  return names;
}

/**
 * The functions that return nothing: each of their returns is bare, null, or a call of another such function, so
 * their caller gets null whichever step ends the chain.
 */
function quietFunctions(functions: ReadonlyMap<string, FunctionStatement>): Set<string> {
  const quiet = new Set(functions.keys());
  const returnsValue = (items: readonly IrStatement[]): boolean =>
    items.some((item) => {
      if (item.kind === "function") return false;
      if (item.kind === "return" && item.value !== null && !isBareReturn(item)) {
        const value = item.value;
        if (!(value.kind === "call" && value.local === true && quiet.has(value.name))) return true;
      }
      return nestedBodies(item).some(returnsValue);
    });
  for (let changed = true; changed;) {
    changed = false;
    for (const name of quiet)
      if (returnsValue(functions.get(name)!.body)) {
        quiet.delete(name);
        changed = true;
      }
  }
  return quiet;
}

/** The strongly connected components of a call graph (Tarjan's algorithm). */
function stronglyConnected(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (name: string): void => {
    index.set(name, index.size);
    low.set(name, index.get(name)!);
    stack.push(name);
    onStack.add(name);
    for (const callee of graph.get(name) ?? []) {
      if (!index.has(callee)) {
        visit(callee);
        low.set(name, Math.min(low.get(name)!, low.get(callee)!));
      } else if (onStack.has(callee)) low.set(name, Math.min(low.get(name)!, index.get(callee)!));
    }
    if (low.get(name) !== index.get(name)) return;
    const component: string[] = [];
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      onStack.delete(member);
      component.unshift(member);
      if (member === name) break;
    }
    components.push(component);
  };
  for (const name of graph.keys()) if (!index.has(name)) visit(name);
  return components;
}

/**
 * The parameter values a call passes: its arguments, then the defaults of the parameters it leaves out; or null where
 * the call passes named or more arguments, or a default it leaves to the function reads a parameter, which the caller
 * would read instead.
 */
function passedValues(fn: FunctionStatement, call: CallExpression): IrExpression[] | null {
  if (Object.keys(call.named).length > 0 || call.positional.length > fn.parameters.length)
    return null;
  const parameters = new Set(fn.parameters.map((parameter) => parameter.name));
  const values: IrExpression[] = [];
  for (const [position, parameter] of fn.parameters.entries()) {
    const value = call.positional[position] ??
      parameter.defaultValue ?? { kind: "literal", value: null };
    if (position >= call.positional.length && readsAny(value, parameters)) return null;
    values.push(value);
  }
  return values;
}

/** Whether a value reads a variable of one of the names. */
function readsAny(value: unknown, names: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => readsAny(item, names));
  if (!isRecord(value)) return false;
  if (value.kind === "variable" && typeof value.name === "string" && names.has(value.name))
    return true;
  return Object.values(value).some((child) => readsAny(child, names));
}

/** Whether running the statements can reach their end: their last statement does not always leave the function. */
function canFallThrough(items: readonly IrStatement[]): boolean {
  const last = items.at(-1);
  if (last === undefined) return true;
  if (
    last.kind === "return" ||
    last.kind === "exit" ||
    last.kind === "goto" ||
    last.kind === "continue"
  )
    return false;
  if (last.kind === "if") return canFallThrough(last.then) || canFallThrough(last.else);
  return true;
}

/**
 * Rule 1: a function that calls itself in tail position, outside loops of its own, as a loop. Each such call
 * computes all its arguments before the parameters take them, and the next pass starts; the end of the function ends
 * the loop.
 */
function selfLooped(
  fn: FunctionStatement,
  sites: readonly TailCall[],
  taken: Set<string>,
): FunctionStatement {
  const calls = new Map(sites.map((site) => [site.statement, site.call]));
  const parameters = fn.parameters.map((parameter) => parameter.name);
  const fresh = (base: string): string => {
    let name = base;
    for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}${suffix}`;
    taken.add(name);
    return name;
  };
  const again = (call: CallExpression, span: IrStatement["span"]): IrStatement[] => {
    const values = passedValues(fn, call) ?? [];
    // A parameter that the call passes on unchanged keeps its value.
    const changed = parameters.flatMap((name, position) => {
      const value = values[position]!;
      return value.kind === "variable" && value.name === name ? [] : [{ name, value }];
    });
    // Where a value reads a parameter that the call changes, every value is computed before any parameter changes.
    const assigned = new Set(changed.map(({ name }) => name));
    const computeFirst =
      changed.length > 1 && changed.some(({ value }) => readsAny(value, assigned));
    const computed: IrStatement[] = [];
    const assignments: IrStatement[] = [];
    for (const { name, value } of changed) {
      const temporary = computeFirst ? fresh(`${name}Next`) : null;
      if (temporary !== null) computed.push({ kind: "let", name: temporary, value, span });
      assignments.push({
        kind: "assign",
        target: { kind: "variable", name },
        operator: "=",
        value: temporary === null ? value : { kind: "variable", name: temporary },
        span,
      });
    }
    return [...computed, ...assignments, { kind: "continue", span }];
  };
  const block = (items: readonly IrStatement[]): IrStatement[] => {
    const result: IrStatement[] = [];
    let replaced = false;
    for (const item of items) {
      // The bare `return` after a replaced call is not reached.
      if (replaced && isBareReturn(item)) continue;
      const call = calls.get(item);
      replaced = call !== undefined;
      if (call !== undefined) result.push(...again(call, item.span));
      else result.push(isLoop(item) ? item : mapBodies(item, block));
    }
    return result;
  };
  const body = block(fn.body);
  const ending: IrStatement[] = canFallThrough(body)
    ? [{ kind: "return", value: null, span: null }]
    : [];
  return {
    ...fn,
    body: [
      {
        kind: "while",
        condition: { kind: "literal", value: true },
        body: [...body, ...ending],
        span: fn.span,
      },
    ],
  };
}

/**
 * Rule 2: the functions of the cycles run as steps. A tail call between them records the next step and its
 * arguments, all computed first, and returns; the driver runs a step and every step it leads to; and every other
 * call of them goes through the driver.
 */
function withSteps(
  statements: IrStatement[],
  cycles: readonly (readonly string[])[],
  quiet: ReadonlySet<string>,
  functions: ReadonlyMap<string, FunctionStatement>,
): IrStatement[] {
  const stepped = new Set(cycles.flat());
  // Each cycle has its own driver, so that a call gets the results of its own cycle's functions only.
  const drivers = cycles.map((_, index) =>
    index === 0 ? STEP_DRIVER : `${STEP_DRIVER}${index + 1}`,
  );
  const cycleOf = new Map(
    cycles.flatMap((members, index) => members.map((name) => [name, index] as const)),
  );
  const variable = (name: string): IrExpression => ({ kind: "variable", name });
  const literal = (value: string | null): IrExpression => ({ kind: "literal", value });
  const assign = (name: string, value: IrExpression, span: IrStatement["span"]): IrStatement => ({
    kind: "assign",
    target: variable(name),
    operator: "=",
    value,
    span,
  });
  // The arguments as open values, which one list holds whatever their types (sexscriptLegacyValue).
  const stepArguments = (call: CallExpression): IrExpression => ({
    kind: "list",
    items: (passedValues(functions.get(call.name)!, call) ?? call.positional).map((value) => ({
      kind: "call",
      name: OPEN_VALUE,
      positional: [throughDriver(value)],
      named: {},
    })),
  });
  // A cycle whose functions return values, whose driver may also return the null of a step's return.
  const valuedCycles = new Set(
    cycles.flatMap((members, index) => (members.some((name) => !quiet.has(name)) ? [index] : [])),
  );
  // Every call of a step other than the tail calls between steps of its cycle goes through the cycle's driver. Where
  // its value is used, the value is open, as the driver's result may also be the null that ends a step, which the
  // function's own result was not.
  const viaDriver = (value: IrExpression, used: boolean): IrExpression => {
    const mapped = mapChildren(value, throughDriver);
    if (mapped.kind !== "call" || mapped.local !== true || !stepped.has(mapped.name)) return mapped;
    const cycle = cycleOf.get(mapped.name)!;
    const call: IrExpression = {
      kind: "call",
      name: drivers[cycle]!,
      positional: [literal(mapped.name), stepArguments(mapped)],
      named: {},
      local: true,
    };
    return used && valuedCycles.has(cycle)
      ? { kind: "call", name: OPEN_VALUE, positional: [call], named: {} }
      : call;
  };
  const throughDriver = (value: IrExpression): IrExpression => viaDriver(value, true);
  const tails = new Map<IrStatement, CallExpression>();
  for (const name of stepped)
    for (const site of tailCalls(functions.get(name)!, quiet, functions))
      if (cycleOf.get(site.call.name) === cycleOf.get(name)) tails.set(site.statement, site.call);
  const block = (items: readonly IrStatement[]): IrStatement[] => {
    const result: IrStatement[] = [];
    let replaced = false;
    for (const item of items) {
      // The bare `return` after a replaced call is not reached.
      if (replaced && isBareReturn(item)) continue;
      const call = tails.get(item);
      replaced = call !== undefined;
      if (call !== undefined)
        result.push(
          assign(STEP_ARGUMENTS_VARIABLE, stepArguments(call), item.span),
          assign(STEP_VARIABLE, literal(call.name), item.span),
          { kind: "return", value: null, span: item.span },
        );
      else if (item.kind === "function")
        result.push({
          ...item,
          parameters: item.parameters.map((parameter) =>
            parameter.defaultValue === null
              ? parameter
              : { ...parameter, defaultValue: throughDriver(parameter.defaultValue) },
          ),
          body: block(item.body),
        });
      else if (item.kind === "permanentButton" && item.body !== undefined)
        result.push({ ...mapOwnExpressions(item, throughDriver), body: block(item.body) });
      // A call made for its effect only, whose value nothing uses.
      else if (item.kind === "expression")
        result.push({ ...item, expression: viaDriver(item.expression, false) });
      else result.push(mapBodies(mapOwnExpressions(item, throughDriver), block));
    }
    return result;
  };
  const converted = block(statements);
  const driverFunction = (members: readonly string[], name: string): IrStatement => {
    const valued = members.some((member) => !quiet.has(member));
    const dispatch: IrStatement = {
      kind: "switch",
      value: variable("step"),
      cases: members.map((member) => {
        const call: IrExpression = {
          kind: "call",
          name: member,
          positional: functions
            .get(member)!
            .parameters.map((_, position) => ({
              kind: "index",
              target: variable("stepArguments"),
              index: { kind: "literal", value: position },
            })),
          named: {},
          local: true,
        };
        const body: IrStatement[] = quiet.has(member)
          ? [{ kind: "expression", expression: call, span: null }]
          : [
              { kind: "let", name: "result", value: call, span: null },
              {
                kind: "if",
                condition: {
                  kind: "binary",
                  operator: "==",
                  left: variable(STEP_VARIABLE),
                  right: literal(null),
                },
                then: [{ kind: "return", value: variable("result"), span: null }],
                else: [],
                span: null,
              },
            ];
        return { span: null, matches: [literal(member)], body };
      }),
      default: [],
      span: null,
    };
    return {
      kind: "function",
      name,
      parameters: [
        { name: "firstStep", defaultValue: null },
        { name: "firstArguments", defaultValue: null },
      ],
      body: [
        assign(STEP_VARIABLE, variable("firstStep"), null),
        assign(STEP_ARGUMENTS_VARIABLE, variable("firstArguments"), null),
        {
          kind: "while",
          condition: {
            kind: "binary",
            operator: "!=",
            left: variable(STEP_VARIABLE),
            right: literal(null),
          },
          body: [
            { kind: "let", name: "step", value: variable(STEP_VARIABLE), span: null },
            {
              kind: "let",
              name: "stepArguments",
              value: variable(STEP_ARGUMENTS_VARIABLE),
              span: null,
            },
            assign(STEP_VARIABLE, literal(null), null),
            dispatch,
          ],
          span: null,
        },
        ...(valued ? [{ kind: "return" as const, value: literal(null), span: null }] : []),
      ],
      span: null,
    };
  };
  const listed = (items: readonly string[]): string =>
    items.length === 1 ? items[0]! : `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`;
  const note =
    cycles.length > 1
      ? `These functions called each other or themselves as their last step, each call inside the one before, which the legacy runtime allowed without end: ${cycles.map(listed).join("; ")}. They run one after another instead: a step records the next one and returns, and ${listed(drivers)} run the steps of each.`
      : `${listed(cycles[0]!)} called ${cycles[0]!.length === 1 ? "itself as its" : "each other as their"} last step, each call inside the one before, which the legacy runtime allowed without end. They run one after another instead: a step records the next one and returns, and ${STEP_DRIVER} runs the steps.`;
  const driver: IrStatement[] = [
    ...commentLines(note).map((text): IrStatement => ({
      kind: "comment",
      text: `// ${text}`,
      trailing: false,
      span: null,
    })),
    { kind: "let", name: STEP_VARIABLE, value: literal(null), type: "string?", span: null },
    {
      kind: "let",
      name: STEP_ARGUMENTS_VARIABLE,
      value: {
        kind: "list",
        items: [{ kind: "call", name: OPEN_VALUE, positional: [literal(null)], named: {} }],
      },
      span: null,
    },
    ...cycles.map((members, index) => driverFunction(members, drivers[index]!)),
    { kind: "blank", span: null },
  ];
  // The record and the driver go before the code that uses them, after the file's leading comments but before the
  // comments of its first statement.
  let at = converted.findIndex(
    (statement) => statement.kind !== "comment" && statement.kind !== "blank",
  );
  if (at === -1) at = converted.length;
  while (at > 0 && converted[at - 1]!.kind === "comment") at -= 1;
  return [...converted.slice(0, at), ...driver, ...converted.slice(at)];
}

/** Text split into lines of at most 116 characters at spaces. */
function commentLines(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > 116) {
      lines.push(line);
      line = word;
    } else line = line === "" ? word : `${line} ${word}`;
  }
  return [...lines, line];
}
