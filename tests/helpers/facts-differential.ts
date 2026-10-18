import type { ScalarTypeName } from "../../src/ast.js";
import {
  NULL_TYPE,
  PropertyTable,
  union,
  UNKNOWN_TYPE,
  type ScalarValue,
  type StaticType,
} from "../../src/static-types.js";
import { typeKey } from "../../src/storage-types.js";
import { memberOf, operationRelations } from "../../src/type-inference/adapters/index.js";
import type {
  OperandRef,
  OperandView,
  OperationInputs,
  OperationResult,
} from "../../src/type-inference/adapters/relation.js";
import type { FactSite, SolvedTypeFacts, TypeText } from "../../src/type-inference/backend.js";
import { collectGraph } from "../../src/type-inference/collector.js";
import type {
  Constraint,
  ConstraintGraph,
  Place,
  PlaceId,
} from "../../src/type-inference/graph.js";
import { analyzeTypes } from "../../src/type-inference/index.js";
import { exportFacts } from "../../src/type-inference/solver/export.js";
import { solve } from "../../src/type-inference/solver/solve.js";
import type { ValueKind } from "../../src/value-kinds.js";
import { request } from "./type-inference-graph.js";

/**
 * The facts differential (O4 stage 3a, work note §7): a source is collected, solved and exported, and its facts are
 * compared with the legacy's site by site. Every difference is classified; an unclassified one is a defect (class 4).
 * Class 1, a decided rule, and class 2, the legacy's replaced undecided-slot mechanism, both require the fact the
 * decided rules derive from inputs the solver does not touch: the classifier's own oracle (below) reads the graph and
 * the legacy's facts of the stored values, applies the decided rules, and the candidate's fact must be the rule's.
 * Class 2 needs the legacy's open-slot form beside that (`?`, `?null`, or a held mark on a member, which `typeKey`
 * writes only for an open slot of the legacy's final checker). Class 3 names the stage-3 PR that solves the
 * construct: in 3a every source with control flow, functions, loops, handlers, storage or speakers, every source
 * where a copied value is changed in place (the copy's content at its point, Q3a), and every value and function
 * fact. One normalization applies to both sides: a union's members are a set, so equal object members collapse.
 */

export type DifferenceClass = 1 | 2 | 3 | 4;

export interface Difference {
  readonly what: "binding" | "value" | "function" | "read";
  readonly site: FactSite;
  readonly name: string;
  readonly legacy: TypeText | null;
  readonly candidate: TypeText | null;
  readonly class: DifferenceClass;
  readonly evidence: string;
}

export interface Differential {
  /** No control flow, functions, loops, handlers, storage or speakers: the sources 3a classifies in full. */
  readonly straightLine: boolean;
  readonly compared: number;
  readonly differences: readonly Difference[];
  readonly legacy: SolvedTypeFacts;
  readonly candidate: SolvedTypeFacts;
}

const GLOBALS = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];
const RELATIONS = operationRelations();

const siteKey = (site: FactSite): string => `${site.file}:${site.start}:${site.end}`;

/** Collects, solves, exports and compares one source; `null` when it does not parse or resolve. */
export function differential(
  source: string,
  mutate: (facts: SolvedTypeFacts) => SolvedTypeFacts = (facts) => facts,
): Differential | null {
  const made = request([{ path: "main.tease", source }], GLOBALS, []);
  if (made === null) return null;
  const legacy = analyzeTypes(made).facts();
  const graph = collectGraph(made);
  const candidate = mutate(exportFacts(solve(graph, { relations: RELATIONS })));
  const straightLine = isStraightLine(graph);
  const copiedAndMutated = isCopiedAndMutated(graph);
  const differences: Difference[] = [];
  let compared = 0;
  const compare = <T extends { readonly site: FactSite; readonly type: TypeText }>(
    what: Difference["what"],
    left: readonly T[],
    right: readonly T[],
    nameOf: (fact: T) => string,
    classify: (
      fact: T | undefined,
      legacyText: TypeText | null,
      candidateText: TypeText | null,
    ) => Pick<Difference, "class" | "evidence">,
  ): void => {
    const byKey = new Map<string, { legacy?: T; candidate?: T }>();
    for (const fact of left)
      byKey.set(siteKey(fact.site), { ...byKey.get(siteKey(fact.site)), legacy: fact });
    for (const fact of right)
      byKey.set(siteKey(fact.site), { ...byKey.get(siteKey(fact.site)), candidate: fact });
    for (const pair of byKey.values()) {
      compared += 1;
      const legacyText = pair.legacy?.type ?? null;
      const candidateText = pair.candidate?.type ?? null;
      if (legacyText !== null && candidateText !== null && sameText(legacyText, candidateText))
        continue;
      const fact = pair.legacy ?? pair.candidate!;
      differences.push({
        what,
        site: fact.site,
        name: nameOf(fact),
        legacy: legacyText,
        candidate: candidateText,
        ...classify(pair.legacy, legacyText, candidateText),
      });
    }
  };
  const oracle = new Oracle(graph, legacy);
  compare(
    "binding",
    legacy.bindings,
    candidate.bindings,
    (fact) => fact.name,
    (fact, legacyText, candidateText) => {
      if (!straightLine)
        return {
          class: 3,
          evidence:
            "not solved yet in 3a: control flow, functions, loops, handlers, storage or speakers (work note §4, §5; PR 3b, 3c)",
        };
      if (copiedAndMutated)
        return {
          class: 3,
          evidence:
            "not solved yet in 3a: a copied value is changed in place after the copy, the copy's content at its point (Q3a, work note §4; PR 3b)",
        };
      if (fact !== undefined && fact.kind !== "letStatement" && fact.kind !== "globalStatement")
        return { class: 3, evidence: `not solved yet in 3a: a ${fact.kind} binding (PR 3b, 3c)` };
      const expected = fact === undefined ? null : oracle.expect(fact.site);
      if (expected === null)
        return {
          class: 4,
          evidence: "no rule-derived expectation: the oracle found no stores or no facts for them",
        };
      if (candidateText === null || !sameText(expected.text, candidateText))
        return {
          class: 4,
          evidence: `the decided rules expect ${expected.text} (${expected.rules.join("; ")})`,
        };
      const open = legacyText === null ? null : openForm(legacyText);
      return open === null
        ? { class: 1, evidence: `${expected.rules.join("; ")}: the rule-derived expectation met` }
        : {
            class: 2,
            evidence: `the legacy's open slot (${open}) and the rule-derived expectation met (${expected.rules.join("; ")})`,
          };
    },
  );
  compare(
    "function",
    legacy.functions.map((fact) => ({ ...fact, type: fact.result ?? "" })),
    candidate.functions.map((fact) => ({ ...fact, type: fact.result ?? "" })),
    (fact) => fact.name,
    () => ({ class: 3, evidence: "not solved yet in 3a: functions (work note §5; PR 3c)" }),
  );
  compare(
    "value",
    legacy.values,
    candidate.values,
    (fact) => fact.kind,
    () => ({
      class: 3,
      evidence:
        "not solved yet in 3a: expression facts after the point domain (work note §4; PR 3b)",
    }),
  );
  compare(
    "read",
    legacy.reads.map((fact) => ({
      ...fact,
      type: fact.binding === null ? "host" : siteKey(fact.binding),
    })),
    candidate.reads.map((fact) => ({
      ...fact,
      type: fact.binding === null ? "host" : siteKey(fact.binding),
    })),
    (fact) => fact.name,
    () => ({ class: 4, evidence: "a read resolves to another declaration than the legacy's" }),
  );
  return { straightLine, compared, differences, legacy, candidate };
}

