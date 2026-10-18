import assert from "node:assert/strict";

import type { Block, Expression, LetStatement, Statement } from "../../src/ast.js";
import {
  INTEGER_TYPE,
  joinTypes,
  members,
  resolved,
  STRING_TYPE,
  union,
  UNKNOWN_TYPE,
  type StaticType,
} from "../../src/static-types.js";
import { typeKey } from "../../src/storage-types.js";
import type {
  DynamicWhy,
  PlaceId,
  ProjectionStep,
  SyntaxEvidence,
} from "../../src/type-inference/graph.js";
import type { TypeAnalysisRequest } from "../../src/type-inference/backend.js";
import { analyzeTypes } from "../../src/type-inference/index.js";
import type {
  OperandPath,
  OperandRef,
  OperandView,
  OperationInputs,
  OperationRelation,
  OperationResult,
} from "../../src/type-inference/adapters/relation.js";
import { restrictedTo } from "../../src/type-inference/adapters/views.js";
import { request } from "./type-inference-graph.js";

/**
 * Parity of a contract adapter with the legacy checker (O4 stage 2b, work note §6.1). A case declares both what the
 * legacy does, the operation's own fact and the errors at it, and what the adapter answers; the helper asserts both,
 * so that a case pins the oracle it is compared with and never infers the adapter's class from the fact.
 */
const PARITY_GLOBALS: readonly string[] = [
  "hostValue",
  "hostFlag",
  "hostText",
  "hostList",
  "hostDict",
];

export interface LegacyOutcome {
  /** The request the check was made of, for collecting its graph. */
  readonly request: TypeAnalysisRequest;
  /** The expression the binding holds, as written. */
  readonly node: Expression;
  /** The fact's type text, or `null` when the check typed no such node. */
  readonly type: string | null;
  /** The error codes reported inside the operation's span, and those reported anywhere else. */
  readonly errorsAtOperation: readonly string[];
  readonly errorsElsewhere: readonly string[];
  /** The errors inside the operation's span with their offsets, for telling an operand's own errors apart. */
  readonly errorSpans: readonly { readonly code: string; readonly start: number; readonly end: number }[];
  /** The type text of a top-level binding of the source, for asserting an operand's closed type. */
  bindingType(name: string): string | undefined;
  /** The type texts the check gave the expressions at a site: one for a typed site, none for an untyped one. */
  factsAt(site: { readonly start: number; readonly end: number }): readonly string[];
}

