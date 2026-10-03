import {
  newFlowState,
  type FlowState,
  type HostFunction,
  type RuntimeValue,
} from "./runtime-check.ts";
import { emitTease } from "./emit-tease.ts";
import type { IrExpression, IrStatement, IrSwitchCase, MigrationProgram } from "./ir.ts";
import { proposalCapability, type ProposalId } from "./proposals.ts";
import { isRecord } from "./ast.ts";

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

/** Calls that only a proposed language change defines, by the proposal (see proposals.ts). */
const PROPOSED_CALLS = new Map<string, ProposalId>([["countImages", "media-tags"]]);

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
      textOptions: shimName("sxProposedTextOptions"),
      collect: shimName("sxProposedCollect"),
      locals: {
        texts: shimName("sxProposedTexts"),
        list: shimName("sxProposedList"),
        text: shimName("sxProposedText"),
        parts: shimName("sxProposedParts"),
        part: shimName("sxProposedPart"),
        option: shimName("sxProposedOption"),
        pick: shimName("sxProposedPick"),
      },
      sites: [],
    });
  const prefills: Array<{ name: string; input: "askText" | "askNumber" }> = [];
  const chooseSite = (): ProposedChooseSite => {
    const names = proposedChoose();
    const number = names.sites.length + 1;
    const site: ProposedChooseSite = {
      choose: shimName(`sxProposedChoose${number}`),
      show: [shimName(`sxProposedShow${number}A`), shimName(`sxProposedShow${number}B`)],
      turn: shimName(`sxProposedTurn${number}`),
    };
    names.sites.push(site);
    return site;
  };
  const call = (
    capability: string,
    name: string,
    positional: IrExpression[],
    named: Record<string, IrExpression> = {},
  ): IrExpression => {
    capabilities.add(capability);
    // Operation names of proposed members (`string-operations.length`) become identifier-safe shim names.
    const words = name.split(/[^A-Za-z0-9]+/u).filter((word) => word !== "");
    const shim = shimName(
      `${SHIM_PREFIX}${words.map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`).join("")}`,
    );
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
        const proposal = PROPOSED_CALLS.get(value.name);
        if (proposal !== undefined && value.local !== true) {
          return call(
            proposalCapability(proposal),
            `${proposal}.${value.name}`,
            value.positional.map(expression),
            Object.fromEntries(
              Object.entries(value.named).map(([name, child]) => [name, expression(child)]),
            ),
          );
        }
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
        if (value.properties.some((property) => property.key !== undefined)) {
          // A literal with computed keys becomes a dictionary built from key-value pairs.
          return call(proposalCapability("dictionaries"), "dictionaries.literal", [
            {
              kind: "list",
              items: value.properties.map((property) => ({
                kind: "list",
                items: [
                  property.key === undefined
                    ? { kind: "literal", value: property.name }
                    : expression(property.key),
                  expression(property.value),
                ],
              })),
            },
          ]);
        }
        return {
          ...value,
          properties: value.properties.map((property) => ({
            ...property,
            value: expression(property.value),
          })),
        };
      case "index":
        if (value.proposed !== undefined) {
          return call(proposalCapability(value.proposed), `${value.proposed}.get`, [
            expression(value.target),
            expression(value.index),
          ]);
        }
        return { ...value, target: expression(value.target), index: expression(value.index) };
      case "property":
        if (value.proposed !== undefined) {
          return call(proposalCapability(value.proposed), `${value.proposed}.${value.name}`, [
            expression(value.target),
          ]);
        }
        return { ...value, target: expression(value.target) };
      case "methodCall":
        if (value.proposed !== undefined) {
          return call(proposalCapability(value.proposed), `${value.proposed}.${value.name}()`, [
            expression(value.target),
            ...value.arguments.map(expression),
          ]);
        }
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
        const site = chooseSite();
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
          name: site.choose,
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
      case "input": {
        if (value.defaultValue === undefined) return value;
        // A generated function per input takes the prefill as its argument, so it is evaluated before the question
        // as legacy evaluated its arguments, and then asks; answers keep rotating per input.
        capabilities.add(proposalCapability("input-defaults"));
        const name = shimName(`sxProposedPrefill${prefills.length + 1}`);
        prefills.push({ name, input: value.input });
        return {
          kind: "call",
          name,
          positional: [expression(value.defaultValue)],
          named: {},
          local: true,
        };
      }
      case "literal":
      case "variable":
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
      case "assign": {
        const target = item.target;
        if (target.kind === "index" && target.proposed === "dictionaries") {
          // A dictionary write replaces the dictionary with an updated copy.
          const dictionary = expression(target.target);
          const key = expression(target.index);
          const assigned = expression(item.value);
          const value: IrExpression =
            item.operator === "="
              ? assigned
              : {
                  kind: "binary",
                  operator: item.operator === "+=" ? "+" : "-",
                  left: call(proposalCapability("dictionaries"), "dictionaries.get", [
                    dictionary,
                    key,
                  ]),
                  right: assigned,
                };
          return [
            {
              ...item,
              operator: "=",
              target: dictionary,
              value: call(proposalCapability("dictionaries"), "dictionaries.set", [
                dictionary,
                key,
                value,
              ]),
            },
          ];
        }
        return [{ ...item, target: expression(item.target), value: expression(item.value) }];
      }
      case "expression": {
        const value = item.expression;
        if (
          value.kind === "methodCall" &&
          value.proposed === "dictionaries" &&
          (value.name === "remove" || value.name === "clear")
        ) {
          const dictionary = expression(value.target);
          return [
            {
              kind: "assign",
              operator: "=",
              target: dictionary,
              value: call(proposalCapability("dictionaries"), `dictionaries.${value.name}()`, [
                dictionary,
                ...value.arguments.map(expression),
              ]),
              span: item.span,
            },
          ];
        }
        return [{ ...item, expression: expression(item.expression) }];
      }
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
  const turns: IrStatement[] = (chooseNames?.sites ?? []).map((site) => ({
    kind: "let",
    name: site.turn,
    value: { kind: "literal", value: 0 },
    span: null,
  }));
  const shimmed = { ...program, statements: [...turns, ...shimmedStatements] };
  const prefillParameter = prefills.length === 0 ? "" : shimName("sxProposedDefault");
  const prefillSource = prefills
    .map(({ name, input }) => `\nfunction ${name}(${prefillParameter}) {\n    return ${input}\n}\n`)
    .join("");
  return {
    program: shimmed,
    source:
      emitTease(shimmed) +
      (chooseNames === null ? "" : proposedChooseSource(chooseNames)) +
      prefillSource,
    builtins: [...builtins].sort(),
    operations,
    capabilities,
  };
}

interface ProposedChooseNames {
  textOptions: string;
  collect: string;
  /** Local variable names of the generated functions, unique in the program. */
  locals: Record<"texts" | "list" | "text" | "parts" | "part" | "option" | "pick", string>;
  sites: ProposedChooseSite[];
}

/** One proposed `choose` of the program, so the smoke run rotates answers per legacy menu. */
interface ProposedChooseSite {
  choose: string;
  /** Two identical functions that show the options; consecutive calls alternate between them. */
  show: [string, string];
  /** Global that selects the next of the two. */
  turn: string;
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
  const { texts, list, text, parts, part, option, pick } = names.locals;
  const lines = [
    "",
    `function ${names.textOptions}(${texts}) {`,
    `    let ${list} = []`,
    `    for ${text} in ${texts} {`,
    `        ${list}.add({ label: ${text}, text: ${text} })`,
    "    }",
    `    return ${list}`,
    "}",
    "",
    `function ${names.collect}(${parts}) {`,
    `    let ${list} = []`,
    `    for ${part} in ${parts} {`,
    `        for ${option} in ${part} {`,
    `            ${list}.add(${option})`,
    "        }",
    "    }",
    `    return ${list}`,
    "}",
  ];
  for (const site of names.sites) {
    lines.push(
      "",
      `function ${site.choose}(${parts}) {`,
      `    let ${list} = ${names.collect}(${parts})`,
      `    ${site.turn} = 1 - ${site.turn}`,
      `    if ${site.turn} == 1 {`,
      `        return ${site.show[0]}(${list})`,
      "    }",
      `    return ${site.show[1]}(${list})`,
      "}",
    );
    for (const show of site.show) {
      lines.push("", `function ${show}(${list}) {`);
      for (let count = 1; count <= PROPOSED_CHOOSE_LIMIT; count += 1) {
        const options = Array.from(
          { length: count },
          (_, index) => `${index}: ${list}[${index}].text`,
        ).join(", ");
        lines.push(
          `    if ${list}.length == ${count} {`,
          `        let ${pick} = choose ${options}`,
          `        return ${list}[${pick}].label`,
          "    }",
        );
      }
      lines.push(
        "    // No options, or more than the stand-in supports: the invalid index fails the run.",
        `    return ${list}[${list}.length].label`,
        "}",
      );
    }
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

/** An image of the package for proposed media tags: its path and the lower-case folder names that tag it. */
export interface MediaFile {
  path: string;
  tags: string[];
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
  media: readonly MediaFile[] = [],
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
  const text = (operation: string, value: RuntimeValue | undefined): string => {
    if (typeof value !== "string") throw new Error(`${operation} needs text.`);
    return value;
  };
  const items = (value: RuntimeValue[]): RuntimeValue => {
    const list = { kind: "list", items: value };
    return list;
  };
  const composite = (value: RuntimeValue | undefined): Record<string, unknown> | null => {
    const fields: unknown = value;
    return isRecord(fields) ? fields : null;
  };
  // Proposed dictionaries: objects with runtime keys. Keys are text; Groovy map keys of other types become text.
  const entries = (operation: string, value: RuntimeValue | undefined) => {
    const object = composite(value);
    if (object === null || !Array.isArray(object.properties)) {
      throw new Error(`${operation} needs a dictionary.`);
    }
    return object.properties.filter(isRecord);
  };
  const keyText = (key: RuntimeValue | undefined): string => {
    if (typeof key !== "string" && typeof key !== "number" && typeof key !== "boolean") {
      throw new Error("A dictionary key must be text, a number, or a boolean.");
    }
    if (String(key) === "") throw new Error("A dictionary key must not be empty.");
    return String(key);
  };
  const dictionary = (properties: Array<Record<string, unknown>>): RuntimeValue => {
    const object = { kind: "object", properties };
    return object;
  };
  const listItems = (value: RuntimeValue | undefined): unknown[] | null => {
    const object = composite(value);
    return object !== null && Array.isArray(object.items) ? object.items : null;
  };
  const runtimeValue = (value: unknown): RuntimeValue => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (isRecord(value) && typeof value.kind === "string") return { ...value, kind: value.kind };
    throw new Error("Unexpected runtime value.");
  };
  const implementations = new Map<string, HostFunction>([
    // Proposed media tags (M1): images counted by the folders they are in, compared without regard to case.
    [
      "media-tags.countImages",
      (_, named) => {
        const wanted = listItems(named.tags);
        if (wanted === null) throw new Error("countImages() needs a list of tags.");
        const tags = wanted.map((tag) => String(runtimeValue(tag)).toLowerCase());
        return media.filter((file) => tags.every((tag) => file.tags.includes(tag))).length;
      },
    ],
    [
      "dictionaries.get",
      ([target, key]) => {
        const elements = listItems(target);
        if (elements !== null) {
          if (
            typeof key !== "number" ||
            !Number.isInteger(key) ||
            key < 0 ||
            key >= elements.length
          ) {
            throw new Error("Invalid list index.");
          }
          return runtimeValue(elements[key]);
        }
        const name = keyText(key);
        const entry = entries("[key]", target).find((property) => property.name === name);
        return entry === undefined ? null : runtimeValue(entry.value);
      },
    ],
    [
      "dictionaries.set",
      ([target, key, value]) => {
        const elements = listItems(target);
        if (elements !== null) {
          if (
            typeof key !== "number" ||
            !Number.isInteger(key) ||
            key < 0 ||
            key >= elements.length
          ) {
            throw new Error("Invalid list index.");
          }
          return items(
            elements.map((element, index) => runtimeValue(index === key ? value : element)),
          );
        }
        const name = keyText(key);
        const properties = entries("[key] =", target);
        const replaced = properties.some((property) => property.name === name);
        return dictionary(
          replaced
            ? properties.map((property) => (property.name === name ? { name, value } : property))
            : [...properties, { name, value }],
        );
      },
    ],
    [
      "dictionaries.has()",
      ([target, key]) =>
        entries("has()", target).some((property) => property.name === keyText(key)),
    ],
    [
      "dictionaries.keys",
      ([target]) => items(entries("keys", target).map((property) => runtimeValue(property.name))),
    ],
    [
      "dictionaries.values",
      ([target]) =>
        items(entries("values", target).map((property) => runtimeValue(property.value))),
    ],
    [
      "dictionaries.length",
      ([target]) => listItems(target)?.length ?? entries("length", target).length,
    ],
    [
      "dictionaries.remove()",
      ([target, key]) =>
        dictionary(
          entries("remove()", target).filter((property) => property.name !== keyText(key)),
        ),
    ],
    [
      "dictionaries.clear()",
      ([target]) =>
        listItems(target) === null ? (entries("clear()", target), dictionary([])) : items([]),
    ],
    [
      "dictionaries.literal",
      ([pairs]) => {
        const properties: Array<Record<string, unknown>> = [];
        for (const pair of listItems(pairs) ?? []) {
          const [key, value] = listItems(runtimeValue(pair)) ?? [];
          const name = keyText(runtimeValue(key));
          // A repeated key keeps its first position and takes the later value, as in a Groovy map.
          const index = properties.findIndex((property) => property.name === name);
          if (index >= 0) properties[index] = { name, value: runtimeValue(value) };
          else properties.push({ name, value: runtimeValue(value) });
        }
        return dictionary(properties);
      },
    ],
    // Proposed string operations (#508): the length also counts list elements and, for dictionaries, keys.
    [
      "string-operations.length",
      ([value]) => {
        if (typeof value === "string") return value.length;
        const composite: unknown = value;
        if (isRecord(composite) && Array.isArray(composite.items)) return composite.items.length;
        if (isRecord(composite) && Array.isArray(composite.properties)) {
          return composite.properties.length;
        }
        throw new Error("length needs text, a list, or a dictionary.");
      },
    ],
    ["string-operations.upper()", ([value]) => text("upper()", value).toUpperCase()],
    ["string-operations.lower()", ([value]) => text("lower()", value).toLowerCase()],
    [
      "string-operations.capitalize()",
      ([value]) => {
        const source = text("capitalize()", value);
        return source.slice(0, 1).toUpperCase() + source.slice(1);
      },
    ],
    ["string-operations.trim()", ([value]) => text("trim()", value).trim()],
    [
      "string-operations.startsWith()",
      ([value, prefix]) => text("startsWith()", value).startsWith(text("startsWith()", prefix)),
    ],
    [
      "string-operations.endsWith()",
      ([value, suffix]) => text("endsWith()", value).endsWith(text("endsWith()", suffix)),
    ],
    [
      "string-operations.replace()",
      ([value, search, replacement]) => {
        const literal = text("replace()", replacement);
        // A callback keeps `$&` and similar patterns literal.
        return text("replace()", value).replaceAll(text("replace()", search), () => literal);
      },
    ],
    [
      "string-operations.split()",
      ([value, separator]) => items(text("split()", value).split(text("split()", separator))),
    ],
    [
      "string-operations.substring()",
      ([value, start, end]) => {
        const source = text("substring()", value);
        if (typeof start !== "number" || (end !== undefined && typeof end !== "number")) {
          throw new Error("substring() needs numeric positions.");
        }
        const stop = end ?? source.length;
        if (start < 0 || stop > source.length || start > stop) {
          throw new Error("substring() positions are out of range.");
        }
        return source.slice(start, stop);
      },
    ],
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
