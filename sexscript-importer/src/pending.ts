import {
  newFlowState,
  type FlowState,
  type HostFunction,
  type RuntimeValue,
} from "./runtime-check.ts";
import { emitTease } from "./emit-tease.ts";
import type { IrExpression, IrStatement, MigrationProgram } from "./ir.ts";
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
  ["getDate", "getDate()"],
  ["getDateTime", "getDateTime()"],
  ["openUrl", "openUrl()"],
  ["takePhoto", "takePhoto()"],
  ["toDate", "toDate()"],
]);

/** Current-time getters whose conversion and format methods (#532) the shim replaces together with the getter. */
const TEMPORAL_GETTERS = new Set(["getDate", "getTime", "getDateTime", "getTimestamp"]);

/** Capability name of the accepted dict (#536), which main does not implement yet. */
const DICT = "dict (#536)";
/** The property of the object that stands in for a dict in smoke runs, and the prefix of its entry names. */
const DICT_PROPERTY = "dict (#536)";
const DICT_KEY_PREFIX = "key ";

/** Calls that only a proposed language change defines, by the proposal (see proposals.ts). */
const PROPOSED_CALLS = new Map<string, ProposalId>([["countImages", "media-tags"]]);

const SHIM_PREFIX = "sxPending";

/**
 * Stand-ins whose accepted result is never null, by the conversion that gives the placeholder's untyped result that
 * type, so that the compiler checks and narrows its uses as it will the accepted operation's.
 */
const TYPED_RESULTS = new Map<string, "toInteger" | "toString" | "toBoolean">([
  ["askBoolean", "toBoolean"],
  ["dict.contains()", "toBoolean"],
  ["dict.length", "toInteger"],
  ["(date - date).days", "toInteger"],
  ["getTimestamp().toSeconds()", "toInteger"],
  ["getTimestamp().toMilliseconds()", "toInteger"],
  ["getDate().toISO()", "toString"],
  ["getDate().formatDate()", "toString"],
  ["getTime().formatTime()", "toString"],
  ["getDateTime().formatDateTime()", "toString"],
  ["media-tags.countImages", "toInteger"],
]);

