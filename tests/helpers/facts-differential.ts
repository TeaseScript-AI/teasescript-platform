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
  DynamicWhy,
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
 * construct: in 3a every source with control flow, functions, loops, handlers, storage or speakers, every binding
 * whose fact a copied value changed in place reaches (the copy's content at its point, Q3a), every value and
 * function fact, and a binding the legacy's known-value fold narrows. One normalization applies to both sides: a
 * union's members are a set, so equal object members collapse and their order does not count.
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
  const involved = involvedBindings(graph);
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
  const oracle = new Oracle(graph, legacy, source);
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
      if (fact !== undefined && fact.kind !== "letStatement" && fact.kind !== "globalStatement")
        return { class: 3, evidence: `not solved yet in 3a: a ${fact.kind} binding (PR 3b, 3c)` };
      const expected = fact === undefined ? null : oracle.expect(fact.site);
      if (expected === null)
        return {
          class: 4,
          evidence: "no rule-derived expectation: the oracle found no stores or no facts for them",
        };
      // a copied value changed in place after the copy: the bindings whose fact the copy reaches, not the others of
      // the source (r10-B7)
      if (expected.touched.some((place) => involved.has(place)))
        return {
          class: 3,
          evidence:
            "not solved yet in 3a: a copied value is changed in place after the copy, the copy's content at its point (Q3a, work note §4; PR 3b)",
        };
      const named = expected.rules.length === 0 ? "" : ` (${expected.rules.join("; ")})`;
      if (candidateText === null || !sameText(expected.text, candidateText))
        return { class: 4, evidence: `the decided rules expect ${expected.text}${named}` };
      const open = legacyText === null ? null : openForm(legacyText);
      if (open !== null)
        return {
          class: 2,
          evidence: `the legacy's open slot (${open}) and the rule-derived expectation met${named}`,
        };
      if (expected.rules.length > 0)
        return {
          class: 1,
          evidence: `${expected.rules.join("; ")}: the rule-derived expectation met`,
        };
      // the expectation met with no decided rule between the facts: the legacy's fold of constant operands
      // (`KnownValues`), which 3a does not model, when the legacy's fact is the fold's narrowing (r10-S1)
      if (expected.folded && legacyText !== null && narrowsNumerically(legacyText, expected.text))
        return {
          class: 3,
          evidence:
            "not solved yet in 3a: the legacy's known-value fold of constant operands (`KnownValues`, work note §3.6; PR 3b)",
        };
      return {
        class: 4,
        evidence: `the rule-derived expectation ${expected.text} is met, but no decided rule, open slot or deferred capability explains the legacy's ${legacyText ?? "(none)"}`,
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
 * The bindings whose content a value changed in place reaches through a copy (`let b = a`, `let c = xs.first`, a
 * `get` or an `otherwise`, a literal that holds a variable's value): Q3a's content at the copy point, which the
 * flow-insensitive solver shares. A fact derived through one of them is class 3; the other bindings of the source
 * are compared (r10-B7).
 */
function involvedBindings(graph: ConstraintGraph): ReadonlySet<PlaceId> {
  const producers = new Map<PlaceId, Constraint[]>();
  for (const c of graph.constraints) {
    const targets =
      c.kind === "read"
        ? [c.occurrence]
        : c.kind === "project"
          ? [c.into]
          : c.kind === "get" || c.kind === "fallback"
            ? [c.result]
            : [];
    for (const target of targets) producers.set(target, [...(producers.get(target) ?? []), c]);
  }
  // the cells of a literal (its element, its properties), by the literal
  const cellsOf = new Map<PlaceId, PlaceId[]>();
  for (const place of graph.places)
    if (place.kind.kind === "cell" || place.kind.kind === "property")
      cellsOf.set(place.kind.owner, [...(cellsOf.get(place.kind.owner) ?? []), place.id]);
  // the bindings whose content a value place carries: through a read, a projection, a `get`, an `otherwise`, and
  // through a literal's content (the values stored into its cells)
  const origins = (value: PlaceId, seen: Set<PlaceId> = new Set()): PlaceId[] => {
    if (seen.has(value)) return [];
    seen.add(value);
    const held = (cellsOf.get(value) ?? []).flatMap((cell) =>
      graph.constraints.flatMap((c) =>
        c.kind === "store" && c.into === cell ? origins(c.value, seen) : [],
      ),
    );
    return [
      ...held,
      ...(producers.get(value) ?? []).flatMap((c) =>
        c.kind === "read"
          ? [c.binding]
          : c.kind === "project"
            ? origins(c.owner, seen)
            : c.kind === "get"
              ? [...origins(c.receiver, seen), ...origins(c.fallback, seen)]
              : c.kind === "fallback"
                ? [...origins(c.left, seen), ...origins(c.right, seen)]
                : [],
      ),
    ];
  };
  // the bindings a store's target belongs to: the binding, or the bindings that hold the literal whose cell it is
  const holders = (into: PlaceId, seen: Set<PlaceId> = new Set()): PlaceId[] => {
    const kind = graph.places[into]?.kind;
    if (kind === undefined || seen.has(into)) return [];
    seen.add(into);
    if (kind.kind === "binding") return [into];
    if (kind.kind === "cell" || kind.kind === "property")
      return graph.constraints.flatMap((c) =>
        c.kind === "store" && c.value === kind.owner ? holders(c.into, seen) : [],
      );
    return [];
  };
  const parent = new Map<PlaceId, PlaceId>();
  const find = (place: PlaceId): PlaceId => {
    let root = place;
    while (parent.has(root)) root = parent.get(root)!;
    return root;
  };
  for (const c of graph.constraints)
    if (c.kind === "store")
      for (const holder of holders(c.into))
        for (const origin of origins(c.value)) {
          const left = find(origin);
          const right = find(holder);
          if (left !== right) parent.set(left, right);
        }
  const bindings = graph.places.flatMap((p) => (p.kind.kind === "binding" ? [p.id] : []));
  const out = new Set<PlaceId>();
  for (const c of graph.constraints) {
    if (c.kind !== "mutate") continue;
    const root = find(c.binding);
    const component = bindings.filter((b) => find(b) === root);
    if (component.length > 1) for (const b of component) out.add(b);
  }
  return out;
}

/** Whether the legacy's text is the expectation's with a number narrowed to an integer, the known-value fold's effect. */
function narrowsNumerically(legacy: string, expected: string): boolean {
  const widened = (text: string): string => normalized(text.replace(/\binteger\b/g, "number"));
  return legacy !== expected && widened(legacy) === widened(expected);
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

/**
 * A fact as the oracle derives it: its members in evidence order, null, and the held mark with the provenances of
 * the values the compiler cannot know (`whys`; `held` without them reads as the host's).
 */
interface Fact {
  readonly members: readonly FactMember[];
  readonly optional: boolean;
  readonly held: boolean;
  readonly whys?: readonly DynamicWhy[];
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
  /** The provenance of a possibility (the value the compiler cannot know it came from). */
  readonly why: DynamicWhy | null;
  /** A structural cycle cut (a part on the way back to its owner): the legacy's back-edge widening, `?`. */
  readonly cycle: boolean;
}

const EMPTY: Fact = { members: [], optional: false, held: false };
/** The provenances of a fact's values the compiler cannot know. */
const whysOf = (fact: Fact): readonly DynamicWhy[] => fact.whys ?? (fact.held ? ["host"] : []);
const held = (fact: Fact, whys: readonly DynamicWhy[] = ["host"]): Fact => ({
  ...fact,
  held: true,
  whys: [...new Set([...whysOf(fact), ...whys])].sort(),
});
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
  why: null,
  cycle: false,
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
  why: null,
  cycle: false,
  ...fields,
});
/** The part a structural cycle is cut at, as the model renders a part already on the path (`?`). */
const CYCLE: Fact = {
  members: [structural({ id: "cycle", cycle: true })],
  optional: false,
  held: false,
};
const asPossible = (fact: Fact, why: DynamicWhy | null): Fact => ({
  ...fact,
  members: fact.members.map((m) => ({ ...m, possible: true, why: m.why ?? why })),
});
/**
 * The provenances an operand's dynamic view is asked with: of its dynamic values and of its possibilities, also a
 * possibility a known member of its type covers (the member keeps the provenance when they join; the model's cell
 * keeps the possibility beside the witness and asks per provenance).
 */
const provenancesOf = (fact: Fact): readonly DynamicWhy[] =>
  [
    ...new Set<DynamicWhy>([
      ...whysOf(fact),
      ...fact.members.flatMap((m) =>
        m.possible ? [m.why ?? "host"] : m.why === null ? [] : [m.why],
      ),
    ]),
  ].sort();
/** The structure of a member, for coverage and identity among flat members. */
const shapeKey = (member: FactMember): string => typeKey(typeOfMember(member), true, true);
/**
 * Whether a fact is held: by a value the compiler cannot know, or by a possibility no known member of the same
 * structure covers (work note §3.5).
 */
function heldOf(fact: Fact): boolean {
  if (fact.held) return true;
  const known = fact.members.filter((m) => !m.possible).map(shapeKey);
  return fact.members.some((m) => m.possible && !known.includes(shapeKey(m)));
}
/** Everything of a fact, for the binding iteration's convergence. */
function factKey(fact: Fact): string {
  const member = (m: FactMember): string =>
    m.cycle
      ? "?"
      : [
          m.ctor ?? "",
          m.props === null
            ? ""
            : `{${[...m.props].map(([n, f]) => `${n}:${factKey(f)}`).join(",")}}`,
          m.open ? "open" : "",
          m.element === null ? "" : factKey(m.element),
          m.type === null ? "" : typeKey(m.type, true, true),
          m.empty ? "e" : "",
          m.decl ? "d" : "",
          m.group ?? "",
          m.id ?? "",
          m.possible ? "p" : "",
          m.why ?? "",
        ].join("|");
  return `${fact.members.map(member).join(";")}#${fact.optional ? "n" : ""}${fact.held ? "h" : ""}${whysOf(fact).join("/")}`;
}
/** The members of a fact in the order its working kind is read: the declaration's first (Q3.1r). */
const byDeclaration = (fact: Fact): Fact => ({
  ...fact,
  members: [...fact.members.filter((m) => m.decl), ...fact.members.filter((m) => !m.decl)],
});
/**
 * A fact as it is read under a path of parts being derived: a structural member whose part is on the path is cut
 * there, the legacy's back-edge widening, as the model renders a part already on the way back to its owner.
 */
function cutOnPath(fact: Fact, path: ReadonlySet<string>): Fact {
  if (path.size === 0) return fact;
  const cut = (member: FactMember, part: string): boolean =>
    member.id !== null && path.has(`${member.id}/${part}`);
  return {
    ...fact,
    members: fact.members.map((member) => {
      if (member.ctor !== null)
        return cut(member, "element")
          ? { ...member, element: CYCLE }
          : {
              ...member,
              element: member.element === null ? null : cutOnPath(member.element, path),
            };
      if (member.props !== null)
        return {
          ...member,
          props: new Map(
            [...member.props].map(([name, value]) => [
              name,
              cut(member, name) ? CYCLE : cutOnPath(value, path),
            ]),
          ),
        };
      return member;
    }),
  };
}

function familyOf(member: FactMember): string {
  if (member.cycle) return "unknown";
  if (member.ctor !== null) return member.ctor;
  if (member.props !== null || member.open) return "object";
  const type = member.type!;
  return type.kind === "scalar" ? (type.name === "number" ? "integer" : type.name) : type.kind;
}

/** The static type of a member for an adapter's view: the parts as the union of their members. */
function typeOfMember(member: FactMember): StaticType {
  if (member.cycle) return UNKNOWN_TYPE;
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
  if (types.length === 0) return heldOf(fact) ? UNKNOWN_TYPE : { kind: "never" };
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
          why: prior.why ?? member.why,
        };
      }
    }
  const whys = [...new Set(facts.flatMap(whysOf))].sort();
  return {
    members,
    optional: facts.some((f) => f.optional),
    held: facts.some((f) => f.held),
    ...(whys.length > 0 ? { whys } : {}),
  };
}