/**
 * A value of one variable copied into another (`let b = a`, `let c = xs.first`, a `get` or an `otherwise`) while a
 * variable is changed in place: Q3a's content at the copy point, which the flow-insensitive solver shares.
 */
function isCopiedAndMutated(graph: ConstraintGraph): boolean {
  const carried = new Set(
    graph.constraints.flatMap((c) =>
      c.kind === "read"
        ? [c.occurrence]
        : c.kind === "project"
          ? [c.into]
          : c.kind === "get" || c.kind === "fallback"
            ? [c.result]
            : [],
    ),
  );
  const copied = graph.constraints.some(
    (c) =>
      c.kind === "store" && carried.has(c.value) && graph.places[c.into]?.kind.kind === "binding",
  );
  return copied && graph.constraints.some((c) => c.kind === "mutate");
}

function isStraightLine(graph: ConstraintGraph): boolean {
  if (graph.functions.length > 0 || graph.handlers.length > 0) return false;
  if (graph.places.some((place) => place.kind.kind === "binding" && place.kind.declared === "loop"))
    return false;
  return !graph.constraints.some(
    (c) =>
      c.kind === "test" ||
      c.kind === "load" ||
      c.kind === "save" ||
      c.kind === "speakerRead" ||
      c.kind === "speakerStore" ||
      c.kind === "call",
  );
}

// ---------- facts: structured, in evidence order, with the declaration and union marks ----------

/** A fact as the oracle derives it: its members in evidence order, null, and the held mark. */
interface Fact {
  readonly members: readonly FactMember[];
  readonly optional: boolean;
  readonly held: boolean;
}

/** A member: a flat type, or a collection over an element fact, or an object over property facts. */
interface FactMember {
  readonly type: StaticType | null;
  readonly ctor: "list" | "set" | "dict" | null;
  readonly element: Fact | null;
  /** The collection's part is empty by construction (`[]`), so the collection is also one over `never`. */
  readonly empty: boolean;
  readonly props: ReadonlyMap<string, Fact> | null;
  readonly open: boolean;
  /** The declaration's evidence (Q3.1r). */
  readonly decl: boolean;
  /** A member of a permitted union; `group` its identity. */
  readonly group: string | null;
  /** The identity of a structural member: a literal's own cell, or the site of the answer that built it. */
  readonly id: string | null;
  /** A member from a possibility: not exported on its own, but its parts' held marks join a known member's. */
  readonly possible: boolean;
}

const EMPTY: Fact = { members: [], optional: false, held: false };
const held = (fact: Fact): Fact => ({ ...fact, held: true });
const flat = (type: StaticType, decl = false, group: string | null = null): FactMember => ({
  type,
  ctor: null,
  element: null,
  empty: false,
  props: null,
  open: false,
  decl,
  group,
  id: null,
  possible: false,
});
const structural = (fields: Partial<FactMember> & Pick<FactMember, "id">): FactMember => ({
  type: null,
  ctor: null,
  element: null,
  empty: false,
  props: null,
  open: false,
  decl: false,
  group: null,
  possible: false,
  ...fields,
});

function familyOf(member: FactMember): string {
  if (member.ctor !== null) return member.ctor;
  if (member.props !== null || member.open) return "object";
  const type = member.type!;
  return type.kind === "scalar" ? (type.name === "number" ? "integer" : type.name) : type.kind;
}

