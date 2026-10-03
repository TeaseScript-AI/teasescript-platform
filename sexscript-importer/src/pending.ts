import {
  newFlowState,
  type FlowState,
  type HostFunction,
  type RuntimeValue,
} from "./runtime-check.ts";
import { emitTease } from "./emit-tease.ts";
import type { IrExpression, IrStatement, IrSwitchCase, MigrationProgram } from "./ir.ts";
import { proposalCapability } from "./proposals.ts";

/**
 * Accepted TeaseScript the importer emits although the current compiler does not implement it yet. The
 * feasibility report compiles a shimmed copy in which these become placeholder host calls, so a remaining
 * compiler error points at importer output rather than at a known TeaseScript implementation gap. Generated
 * packages never contain the shims.
 */
const PENDING_CALLS = new Map<string, string>([
  ["askBoolean", "askBoolean()"],
  ["askBooleans", "askBooleans()"],
  ["askInteger", "askInteger()"],
  ["ceil", "ceil()"],
  ["floor", "floor()"],
  ["getDate", "getDate()"],
  ["getDateTime", "getDateTime()"],
  ["getSeconds", "getSeconds()"],
  ["openUrl", "openUrl()"],
  ["round", "round()"],
  ["showButton", "showButton timeout"],
  ["toBoolean", "toBoolean()"],
  ["toInteger", "toInteger()"],
  ["toNumber", "toNumber()"],
  ["toString", "toString()"],
]);

const SHIM_PREFIX = "sxPending";

export interface PendingShim {
  program: MigrationProgram;
  /** The shimmed program as TeaseScript, followed by the functions that stand in for proposed constructs. */
  source: string;
  /** Placeholder names to register as host builtins when compiling the shimmed program. */
  builtins: string[];
  /** Placeholder name to the TeaseScript operation it stands for (`save`, `askBooleans`, ...). */
  operations: Map<string, string>;
  /** Accepted-but-unimplemented capabilities the program uses, by display name. */
  capabilities: Set<string>;
}

