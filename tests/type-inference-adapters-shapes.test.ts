import assert from "node:assert/strict";
import test from "node:test";

import {
  INTEGER_TYPE,
  joinTypes,
  NULL_TYPE,
  NUMBER_TYPE,
  optional,
  STRING_TYPE,
  union,
  type StaticType,
} from "../src/static-types.js";
import { typeKey } from "../src/storage-types.js";
import { operationRelations } from "../src/type-inference/adapters/index.js";
import type { OperandView, OperationRelation } from "../src/type-inference/adapters/relation.js";
import { viewMembers } from "../src/type-inference/adapters/views.js";
import type { ContractFamily } from "../src/type-inference/graph.js";
import {
  assertCase,
  BOTTOM_VIEW,
  closedView,
  dynamicView,
  inputsOf,
  isClosedFact,
  legacyOperation,
} from "./helpers/adapter-parity.js";

/**
 * The input-shape tables of the three relations the PR review rounds found siblings in (work note §6.3, the
 * orchestrator's decision of 2026-10-18): the set operations with the dict gate, the weighted source, and the
 * `min`/`max` dispatch. Each relation is run over the product of its operands' shapes (a closed kind, a nullable, null
 * alone, a union of collections of one kind, an empty collection, a value the compiler cannot know, one that may
 * also be such a value, and bottom) and its call shapes (as written, an extra positional argument, an extra named
 * argument, a named-only argument). A shape the source can write is pinned by the oracle: a closed fact is realized,
 * an unknown one answered by an answer that realizes to unknown. A bottom operand follows the carrier's read-order
 * rule (work note §3, the orchestrator's decision of 2026-10-18): the relation waits for it where the legacy's
 * branch reads the operand's type before deciding, and waiting longer than strictly necessary is the safe
 * direction. The table checks the unsafe direction: where the same inputs with the operand of several kinds give
 * different answers, the relation must wait; where they agree, the common answer or a wait is accepted.
 */
interface Shape {
  readonly label: string;
  /** The statements that declare `<name>`, with `$` for the name, or `null` when no source writes the shape. */
  readonly declare: string | null;
  readonly view: OperandView;
}

const list = (element: StaticType): StaticType => ({ kind: "list", element });
const set = (element: StaticType): StaticType => ({ kind: "set", element });
const dict = (element: StaticType): StaticType => ({ kind: "dict", element });

function shape(label: string, declare: string | null, type: StaticType): Shape {
  return { label, declare, view: closedView(type) };
}

const BOTTOM: Shape = { label: "bottom", declare: null, view: BOTTOM_VIEW };
const HOST: Shape = { label: "host", declare: "let $ = hostValue", view: dynamicView("host") };
const REMAINDER: Shape = {
  label: "remainder",
  declare: null,
  view: dynamicView("host", [list(INTEGER_TYPE)]),
};

const COLLECTION_ARGUMENTS: readonly Shape[] = [
  shape("integers", "let $: integer[] = hostValue", list(INTEGER_TYPE)),
  shape("numbers", "let $: number[] = hostValue", list(NUMBER_TYPE)),
  shape("texts", "let $: string[] = hostValue", list(STRING_TYPE)),
  shape("text set", "let $: string set = hostValue", set(STRING_TYPE)),
  shape(
    "list or set",
    "let $: integer[] | string set = hostValue",
    union([list(INTEGER_TYPE), set(STRING_TYPE)]),
  ),
  shape("nullable list", "let $: integer[]? = hostValue", optional(list(INTEGER_TYPE))),
  shape("nullable number", "let $: integer? = hostValue", optional(INTEGER_TYPE)),
  shape("null", "let $ = null", NULL_TYPE),
  shape("empty", "let $ = []", list({ kind: "never" })),
  shape("text", "let $: string = hostValue", STRING_TYPE),
  HOST,
  REMAINDER,
  BOTTOM,
];