function sameMember(a: FactMember, b: FactMember): boolean {
  if (a.cycle || b.cycle) return a.cycle && b.cycle;
  if (a.ctor !== null || b.ctor !== null)
    return a.ctor === b.ctor && a.group === b.group && a.id === b.id;
  if (a.props !== null || b.props !== null || a.open || b.open)
    return a.id !== null && a.id === b.id && a.group === b.group;
  return (
    typeKey(typeOfMember(a), true, true) === typeKey(typeOfMember(b), true, true) &&
    a.group === b.group
  );
}

/**
 * The decided rules over a fact's members: the declaration's first, else the earliest; a union admits its members;
 * held by a value the compiler cannot know or by a possibility no known member covers.
 */
function exported(fact: Fact): Fact {
  const known = fact.members.filter((m) => !m.possible);
  const held = heldOf(fact);
  const first = known.find((m) => m.decl) ?? known[0];
  if (first === undefined) return { ...fact, members: [], held };
  const admitted = new Set(
    first.group !== null
      ? known.filter((m) => m.group === first.group).map(familyOf)
      : [familyOf(first)],
  );
  return { ...fact, members: known.filter((m) => admitted.has(familyOf(m))), held };
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
  const key = (t: StaticType): string => typeKey(t, true, true);
  const texts = new Map<string, Set<string>>();
  for (const pair of pairs) {
    const own = texts.get(key(pair.type));
    if (own === undefined) texts.set(key(pair.type), new Set([pair.text]));
    else own.add(pair.text);
  }
  const kept = new Set((type.kind === "union" ? type.members : [type]).map(key));
  const all = new Set<string>();
  for (const k of kept) for (const text of texts.get(k) ?? [k]) all.add(text);
  // a member the union merged away keeps its text when it says more than its type (a held mark inside it)
  for (const pair of pairs)
    if (!kept.has(key(pair.type)) && pair.text !== key(pair.type)) all.add(pair.text);
  const sorted = [...all].sort();
  const text = sorted.length === 1 ? sorted[0]! : `(${sorted.join("|")})`;
  return `${text}${working.held ? "!" : ""}`;
}

