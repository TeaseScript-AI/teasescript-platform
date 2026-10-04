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
import { renameConflictingIdentifiers } from "./naming.ts";

/**
 * Accepted TeaseScript the importer emits although the current compiler does not implement it yet. The
 * feasibility report compiles a shimmed copy in which these become placeholder host calls, so a remaining
 * compiler error points at importer output rather than at a known TeaseScript implementation gap. Generated
 * packages never contain the shims.
 */
const PENDING_CALLS = new Map<string, string>([
  ["askBoolean", "askBoolean()"],
  ["askBooleans", "askBooleans()"],
  ["openUrl", "openUrl()"],
  ["takePhoto", "takePhoto()"],
]);

/** Calls that only a proposed language change defines, by the proposal (see proposals.ts). */
const PROPOSED_CALLS = new Map<string, ProposalId>([["countImages", "media-tags"]]);

const SHIM_PREFIX = "sxPending";

/** Capability of global functions and globals (#570), which `main` does not implement yet. */
const GLOBALS = "global function (#570)";

/** Whether a statement is a `global` or a `global function`. */
function isGlobalForm(statement: IrStatement): boolean {
  return (statement.kind === "let" || statement.kind === "function") && statement.global === true;
}

/** A `global` as a `let` and a `global function` as a function of the file. */
function withoutGlobalForm(statement: IrStatement): IrStatement {
  if (statement.kind !== "let" && statement.kind !== "function") return statement;
  if (statement.global !== true) return statement;
  const { global: _global, ...local } = statement;
  return local;
}

/** Capabilities of the file transfers of ADR 0022 (#570), which `main` does not implement yet. */
const GOTO_FILE = "goto to a file (#570)";
const GOTO_SCRIPT = "goto script() (#570)";

/**
 * Stand-ins whose accepted result is never null, by the conversion that gives the placeholder's untyped result that
 * type, so that the compiler checks and narrows its uses as it will the accepted operation's.
 */
const TYPED_RESULTS = new Map<string, "toInteger" | "toString" | "toBoolean">([
  ["askBoolean", "toBoolean"],
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

export function shimPendingCapabilities(
  generated: MigrationProgram,
  /** The package's helpers.tease, whose global functions and globals (#570) the file may use. */
  helpers: MigrationProgram | null = null,
): PendingShim {
  const builtins = new Set<string>();
  const capabilities = new Set<string>();
  // Until #570 lands, the file compiles with its own copy of the package's global functions and globals.
  const shared = (helpers?.statements ?? []).filter(
    (statement) =>
      (statement.kind === "function" || statement.kind === "let") && statement.global === true,
  );
  const fileNames = new Set<string>();
  collectNames(generated.statements, fileNames);
  // Only the global functions and globals the file reaches, also through each other, go into its copy.
  const needed = new Set<IrStatement>();
  for (let grown = generated !== helpers; grown;) {
    grown = false;
    for (const statement of shared) {
      if (needed.has(statement)) continue;
      if (
        (statement.kind === "function" || statement.kind === "let") &&
        fileNames.has(statement.name)
      ) {
        needed.add(statement);
        collectNames(statement, fileNames);
        grown = true;
      }
    }
  }
  const usesShared = needed.size > 0;
  if (usesShared || generated.statements.some(isGlobalForm)) capabilities.add(GLOBALS);
  const combined: MigrationProgram = {
    ...generated,
    statements: [
      ...shared.filter((statement) => needed.has(statement)),
      ...generated.statements,
    ].map(withoutGlobalForm),
  };
  // In the copy, a parameter or local of a global function may meet a top-level name of the file, which a global
  // function never sees; it gets another name there.
  const program = usesShared ? renameConflictingIdentifiers(combined, new Set(), false) : combined;
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
    // Operation names such as `media-tags.countImages` become identifier-safe shim names.
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
        return {
          ...value,
          properties: value.properties.map((property) => ({
            ...property,
            ...(property.key === undefined ? {} : { key: expression(property.key) }),
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
      // A transfer to another file (ADR 0022, #570) leaves the current file, so the shimmed copy stops there.
      case "goto":
        return [
          callStatement(
            item.target.kind === "file"
              ? call(GOTO_FILE, "goto", [{ kind: "literal", value: item.target.path }])
              : call(GOTO_SCRIPT, "goto script()", [expression(item.target.path)]),
            item.span,
          ),
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
 * Host stand-ins for the pending capabilities of a shimmed program, for smoke runs only: a transfer to another file
 * records its target in the flow state, and inputs answer in turn.
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
  const listItems = (value: RuntimeValue | undefined): unknown[] | null => {
    const object: unknown = value;
    return isRecord(object) && Array.isArray(object.items) ? object.items : null;
  };
  const implementations = new Map<string, HostFunction>([
    // Proposed media tags (M1): images counted by the folders they are in, compared without regard to case.
    [
      "media-tags.countImages",
      (_, named) => {
        const wanted = listItems(named.tags);
        if (wanted === null) throw new Error("countImages() needs a list of tags.");
        const tags = wanted.map((tag) => String(tag).toLowerCase());
        return media.filter((file) => tags.every((tag) => file.tags.includes(tag))).length;
      },
    ],
    ["goto", ([script]) => ((state.transfer = String(script)), null)],
    ["goto script()", ([script]) => ((state.transfer = String(script)), null)],
    ["showPopup", () => null],
    ["askBoolean", () => next("askBoolean", [true, false])],
    ["askBooleans", (_, named) => named.defaults ?? emptyList],
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