const COLLECTION_RECEIVERS: readonly Shape[] = [
  shape("integers", "let $: integer[] = hostValue", list(INTEGER_TYPE)),
  shape("integer set", "let $: integer set = hostValue", set(INTEGER_TYPE)),
  shape(
    "two lists",
    "let $: integer[] | string[] = hostValue",
    union([list(INTEGER_TYPE), list(STRING_TYPE)]),
  ),
  shape("empty", "let $ = []", list({ kind: "never" })),
  shape("unknown elements", "let $: list = hostValue", list({ kind: "unknown" })),
  shape("unknown set elements", "let $: set = hostValue", set({ kind: "unknown" })),
  shape("nullable list", "let $: integer[]? = hostValue", optional(list(INTEGER_TYPE))),
  shape(
    "list or dict",
    "let $: integer[] | integer dict = hostValue",
    union([list(INTEGER_TYPE), dict(INTEGER_TYPE)]),
  ),
  shape(
    "list or text",
    "let $: integer[] | string = hostValue",
    union([list(INTEGER_TYPE), STRING_TYPE]),
  ),
  HOST,
  REMAINDER,
];

/** The call shapes: the first argument as written, with an extra positional or named argument, or named only. */
const CALLS: readonly {
  readonly label: string;
  readonly write: (a: string) => string;
  readonly extra: "positional" | "named" | "named only" | null;
}[] = [
  { label: "plain", write: (a) => `(${a})`, extra: null },
  { label: "extra positional", write: (a) => `(${a}, 1)`, extra: "positional" },
  { label: "extra named", write: (a) => `(${a}, extra: 1)`, extra: "named" },
  { label: "named only", write: (a) => `(extra: ${a})`, extra: "named only" },
];

function relationOf(family: ContractFamily, name: string) {
  const relation = operationRelations().relation({ family, name });
  assert.ok(relation !== undefined, `a relation for ${family}.${name}`);
  return relation;
}

const INTEGER = closedView(INTEGER_TYPE);
const PROBES: readonly OperandView[] = [
  INTEGER,
  closedView(list(INTEGER_TYPE)),
  closedView(list({ kind: "never" })),
  closedView(optional(list(INTEGER_TYPE))),
  closedView(STRING_TYPE),
  closedView(NULL_TYPE),
  dynamicView("host"),
];

/**
 * The unsafe direction of the read-order rule: a relation must not answer at bottom what the operand, once known,
 * could change. The slot is probed with several kinds; different answers demand a wait, one answer accepts it or a
 * wait (a finite set of probes cannot establish independence: `min(⊥, extra: 1 s)` is a duration for a duration).
 */
function assertBottomRule(
  relation: OperationRelation,
  build: (view: OperandView) => ReturnType<typeof inputsOf>,
  label: string,
): void {
  const answers = PROBES.map((probe) => JSON.stringify(relation.result(build(probe))));
  const atBottom = relation.result(build(BOTTOM_VIEW));
  if (answers.every((answer) => answer === answers[0]))
    assert.ok(
      atBottom.kind === "unconstrained" || JSON.stringify(atBottom) === answers[0],
      `${label}: at bottom, the answer every kind gives, or a wait`,
    );
  else assert.equal(atBottom.kind, "unconstrained", `${label}: the operand decides the answer`);
}