export function shimPendingCapabilities(program: MigrationProgram): PendingShim {
  const builtins = new Set<string>();
  const capabilities = new Set<string>();
  // Placeholder names must not collide with names the generated program already uses.
  const used = new Set<string>();
  collectNames(program.statements, used);
  const shimNames = new Map<string, string>();
  const operations = new Map<string, string>();
  const shimName = (base: string): string => {
    const existing = shimNames.get(base);
    if (existing !== undefined) return existing;
    let candidate = base;
    for (let suffix = 2; used.has(candidate); suffix += 1) candidate = `${base}${suffix}`;
    used.add(candidate);
    shimNames.set(base, candidate);
    return candidate;
  };
  let switchCount = 0;
  // Generated functions standing in for proposed constructs, by the name the copy calls them with.
  const generated: { choose: ProposedChooseNames | null } = { choose: null };
  const proposedChoose = (): ProposedChooseNames =>
    (generated.choose ??= {
      choose: shimName("sxProposedChoose"),
      textOptions: shimName("sxProposedTextOptions"),
      show: [shimName("sxProposedShowA"), shimName("sxProposedShowB")],
      turn: shimName("sxProposedTurn"),
      locals: shimName("sxProposedOptions"),
    });
  const call = (
    capability: string,
    name: string,
    positional: IrExpression[],
    named: Record<string, IrExpression> = {},
  ): IrExpression => {
    capabilities.add(capability);
    const shim = shimName(`${SHIM_PREFIX}${name[0]!.toUpperCase()}${name.slice(1)}`);
    operations.set(shim, name);
    builtins.add(shim);
    return { kind: "call", name: shim, positional, named };
  };

  const expression = (value: IrExpression): IrExpression => {
    switch (value.kind) {
      case "load":
        return {
          ...value,
          key: expression(value.key),
          ...(value.defaultValue === undefined
            ? {}
            : { defaultValue: expression(value.defaultValue) }),
        };
      case "call": {
        const capability = PENDING_CALLS.get(value.name);
        const positional = value.positional.map(expression);
        const named = Object.fromEntries(
          Object.entries(value.named).map(([name, child]) => [name, expression(child)]),
        );
        if (value.name === "askInteger" && capability !== undefined) {
          // A real number input keeps the interaction boundary of each answer in the copy: the placeholder
          // evaluates the prompt and returns 0, and the input supplies the number.
          return {
            kind: "binary",
            operator: "+",
            left: call(capability, "askIntegerPrompt", positional, named),
            right: { kind: "input", input: "askNumber" },
          };
        }
        return capability === undefined
          ? { ...value, positional, named }
          : call(capability, value.name, positional, named);
      }
      case "list":
        return { ...value, items: value.items.map(expression) };
      case "object":
        return {
          ...value,
          properties: value.properties.map((property) => ({
            ...property,
            value: expression(property.value),
          })),
        };
      case "index":
        return { ...value, target: expression(value.target), index: expression(value.index) };
      case "property":
        return { ...value, target: expression(value.target) };
      case "methodCall":
        return {
          ...value,
          target: expression(value.target),
          arguments: value.arguments.map(expression),
        };
      case "choice":
        return { ...value, options: value.options.map(expression) };
      case "listChoice": {
        capabilities.add(proposalCapability("choose-lists"));
        const names = proposedChoose();
        const textOptions = (list: IrExpression): IrExpression => ({
          kind: "call",
          name: names.textOptions,
          positional: [list],
          named: {},
          local: true,
        });
        // Each part is a list of `{ label, text }` options; unlabelled texts get their text as label.
        const parts: IrExpression[] = [];
        let texts: IrExpression[] = [];
        const flushTexts = (): void => {
          if (texts.length > 0) parts.push(textOptions({ kind: "list", items: texts }));
          texts = [];
        };
        for (const option of value.options) {
          if (option.kind === "list") {
            flushTexts();
            const list = expression(option.list);
            parts.push(option.records ? list : textOptions(list));
          } else if (option.label === null) {
            texts.push(expression(option.text));
          } else {
            flushTexts();
            parts.push({
              kind: "list",
              items: [
                {
                  kind: "object",
                  properties: [
                    { name: "label", value: { kind: "literal", value: option.label } },
                    { name: "text", value: expression(option.text) },
                  ],
                },
              ],
            });
          }
        }
        flushTexts();
        return {
          kind: "call",
          name: names.choose,
          positional: [{ kind: "list", items: parts }],
          named: {},
          local: true,
        };
      }
      case "range":
        return { ...value, from: expression(value.from), to: expression(value.to) };
      case "unary":
        return { ...value, value: expression(value.value) };
      case "binary":
        return { ...value, left: expression(value.left), right: expression(value.right) };
      case "template":
        return {
          ...value,
          parts: value.parts.map((part) =>
            "text" in part ? part : { value: expression(part.value) },
          ),
        };
      case "literal":
      case "variable":
      case "input":
        return value;
    }
  };

  const statements = (items: IrStatement[]): IrStatement[] => items.flatMap(statement);
  const callStatement = (value: IrExpression, span: IrStatement["span"]): IrStatement => ({
    kind: "expression",
    expression: value,
    span,
  });

  const statement = (item: IrStatement): IrStatement[] => {
    switch (item.kind) {
      case "save":
        return [{ ...item, key: expression(item.key), value: expression(item.value) }];
      case "delete":
        return [{ ...item, key: expression(item.key) }];
      // Transfer and end leave the current file, so the shimmed copy stops there.
      case "run":
        return [
          callStatement(call("run/end", "run", [expression(item.script)]), item.span),
          { kind: "exit", span: item.span },
        ];
      case "end":
        return [
          callStatement(call("run/end", "end", []), item.span),
          { kind: "exit", span: item.span },
        ];
      case "showPopup":
        return [
          callStatement(call("showPopup", "showPopup", [expression(item.message)]), item.span),
        ];
      case "showButton":
        if (item.timeout === null) return [{ ...item, label: expression(item.label) }];
        return [
          callStatement(
            call("showButton timeout", "showButton", [
              expression(item.label),
              expression(item.timeout),
            ]),
            item.span,
          ),
        ];
      case "switch": {
        capabilities.add("switch");
        switchCount += 1;
        return switchAsIfChain(
          item,
          shimName(`${SHIM_PREFIX}SwitchValue${switchCount}`),
          expression,
          statements,
        );
      }
      case "function":
        return [{ ...item, body: statements(item.body) }];
      case "let":
        return [{ ...item, value: expression(item.value) }];
      case "assign":
        return [{ ...item, target: expression(item.target), value: expression(item.value) }];
      case "expression":
        return [{ ...item, expression: expression(item.expression) }];
      case "say":
        return [{ ...item, value: expression(item.value) }];
      case "wait":
        return [{ ...item, duration: expression(item.duration) }];
      case "showImage":
        return [{ ...item, file: expression(item.file) }];
      case "playAudio":
        return [
          {
            ...item,
            file: expression(item.file),
            repeatCount: item.repeatCount === null ? null : expression(item.repeatCount),
          },
        ];
      case "return":
        return [{ ...item, value: item.value === null ? null : expression(item.value) }];
      case "if":
        return [
          {
            ...item,
            condition: expression(item.condition),
            then: statements(item.then),
            else: statements(item.else),
          },
        ];
      case "while":
        return [{ ...item, condition: expression(item.condition), body: statements(item.body) }];
      case "repeat":
        return [{ ...item, count: expression(item.count), body: statements(item.body) }];
      case "for":
        return [{ ...item, collection: expression(item.collection), body: statements(item.body) }];
      case "hideImage":
      case "break":
      case "continue":
      case "exit":
      case "unsupported":
      case "comment":
      case "blank":
        return [item];
    }
  };

  const shimmedStatements = statements(program.statements);
  const chooseNames = generated.choose;
  const shimmed = {
    ...program,
    statements:
      chooseNames === null
        ? shimmedStatements
        : [
            {
              kind: "let" as const,
              name: chooseNames.turn,
              value: { kind: "literal" as const, value: 0 },
              span: null,
            },
            ...shimmedStatements,
          ],
  };
  return {
    program: shimmed,
    source: emitTease(shimmed) + (chooseNames === null ? "" : proposedChooseSource(chooseNames)),
    builtins: [...builtins].sort(),
    operations,
    capabilities,
  };
}