/** The static type of a member for an adapter's view: the parts as the union of their members. */
function typeOfMember(member: FactMember): StaticType {
  if (member.ctor !== null)
    return { kind: member.ctor, element: typeOfFact(member.element ?? EMPTY) };
  if (member.open) return { kind: "object", properties: null };
  if (member.props !== null)
    return {
      kind: "object",
      properties: new PropertyTable(
        [...member.props].map(([name, fact]) => [name, typeOfFact(fact)]),
      ),
    };
  return member.type!;
}

function typeOfFact(fact: Fact): StaticType {
  const types = [
    ...fact.members.filter((m) => !m.possible).map(typeOfMember),
    ...(fact.optional ? [NULL_TYPE] : []),
  ];
  if (types.length === 0) return fact.held ? UNKNOWN_TYPE : { kind: "never" };
  return union(types);
}

/** Joins facts: the members in order, the same member once; a structural member of one identity merges its parts. */
function join(facts: readonly Fact[]): Fact {
  const members: FactMember[] = [];
  for (const fact of facts)
    for (const member of fact.members) {
      const same = members.findIndex((m) => sameMember(m, member));
      if (same < 0) members.push(member);
      else {
        const prior = members[same]!;
        members[same] = {
          ...prior,
          element:
            prior.ctor !== null
              ? join([prior.element ?? EMPTY, member.element ?? EMPTY])
              : prior.element,
          empty: prior.empty || member.empty,
          decl: prior.decl || member.decl,
          possible: prior.possible && member.possible,
        };
      }
    }
  return { members, optional: facts.some((f) => f.optional), held: facts.some((f) => f.held) };
}

function sameMember(a: FactMember, b: FactMember): boolean {
  if (a.ctor !== null || b.ctor !== null)
    return a.ctor === b.ctor && a.group === b.group && a.id === b.id;
  if (a.props !== null || b.props !== null || a.open || b.open)
    return a.id !== null && a.id === b.id && a.group === b.group;
  return (
    typeKey(typeOfMember(a), true, true) === typeKey(typeOfMember(b), true, true) &&
    a.group === b.group
  );
}

/** The decided rules over a fact's members: the declaration's first, else the earliest; a union admits its members. */
function exported(fact: Fact): Fact {
  const known = fact.members.filter((m) => !m.possible);
  const first = known.find((m) => m.decl) ?? known[0];
  if (first === undefined) return { ...fact, members: [] };
  const admitted = new Set(
    first.group !== null
      ? known.filter((m) => m.group === first.group).map(familyOf)
      : [familyOf(first)],
  );
  return { ...fact, members: known.filter((m) => admitted.has(familyOf(m))) };
}

/**
 * The export's text of a fact: the working members, each part exported by the same rules, joined by the legacy's
 * `union` over their types as the export joins them (a member the union keeps writes its own text, with the held
 * marks of its parts; two members of one type whose texts differ both keep their text; a member the union merges
 * writes the merged type).
 */
function renderFact(fact: Fact): string {
  const working = exported(fact);
  if (working.members.length === 0)
    return working.held ? "unknown" : working.optional ? "(?|null)" : "never";
  const pairs = working.members.map((member) => ({
    type: exportedType(member),
    text: renderMember(member),
  }));
  const type = union([...pairs.map((pair) => pair.type), ...(working.optional ? [NULL_TYPE] : [])]);
  const textsOf = (t: StaticType): string[] => {
    const own = pairs.filter((pair) => pair.type === t).map((pair) => pair.text);
    return own.length === 0 ? [typeKey(t, true, true)] : own;
  };
  const all = [...new Set((type.kind === "union" ? type.members : [type]).flatMap(textsOf))].sort();
  const text = all.length === 1 ? all[0]! : `(${all.join("|")})`;
  return `${text}${working.held ? "!" : ""}`;
}

/** The type of a member as the export builds it: over the exported parts (their working members). */
function exportedType(member: FactMember): StaticType {
  if (member.ctor !== null)
    return { kind: member.ctor, element: exportedTypeOfFact(member.element ?? EMPTY) };
  if (member.open) return { kind: "object", properties: null };
  if (member.props !== null)
    return {
      kind: "object",
      properties: new PropertyTable(
        [...member.props]
          .filter(([, fact]) => fact.members.length > 0 || fact.optional || fact.held)
          .map(([name, fact]) => [name, exportedTypeOfFact(fact)]),
      ),
    };
  return member.type!;
}

function exportedTypeOfFact(fact: Fact): StaticType {
  const working = exported(fact);
  const types = [...working.members.map(exportedType), ...(working.optional ? [NULL_TYPE] : [])];
  if (types.length === 0) return working.held ? UNKNOWN_TYPE : { kind: "never" };
  return union(types);
}

function renderMember(member: FactMember): string {
  if (member.ctor !== null) return `${member.ctor}<${renderFact(member.element ?? EMPTY)}>`;
  if (member.open) return "object";
  if (member.props !== null)
    return `{${[...member.props]
      .filter(([, fact]) => fact.members.length > 0 || fact.optional || fact.held)
      .map(([name, fact]) => `${JSON.stringify(name)}:${renderFact(fact)}`)
      .sort()
      .join(",")}}`;
  return typeKey(member.type!, true, true);
}

// ---------- texts ----------