/** The type of a member as the export builds it: over the exported parts (their working members). */
function exportedType(member: FactMember): StaticType {
  if (member.cycle) return UNKNOWN_TYPE;
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
  if (member.cycle) return "?";
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

/**
 * Which decided rules make the expectation differ from the legacy's fact, by what differs, at every level of the
 * parts; none when nothing a rule decides differs (then no rule explains a difference).
 */
function rulesFor(legacy: Fact | null, expected: Fact): string[] {
  if (legacy === null) return ["a fact the legacy has no site for"];
  return [...new Set(rulesBetween(legacy, expected))];
}

function rulesBetween(legacy: Fact, expected: Fact): string[] {
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
  if ([...a].some((f) => !b.has(f)) || [...b].some((f) => !a.has(f))) {
    rules.push(
      "Q3.1/Q3.1r/Q3.7/Q3.8 (the declaration's family first, else the earliest; a mixed literal's first member; a union that does not fit is a conflict)",
    );
    return rules;
  }
  // the same families: the rules over their parts (an element or a property), recursively
  for (const member of right.members) {
    const other = left.members.find((m) => familyOf(m) === familyOf(member));
    if (other === undefined) continue;
    if (member.ctor !== null && other.ctor !== null)
      rules.push(
        ...rulesBetween(other.element ?? EMPTY, member.element ?? EMPTY).map(
          (rule) => `${rule} in the element`,
        ),
      );
    if (member.props !== null && other.props !== null)
      for (const name of new Set([...member.props.keys(), ...other.props.keys()]))
        rules.push(
          ...rulesBetween(other.props.get(name) ?? EMPTY, member.props.get(name) ?? EMPTY).map(
            (rule) => `${rule} in the property ${JSON.stringify(name)}`,
          ),
        );
  }
  return rules;
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
  readonly #source: string;
  readonly #values = new Map<string, TypeText>();
  readonly #bindingFacts = new Map<string, TypeText>();
  readonly #places = new Map<string, Place>();
  readonly #producers = new Map<PlaceId, Constraint[]>();
  readonly #estimates = new Map<PlaceId, Fact>();
  /** The bindings a derivation read (the dependence of a fact on a copied value changed in place). */
  readonly #touched = new Set<PlaceId>();
  /** Whether a derivation asked a relation with every strict operand a constant (the legacy folds those). */
  #folded = false;
  readonly #constants = new Map<PlaceId, boolean>();

  constructor(graph: ConstraintGraph, legacy: SolvedTypeFacts, source: string) {
    this.#graph = graph;
    this.#source = source;
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

  expect(site: FactSite): Expectation | null {
    const place = this.#places.get(siteKey(site));
    if (place === undefined || place.kind.kind !== "binding") return null;
    this.#touched.clear();
    this.#folded = false;
    const legacyText = this.#bindingFacts.get(siteKey(site));
    const legacy = legacyText === undefined ? null : parse(legacyText);
    const derived = this.#binding(place.id, new Set());
    if (derived === null) return null;
    const touched = [...this.#touched];
    const folded = this.#folded;
    if (place.kind.written !== null && legacyText !== undefined) {
      // a written type is the bound, every member admitted; the place is held by a stored value the compiler cannot
      // know, or by a stored possibility no bound or known member covers (Q3.2a, r10-B4)
      const bound = parse(legacyText.replace(/!$/, ""));
      const members = bound.members.map((m) => ({ ...m, group: `written:${place.id}` }));
      const known = [...members, ...derived.members.filter((m) => !m.possible)].map(shapeKey);
      const expected = {
        ...bound,
        members,
        held:
          derived.held || derived.members.some((m) => m.possible && !known.includes(shapeKey(m))),
      };
      return { text: renderFact(expected), rules: rulesFor(legacy, expected), touched, folded };
    }
    return { text: renderFact(derived), rules: rulesFor(legacy, derived), touched, folded };
  }

  /** The fact of a binding with every family stored, iterated from nothing through any cycle. */
  #binding(place: PlaceId, path: ReadonlySet<string>): Fact | null {
    this.#touched.add(place);
    const known = this.#estimates.get(place);
    if (known !== undefined) return known;
    this.#estimates.set(place, EMPTY);
    let derived: Fact | null = null;
    for (let round = 0; round < 10; round += 1) {
      const next = this.#derive(place, path);
      if (next === null) break;
      // converged when nothing of the fact changed: not only its text (a possibility a known member covers, or a
      // provenance, changes what the next round asks)
      if (derived !== null && factKey(next) === factKey(derived)) {
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

  /** A store's value as it enters the target, cut where a part on the path is reached again. */
  #stored(store: Extract<Constraint, { kind: "store" }>, path: ReadonlySet<string>): Fact {
    const stored =
      store.how === "elements"
        ? this.#elements(this.#value(store.value, path))
        : this.#value(store.value, path);
    const value = cutOnPath(stored, path);
    return DECL_STORES.includes(store.how)
      ? { ...value, members: value.members.map((m) => ({ ...m, decl: true })) }
      : value;
  }

  #derive(into: PlaceId, path: ReadonlySet<string>): Fact | null {
    const stores = this.#stores(into);
    if (stores.length === 0) return null;
    return join(stores.map((store) => this.#stored(store, path)));
  }

  /** The elements of a collection fact (the alternatives of every collection member). */
  #elements(value: Fact): Fact {
    const parts = value.members.filter((m) => m.ctor !== null).map((m) => m.element ?? EMPTY);
    const joined = join(parts);
    return heldOf(value) ? held(joined, provenancesOf(value)) : joined;
  }

  /** The property of an object fact. */
  #property(value: Fact, name: string): Fact {
    const parts = value.members.map((m) => (m.open ? held(EMPTY) : (m.props?.get(name) ?? EMPTY)));
    const joined = join(parts);
    return heldOf(value) ? held(joined, provenancesOf(value)) : joined;
  }

  /** The fact of a value place, by the constraint that produces it. */
  #value(place: PlaceId, path: ReadonlySet<string>): Fact {
    const fact = this.#valueOf(place, path);
    if (process.env["ORACLE_TRACE"] !== undefined)
      console.log(
        `  value ${this.#graph.places[place]?.label ?? place} (${
          this.#producers
            .get(place)
            ?.map((c) => c.kind)
            .join(",") ?? "-"
        }) -> ${renderFact(fact)} [${fact.members.map((m) => `${familyOf(m)}${m.possible ? "?" : ""}${m.why === null ? "" : `(${m.why})`}`).join(",")}${fact.optional ? " null" : ""}${fact.held ? ` held(${whysOf(fact).join("/")})` : ""}]`,
      );
    return fact;
  }

  /**
   * The parts of a literal being derived are the path (`cell:<place>/element`, `cell:<place>/<property>`): a part met
   * again along it is cut there, the legacy's back-edge widening, which bounds the derivation by the cycle, not by
   * a depth (r10-B6).
   */
  #valueOf(place: PlaceId, path: ReadonlySet<string>): Fact {
    const legacy = this.#legacyValue(place);
    const id = `cell:${place}`;
    const under = (part: string): ReadonlySet<string> => new Set([...path, `${id}/${part}`]);
    for (const c of this.#producers.get(place) ?? []) {
      switch (c.kind) {
        case "has":
          if (c.type.kind === "list" || c.type.kind === "set" || c.type.kind === "dict") {
            if (path.has(`${id}/element`))
              return {
                members: [structural({ ctor: c.type.kind, element: CYCLE, id })],
                optional: false,
                held: false,
              };
            const cell =
              c.type.element.kind === "ref"
                ? this.#cell(c.type.element.place, under("element"))
                : { fact: EMPTY, empty: true };
            return {
              members: [
                structural({ ctor: c.type.kind, element: cell.fact, empty: cell.empty, id }),
              ],
              optional: false,
              held: false,
            };
          }
          if (c.type.kind === "object") {
            if (c.type.properties === null)
              return {
                members: [structural({ props: new Map(), open: true, id })],
                optional: false,
                held: false,
              };
            const props = new Map<string, Fact>();
            for (const { name, type } of c.type.properties)
              props.set(
                name,
                path.has(`${id}/${name}`)
                  ? CYCLE
                  : type.kind === "ref"
                    ? this.#cell(type.place, under(name)).fact
                    : EMPTY,
              );
            for (const [name, fact] of this.#storedProperties(c.place, path))
              if (!props.has(name)) props.set(name, fact);
            return { members: [structural({ props, id })], optional: false, held: false };
          }
          if (c.type.kind === "dynamic") return held(EMPTY, [c.type.why]);
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
          // a read takes the binding's members in its working order, the declaration's first, so a copy keeps its
          // source's working kind (r10-B3); where the value enters a part on the path, the store cuts it
          const derived = this.#binding(c.binding, path);
          const text =
            binding.site === null ? undefined : this.#bindingFacts.get(siteKey(binding.site));
          if (binding.kind.written !== null && text !== undefined) {
            const bound = parse(text.replace(/!$/, ""), `bound:${c.binding}`);
            const members = bound.members.map((m) => ({ ...m, group: `written:${c.binding}` }));
            return derived === null
              ? { ...bound, members }
              : {
                  members: [...members, ...derived.members.filter((m) => m.possible)],
                  optional: bound.optional || derived.optional,
                  held: derived.held,
                };
          }
          if (derived !== null) return byDeclaration(derived);
          return text === undefined ? EMPTY : parse(text, `binding:${c.binding}`);
        }
        case "project": {
          const owner = this.#value(c.owner, path);
          return typeof c.step !== "object"
            ? this.#elements(owner)
            : this.#member(owner, c.step.property);
        }
        case "fallback":
          return asUnion(
            join([{ ...this.#value(c.left, path), optional: false }, this.#value(c.right, path)]),
            `fallback@${c.site.start}`,
          );
        case "get":
          return asUnion(
            join([this.#elements(this.#value(c.receiver, path)), this.#value(c.fallback, path)]),
            `get@${c.site.start}`,
          );
        case "operation": {
          const answer = this.#operation(c, path);
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
        parts.push(
          this.#read(answer, (ref) => ("receiver" in ref ? one : null), `member@${name}`, false),
        );
    }
    const joined = join(parts);
    return heldOf(owner) ? held(joined, provenancesOf(owner)) : joined;
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
  #storedProperties(literal: PlaceId, path: ReadonlySet<string>): Map<string, Fact> {
    const occurrences = this.#occurrencesOf(literal);
    const out = new Map<string, Fact[]>();
    for (const c of this.#graph.constraints) {
      if (c.kind !== "project" || typeof c.step !== "object" || !occurrences.has(c.owner)) continue;
      const stores = this.#stores(c.into);
      if (stores.length === 0) continue;
      const name = c.step.property;
      if (path.has(`cell:${literal}/${name}`)) {
        out.set(name, [CYCLE]);
        continue;
      }
      const under = new Set([...path, `cell:${literal}/${name}`]);
      out.set(name, [
        ...(out.get(name) ?? []),
        ...stores.map((store) => this.#stored(store, under)),
      ]);
    }
    return new Map([...out].map(([name, facts]) => [name, join(facts)]));
  }

  /** A literal's own cell: its member stores, and the stores through the variables that hold the literal. */
  #cell(
    cell: PlaceId,
    path: ReadonlySet<string>,
  ): { readonly fact: Fact; readonly empty: boolean } {
    const facts: Fact[] = this.#stores(cell).map((store) => {
      const stored = this.#stored(store, path);
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
        for (const store of this.#stores(c.into)) facts.push(this.#stored(store, path));
      }
    }
    return { fact: join(facts), empty };
  }

  /**
   * Whether a place holds a constant the legacy's `KnownValues` folds: a written number, text or boolean, an
   * operation over constants, or a read of an unwritten variable whose one store is a constant.
   */
  #constant(place: PlaceId): boolean {
    const known = this.#constants.get(place);
    if (known !== undefined) return known;
    this.#constants.set(place, false);
    let constant = false;
    for (const c of this.#producers.get(place) ?? []) {
      if (c.kind === "has" && c.type.kind === "atom") {
        const site = this.#graph.places[place]?.site;
        const text =
          site === null || site === undefined ? "" : this.#source.slice(site.start, site.end);
        constant = /^(-?\d+(\.\d+)?|"[^"]*"|true|false)$/.test(text.trim());
      } else if (c.kind === "operation") {
        const strict = [
          ...(c.receiver === null ? [] : [c.receiver]),
          ...c.arguments,
          ...c.named.filter((n) => n.name !== "default").map((n) => n.value),
        ];
        constant = strict.length > 0 && strict.every((operand) => this.#constant(operand));
      } else if (c.kind === "read") {
        const stores = this.#stores(c.binding);
        constant =
          this.#graph.constraints.some((k) => k.kind === "knownValue" && k.occurrence === place) &&
          stores.length === 1 &&
          this.#constant(stores[0]!.value);
      }
      if (constant) break;
    }
    this.#constants.set(place, constant);
    return constant;
  }

  /** An operation's fact from its adapter: per alternative of each operand, and once with the dynamic view. */
  #operation(
    c: Extract<Constraint, { kind: "operation" }>,
    path: ReadonlySet<string>,
  ): Fact | null {
    const relation = RELATIONS.relation(c.contract);
    if (relation === undefined) return null;
    const operands: {
      readonly ref: OperandRef;
      readonly place: PlaceId;
      readonly fact: Fact;
      readonly lazy: boolean;
    }[] = [
      ...(c.receiver === null
        ? []
        : [
            {
              ref: RECEIVER_REF,
              place: c.receiver,
              fact: this.#value(c.receiver, path),
              lazy: false,
            },
          ]),
      ...c.arguments.map((place, index) => ({
        ref: argumentRef(index),
        place,
        fact: this.#value(place, path),
        lazy: false,
      })),
      ...c.named.map((n) => ({
        ref: namedRef(n.name),
        place: n.value,
        fact: this.#value(n.value, path),
        lazy: n.name === "default",
      })),
    ];
    if (c.contract.family === "logic" && operands[1] !== undefined)
      operands[1] = { ...operands[1], lazy: true };
    const strict = operands.filter((operand) => !operand.lazy);
    if (strict.length > 0 && strict.every((operand) => this.#constant(operand.place)))
      this.#folded = true;

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
    // the choices of each operand, as the lifting's (work note §3.5): its alternatives (an empty-by-construction
    // collection also over never, null as one of them, a possibility as a possible choice), one dynamic view per
    // provenance of its dynamic values and possibilities, an unevaluated lazy operand beside them
    interface Pick {
      readonly view: OperandView;
      readonly chosen: Fact | null;
      readonly possible: boolean;
      readonly dynamic: DynamicWhy | null;
    }
    const choices = operands.map((operand) => {
      const list: Pick[] = [];
      for (const member of operand.fact.members) {
        const type = typeOfMember(member);
        list.push({
          view: { alternatives: [type], dynamic: null, known: undefined },
          chosen: { members: [member], optional: false, held: false },
          possible: member.possible,
          dynamic: null,
        });
        if (member.ctor !== null && member.empty)
          list.push({
            view: {
              alternatives: [{ kind: member.ctor, element: { kind: "never" } }],
              dynamic: null,
              known: undefined,
            },
            chosen: { members: [{ ...member, element: EMPTY }], optional: false, held: false },
            possible: member.possible,
            dynamic: null,
          });
      }
      if (operand.fact.optional)
        list.push({
          view: { alternatives: [NULL_TYPE], dynamic: null, known: undefined },
          chosen: { members: [], optional: true, held: false },
          possible: false,
          dynamic: null,
        });
      const types = [
        ...operand.fact.members.map(typeOfMember),
        ...(operand.fact.optional ? [NULL_TYPE] : []),
      ];
      for (const why of provenancesOf(operand.fact))
        list.push({
          view: { alternatives: types.length === 0 ? null : types, dynamic: why, known: undefined },
          chosen: operand.fact,
          possible: false,
          dynamic: why,
        });
      if (operand.lazy)
        list.push({
          view: { alternatives: null, dynamic: null, known: undefined },
          chosen: null,
          possible: false,
          dynamic: null,
        });
      return list;
    });
    const strictEmpty = operands.some((o, i) => !o.lazy && choices[i]!.length === 0);
    const parts: Fact[] = [];
    if (!strictEmpty) {
      const product = choices.reduce<Pick[][]>(
        (acc, list) => acc.flatMap((combo) => list.map((pick) => [...combo, pick])),
        [[]],
      );
      for (const combo of product.slice(0, 1024)) {
        const chosen = (ref: OperandRef): Fact | null =>
          combo[operands.findIndex((o) => sameRefs(o.ref, ref))]?.chosen ?? null;
        // under a dynamic receiver every applicable case of `byReceiver` is a possibility; a closed answer under a
        // dynamic view is a witness, a dynamic answer held (work note §3.5, r10-B6)
        const receiverDynamic = combo.some(
          (pick, index) => "receiver" in operands[index]!.ref && pick.dynamic !== null,
        );
        const read = this.#read(
          relation.result(inputs(combo.map((pick) => pick.view))),
          chosen,
          site,
          receiverDynamic,
        );
        // a combination over a possibility decides nothing: its answers are possibilities
        const possible = combo.find((pick) => pick.possible);
        const answer =
          possible === undefined
            ? read
            : asPossible(read, possible.chosen?.members.find((m) => m.possible)?.why ?? null);
        parts.push(
          combo.some((pick) => pick.chosen?.members.some((m) => m.group !== null))
            ? asUnion(answer, site)
            : answer,
        );
      }
    }
    return join(parts);
  }

  /**
   * Reads an answer into a fact, with the chosen alternative of each operand for its projections; under a dynamic
   * receiver the cases of `byReceiver` are possibilities.
   */
  #read(
    answer: OperationResult,
    chosen: (ref: OperandRef) => Fact | null,
    site: string,
    dynamicReceiver: boolean,
  ): Fact {
    switch (answer.kind) {
      case "type":
        return parse(typeKey(answer.type, true, true), site);
      case "possible": {
        // a possibility decides nothing on its own: it is held unless a known member of its structure covers it;
        // a structural possibility's parts carry their held marks into the known member they join
        const members = answer.types.flatMap((type) =>
          parse(typeKey(type, true, true), site).members.map((m) => ({
            ...m,
            possible: true,
            why: answer.why,
          })),
        );
        return { members, optional: false, held: false };
      }
      case "dynamic":
        return held(EMPTY, [answer.why]);
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
            this.#read({ kind: "projection", source: part }, chosen, site, dynamicReceiver),
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
        const joined = join(
          answer.results.map((r) => this.#read(r, chosen, site, dynamicReceiver)),
        );
        return bearing >= 2 ? asUnion(joined, site) : joined;
      }
      case "byReceiver": {
        const receiver = chosen({ receiver: true });
        const families = new Set((receiver?.members ?? []).map(familyOf));
        const joined = join(
          answer.cases
            .filter((cs) => families.has(cs.receiver === "number" ? "integer" : cs.receiver))
            .map((cs) => this.#read(cs.result, chosen, site, dynamicReceiver)),
        );
        return dynamicReceiver ? asPossible(joined, null) : joined;
      }
    }
  }
}

/** What the oracle expects for a binding: the text, the rules between it and the legacy's fact, what it read. */
interface Expectation {
  readonly text: string;
  readonly rules: readonly string[];
  /** The bindings the derivation read. */
  readonly touched: readonly PlaceId[];
  /** Whether the derivation asked a relation over constant operands only (the legacy folds those). */
  readonly folded: boolean;
}

/** The members of a fact as the members of a permitted union with the given identity. */
function asUnion(fact: Fact, group: string): Fact {
  return { ...fact, members: fact.members.map((m) => ({ ...m, group })) };
}