interface ProposedChooseNames {
  choose: string;
  textOptions: string;
  /** Two identical functions that show the options; consecutive calls alternate between them. */
  show: [string, string];
  /** Global that selects the next of the two. */
  turn: string;
  /** Prefix of the generated functions' local variables, unique in the program. */
  locals: string;
}

/** Largest number of options the stand-in for a proposed `choose` supports; more fail the smoke run. */
const PROPOSED_CHOOSE_LIMIT = 40;

/**
 * Stand-ins for a proposed `choose` in current TeaseScript: the options are collected at runtime, and a compact
 * `choose` with numeric labels per option count shows them, so the interaction stays real. The chosen option's
 * label is the result.
 *
 * Consecutive calls alternate between two copies of the showing function. The runtime revalidates the retained
 * settlement of the last choice against the option texts its instruction currently holds, so one `choose` reached
 * again with other texts makes the next completion fail with TSR101 (a runtime defect, also for accepted
 * `choose` options computed in a loop); with two copies the last choice's instruction is not the one being reused.
 */
function proposedChooseSource(names: ProposedChooseNames): string {
  const local = (name: string): string => `${names.locals}${name}`;
  const lines = [
    "",
    `function ${names.textOptions}(${local("Texts")}) {`,
    `    let ${local("List")} = []`,
    `    for ${local("Text")} in ${local("Texts")} {`,
    `        ${local("List")}.add({ label: ${local("Text")}, text: ${local("Text")} })`,
    "    }",
    `    return ${local("List")}`,
    "}",
    "",
    `function ${names.choose}(${local("Parts")}) {`,
    `    let ${local("List")} = []`,
    `    for ${local("Part")} in ${local("Parts")} {`,
    `        for ${local("Option")} in ${local("Part")} {`,
    `            ${local("List")}.add(${local("Option")})`,
    "        }",
    "    }",
    `    ${names.turn} = 1 - ${names.turn}`,
    `    if ${names.turn} == 1 {`,
    `        return ${names.show[0]}(${local("List")})`,
    "    }",
    `    return ${names.show[1]}(${local("List")})`,
    "}",
  ];
  for (const show of names.show) {
    lines.push("", `function ${show}(${local("List")}) {`);
    for (let count = 1; count <= PROPOSED_CHOOSE_LIMIT; count += 1) {
      const options = Array.from(
        { length: count },
        (_, index) => `${index}: ${local("List")}[${index}].text`,
      ).join(", ");
      lines.push(
        `    if ${local("List")}.length == ${count} {`,
        `        let ${local("Pick")} = choose ${options}`,
        `        return ${local("List")}[${local("Pick")}].label`,
        "    }",
      );
    }
    lines.push(
      "    // No options, or more than the stand-in supports: the invalid index fails the run.",
      `    return ${local("List")}[${local("List")}.length].label`,
      "}",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Accepted switch semantics (literal or range cases, no fallthrough) expressed as an equivalent if chain. */
function switchAsIfChain(
  item: Extract<IrStatement, { kind: "switch" }>,
  valueName: string,
  expression: (value: IrExpression) => IrExpression,
  statements: (items: IrStatement[]) => IrStatement[],
): IrStatement[] {
  const value: IrExpression = { kind: "variable", name: valueName };
  const matches = (switchCase: IrSwitchCase): IrExpression => {
    const match = switchCase.match;
    if (match.kind !== "range")
      return { kind: "binary", operator: "==", left: value, right: expression(match) };
    return {
      kind: "binary",
      operator: "and",
      left: { kind: "binary", operator: ">=", left: value, right: expression(match.from) },
      right: {
        kind: "binary",
        operator: match.inclusive ? "<=" : "<",
        left: value,
        right: expression(match.to),
      },
    };
  };
  let chain: IrStatement[] = statements(item.default);
  for (const switchCase of [...item.cases].reverse()) {
    chain = [
      {
        kind: "if",
        condition: matches(switchCase),
        then: statements(switchCase.body),
        else: chain,
        span: switchCase.span,
      },
    ];
  }
  return [
    { kind: "let", name: valueName, value: expression(item.value), span: item.span },
    ...chain,
  ];
}

function collectNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNames(item, names);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "name" || key === "variable") && typeof child === "string") names.add(child);
    else collectNames(child, names);
  }
}