/** Splits a text at its top-level separators. */
function topLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === '"') quoted = !quoted;
    if (quoted) continue;
    if (c === "(" || c === "<" || c === "{") depth += 1;
    else if (c === ")" || c === ">" || c === "}") depth -= 1;
    else if (c === separator && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/**
 * Parses a `typeKey` text into a fact. The legacy's open-slot forms are read as the decided rules read them: `?` as
 * an element or property no store reached is `never`, `?null` is the one null-only form, a held mark on a member is
 * the fact's.
 */
function parse(text: string, id: string | null = null): Fact {
  let isHeld = false;
  let body = text.trim();
  if (body.endsWith("!")) {
    isHeld = true;
    body = body.slice(0, -1);
  }
  if (body === "unknown") return { members: [], optional: false, held: true };
  if (body === "?null") return { members: [], optional: true, held: isHeld };
  if (body === "?" || body === "never") return { members: [], optional: false, held: isHeld };
  const inner = body.startsWith("(") && body.endsWith(")") ? body.slice(1, -1) : body;
  const members: FactMember[] = [];
  let optional = false;
  for (const raw of topLevel(inner, "|")) {
    let member = raw.trim();
    if (member.endsWith("!")) {
      isHeld = true;
      member = member.slice(0, -1);
    }
    if (member === "null") optional = true;
    else if (member === "?" || member === "never") continue;
    else if (member === "unknown") isHeld = true;
    else if (member.length > 0) members.push(parseMember(member, id));
  }
  return { members, optional, held: isHeld };
}

function parseMember(text: string, id: string | null): FactMember {
  for (const ctor of ["list", "set", "dict"] as const)
    if (text.startsWith(`${ctor}<`) && text.endsWith(">"))
      return structural({ ctor, element: parse(text.slice(ctor.length + 1, -1), id), id });
  if (text === "object") return structural({ props: new Map(), open: true, id });
  if (text.startsWith("{") && text.endsWith("}")) {
    const props = new Map<string, Fact>();
    for (const entry of topLevel(text.slice(1, -1), ",")) {
      if (entry.length === 0) continue;
      const colon = entry.indexOf(":");
      // EVIDENCE: the property names of a typeKey text are JSON strings.
      props.set(JSON.parse(entry.slice(0, colon)) as string, parse(entry.slice(colon + 1), id));
    }
    return structural({ props, id });
  }
  return flat(typeOf(text));
}

/** A `typeKey` text as a `StaticType` (null, unknown and never as themselves). */
function typeOf(text: string): StaticType {
  const body = text.endsWith("!") ? text.slice(0, -1) : text;
  if (body === "null") return NULL_TYPE;
  if (body === "unknown" || body === "?") return UNKNOWN_TYPE;
  if (body === "never") return { kind: "never" };
  if (body.startsWith("(") && body.endsWith(")"))
    return union(topLevel(body.slice(1, -1), "|").map(typeOf));
  for (const ctor of ["list", "set", "dict"] as const)
    if (body.startsWith(`${ctor}<`) && body.endsWith(">"))
      return { kind: ctor, element: typeOf(body.slice(ctor.length + 1, -1)) };
  if (body === "object") return { kind: "object", properties: null };
  if (body.startsWith("{") && body.endsWith("}")) {
    const table = new PropertyTable();
    for (const entry of topLevel(body.slice(1, -1), ",")) {
      if (entry.length === 0) continue;
      const colon = entry.indexOf(":");
      // EVIDENCE: the property names of a typeKey text are JSON strings.
      table.set(JSON.parse(entry.slice(0, colon)) as string, typeOf(entry.slice(colon + 1)));
    }
    return { kind: "object", properties: table };
  }
  const restricted = /^([a-zA-Z]+)\{(.*)\}$/.exec(body);
  if (restricted !== null) {
    // EVIDENCE: the scalar names of a typeKey text are registry kinds; the values are JSON texts joined by bars.
    const name = restricted[1] as ScalarTypeName;
    const values: ScalarValue[] = [];
    for (const value of topLevel(restricted[2]!, "|")) {
      // EVIDENCE: as above, a restricted scalar's values are JSON texts.
      const parsed = JSON.parse(value) as ScalarValue;
      values.push(parsed);
    }
    return { kind: "scalar", name, values };
  }
  // EVIDENCE: as above, a bare name is a registry kind.
  const name = body as ScalarTypeName;
  return { kind: "scalar", name };
}

/** The one normalization (work note §7): a union's members as a sorted set, so equal object members collapse. */
function normalized(text: string): string {
  const body = text.endsWith("!") ? text.slice(0, -1) : text;
  const mark = text.endsWith("!") ? "!" : "";
  if (body.startsWith("(") && body.endsWith(")"))
    return `(${[...new Set(topLevel(body.slice(1, -1), "|").map(normalized))].sort().join("|")})${mark}`;
  for (const ctor of ["list", "set", "dict"] as const)
    if (body.startsWith(`${ctor}<`) && body.endsWith(">"))
      return `${ctor}<${normalized(body.slice(ctor.length + 1, -1))}>${mark}`;
  if (body.startsWith("{") && body.endsWith("}"))
    return `{${topLevel(body.slice(1, -1), ",")
      .map((entry) => {
        const colon = entry.indexOf(":");
        return colon < 0 ? entry : `${entry.slice(0, colon)}:${normalized(entry.slice(colon + 1))}`;
      })
      .sort()
      .join(",")}}${mark}`;
  return text;
}

function sameText(left: string, right: string): boolean {
  return left === right || normalized(left) === normalized(right);
}

/** The legacy's open-slot form in a text, or `null`: `?`, `?null`, or a held mark on a member inside a union. */
function openForm(text: string): string | null {
  if (/\?null/.test(text)) return "?null";
  if (/\?(?!null)/.test(text)) return "?";
  if (/![|)]/.test(text)) return "a member's held mark";
  return null;
}