/** The first `let <name>` of the statements, looking into function bodies and blocks too. */
function findLet(statements: readonly Statement[], name: string): LetStatement | undefined {
  for (const statement of statements) {
    if (statement.kind === "letStatement" && statement.name.name === name) return statement;
    for (const part of Object.values(statement)) {
      const blocks: Block[] = Array.isArray(part)
        ? part.filter((item): item is Block => isBlock(item))
        : isBlock(part)
          ? [part]
          : [];
      for (const block of blocks) {
        const found = findLet(block.statements, name);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

function isBlock(value: unknown): value is Block {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "block" &&
    "statements" in value &&
    Array.isArray(value.statements)
  );
}

/** The legacy check of `source`, read at the initializer of the top-level `let <binding>`. */
export function legacyOperation(
  source: string,
  options: {
    readonly binding?: string;
    readonly globals?: readonly string[];
    readonly builtins?: readonly string[];
  } = {},
): LegacyOutcome {
  const binding = options.binding ?? "r";
  const made = request(
    [{ path: "main.tease", source }],
    options.globals ?? PARITY_GLOBALS,
    options.builtins ?? [],
  );
  assert.notEqual(made, null, `the source parses and its names resolve:\n${source}`);
  const statement = findLet(made!.files[0]!.program.statements, binding);
  assert.ok(statement !== undefined, `a let ${binding}`);
  const node = statement.initializer;
  const outcome = analyzeTypes(made!);
  const facts = outcome.facts();
  const start = node.span.start.offset;
  const end = node.span.end.offset;
  const fact = facts.values.find(
    (value) =>
      value.site.file === 0 &&
      value.site.start === start &&
      value.site.end === end &&
      value.kind === node.kind,
  );
  const errors = outcome.checked.diagnostics
    .flat()
    .filter((diagnostic) => diagnostic.severity === "error");
  const inside = (span: {
    readonly start: { readonly offset: number };
    readonly end: { readonly offset: number };
  }) => span.start.offset >= start && span.end.offset <= end;
  return {
    request: made!,
    node,
    type: fact?.type ?? null,
    errorsAtOperation: errors.filter((error) => inside(error.span)).map((error) => error.code),
    errorSpans: errors
      .filter((error) => inside(error.span))
      .map((error) => ({
        code: error.code,
        start: error.span.start.offset,
        end: error.span.end.offset,
      })),
    errorsElsewhere: errors.filter((error) => !inside(error.span)).map((error) => error.code),
    bindingType: (name) => facts.bindings.find((entry) => entry.name === name)?.type,
    factsAt: (site) => [
      ...new Set(
        facts.values
          .filter(
            (value) =>
              value.site.file === 0 && value.site.start === site.start && value.site.end === site.end,
          )
          .map((value) => value.type),
      ),
    ],
  };
}

/** A closed view: the alternatives of a type, nothing dynamic, no known value. */
export function closedView(type: StaticType): OperandView {
  return { alternatives: members(type), dynamic: null, known: undefined };
}

export function dynamicView(
  why: DynamicWhy,
  alternatives: readonly StaticType[] = [],
): OperandView {
  return {
    alternatives: alternatives.length === 0 ? null : alternatives,
    dynamic: why,
    known: undefined,
  };
}

export const BOTTOM_VIEW: OperandView = Object.freeze({
  alternatives: null,
  dynamic: null,
  known: undefined,
});

export function inputsOf(parts: {
  readonly receiver?: OperandView;
  readonly arguments?: readonly OperandView[];
  readonly named?: Readonly<Record<string, OperandView>>;
  readonly evidence?: SyntaxEvidence;
  readonly places?: ReadonlyMap<PlaceId, OperandView>;
}): OperationInputs {
  return {
    receiver: parts.receiver ?? null,
    arguments: parts.arguments ?? [],
    named: new Map(Object.entries(parts.named ?? {})),
    evidence: parts.evidence,
    view: (place) => {
      const found = parts.places?.get(place);
      assert.ok(found !== undefined, `a view of place ${place}`);
      return found;
    },
  };
}

/** A symbolic result realized on closed inputs: a closed type, or no value. */
type Realized =
  | { readonly kind: "type"; readonly type: StaticType }
  | { readonly kind: "invalid" }
  | { readonly kind: "unconstrained" };

function operandOf(inputs: OperationInputs, ref: OperandRef): OperandView {
  if ("receiver" in ref) {
    assert.ok(inputs.receiver !== null, "a receiver");
    return inputs.receiver;
  }
  if ("argument" in ref) {
    const view = inputs.arguments[ref.argument];
    assert.ok(view !== undefined, `argument ${ref.argument}`);
    return view;
  }
  const view = inputs.named.get(ref.named);
  assert.ok(view !== undefined, `named argument ${ref.named}`);
  return view;
}

/** One step of a path on a closed type, as the solver would take it. */
function step(type: StaticType, along: ProjectionStep): StaticType {
  const parts = members(type).map((member) => {
    const value = resolved(member);
    if (typeof along === "object")
      return value.kind === "object"
        ? (value.properties?.get(along.property) ?? UNKNOWN_TYPE)
        : UNKNOWN_TYPE;
    switch (along) {
      case "element":
      case "entry":
      case "index":
        return value.kind === "list" || value.kind === "set" || value.kind === "dict"
          ? value.element
          : UNKNOWN_TYPE;
      case "iteration":
        if (value.kind === "dict") return STRING_TYPE;
        if (value.kind === "range") return INTEGER_TYPE;
        return value.kind === "list" || value.kind === "set" ? value.element : UNKNOWN_TYPE;
    }
  });
  return parts.length === 1 ? parts[0]! : union(parts);
}

function pathType(inputs: OperationInputs, path: OperandPath): StaticType {
  const view = operandOf(inputs, path.of);
  let type: StaticType = view.alternatives === null ? UNKNOWN_TYPE : union(view.alternatives);
  for (const along of path.path) type = step(type, along);
  return type;
}

/** The closed type a result stands for on these inputs. */
function realize(result: OperationResult, inputs: OperationInputs): Realized {
  switch (result.kind) {
    case "type":
      return { kind: "type", type: result.type };
    case "possible":
      return { kind: "type", type: union(result.types) };
    case "projection":
      return { kind: "type", type: pathType(inputs, result.source) };
    case "join": {
      // The parts' types join as the elements of a literal do (numeric promotion); parts that mix give no value.
      const element = joinTypes(result.parts.map((part) => pathType(inputs, part)));
      return element === undefined
        ? { kind: "invalid" }
        : { kind: "type", type: { kind: result.constructor, element } };
    }
    case "dynamic":
      return { kind: "type", type: UNKNOWN_TYPE };
    case "unconstrained":
    case "invalid":
      return { kind: result.kind };
    case "alternatives": {
      const types = result.results.flatMap((inner) => {
        const realized = realize(inner, inputs);
        return realized.kind === "type" ? [realized.type] : [];
      });
      return types.length === 0 ? { kind: "invalid" } : { kind: "type", type: union(types) };
    }
    case "byReceiver": {
      assert.ok(inputs.receiver !== null, "a receiver for the cases");
      const types = result.cases.flatMap((entry) => {
        const restricted: OperationInputs = {
          ...inputs,
          receiver: restrictedTo(inputs.receiver!, entry.receiver),
          view: inputs.view,
        };
        const realized = realize(entry.result, restricted);
        return realized.kind === "type" ? [realized.type] : [];
      });
      return types.length === 0 ? { kind: "invalid" } : { kind: "type", type: union(types) };
    }
  }
}

/** The text of a realized type as the facts render one. */
function realizedText(realized: Realized): string {
  return realized.kind === "type" ? typeKey(realized.type, true, true) : realized.kind;
}

/** What the legacy does at the operation, as the case declares it. */
export interface LegacyExpectation {
  /** The operation's own fact text; `"unknown"` for the legacy's unknown. */
  readonly fact: string;
  /** The error codes reported inside the operation, in order; none by default. */
  readonly errors?: readonly string[];
  /** Error codes reported elsewhere in the source that the case accepts. */
  readonly elsewhere?: readonly string[];
}

/** What the adapter answers, as the case declares it (work note §6.1). */
export type AdapterExpectation =
  /** The realized result renders as the legacy's fact. */
  | "fact"
  | "invalid"
  | "unconstrained"
  | { readonly dynamic: DynamicWhy }
  /** The exact possibilities, in the order the relation gives them. */
  | { readonly possible: readonly StaticType[] }
  /** A declared recovery: the realized text the adapter's answer gives, where the legacy recovered otherwise. */
  | { readonly realized: string };

/** Whether a fact text is a closed type: no open slot, held-unknown or open-shape marker. */
export function isClosedFact(fact: string): boolean {
  return !/[?!+]/.test(fact.replaceAll('"', ""));
}

/**
 * Asserts a declared case: the legacy's fact and errors are what the case says (so the oracle is pinned), and the
 * adapter's answer is what the case says, by tag and by realization. A fact that is not closed is refused unless
 * the case declares the adapter's answer by `realized` text.
 */
export function assertCase(
  relation: OperationRelation,
  inputs: OperationInputs,
  outcome: LegacyOutcome,
  legacy: LegacyExpectation,
  adapter: AdapterExpectation,
  tag?: OperationResult["kind"],
): OperationResult {
  assert.equal(outcome.type, legacy.fact, "the legacy fact the case declares");
  assert.deepEqual(outcome.errorsAtOperation, legacy.errors ?? [], "the errors at the operation");
  assert.deepEqual(outcome.errorsElsewhere, legacy.elsewhere ?? [], "the errors elsewhere");
  const result = relation.result(inputs);
  if (tag !== undefined) assert.equal(result.kind, tag, "the result's kind");
  const realized = realize(result, inputs);
  if (adapter === "fact") {
    assert.ok(
      isClosedFact(legacy.fact) && legacy.fact !== "unknown",
      `a closed fact to compare with: ${legacy.fact}`,
    );
    assert.equal(realizedText(realized), legacy.fact, "the realized result is the legacy's type");
  } else if (adapter === "invalid" || adapter === "unconstrained") {
    assert.equal(result.kind, adapter, `the adapter answers ${adapter}`);
  } else if ("dynamic" in adapter) {
    assert.deepEqual(result, { kind: "dynamic", why: adapter.dynamic }, "the dynamic result");
  } else if ("possible" in adapter) {
    assert.equal(result.kind, "possible", "a possible result");
    if (result.kind === "possible")
      assert.deepEqual(
        result.types.map((type) => typeKey(type, true, true)),
        adapter.possible.map((type) => typeKey(type, true, true)),
        "the possibilities",
      );
  } else {
    assert.equal(realizedText(realized), adapter.realized, "the declared realization");
  }
  return result;
}

/** The common case: the legacy gives a closed fact without an error and the adapter realizes it. */
export function assertEqualResult(
  relation: OperationRelation,
  inputs: OperationInputs,
  outcome: LegacyOutcome,
  tag?: OperationResult["kind"],
): OperationResult {
  assert.notEqual(outcome.type, null, "the legacy check typed the operation");
  return assertCase(relation, inputs, outcome, { fact: outcome.type! }, "fact", tag);
}