/**
 * Host stand-ins for the pending capabilities of a shimmed program, for smoke runs only: `run` records its target in
 * the flow state, time and dates follow the simulated clock from 2026-10-02 12:00 UTC, conversions fail without a
 * `default` like the accepted functions, and a timed button answers quickly, then at its timeout, without advancing
 * the clock. Integer input is a real number input in the shimmed program.
 */
export function pendingHostFunctions(
  shim: PendingShim,
  state: FlowState = newFlowState(),
): Record<string, HostFunction> {
  const next = <T>(operation: string, answers: readonly T[]): T => {
    const visit = state.answers.get(operation) ?? 0;
    state.answers.set(operation, visit + 1);
    return answers[visit % answers.length]!;
  };
  const emptyList = { kind: "list", items: [] };
  const epochMs = Date.UTC(2026, 9, 2, 12, 0, 0);
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const date = (withTime: boolean): RuntimeValue => {
    const moment = new Date(epochMs + state.clock.nowMs);
    const fields: Array<[string, RuntimeValue]> = [
      ["year", moment.getUTCFullYear()],
      ["month", moment.getUTCMonth() + 1],
      ["day", moment.getUTCDate()],
      ["weekday", weekdays[moment.getUTCDay()]!],
      ["weekdayNumber", moment.getUTCDay() === 0 ? 7 : moment.getUTCDay()],
    ];
    if (withTime) {
      fields.push(
        ["hour", moment.getUTCHours()],
        ["minute", moment.getUTCMinutes()],
        ["second", moment.getUTCSeconds()],
        ["millisecond", moment.getUTCMilliseconds()],
      );
    }
    const value = {
      kind: "object",
      properties: fields.map(([name, item]) => ({ name, value: item })),
    };
    return value;
  };
  const convert =
    (
      name: string,
      parse: (value: RuntimeValue | undefined) => RuntimeValue | undefined,
    ): HostFunction =>
    ([positionalValue], named) => {
      const value = positionalValue ?? named.value;
      const converted = parse(value);
      if (converted !== undefined) return converted;
      if (named.default !== undefined) return named.default;
      throw new Error(`${name}() cannot convert ${JSON.stringify(value)}.`);
    };
  const toNumber = (value: RuntimeValue | undefined): number | undefined => {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const rounded =
    (name: string, round: (value: number) => number): HostFunction =>
    ([value]) => {
      if (typeof value !== "number") throw new Error(`${name}() needs a number.`);
      return round(value);
    };
  const implementations = new Map<string, HostFunction>([
    ["run", ([script]) => ((state.transfer = String(script)), null)],
    ["end", () => null],
    ["showPopup", () => null],
    // Seconds until the click: quick, then at the timeout. The simulated clock does not advance meanwhile.
    [
      "showButton",
      ([, positionalTimeout], named) => {
        const timeout = positionalTimeout ?? named.timeout;
        const limit = typeof timeout === "number" ? timeout : 30;
        return next("showButton", [Math.min(1, limit), limit]);
      },
    ],
    ["askIntegerPrompt", () => 0],
    ["askBoolean", () => next("askBoolean", [true, false])],
    ["askBooleans", (_, named) => named.defaults ?? emptyList],
    ["getSeconds", () => Math.floor((epochMs + state.clock.nowMs) / 1000)],
    ["getDateTime", () => date(true)],
    ["getDate", () => date(false)],
    ["openUrl", () => null],
    // Owner decision (#507): ties round away from zero.
    ["round", rounded("round", (value) => Math.sign(value) * Math.round(Math.abs(value)))],
    ["floor", rounded("floor", Math.floor)],
    ["ceil", rounded("ceil", Math.ceil)],
    [
      "toInteger",
      convert("toInteger", (value) => {
        const parsed = toNumber(value);
        return parsed === undefined ? undefined : Math.trunc(parsed);
      }),
    ],
    ["toNumber", convert("toNumber", toNumber)],
    [
      "toString",
      convert("toString", (value) =>
        typeof value === "object" && value !== null ? undefined : String(value),
      ),
    ],
    [
      "toBoolean",
      convert("toBoolean", (value) =>
        typeof value === "boolean"
          ? value
          : value === "true"
            ? true
            : value === "false"
              ? false
              : undefined,
      ),
    ],
  ]);
  const result: Record<string, HostFunction> = {};
  for (const [shimName, operation] of shim.operations) {
    const implementation = implementations.get(operation);
    if (implementation !== undefined) result[shimName] = implementation;
  }
  return result;
}