/** Which decided rules make the expectation differ from the legacy's fact, by what differs. */
function rulesFor(legacy: Fact | null, expected: Fact): string[] {
  if (legacy === null) return ["a fact the legacy has no site for"];
  const rules: string[] = [];
  const left = exported(legacy);
  const right = exported(expected);
  if (left.held !== right.held)
    rules.push(
      "Q3.2a/Q3.2b (a value the compiler cannot know is held whatever the order; a known store decides)",
    );
  if (left.optional !== right.optional)
    rules.push(
      "Q3.5/Q3.2c/Q3.4 (a known null, also a conversion's `default: null`, is optionality; a read of a part no value reached gives nothing)",
    );
  const families = (fact: Fact): Set<string> => new Set(fact.members.map(familyOf));
  const a = families(left);
  const b = families(right);
  if ([...a].some((f) => !b.has(f)) || [...b].some((f) => !a.has(f)))
    rules.push(
      "Q3.1/Q3.1r/Q3.7/Q3.8 (the declaration's family first, else the earliest; a mixed literal's first member; a union that does not fit is a conflict)",
    );
  else if (renderFact(legacy) !== renderFact(expected))
    rules.push("the rules over a part (an element or a property, recursively)");
  return rules.length === 0 ? ["the decided rules"] : rules;
}

const DECL_STORES: readonly string[] = [
  "initializer",
  "parameter default",
  "loop variable",
  "start value",
];
const RECEIVER_REF: OperandRef = { receiver: true };
const argumentRef = (index: number): OperandRef => ({ argument: index });
const namedRef = (name: string): OperandRef => ({ named: name });

const sameRefs = (a: OperandRef, b: OperandRef): boolean =>
  "receiver" in a
    ? "receiver" in b
    : "argument" in a
      ? "argument" in b && a.argument === b.argument
      : "named" in b && a.named === b.named;

const valueKindOf = (type: StaticType): ValueKind | null =>
  type.kind === "scalar"
    ? type.name
    : type.kind === "list" || type.kind === "set" || type.kind === "dict" || type.kind === "object"
      ? type.kind
      : null;

/**
 * The classifier's oracle: the fact the decided rules derive for a `let` or `global` binding, independent of the
 * solver. The stores into the place come from the graph, in source order, the declaration's marked; a literal's fact
 * from its own members and the stores through the variables that hold it (a part nothing reaches is empty by
 * construction); a read's from the binding's derived fact with every family stored; a property read's from the
 * member rules; an operation's from the adapters over its operands' derived facts, asked per alternative (a lazy
 * operand also unevaluated) and once with the dynamic view when an operand holds a value the compiler cannot know,
 * as the lifting asks; a contract's union, `otherwise` and `get` define a permitted union; a cycle through a binding
 * is iterated from nothing. The export's rules then render the working members at every level.
 */
class Oracle {
  readonly #graph: ConstraintGraph;
  readonly #values = new Map<string, TypeText>();
  readonly #bindingFacts = new Map<string, TypeText>();
  readonly #places = new Map<string, Place>();
  readonly #producers = new Map<PlaceId, Constraint[]>();
  readonly #estimates = new Map<PlaceId, Fact>();

  constructor(graph: ConstraintGraph, legacy: SolvedTypeFacts) {
    this.#graph = graph;
    for (const fact of legacy.values)
      if (!this.#values.has(siteKey(fact.site))) this.#values.set(siteKey(fact.site), fact.type);
    for (const fact of legacy.bindings) this.#bindingFacts.set(siteKey(fact.site), fact.type);
    for (const place of graph.places)
      if (place.site !== null && place.kind.kind === "binding")
        this.#places.set(siteKey(place.site), place);
    for (const c of graph.constraints) {
      const targets =
        c.kind === "has"
          ? [c.place]
          : c.kind === "read"
            ? [c.occurrence]
            : c.kind === "project"
              ? [c.into]
              : c.kind === "operation" ||
                  c.kind === "get" ||
                  c.kind === "fallback" ||
                  c.kind === "call" ||
                  c.kind === "load"
                ? [c.result]
                : [];
      for (const target of targets)
        this.#producers.set(target, [...(this.#producers.get(target) ?? []), c]);
    }
  }

  expect(site: FactSite): { readonly text: string; readonly rules: readonly string[] } | null {
    const place = this.#places.get(siteKey(site));
    if (place === undefined || place.kind.kind !== "binding") return null;
    const legacyText = this.#bindingFacts.get(siteKey(site));
    const legacy = legacyText === undefined ? null : parse(legacyText);
    const derived = this.#binding(place.id);
    if (derived === null) return null;
    if (place.kind.written !== null && legacyText !== undefined) {
      // a written type is the bound, every member admitted; a store of a value the compiler cannot know makes the
      // place held (Q3.2a)
      const bound = parse(legacyText.replace(/!$/, ""));
      const expected = {
        ...bound,
        members: bound.members.map((m) => ({ ...m, group: `written:${place.id}` })),
        held: derived.held,
      };
      return { text: renderFact(expected), rules: rulesFor(legacy, expected) };
    }
    return { text: renderFact(derived), rules: rulesFor(legacy, derived) };
  }

  /** The fact of a binding with every family stored, iterated from nothing through any cycle. */
  #binding(place: PlaceId): Fact | null {
    const known = this.#estimates.get(place);
    if (known !== undefined) return known;
    this.#estimates.set(place, EMPTY);
    let derived: Fact | null = null;
    for (let round = 0; round < 5; round += 1) {
      const next = this.#derive(place);
      if (next === null) break;
      if (
        derived !== null &&
        renderFact(next) === renderFact(derived) &&
        next.members.length === derived.members.length
      ) {
        derived = next;
        break;
      }
      derived = next;
      this.#estimates.set(place, next);
    }
    this.#estimates.delete(place);
    return derived;
  }