/** The oracle's pin of a source: the fact realized when closed, an answer that realizes to unknown otherwise. */
function assertOracle(
  relation: OperationRelation,
  inputs: ReturnType<typeof inputsOf>,
  source: string,
  label: string,
): void {
  const outcome = legacyOperation(source);
  assert.notEqual(outcome.type, null, `${label}: the legacy typed the operation`);
  const fact = outcome.type!;
  // A fact with an open slot (an element nothing was stored into, copied) is the solver's case, not a relation's.
  if (fact !== "unknown" && !isClosedFact(fact)) return;
  // Q3.7's scope (work note §3.8): a collection whose elements mix is built from both operands' elements, the
  // report (TSV044, or an arity or name report that pre-empts it) staying at the construction; the legacy recovered
  // unknown elements. The rows that mix are the relation's own condition read from the inputs: the first written
  // argument is collections only (no null, no other kind), no element is unknown, and the elements of some receiver
  // member do not join with the argument's; the declared realization is the join over all those elements.
  const mixed = /^(list|set)<unknown>$/.exec(fact);
  const first = inputs.arguments[0] ?? inputs.named.values().next().value;
  const elementsOf = (view: OperandView | null | undefined): StaticType[] | null => {
    if (view === null || view === undefined || view.alternatives === null || view.dynamic !== null)
      return null;
    const members = viewMembers(view);
    const collections = members.filter((m) => m.kind === "list" || m.kind === "set");
    if (collections.length === 0 || collections.length < members.length) return null;
    return collections.flatMap((m) => (m.kind === "list" || m.kind === "set" ? [m.element] : []));
  };
  const owns = elementsOf(inputs.receiver) ?? [];
  const others = elementsOf(first);
  const known = (elements: readonly StaticType[]): boolean =>
    elements.every((e) => e.kind !== "unknown");
  const mixes =
    mixed !== null &&
    others !== null &&
    known(owns) &&
    known(others) &&
    owns.some((own) => {
      const parts = [own, ...others].filter((e) => e.kind !== "never");
      return parts.length > 0 && joinTypes(parts) === undefined;
    });
  // A join answer (a new collection over the receiver's elements, or over both operands' for `union`, parts shared)
  // realizes as one collection over the union of those elements, where the legacy echoed one per receiver member.
  const receiverKind = viewMembers(
    inputs.receiver ?? { alternatives: null, dynamic: null, known: undefined },
  )
    .map((m) => m.kind)
    .find((k) => k === "list" || k === "set");
  const joined =
    receiverKind === undefined || owns.length === 0
      ? null
      : [...owns, ...(relation.contract.name === "union" ? (others ?? []) : [])].filter(
          (e) => e.kind !== "never",
        );
  const joinText =
    joined === null || joined.length === 0
      ? null
      : `${receiverKind}<${typeKey(union(joined), true, true)}>`;
  const answer = relation.result(inputs);
  const decided = mixes
    ? {
        realized: `${mixed![1]}<${typeKey(union([...owns, ...others!].filter((e) => e.kind !== "never")), true, true)}>`,
      }
    : answer.kind === "join" &&
        (others !== null || relation.contract.name !== "union") &&
        joinText !== null &&
        joinText !== fact
      ? { realized: joinText }
      : null;
  try {
    assertCase(
      relation,
      inputs,
      outcome,
      { fact, errors: outcome.errorsAtOperation, elsewhere: outcome.errorsElsewhere },
      decided ?? (fact === "unknown" ? "unknown" : "fact"),
    );
  } catch (error) {
    throw new Error(
      `${label}\n${source}\n${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

test("the set operations over every receiver, argument and call shape", () => {
  for (const name of ["union", "intersection", "difference"]) {
    const relation = relationOf("method", name);
    for (const receiver of COLLECTION_RECEIVERS)
      for (const argument of COLLECTION_ARGUMENTS)
        for (const call of CALLS) {
          const label = `${name} on ${receiver.label} with ${argument.label}, ${call.label}`;
          const build = (view: OperandView) =>
            inputsOf({
              receiver: receiver.view,
              arguments:
                call.extra === "named only"
                  ? []
                  : call.extra === "positional"
                    ? [view, INTEGER]
                    : [view],
              named:
                call.extra === "named"
                  ? { extra: INTEGER }
                  : call.extra === "named only"
                    ? { extra: view }
                    : {},
            });
          if (argument === BOTTOM) {
            assertBottomRule(relation, build, label);
            continue;
          }
          if (argument.declare === null || receiver.declare === null) {
            // A shape no source writes: the answer is the relation's own (asserted by its direct tests).
            relation.result(build(argument.view));
            continue;
          }
          const source = `${receiver.declare.replaceAll("$", "xs")}\n${argument.declare.replaceAll("$", "a")}\nlet r = xs.${name}${call.write("a")}\nexit`;
          assertOracle(relation, build(argument.view), source, label);
        }
  }
});

const DICT_RECEIVERS: readonly Shape[] = [
  shape("integer dict", "let $: integer dict = hostValue", dict(INTEGER_TYPE)),
  shape(
    "dict or list",
    "let $: integer dict | integer[] = hostValue",
    union([dict(INTEGER_TYPE), list(INTEGER_TYPE)]),
  ),
  shape("nullable dict", "let $: integer dict? = hostValue", optional(dict(INTEGER_TYPE))),
];

test("the dict methods' shape gate over a dict alone, a dict beside a list, and a dict that may be null", () => {
  const calls: readonly {
    readonly method: string;
    readonly write: string;
    readonly arguments: OperandView[];
    readonly named: Record<string, OperandView>;
  }[] = [
    { method: "remove", write: '("k")', arguments: [closedView(STRING_TYPE)], named: {} },
    { method: "remove", write: "()", arguments: [], named: {} },
    {
      method: "remove",
      write: '("k", 1)',
      arguments: [closedView(STRING_TYPE), INTEGER],
      named: {},
    },
    {
      method: "remove",
      write: '("k", extra: 1)',
      arguments: [closedView(STRING_TYPE)],
      named: { extra: INTEGER },
    },
    { method: "clear", write: "()", arguments: [], named: {} },
    { method: "clear", write: "(1)", arguments: [INTEGER], named: {} },
    { method: "contains", write: '("k")', arguments: [closedView(STRING_TYPE)], named: {} },
    {
      method: "get",
      write: '("k", default: 1)',
      arguments: [closedView(STRING_TYPE)],
      named: { default: INTEGER },
    },
    { method: "get", write: '("k")', arguments: [closedView(STRING_TYPE)], named: {} },
    { method: "get", write: "(default: 1)", arguments: [], named: { default: INTEGER } },
    {
      method: "get",
      write: '("k", default: 1, extra: 2)',
      arguments: [closedView(STRING_TYPE)],
      named: { default: INTEGER, extra: INTEGER },
    },
  ];
  for (const receiver of DICT_RECEIVERS)
    for (const call of calls) {
      const relation = relationOf("method", call.method);
      const inputs = inputsOf({
        receiver: receiver.view,
        arguments: call.arguments,
        named: call.named,
      });
      const source = `${receiver.declare!.replaceAll("$", "d")}\nlet r = d.${call.method}${call.write}\nexit`;
      assertOracle(relation, inputs, source, `${call.method}${call.write} on ${receiver.label}`);
    }
});

const WEIGHTED_SOURCES: readonly Shape[] = [
  shape("integer dict", "let $: integer dict = hostValue", dict(INTEGER_TYPE)),
  shape(
    "two dicts",
    "let $: integer dict | number dict = hostValue",
    union([dict(INTEGER_TYPE), dict(NUMBER_TYPE)]),
  ),
  shape(
    "text dict or integer dict",
    "let $: integer dict | string dict = hostValue",
    union([dict(INTEGER_TYPE), dict(STRING_TYPE)]),
  ),
  shape(
    "dict or list",
    "let $: integer dict | integer[] = hostValue",
    union([dict(INTEGER_TYPE), list(INTEGER_TYPE)]),
  ),
  shape("objects", "let $: object[] = hostValue", list({ kind: "object", properties: null })),
  shape(
    "nullable objects",
    "let $: object[]? = hostValue",
    optional(list({ kind: "object", properties: null })),
  ),
  shape(
    "two lists",
    "let $: integer[] | string[] = hostValue",
    union([list(INTEGER_TYPE), list(STRING_TYPE)]),
  ),
  shape("nullable dict", "let $: integer dict? = hostValue", optional(dict(INTEGER_TYPE))),
  shape("null", "let $ = null", NULL_TYPE),
  shape("text", "let $: string = hostValue", STRING_TYPE),
  shape("empty", "let $ = []", list({ kind: "never" })),
  HOST,
  { label: "remainder", declare: null, view: dynamicView("host", [dict(INTEGER_TYPE)]) },
  BOTTOM,
];

test("randomWeighted over every source and call shape", () => {
  const relation = relationOf("random", "randomWeighted");
  const calls: readonly {
    readonly label: string;
    readonly write: string;
    readonly named: Record<string, OperandView>;
    readonly extra: boolean;
  }[] = [
    { label: "plain", write: "(a)", named: {}, extra: false },
    {
      label: "weight",
      write: '(a, weight: "w")',
      named: { weight: closedView(STRING_TYPE) },
      extra: false,
    },
    { label: "extra named", write: "(a, extra: 1)", named: { extra: INTEGER }, extra: false },
    { label: "extra positional", write: "(a, 1)", named: {}, extra: true },
    { label: "named only", write: "(weight: a)", named: {}, extra: false },
  ];
  for (const source of WEIGHTED_SOURCES)
    for (const call of calls) {
      const label = `randomWeighted${call.write} of ${source.label}`;
      const build = (view: OperandView) =>
        call.label === "named only"
          ? inputsOf({ arguments: [], named: { weight: view } })
          : inputsOf({ arguments: call.extra ? [view, INTEGER] : [view], named: call.named });
      if (source === BOTTOM) {
        assertBottomRule(relation, build, label);
        continue;
      }
      if (source.declare === null) {
        relation.result(build(source.view));
        continue;
      }
      assertOracle(
        relation,
        build(source.view),
        `${source.declare.replaceAll("$", "a")}\nlet r = randomWeighted${call.write}\nexit`,
        label,
      );
    }
});

const SINGLE_VALUES: readonly Shape[] = [
  shape("integer", "let $: integer = hostValue", INTEGER_TYPE),
  shape("integers", "let $: integer[] = hostValue", list(INTEGER_TYPE)),
  shape(
    "integer or list",
    "let $: integer | integer[] = hostValue",
    union([INTEGER_TYPE, list(INTEGER_TYPE)]),
  ),
  shape("nullable integer", "let $: integer? = hostValue", optional(INTEGER_TYPE)),
  shape("nullable list", "let $: integer[]? = hostValue", optional(list(INTEGER_TYPE))),
  shape("null", "let $ = null", NULL_TYPE),
  shape("text", "let $: string = hostValue", STRING_TYPE),
  HOST,
  REMAINDER,
  BOTTOM,
];

test("min and max of one value over every shape: the list form, the value form, or a wait", () => {
  for (const name of ["min", "max"]) {
    const relation = relationOf("listFunction", name);
    const calls: readonly {
      readonly label: string;
      readonly write: string;
      readonly positional: readonly OperandView[];
      readonly named: Record<string, OperandView>;
      readonly only?: "named";
    }[] = [
      { label: "plain", write: "(a)", positional: [], named: {} },
      { label: "extra named", write: "(a, extra: 1)", positional: [], named: { extra: INTEGER } },
      {
        label: "extra text",
        write: '(a, extra: "x")',
        positional: [],
        named: { extra: closedView(STRING_TYPE) },
      },
      {
        label: "extra duration",
        write: "(a, extra: 1 s)",
        positional: [],
        named: { extra: closedView({ kind: "scalar", name: "duration" }) },
      },
      {
        label: "by",
        write: '(a, by: "p")',
        positional: [],
        named: { by: closedView(STRING_TYPE) },
      },
      { label: "extra positional", write: "(a, 1)", positional: [INTEGER], named: {} },
      { label: "named only", write: "(extra: a)", positional: [], named: {}, only: "named" },
    ];
    for (const value of SINGLE_VALUES)
      for (const call of calls) {
        const label = `${name}${call.write} of ${value.label}`;
        const build = (view: OperandView) =>
          call.only === "named"
            ? inputsOf({ arguments: [], named: { extra: view } })
            : inputsOf({ arguments: [view, ...call.positional], named: call.named });
        if (value === BOTTOM) {
          assertBottomRule(relation, build, label);
          continue;
        }
        if (value.declare === null) {
          relation.result(build(value.view));
          continue;
        }
        assertOracle(
          relation,
          build(value.view),
          `${value.declare.replaceAll("$", "a")}\nlet r = ${name}${call.write}\nexit`,
          label,
        );
      }
  }
});