export interface PendingShim {
  program: MigrationProgram;
  /** The shimmed program as TeaseScript. */
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
  const call = (
    capability: string,
    name: string,
    positional: IrExpression[],
    named: Record<string, IrExpression> = {},
  ): IrExpression => {
    capabilities.add(capability);
    // Operation names of members (`text.length`, `dict.contains()`) become identifier-safe shim names.
    const words = name.split(/[^A-Za-z0-9]+/u).filter((word) => word !== "");
    const shim = shimName(
      `${SHIM_PREFIX}${words.map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`).join("")}`,
    );
    operations.set(shim, name);
    builtins.add(shim);
    const placeholder: IrExpression = { kind: "call", name: shim, positional, named };
    const conversion = TYPED_RESULTS.get(name);
    return conversion === undefined
      ? placeholder
      : { kind: "call", name: conversion, positional: [placeholder], named: {} };
  };

  const expression = (value: IrExpression): IrExpression => {
    switch (value.kind) {
      case "load":
        return value.defaultValue === undefined
          ? { ...value, key: expression(value.key) }
          : { ...value, key: expression(value.key), defaultValue: expression(value.defaultValue) };
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
        return capability === undefined
          ? { ...value, positional, named }
          : call(capability, value.name, positional, named);
      }
      case "list":
        return { ...value, items: value.items.map(expression) };
      case "object":
        if (value.dict === true) {
          // A dict literal (#536) becomes a stand-in built from a list of keys and a list of their values, so each
          // list holds one type.
          return call(DICT, "dict.literal", [
            {
              kind: "list",
              items: value.properties.map((property) =>
                property.key === undefined
                  ? { kind: "literal", value: property.name }
                  : expression(property.key),
              ),
            },
            { kind: "list", items: value.properties.map((property) => expression(property.value)) },
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
        if (value.dict === true) {
          return call(DICT, "dict.get", [expression(value.target), expression(value.index)]);
        }
        return { ...value, target: expression(value.target), index: expression(value.index) };
      case "property":
        if (value.dict === true)
          return call(DICT, `dict.${value.name}`, [expression(value.target)]);
        if (
          value.name === "days" &&
          value.target.kind === "binary" &&
          value.target.operator === "-"
        ) {
          // Calendar days between two dates (#532), with the dates' stand-ins as arguments.
          return call("(date - date).days", "(date - date).days", [
            expression(value.target.left),
            expression(value.target.right),
          ]);
        }
        return { ...value, target: expression(value.target) };
      case "methodCall":
        if (
          value.target.kind === "call" &&
          value.target.local !== true &&
          TEMPORAL_GETTERS.has(value.target.name) &&
          value.target.positional.length === 0
        ) {
          // A conversion or format method of the current date or time (#532), as one placeholder.
          const operation = `${value.target.name}().${value.name}()`;
          return call(operation, operation, value.arguments.map(expression));
        }
        if (value.dict === true) {
          // `get(key, default: value)` is apart from the `[key]` read, which is `dict.get`.
          const operation =
            value.name === "get" && value.arguments.length === 2
              ? "dict.get(default:)"
              : `dict.${value.name}()`;
          return call(DICT, operation, [
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
      case "listChoice":
        return {
          ...value,
          options: value.options.map((option) =>
            option.kind === "list"
              ? { ...option, list: expression(option.list) }
              : { ...option, text: expression(option.text) },
          ),
        };
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
      case "input":
        return value.defaultValue === undefined
          ? value
          : { ...value, defaultValue: expression(value.defaultValue) };
      case "button":
        return {
          ...value,
          label: expression(value.label),
          timeout: value.timeout === null ? null : expression(value.timeout),
        };
      case "literal":
      case "duration":
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
        return [
          {
            ...item,
            label: expression(item.label),
            timeout: item.timeout === null ? null : expression(item.timeout),
          },
        ];
      case "switch":
        return [
          {
            ...item,
            value: expression(item.value),
            cases: item.cases.map((switchCase) => ({
              ...switchCase,
              matches: switchCase.matches.map(expression),
              body: statements(switchCase.body),
            })),
            default: statements(item.default),
          },
        ];
      case "function":
        return [{ ...item, body: statements(item.body) }];
      case "let":
        return [{ ...item, value: expression(item.value) }];
      case "assign": {
        const target = item.target;
        if (target.kind === "index" && target.dict === true) {
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
                  left: call(DICT, "dict.get", [dictionary, key]),
                  right: assigned,
                };
          return [
            {
              ...item,
              operator: "=",
              target: dictionary,
              value: call(DICT, "dict.set", [dictionary, key, value]),
            },
          ];
        }
        return [{ ...item, target: expression(item.target), value: expression(item.value) }];
      }
      case "expression": {
        const value = item.expression;
        if (
          value.kind === "methodCall" &&
          value.dict === true &&
          (value.name === "remove" || value.name === "clear")
        ) {
          const dictionary = expression(value.target);
          return [
            {
              kind: "assign",
              operator: "=",
              target: dictionary,
              value: call(DICT, `dict.${value.name}()`, [
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
      case "for": {
        // A loop over a dict visits its keys as they were when the loop started (#536).
        const collection = expression(item.collection);
        return [
          {
            ...item,
            collection: item.dict === true ? call(DICT, "dict.keys", [collection]) : collection,
            body: statements(item.body),
          },
        ];
      }
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

  const shimmed = { ...program, statements: statements(program.statements) };
  return {
    program: shimmed,
    source: emitTease(shimmed),
    builtins: [...builtins].sort(),
    operations,
    capabilities,
  };
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
 * the flow state, and time and dates follow the simulated clock from 2026-10-02 12:00 UTC.
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
  const items = (value: RuntimeValue[]): RuntimeValue => {
    const list = { kind: "list", items: value };
    return list;
  };
  const composite = (value: RuntimeValue | undefined): Record<string, unknown> | null => {
    const fields: unknown = value;
    return isRecord(fields) ? fields : null;
  };
  const entries = (operation: string, value: RuntimeValue | undefined) => {
    const object = composite(value);
    if (object === null || !Array.isArray(object.properties)) {
      throw new Error(`${operation} needs an object.`);
    }
    return object.properties.filter(isRecord);
  };
  // A dict (#536) is an object with one property, DICT_PROPERTY, whose object has a property per entry, named with
  // DICT_KEY_PREFIX before the key so that the empty text is a key too. It never equals an object, two dicts compare
  // without regard to order, and keys are text only.
  const dictEntries = (operation: string, value: RuntimeValue | undefined) => {
    const [wrapper] = entries(operation, value);
    const table = wrapper?.name === DICT_PROPERTY ? composite(runtimeValue(wrapper.value)) : null;
    if (table === null || !Array.isArray(table.properties))
      throw new Error(`${operation} needs a dict.`);
    return table.properties
      .filter(isRecord)
      .map((property) => ({
        name: String(property.name).slice(DICT_KEY_PREFIX.length),
        value: runtimeValue(property.value),
      }));
  };
  const keyText = (key: RuntimeValue | undefined): string => {
    if (typeof key !== "string") throw new Error("A dict key must be text (#536).");
    return key;
  };
  const dictionary = (
    properties: ReadonlyArray<{ name: string; value: RuntimeValue }>,
  ): RuntimeValue => {
    const table = {
      kind: "object",
      properties: properties.map(({ name, value }) => ({
        name: `${DICT_KEY_PREFIX}${name}`,
        value,
      })),
    };
    const dict = { kind: "object", properties: [{ name: DICT_PROPERTY, value: table }] };
    return dict;
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
    // A missing key is an error (#536), where Groovy read null.
    [
      "dict.get",
      ([target, key]) => {
        const name = keyText(key);
        const entry = dictEntries("[key]", target).find((property) => property.name === name);
        if (entry === undefined) throw new Error(`Dictionary has no key ${JSON.stringify(name)}.`);
        return entry.value;
      },
    ],
    [
      "dict.get(default:)",
      ([target, key, fallback]) => {
        const name = keyText(key);
        if (fallback === undefined || fallback === null)
          throw new Error("get() needs a default that is not null (#536).");
        const properties = dictEntries("get()", target);
        // The default has the dict's value type (#536).
        const kind = (value: RuntimeValue): string =>
          typeof value === "object" && value !== null ? value.kind : typeof value;
        if (
          properties.some(
            (property) => property.value !== null && kind(property.value) !== kind(fallback),
          )
        )
          throw new Error("get() needs a default of the dict's value type (#536).");
        const entry = properties.find((property) => property.name === name);
        return entry === undefined ? fallback : entry.value;
      },
    ],
    [
      "dict.set",
      ([target, key, value]) => {
        const name = keyText(key);
        const stored = value ?? null;
        const properties = dictEntries("[key] =", target);
        const replaced = properties.some((property) => property.name === name);
        return dictionary(
          replaced
            ? properties.map((property) =>
                property.name === name ? { name, value: stored } : property,
              )
            : [...properties, { name, value: stored }],
        );
      },
    ],
    [
      "dict.contains()",
      ([target, key]) =>
        dictEntries("contains()", target).some((property) => property.name === keyText(key)),
    ],
    [
      "dict.keys",
      ([target]) => items(dictEntries("keys", target).map((property) => property.name)),
    ],
    [
      "dict.values",
      ([target]) => items(dictEntries("values", target).map((property) => property.value)),
    ],
    ["dict.length", ([target]) => dictEntries("length", target).length],
    [
      "dict.remove()",
      ([target, key]) => {
        const name = keyText(key);
        const properties = dictEntries("remove()", target);
        if (!properties.some((property) => property.name === name))
          throw new Error(`Dictionary has no key ${JSON.stringify(name)}.`);
        return dictionary(properties.filter((property) => property.name !== name));
      },
    ],
    ["dict.clear()", ([target]) => (dictEntries("clear()", target), dictionary([]))],
    [
      "dict.literal",
      ([keys, values]) => {
        const properties: Array<{ name: string; value: RuntimeValue }> = [];
        const entryValues = listItems(values) ?? [];
        for (const [position, key] of (listItems(keys) ?? []).entries()) {
          const value = runtimeValue(entryValues[position]);
          const name = keyText(runtimeValue(key));
          // A repeated key keeps its first position and takes the later value, as in a Groovy map.
          const index = properties.findIndex((property) => property.name === name);
          if (index >= 0) properties[index] = { name, value };
          else properties.push({ name, value });
        }
        return dictionary(properties);
      },
    ],
    ["run", ([script]) => ((state.transfer = String(script)), null)],
    ["end", () => null],
    ["showPopup", () => null],
    ["askBoolean", () => next("askBoolean", [true, false])],
    ["askBooleans", (_, named) => named.defaults ?? emptyList],
    ["getTimestamp().toSeconds()", () => Math.floor((epochMs + state.clock.nowMs) / 1000)],
    ["getTimestamp().toMilliseconds()", () => epochMs + state.clock.nowMs],
    // A date from strict ISO text, or the date of a datetime (#532), with the fields the getDate() stand-in has.
    [
      "toDate",
      ([text]) => {
        const datetime =
          typeof text === "object" && text !== null ? entries("toDate()", text) : null;
        if (datetime !== null) {
          const value = {
            kind: "object",
            properties: datetime.filter((property) =>
              ["year", "month", "day", "weekday", "weekdayNumber"].includes(String(property.name)),
            ),
          };
          return value;
        }
        const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(typeof text === "string" ? text : "");
        if (match === null) throw new Error(`toDate() cannot convert ${JSON.stringify(text)}.`);
        const fields: Array<[string, RuntimeValue]> = [
          ["year", Number(match[1])],
          ["month", Number(match[2])],
          ["day", Number(match[3])],
        ];
        const value = {
          kind: "object",
          properties: fields.map(([name, item]) => ({ name, value: item })),
        };
        return value;
      },
    ],
    // Whole calendar days between two dates: `(left - right).days`.
    [
      "(date - date).days",
      ([left, right]) => {
        const day = (value: RuntimeValue | undefined): number => {
          const fields = new Map(
            entries("(date - date).days", value).map((property) => [property.name, property.value]),
          );
          return Date.UTC(
            Number(fields.get("year")),
            Number(fields.get("month")) - 1,
            Number(fields.get("day")),
          );
        };
        return Math.round((day(left) - day(right)) / 86_400_000);
      },
    ],
    ["getDate().toISO()", () => new Date(epochMs + state.clock.nowMs).toISOString().slice(0, 10)],
    // The player's local presentation; the stand-in uses the ISO form.
    [
      "getDate().formatDate()",
      () => new Date(epochMs + state.clock.nowMs).toISOString().slice(0, 10),
    ],
    [
      "getTime().formatTime()",
      () => new Date(epochMs + state.clock.nowMs).toISOString().slice(11, 16),
    ],
    [
      "getDateTime().formatDateTime()",
      () => new Date(epochMs + state.clock.nowMs).toISOString().slice(0, 16).replace("T", " "),
    ],
    ["getDateTime", () => date(true)],
    ["getDate", () => date(false)],
    ["openUrl", () => null],
    // A photo reference, then null as when the camera is unavailable or the player cancels.
    ["takePhoto", () => next("takePhoto", ["camera/photo.jpg", null])],
  ]);
  const result: Record<string, HostFunction> = {};
  for (const [shimName, operation] of shim.operations) {
    const implementation = implementations.get(operation);
    if (implementation !== undefined) result[shimName] = implementation;
  }
  return result;
}