  #stores(into: PlaceId): Extract<Constraint, { kind: "store" }>[] {
    return this.#graph.constraints
      .flatMap((c) => (c.kind === "store" && c.into === into ? [c] : []))
      .sort((a, b) => a.site.start - b.site.start);
  }

  #stored(store: Extract<Constraint, { kind: "store" }>, depth: number): Fact {
    const value =
      store.how === "elements"
        ? this.#elements(this.#value(store.value, depth))
        : this.#value(store.value, depth);
    return DECL_STORES.includes(store.how)
      ? { ...value, members: value.members.map((m) => ({ ...m, decl: true })) }
      : value;
  }

  #derive(into: PlaceId): Fact | null {
    const stores = this.#stores(into);
    if (stores.length === 0) return null;
    return join(stores.map((store) => this.#stored(store, 0)));
  }

  /** The elements of a collection fact (the alternatives of every collection member). */
  #elements(value: Fact): Fact {
    const parts = value.members.filter((m) => m.ctor !== null).map((m) => m.element ?? EMPTY);
    const joined = join(parts);
    return value.held ? held(joined) : joined;
  }

  /** The property of an object fact. */
  #property(value: Fact, name: string): Fact {
    const parts = value.members.map((m) => (m.open ? held(EMPTY) : (m.props?.get(name) ?? EMPTY)));
    const joined = join(parts);
    return value.held ? held(joined) : joined;
  }

  /** The fact of a value place, by the constraint that produces it. */
  #value(place: PlaceId, depth: number): Fact {
    const fact = this.#valueOf(place, depth);
    if (process.env["ORACLE_TRACE"] !== undefined)
      console.log(
        `  value ${this.#graph.places[place]?.label ?? place} (${
          this.#producers
            .get(place)
            ?.map((c) => c.kind)
            .join(",") ?? "-"
        }) -> ${renderFact(fact)} [${fact.members.map(familyOf).join(",")}${fact.optional ? " null" : ""}${fact.held ? " held" : ""}]`,
      );
    return fact;
  }

  #valueOf(place: PlaceId, depth: number): Fact {
    if (depth > 10) return EMPTY;
    const legacy = this.#legacyValue(place);
    for (const c of this.#producers.get(place) ?? []) {
      switch (c.kind) {
        case "has":
          if (c.type.kind === "list" || c.type.kind === "set" || c.type.kind === "dict") {
            const cell =
              c.type.element.kind === "ref"
                ? this.#cell(c.type.element.place, depth + 1)
                : { fact: EMPTY, empty: true };
            return {
              members: [
                structural({
                  ctor: c.type.kind,
                  element: cell.fact,
                  empty: cell.empty,
                  id: `cell:${c.place}`,
                }),
              ],
              optional: false,
              held: false,
            };
          }
          if (c.type.kind === "object") {
            if (c.type.properties === null)
              return {
                members: [structural({ props: new Map(), open: true, id: `cell:${c.place}` })],
                optional: false,
                held: false,
              };
            const props = new Map<string, Fact>();
            for (const { name, type } of c.type.properties)
              props.set(name, type.kind === "ref" ? this.#cell(type.place, depth + 1).fact : EMPTY);
            for (const [name, fact] of this.#storedProperties(c.place, depth + 1))
              if (!props.has(name)) props.set(name, fact);
            return {
              members: [structural({ props, id: `cell:${c.place}` })],
              optional: false,
              held: false,
            };
          }
          if (c.type.kind === "dynamic") return held(EMPTY);
          if (c.type.kind === "atom") {
            if (c.type.name === "null") return { members: [], optional: true, held: false };
            // EVIDENCE: an atom term of the graph names a registry kind, which a scalar type carries by name.
            const name = c.type.name as ScalarTypeName;
            return { members: [flat({ kind: "scalar", name })], optional: false, held: false };
          }
          break;
        case "read": {
          const binding = this.#graph.places[c.binding]!;
          if (binding.kind.kind !== "binding") break;
          if (binding.kind.declared === "host") return held(EMPTY);
          const derived = this.#binding(c.binding);
          const text =
            binding.site === null ? undefined : this.#bindingFacts.get(siteKey(binding.site));
          if (binding.kind.written !== null && text !== undefined) {
            const bound = parse(text.replace(/!$/, ""), `bound:${c.binding}`);
            const members = bound.members.map((m) => ({ ...m, group: `written:${c.binding}` }));
            return derived === null
              ? { ...bound, members }
              : { members, optional: bound.optional || derived.optional, held: derived.held };
          }
          if (derived !== null) return derived;
          return text === undefined ? EMPTY : parse(text, `binding:${c.binding}`);
        }
        case "project": {
          const owner = this.#value(c.owner, depth + 1);
          return typeof c.step !== "object"
            ? this.#elements(owner)
            : this.#member(owner, c.step.property);
        }
        case "fallback":
          return asUnion(
            join([
              { ...this.#value(c.left, depth + 1), optional: false },
              this.#value(c.right, depth + 1),
            ]),
            `fallback@${c.site.start}`,
          );
        case "get":
          return asUnion(
            join([
              this.#elements(this.#value(c.receiver, depth + 1)),
              this.#value(c.fallback, depth + 1),
            ]),
            `get@${c.site.start}`,
          );
        case "operation": {
          const answer = this.#operation(c, depth);
          if (answer !== null) return answer;
          break;
        }
        default:
          break;
      }
    }
    return legacy === undefined ? EMPTY : parse(legacy, `value:${place}`);
  }

  #legacyValue(place: PlaceId): TypeText | undefined {
    const site = this.#graph.places[place]?.site;
    return site === null || site === undefined ? undefined : this.#values.get(siteKey(site));
  }

  /** A property read through the member rules per member of the owner. */
  #member(owner: Fact, name: string): Fact {
    const parts: Fact[] = [];
    for (const member of owner.members) {
      const type = typeOfMember(member);
      const kind = valueKindOf(type);
      const answer =
        kind === null
          ? undefined
          : memberOf(kind, name, { alternatives: [type], dynamic: null, known: undefined });
      if (answer === undefined) continue;
      const one: Fact = { members: [member], optional: false, held: false };
      if (answer.kind === "held")
        parts.push(
          typeof answer.step === "object"
            ? this.#property(one, answer.step.property)
            : this.#elements(one),
        );
      else
        parts.push(this.#read(answer, (ref) => ("receiver" in ref ? one : null), `member@${name}`));
    }
    const joined = join(parts);
    return owner.held ? held(joined) : joined;
  }

  /** The variables a literal is stored into, their occurrences. */
  #occurrencesOf(literal: PlaceId): Set<PlaceId> {
    const bindings = new Set(
      this.#graph.constraints.flatMap((c) =>
        c.kind === "store" && c.value === literal ? [c.into] : [],
      ),
    );
    return new Set(
      this.#graph.constraints.flatMap((c) =>
        c.kind === "read" && bindings.has(c.binding) ? [c.occurrence] : [],
      ),
    );
  }

  /** The properties stored through the variables that hold an object literal, beyond its own. */
  #storedProperties(literal: PlaceId, depth: number): Map<string, Fact> {
    const occurrences = this.#occurrencesOf(literal);
    const out = new Map<string, Fact[]>();
    for (const c of this.#graph.constraints) {
      if (c.kind !== "project" || typeof c.step !== "object" || !occurrences.has(c.owner)) continue;
      const stores = this.#stores(c.into);
      if (stores.length === 0) continue;
      out.set(c.step.property, [
        ...(out.get(c.step.property) ?? []),
        ...stores.map((store) => this.#stored(store, depth)),
      ]);
    }
    return new Map([...out].map(([name, facts]) => [name, join(facts)]));
  }

  /** A literal's own cell: its member stores, and the stores through the variables that hold the literal. */
  #cell(cell: PlaceId, depth: number): { readonly fact: Fact; readonly empty: boolean } {
    const facts: Fact[] = this.#stores(cell).map((store) => {
      const stored = this.#stored(store, depth);
      return { ...stored, members: stored.members.map((m) => ({ ...m, decl: true })) };
    });
    const empty = facts.length === 0;
    const owner = this.#graph.places[cell]?.kind;
    if (owner !== undefined && (owner.kind === "cell" || owner.kind === "property")) {
      const occurrences = this.#occurrencesOf(owner.owner);
      for (const c of this.#graph.constraints) {
        if (c.kind !== "project" || !occurrences.has(c.owner)) continue;
        const matches =
          owner.kind === "cell"
            ? typeof c.step !== "object"
            : typeof c.step === "object" && c.step.property === owner.name;
        if (!matches) continue;
        for (const store of this.#stores(c.into)) facts.push(this.#stored(store, depth));
      }
    }
    return { fact: join(facts), empty };
  }

  /** An operation's fact from its adapter: per alternative of each operand, and once with the dynamic view. */
  #operation(c: Extract<Constraint, { kind: "operation" }>, depth: number): Fact | null {
    const relation = RELATIONS.relation(c.contract);
    if (relation === undefined) return null;
    const operands: { readonly ref: OperandRef; readonly fact: Fact; readonly lazy: boolean }[] = [
      ...(c.receiver === null
        ? []
        : [{ ref: RECEIVER_REF, fact: this.#value(c.receiver, depth + 1), lazy: false }]),
      ...c.arguments.map((place, index) => ({
        ref: argumentRef(index),
        fact: this.#value(place, depth + 1),
        lazy: false,
      })),
      ...c.named.map((n) => ({
        ref: namedRef(n.name),
        fact: this.#value(n.value, depth + 1),
        lazy: n.name === "default",
      })),
    ];
    if (c.contract.family === "logic" && operands[1] !== undefined)
      operands[1] = { ...operands[1], lazy: true };
    const inputs = (views: readonly OperandView[]): OperationInputs => {
      let receiver: OperandView | null = null;
      const args: OperandView[] = [];
      const named = new Map<string, OperandView>();
      operands.forEach((operand, index) => {
        const view = views[index]!;
        if ("receiver" in operand.ref) receiver = view;
        else if ("argument" in operand.ref) args[operand.ref.argument] = view;
        else named.set(operand.ref.named, view);
      });
      return {
        receiver,
        arguments: args,
        named,
        evidence: c.evidence,
        view: () => ({ alternatives: null, dynamic: null, known: undefined }),
      };
    };
    const site = `op@${c.site.start}`;
    // the closed alternatives of each operand (an empty-by-construction collection also over never, null as one of
    // them), an unevaluated lazy operand beside them
    const choices = operands.map((operand) => {
      const list: { readonly view: OperandView; readonly chosen: Fact | null }[] = [];
      for (const member of operand.fact.members) {
        if (member.possible) continue;
        const type = typeOfMember(member);
        list.push({
          view: { alternatives: [type], dynamic: null, known: undefined },
          chosen: { members: [member], optional: false, held: false },
        });
        if (member.ctor !== null && member.empty)
          list.push({
            view: {
              alternatives: [{ kind: member.ctor, element: { kind: "never" } }],
              dynamic: null,
              known: undefined,
            },
            chosen: { members: [{ ...member, element: EMPTY }], optional: false, held: false },
          });
      }
      if (operand.fact.optional)
        list.push({
          view: { alternatives: [NULL_TYPE], dynamic: null, known: undefined },
          chosen: { members: [], optional: true, held: false },
        });
      if (operand.lazy)
        list.push({ view: { alternatives: null, dynamic: null, known: undefined }, chosen: null });
      return list;
    });
    const strictEmpty = operands.some((o, i) => !o.lazy && choices[i]!.length === 0);
    const parts: Fact[] = [];
    if (!strictEmpty) {
      const product = choices.reduce<
        { readonly view: OperandView; readonly chosen: Fact | null }[][]
      >((acc, list) => acc.flatMap((combo) => list.map((pick) => [...combo, pick])), [[]]);
      for (const combo of product.slice(0, 512)) {
        const chosen = (ref: OperandRef): Fact | null =>
          combo[operands.findIndex((o) => sameRefs(o.ref, ref))]?.chosen ?? null;
        const answer = this.#read(
          relation.result(inputs(combo.map((pick) => pick.view))),
          chosen,
          site,
        );
        parts.push(
          combo.some((pick) => pick.chosen?.members.some((m) => m.group !== null))
            ? asUnion(answer, site)
            : answer,
        );
      }
    }
    if (operands.some((o) => o.fact.held)) {
      const views = operands.map((o) => {
        const types = [
          ...o.fact.members.filter((m) => !m.possible).map(typeOfMember),
          ...(o.fact.optional ? [NULL_TYPE] : []),
        ];
        return {
          alternatives: types.length === 0 ? null : types,
          dynamic: o.fact.held ? ("host" as const) : null,
          known: undefined,
        };
      });
      if (
        !operands.some(
          (o, i) => !o.lazy && views[i]!.alternatives === null && views[i]!.dynamic === null,
        )
      )
        parts.push(
          held(
            this.#read(
              relation.result(inputs(views)),
              (ref) => operands.find((o) => sameRefs(o.ref, ref))?.fact ?? null,
              site,
            ),
          ),
        );
    }
    return join(parts);
  }

  /** Reads an answer into a fact, with the chosen alternative of each operand for its projections. */
  #read(answer: OperationResult, chosen: (ref: OperandRef) => Fact | null, site: string): Fact {
    switch (answer.kind) {
      case "type":
        return parse(typeKey(answer.type, true, true), site);
      case "possible": {
        // a possibility decides nothing (held); a structural possibility's parts carry their held marks into the
        // known member they join
        const parts = answer.types.flatMap((type) =>
          parse(typeKey(type, true, true), site)
            .members.filter((m) => m.ctor !== null)
            .map((m) => ({ ...m, possible: true })),
        );
        return { members: parts, optional: false, held: true };
      }
      case "dynamic":
        return held(EMPTY);
      case "invalid":
      case "unconstrained":
        return EMPTY;
      case "projection": {
        let current = chosen(answer.source.of) ?? EMPTY;
        for (const step of answer.source.path)
          current =
            typeof step === "object"
              ? this.#property(current, step.property)
              : this.#elements(current);
        return current;
      }
      case "join": {
        const element = join(
          answer.parts.map((part) =>
            this.#read({ kind: "projection", source: part }, chosen, site),
          ),
        );
        return {
          members: [
            structural({
              ctor: answer.constructor,
              element,
              empty: element.members.length === 0 && !element.held,
              id: site,
            }),
          ],
          optional: false,
          held: false,
        };
      }
      case "alternatives": {
        const bearing = answer.results.filter(
          (r) => r.kind !== "dynamic" && r.kind !== "unconstrained" && r.kind !== "invalid",
        ).length;
        const joined = join(answer.results.map((r) => this.#read(r, chosen, site)));
        return bearing >= 2 ? asUnion(joined, site) : joined;
      }
      case "byReceiver": {
        const receiver = chosen({ receiver: true });
        const families = new Set((receiver?.members ?? []).map(familyOf));
        return join(
          answer.cases
            .filter((cs) => families.has(cs.receiver === "number" ? "integer" : cs.receiver))
            .map((cs) => this.#read(cs.result, chosen, site)),
        );
      }
    }
  }
}

/** The members of a fact as the members of a permitted union with the given identity. */
function asUnion(fact: Fact, group: string): Fact {
  return { ...fact, members: fact.members.map((m) => ({ ...m, group })) };
}
