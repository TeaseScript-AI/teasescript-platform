// A list's join (V30 §16): the right operand's elements fit the element type the left operand holds.
import type { PlaceId } from "../../../graph.js";
import type { Admission } from "../../admission.js";
import {
  joinSteps,
  keepText,
  keptSlice,
  keptSteps,
  keptText,
  pathText,
  stepText,
} from "../../budget.js";
import { typeTags } from "../../contract.js";
import { keyStepsIn, stepsArray } from "../../contract/key-ids.js";
import { joinedOperand, keptKey, keyOf, keyPlace } from "../../definitions.js";
import { withoutEmpty } from "../../exact-path.js";
import type { FlowNode } from "../../flow-graph.js";
import type { ItemTag } from "../../items.js";
import type { MixedSteps } from "../../result.js";
import { decided } from "../decision.js";
import { admitsNumber, concrete, fits, NUMERIC } from "../kinds.js";
import type { Join, JoinDecided } from "../model.js";
import { joinedDomain, permittedAt, unrestricted } from "../permitted.js";
import { holdsSource, pathsBelow, sourceOf } from "../structure.js";
import { writtenSource } from "../walk.js";
import {
  type CollectionWalk,
  intermediateDepths,
  joinDecider,
  layersAt,
  mixedOptional,
  type MixedOptional,
  shownOf,
} from "./mixed-sentence.js";
import { literalChildren } from "./stores.js";

/** The carriers a value is read through to what it selects: a projection's owner, an `otherwise`'s sides. */
const RESOLVED: ReadonlySet<string> = new Set([
  "projection/owner",
  "projection/record field",
  "otherwise/operand",
  "otherwise/fallback",
]);

/**
 * ADR 0021 1.3, V30 §4 and §16: a list's `+` (and `+=`) holds both operands' elements, so a join's right operand must
 * fit the element type its left operand holds (#1272), as a store into a variable holding the left one must. Each
 * value's element type at a path is the one a variable holding it is decided by (`scanAt`), so a join answers the same
 * inline as kept in a variable: an operand's own (`decidedAt`: a written copy by its type, a read or a call by its
 * place's decision, else its elements' kinds as a literal's earliest element decides them, `earliestDecider`); a join's
 * from its operands' in evaluation order, the earliest deciding there decides, a written type by itself, else with the
 * kinds of every operand the join holds; each operand's domain by `joinedDomain` (an open one leaves the join open, one
 * holding only `null` decides nothing but at a strict written destination). A right operand whose elements there are of
 * one other family, none of whose kinds fits, is an error at its join, unless the written type the tree lands in
 * directly holds both, and is rejected from that join. A right operand is compared at the paths of its own structure,
 * a join's at its list levels as a variable holding it is (`pathsBelow`); a join's paths are its operands', the
 * smaller one's added to the larger one's, so a chain of k joins, on either side, costs its operands' structures once.
 * `error` hears of each with the join, the path, the decided kinds there and the operand's, the tree's value, whose
 * declaration a fix may give the type (#1268), and the type it writes: `levels`, what the tree's elements hold at each
 * list level down to the path, its `null`s and numbers kept. `undecided`, before admission settled: a join an operand
 * of which is read through a decision. `stopped`, after it settled: a join an operand of which a stop left undecided
 * (#2289: a literal's element), not compared.
 */
export function joinElements(
  admission: Admission,
  order: <T>(list: readonly T[]) => T[],
  error: (found: {
    readonly c: Join;
    readonly path: readonly string[];
    readonly earliest: readonly ItemTag[];
    readonly kinds: readonly ItemTag[];
    readonly value: PlaceId;
    readonly levels: readonly (readonly ItemTag[])[] | null;
    readonly optional?: MixedOptional;
    readonly shown?: MixedSteps;
  }) => void,
  undecided?: (value: PlaceId) => void,
  stopped?: (value: PlaceId) => void,
): void {
  const { program, contract, definitions } = admission.pass;
  const family = (tag: ItemTag): ItemTag => (NUMERIC.has(tag) ? "number" : tag);
  const joins = new Map<PlaceId, Join>();
  for (const c of program.constraints)
    if (
      c.kind === "operation" &&
      c.contract.family === "operator" &&
      c.contract.name === "+" &&
      c.arguments.length === 2
    )
      joins.set(c.result, c);
  // (a tree's root: no join's operand)
  const inner = new Set<PlaceId>();
  for (const c of joins.values())
    for (const operand of c.arguments) if (joins.has(operand)) inner.add(operand);
  const roots: Join[] = [];
  for (const c of joins.values()) if (!inner.has(c.result)) roots.push(c);
  const byResult = new Map<PlaceId, Join>();
  for (const root of roots) byResult.set(root.result, root);
  // a tree's operands in source order, each with the node it is read at (a `+=`'s its statement's): what the type a fix
  // writes holds (`levelsAt`); and its joins, each before the joins it holds; once per tree
  const shapes = new Map<
    PlaceId,
    {
      readonly operands: readonly { readonly operand: PlaceId; readonly node: FlowNode }[];
      readonly tree: readonly Join[];
    }
  >();
  const shapeOf = (root: Join) => {
    const known = shapes.get(root.result);
    if (known !== undefined) return known;
    const operands: { readonly operand: PlaceId; readonly node: FlowNode }[] = [];
    const tree: Join[] = [];
    const pending: { value: PlaceId; node: FlowNode | null }[] = [
      { value: root.result, node: null },
    ];
    while (pending.length > 0) {
      const { value, node } = pending.pop()!;
      program.work.charge("checks");
      const c = joins.get(value);
      if (c === undefined) {
        if (node !== null) operands.push({ operand: value, node });
        continue;
      }
      tree.push(c);
      const at = program.exprAt(c.site) ?? program.flow.statementAt(c.site) ?? null;
      pending.push({ value: c.arguments[1]!, node: at });
      pending.push({ value: c.arguments[0]!, node: at });
    }
    const shape = { operands, tree };
    shapes.set(root.result, shape);
    return shape;
  };
  // each value's element type per path, as a variable holding it is decided (`scanAt`): an operand's own at the paths
  // of its structure, a join's its operands' in evaluation order (its paths the earliest decider of each, the kinds of
  // every operand it holds there), the earliest operand deciding the element asked at any other path (its type may give
  // it); read once per operand, never by reading a join's tree again (#1310). An operand open at a path (`list`, V30
  // §13: any list) leaves the join open there and below, whichever operand came first: no conflict is proved from it
  // (#1310)
  interface Decider {
    readonly decided: JoinDecided | "open";
    readonly position: number;
  }
  interface Entry {
    readonly path: readonly string[];
    first: Decider | null;
    readonly kinds: Set<ItemTag>;
  }
  interface Held {
    readonly entries: Map<string, Entry>;
    /** The paths an operand leaves open: open there and below. */
    readonly opens: Set<string>;
    /** Its list levels: where a variable holding it is compared (`pathsBelow`). */
    readonly levels: Set<string>;
    head: { readonly operand: PlaceId; readonly node: FlowNode; readonly position: number } | null;
  }
  // (what an operand's value is, through the projections the join rule resolves (`carriersOf`, a literal's cells at the
  // step read): a projection's owner, an `otherwise`'s sides; each part an earlier tree's join, whose composed type
  // stands for it, or a value taken for its own type; `null` where no part is a join, or a step is read into a value
  // that is no literal and carries nothing. The join check never derives again a type the join rule already composed:
  // a join answers the same inline as kept, #1310)
  type Part = { readonly join: PlaceId } | { readonly leaf: PlaceId };
  const reaches = new Map<PlaceId, readonly Part[] | null>();
  const reachOf = (operand: PlaceId): readonly Part[] | null => {
    const known = reaches.get(operand);
    if (known !== undefined) return known;
    const parts: Part[] = [];
    let joined = false;
    let resolved = true;
    const pending: (readonly [PlaceId, readonly string[]])[] = [[operand, []]];
    while (resolved && pending.length > 0) {
      const [at, strip] = pending.pop()!;
      program.work.charge("checks");
      if (joins.has(at)) {
        resolved = strip.length === 0 && byResult.has(at);
        parts.push({ join: at });
        joined = true;
        continue;
      }
      const literal = program.hasOf.has(at);
      if (writtenSource(admission, at, strip) === null && literal && strip.length > 0) {
        const children = literalChildren(admission, at, strip[0]!);
        resolved = children.length > 0;
        const rest = keptSlice(admission.work, strip, 1);
        for (let index = children.length - 1; index >= 0; index -= 1)
          pending.push([children[index]!.value!, rest]);
        continue;
      }
      const carried =
        literal || sourceOf(admission, at) !== null || writtenSource(admission, at, strip) !== null
          ? []
          : admission.carriersOf(at, strip);
      if (carried.length > 0 && carried.every(([, , role]) => RESOLVED.has(role))) {
        for (let index = carried.length - 1; index >= 0; index -= 1)
          pending.push([carried[index]![0], carried[index]![1]]);
        continue;
      }
      resolved = strip.length === 0;
      parts.push({ leaf: at });
    }
    const out = resolved && joined ? parts : null;
    reaches.set(operand, out);
    return out;
  };
  // (each tree composed once, a tree an operand reaches before the tree reading it, and reported in the order given)
  const composed = new Map<PlaceId, { readonly held: Held | null; readonly report: () => void }>();
  // (the trees whose composed type an operand took: each is reached once, by the operand holding it)
  const taken = new Set<PlaceId>();
  const compose = (root: Join): { readonly held: Held | null; readonly report: () => void } => {
    const { operands, tree } = shapeOf(root);
    const reports: (() => void)[] = [];
    const done = (final: Held | null) => ({
      held: final,
      report: () => {
        for (const each of reports) each();
      },
    });
    if (operands.length < 2) return done(null);
    let halted = false;
    // (before admission settled, a decision is read nowhere: a join with an operand that reads a place or holds a
    // source, a copy or a call, is marked instead, as a literal with a named element is)
    if (
      undecided !== undefined &&
      operands.some(
        ({ operand }) =>
          contract.copiedKey(operand) !== null ||
          contract.resultKey(operand) !== null ||
          holdsSource(admission, operand),
      )
    ) {
      reports.push(() => undecided(root.result));
      return done(null);
    }
    const written = contract.landsIn(root.result, []);
    // (a `+=`'s left operand reads the place its store sets, a selection there an own property where the store's
    // target keeps it, #1275)
    const target = (definitions.byValue.get(root.result) ?? []).find(
      (d) => d.kind === "whole" && d.how === "compound",
    );
    const stored = (operand: PlaceId): boolean =>
      target !== undefined && operand === root.arguments[0];
    const isList = (operand: PlaceId, node: FlowNode): boolean =>
      stored(operand)
        ? admission.admitted(target!.place, target!.path).includes("list")
        : admission.items(operand, node, []).some((item) => item.tag === "list");
    // the place an operand reads, whose admitted type is its type: a variable's or a property's, a call's result
    // (a written result's type decides, #1310), a `+=`'s target
    const placeOf = (
      operand: PlaceId,
    ): { readonly place: PlaceId; readonly path: readonly string[] } | null => {
      if (stored(operand)) return target!;
      const key = contract.copiedKey(operand) ?? contract.resultKey(operand);
      // (a tree's target keeps an array: a cursor's steps copied out, `stepsArray`)
      return key === null
        ? null
        : { place: keyPlace(key), path: stepsArray(keyStepsIn(contract, key)) };
    };
    // (the left operand that reads the place the tree is stored into, a `+=`'s or `xs = xs + …`'s: a strict written
    // destination, whose type holds only what it holds)
    const destination = (operand: PlaceId): boolean => {
      if (operand !== root.arguments[0]) return false;
      if (stored(operand)) return true;
      const read = placeOf(operand);
      return (
        read !== null &&
        (definitions.byValue.get(root.result) ?? []).some(
          (d) =>
            d.kind === "whole" &&
            d.place === read.place &&
            pathText(d.path) === pathText(read.path),
        )
      );
    };
    // what an operand's elements are at a path, by `joinedDomain`: a written copy's type, a read's place's decision,
    // the earliest deciding value's kinds, else its own kinds of one family and no unknown (a type holding only `null`
    // decides nothing, its `null` the sentence's walk's, never an empty domain no kind fits, but at a strict written
    // destination, #1310)
    const decidedAt = (
      operand: PlaceId,
      node: FlowNode,
      path: readonly string[],
    ): JoinDecided | "open" | null => {
      const at = joinSteps(["element"], path);
      const decider = joinDecider(admission, operand, node, at);
      // (#2289: a literal's element a stop left undecided leaves the join undecided: it is reported, not compared)
      if (decider?.stopped === true) {
        halted = true;
        return null;
      }
      if (decider !== null && decider.term !== null) {
        const domain = joinedDomain(typeTags(decider.term));
        if (domain === "open") return "open";
        if (domain === "null" && !destination(operand)) return null;
        const tags = typeTags(decider.term).filter((tag) => tag !== "null");
        return {
          tags,
          exact: true,
          typed: true,
          own: tags,
          nullable: typeTags(decider.term).includes("null"),
        };
      }
      const read = placeOf(operand);
      const place = read === null ? null : decided(admission, read.place, joinSteps(read.path, at));
      if (place?.tags !== null && place?.tags !== undefined) {
        const domain = joinedDomain(place.tags);
        if (domain === "open") return "open";
        if (domain === "null" && !(place.byWritten && destination(operand))) return null;
        const tags = place.tags.filter((tag) => tag !== "null");
        return {
          tags,
          exact: place.byWritten,
          typed: place.byWritten,
          own: tags,
          nullable: place.byWritten && place.nullable,
        };
      }
      const items = admission.items(operand, node, at);
      const kinds =
        decider?.tags ??
        (items.some((item) => item.tag === "unknown")
          ? []
          : [...new Set(items.filter(concrete).map((item) => item.tag))]);
      // (whole numbers beside numbers are numbers, ADR 0021 1.3, as a place's decision has them)
      const own =
        kinds.includes("integer") && items.some(admitsNumber)
          ? [...new Set(kinds.map(family))]
          : kinds;
      // (elements of several families hold a union an earlier type declared, a written result's through a copy:
      // each of its kinds fits as itself)
      return own.length === 0
        ? null
        : { tags: own, exact: new Set(own.map(family)).size > 1, typed: false, own };
    };
    // (the type a fix writes holds every value the tree's operands bring and every legitimate store of the places
    // they read and it lands in: at each list level down to a path of elements, a place's admitted type, a value's
    // kinds, `null` among them, and numbers where external data may give one beside whole numbers; per path once,
    // whatever errs there)
    const levels = new Map<string, readonly (readonly ItemTag[])[] | null>();
    const levelsAt = (path: readonly string[]): readonly (readonly ItemTag[])[] | null => {
      const at = keptText(admission.work, path);
      if (levels.has(at)) return levels.get(at)!;
      let out: ItemTag[][] | null = null;
      if (path.every((step) => step === "element")) {
        out = [];
        for (let depth = 0; depth <= path.length; depth += 1) {
          const kinds = new Set<ItemTag>();
          let external = false;
          const prefix = keptSlice(admission.work, path, 0, depth);
          const steps = joinSteps(["element"], prefix);
          // (a place's admitted type, every legitimate store into it held: its written type, or its decision with
          // its null and its numbers; a number external data may store there too)
          const admitted = (place: PlaceId, path: readonly string[]): boolean => {
            const below = joinSteps(path, steps);
            const tags = admission.admitted(place, below).filter((tag) => tag !== "unknown");
            for (const tag of tags) kinds.add(tag);
            for (const item of withoutEmpty(
              admission.run(contract.contractOf(keyOf(place, below))),
            ))
              external ||= item.tag === "number" && item.extOnly === true;
            return tags.length > 0;
          };
          for (const { operand, node } of operands) {
            const read = placeOf(operand);
            if (read !== null && admitted(read.place, read.path)) continue;
            // (a value's own elements; external data is checked where it comes in: its kinds are no part of the
            // type, but a number it may give makes whole numbers numbers, as an operation on it may)
            for (const item of admission.items(operand, node, steps))
              if (item.tag === "unknown" || item.extOnly === true)
                external ||= item.tag === "number";
              else kinds.add(item.tag);
            // (a written type it copies may hold null where its value does not yet)
            const ruled = decidedAt(operand, node, prefix);
            if (ruled !== null && ruled !== "open" && ruled.nullable === true) kinds.add("null");
          }
          // (and the place the tree lands in, whose other stores the fix keeps too, once admission settled)
          if (undecided === undefined)
            for (const d of admission.pass.definitions.byValue.get(root.result) ?? [])
              if (d.kind === "whole") admitted(d.place, d.path);
          // (whole numbers beside numbers are numbers, in the whole numbers' place)
          out.push(
            external || kinds.has("number")
              ? [...new Set([...kinds].map((kind) => (kind === "integer" ? "number" : kind)))]
              : [...kinds],
          );
        }
      }
      levels.set(at, out);
      return out;
    };
    // (an operand's place in evaluation order: where its source starts, so an earlier tree's composed type keeps its
    // own operands' places inside the operand that reaches it, before every operand after it and after every one before)
    const startOf = (value: PlaceId): number => program.places[value]?.site?.start ?? 0;
    const positions = new Map<PlaceId, { readonly node: FlowNode; readonly position: number }>();
    for (const { operand, node } of operands)
      positions.set(operand, { node, position: startOf(operand) });
    const leaf = (operand: PlaceId, node: FlowNode, position: number): Held | null => {
      if (!isList(operand, node)) return null;
      const held: Held = { entries: new Map(), opens: new Set(), levels: new Set(), head: null };
      const paths: (readonly string[])[] = [[]];
      for (const path of pathsBelow(admission, operand, []))
        if (path.length > 1 && path[0] === "element")
          paths.push(keptSlice(admission.work, path, 1));
      for (const path of paths) {
        program.work.charge("checks");
        const at = keptText(admission.work, path);
        const ruled = decidedAt(operand, node, path);
        held.entries.set(at, {
          path,
          first: ruled === null ? null : { decided: ruled, position },
          kinds: new Set(ruled === null || ruled === "open" ? [] : ruled.own),
        });
        if (ruled === "open") held.opens.add(at);
        if (path.every((step) => step === "element")) held.levels.add(at);
        if (path.length === 0 && ruled !== null) held.head = { operand, node, position };
      }
      // (a written type open at a list level below its value's levels, `list[]` holding no element yet, leaves the join
      // open there too: each further level asked once while a written type decides the one above and holds lists there.
      // A written type's levels end; a level decided by values alone ends the descent, since below its structure a value
      // is a list only through a cycle that adds a step each turn, followed no further (ADR 0021 1.1, #2763))
      let level: readonly string[] = [];
      let above = held.entries.get("")?.first?.decided ?? null;
      while (above !== null && above !== "open" && above.typed && above.tags.includes("list")) {
        program.work.charge("checks");
        level = keptSteps(admission.work, level, ["element"]);
        const at = keptText(admission.work, level);
        const entry = held.entries.get(at);
        above =
          entry !== undefined ? (entry.first?.decided ?? null) : decidedAt(operand, node, level);
        if (entry === undefined && above === "open") held.opens.add(at);
      }
      return held;
    };
    // (a head's decisions at paths its structure does not give, each asked once)
    const asked = new Map<
      PlaceId,
      Map<string, { readonly decided: JoinDecided | "open" } | null>
    >();
    const decisionOf = (
      held: Held,
      path: readonly string[],
      at: string,
    ): { readonly decided: JoinDecided | "open" } | null => {
      // (open at the path or above it: each prefix's text one step longer than the last)
      if (held.opens.size > 0)
        for (let depth = 0, text = ""; depth <= path.length; depth += 1) {
          program.work.charge("checks");
          if (depth > 0) text = depth === 1 ? path[0]! : stepText(text, path[depth - 1]!);
          keepText(admission.work, text.length);
          if (held.opens.has(text)) return { decided: "open" };
        }
      const entry = held.entries.get(at);
      let first = entry?.first ?? null;
      let kinds: ReadonlySet<ItemTag> = entry?.kinds ?? new Set();
      const head = held.head;
      if (head !== null && (first === null || head.position < first.position)) {
        let mine = asked.get(head.operand);
        if (mine === undefined) asked.set(head.operand, (mine = new Map()));
        let found = mine.get(at);
        if (found === undefined) {
          const ruled = decidedAt(head.operand, head.node, path);
          found = ruled === null ? null : { decided: ruled };
          mine.set(at, found);
        }
        if (found !== null) {
          const { decided: ruled } = found;
          first = { decided: ruled, position: head.position };
          if (ruled !== "open") kinds = new Set([...kinds, ...ruled.own]);
        }
      }
      if (first === null) return null;
      const { decided: ruled } = first;
      if (ruled === "open" || ruled.typed || [...kinds].every((kind) => ruled.own.includes(kind)))
        return { decided: ruled };
      // (a value's kinds, as `decidedAt` reads them: whole numbers beside numbers are numbers, ADR 0021 1.3; several
      // families each fit as itself)
      const own = kinds.has("number") ? [...new Set([...kinds].map(family))] : [...kinds];
      return {
        decided: { tags: own, exact: new Set(own.map(family)).size > 1, typed: false, own },
      };
    };
    // (a join's paths: the smaller operand's added to the larger one's, the earlier decider at each)
    const joined = (left: Held, right: Held): Held => {
      const [into, from] = left.entries.size < right.entries.size ? [right, left] : [left, right];
      for (const [at, entry] of from.entries) {
        program.work.charge("checks");
        const known = into.entries.get(at);
        if (known === undefined) {
          into.entries.set(at, entry);
          continue;
        }
        if (
          entry.first !== null &&
          (known.first === null || entry.first.position < known.first.position)
        )
          known.first = entry.first;
        for (const kind of entry.kinds) known.kinds.add(kind);
      }
      for (const at of from.opens) into.opens.add(at);
      for (const at of from.levels) into.levels.add(at);
      if (from.head !== null && (into.head === null || from.head.position < into.head.position))
        into.head = from.head;
      return into;
    };
    // (an earlier join's composed type for an operand that reaches it, taken whole: a join's result is reached by one
    // operand only, and its own operands' places stand inside that operand's; compared at its list levels, as a join is
    // (its paths are the earlier tree's, which grow with a chain, #1383))
    const reaching = new Set<PlaceId>();
    // (an operand's parts in evaluation order, the earlier part `first`: the earliest deciding at a path decides alone, as
    // `decidedAt`'s earliest decider does, a later part adding only the numbers that make whole numbers numbers, and
    // deciding where no earlier part does. The larger part's map is the result, by reference, and only the
    // smaller part's entries, opens and levels are visited, whichever of the two it is, so a growing earlier join is never
    // walked again whatever position it stands in, #1310)
    const parted = (first: Held, later: Held): Held => {
      const numbers = (into: Entry, from: Entry): void => {
        if (into.kinds.has("integer"))
          for (const kind of from.kinds) if (NUMERIC.has(kind)) into.kinds.add(kind);
      };
      if (first.entries.size >= later.entries.size) {
        // (a later part leaves its paths open where the earlier part decides nothing: asked before its entries join)
        for (const at of later.opens) {
          program.work.charge("partVisits");
          if ((first.entries.get(at)?.first ?? null) === null) first.opens.add(at);
        }
        for (const [at, entry] of later.entries) {
          program.work.charge("partVisits");
          const known = first.entries.get(at);
          if (known !== undefined && known.first !== null) {
            numbers(known, entry);
            continue;
          }
          first.entries.set(at, entry);
        }
        for (const at of later.levels) first.levels.add(at);
        first.head ??= later.head;
        return first;
      }
      for (const [at, entry] of first.entries) {
        program.work.charge("partVisits");
        const known = later.entries.get(at);
        if (entry.first === null) {
          if (known === undefined) later.entries.set(at, entry);
          continue;
        }
        if (known !== undefined) numbers(entry, known);
        later.entries.set(at, entry);
        later.opens.delete(at);
      }
      for (const at of first.opens) later.opens.add(at);
      for (const at of first.levels) later.levels.add(at);
      later.head = first.head ?? later.head;
      return later;
    };
    const reached = (operand: PlaceId): Held | null | undefined => {
      const parts = reachOf(operand);
      if (
        parts === null ||
        parts.some(
          (part) =>
            "join" in part &&
            ((composed.get(part.join)?.held ?? null) === null || taken.has(part.join)),
        )
      )
        return undefined;
      const { node } = positions.get(operand)!;
      let out: Held | null = null;
      for (const part of parts) {
        let one: Held | null;
        if ("join" in part) {
          taken.add(part.join);
          one = composed.get(part.join)!.held;
        } else one = leaf(part.leaf, node, startOf(part.leaf));
        out = out === null ? one : one === null ? out : parted(out, one);
      }
      reaching.add(operand);
      return out;
    };
    // each join after the joins it holds, its operands' values taken once
    const held = new Map<PlaceId, Held | null>();
    const take = (value: PlaceId): Held | null => {
      if (!joins.has(value)) {
        const found = reached(value);
        if (found !== undefined) return found;
        const { node, position } = positions.get(value)!;
        return leaf(value, node, position);
      }
      const found = held.get(value) ?? null;
      held.delete(value);
      return found;
    };
    for (const c of tree.toReversed()) {
      const [left, right] = [c.arguments[0]!, c.arguments[1]!];
      const ours = take(left);
      const theirs = take(right);
      let rejected = !admission.pass.lists.joined(right);
      if (ours !== null && theirs !== null)
        for (const at of joins.has(right) || reaching.has(right)
          ? theirs.levels
          : theirs.entries.keys()) {
          program.work.charge("checks");
          const path = theirs.entries.get(at)!.path;
          const ruled = decisionOf(ours, path, at);
          if (ruled === null || ruled.decided === "open") continue;
          const own = decisionOf(theirs, path, at);
          if (own === null || own.decided === "open") continue;
          const kinds = own.decided.own;
          const { tags, exact } = ruled.decided;
          if (
            (exact ? kinds : kinds.map(family)).some((tag) =>
              tags.some((ref) => fits(tag, ref, exact)),
            )
          )
            continue;
          // (a written type the tree lands in directly holds both)
          const landing =
            written === null ? null : permittedAt(written, joinSteps(["element"], path));
          if (
            landing !== null &&
            (unrestricted(landing) ||
              [...ruled.decided.own, ...kinds].every((tag) =>
                typeTags(landing).some((ref) => fits(tag, ref, true)),
              ))
          )
            continue;
          // (#1765: the layers between the element and the leaf that may hold null, each side's by its form, as a
          // literal's elements are: each operand walked down below its elements; #1790/#1828: and its
          // leaf by the same walk one depth more, the sentence's null as this occurrence holds it, not as the decided
          // domain allows it: `n: integer? = 1` joined names no null, a copied `integer?[]` its written leaf)
          const joinNode = program.exprAt(c.site) ?? program.flow.statementAt(c.site) ?? null;
          const below = joinSteps(["element"], path);
          const depths = [...intermediateDepths(path).map((depth) => depth + 1), below.length];
          const layers = (side: PlaceId): boolean[] =>
            joinNode === null
              ? depths.map(() => false)
              : layersAt(admission, side, joinNode, below, depths);
          // (an operand whose occurrence says nothing at the leaf, as a compound assignment's target read through a
          // property, names its place's admitted null there: the walk has nothing to read)
          const leafOf = (side: PlaceId, walked: boolean[]): boolean[] => {
            if (walked.at(-1)! || joinNode === null) return walked;
            const read = placeOf(side);
            if (
              read === null ||
              !admission.items(side, joinNode, below).every((item) => item.tag === "unknown") ||
              !admission.admitted(read.place, joinSteps(read.path, below)).includes("null")
            )
              return walked;
            return [...walked.slice(0, -1), true];
          };
          const [leftLayers, rightLayers] = [
            leafOf(left, layers(left)),
            leafOf(right, layers(right)),
          ];
          const optional = mixedOptional(leftLayers.slice(0, -1), rightLayers.slice(0, -1));
          // (#1762, #1825: each operand's layers are a dict's or a set's by the same walk below its elements, its
          // contract's items, #1814)
          const collections =
            (side: PlaceId): CollectionWalk =>
            (fact, walked, asked) =>
              joinNode === null
                ? asked.map(() => false)
                : layersAt(
                    admission,
                    side,
                    joinNode,
                    keptSteps(admission.work, ["element"], walked),
                    asked.map((depth) => depth + 1),
                    fact,
                  );
          const found: Parameters<typeof error>[0] = {
            ...(optional === undefined ? {} : { optional }),
            c,
            path,
            ...shownOf(path, collections(left), collections(right)),
            earliest: leftLayers.at(-1)! ? [...ruled.decided.own, "null"] : ruled.decided.own,
            kinds: rightLayers.at(-1)! ? [...kinds, "null"] : kinds,
            value: root.result,
            levels: levelsAt(path),
          };
          const key = keptKey(admission.work, c.result, joinSteps(["element"], path));
          reports.push(() => {
            error(found);
            admission.rejections += 1;
            admission.newlyRejected.set(joinedOperand(right), new Set([key]));
          });
          rejected = true;
          break;
        }
      held.set(
        c.result,
        theirs === null || rejected ? ours : ours === null ? theirs : joined(ours, theirs),
      );
    }
    const stop = undecided ?? stopped;
    // (no test reaches this guard; it stays so that a stop never loses a check, #2289)
    if (halted && stop !== undefined) return { held: null, report: () => stop(root.result) };
    return done(held.get(root.result) ?? null);
  };
  // (a tree after the earlier trees its operands reach: each asked before the tree reading it, without recursion)
  const ensure = (first: Join): void => {
    const stack: { readonly root: Join; ready: boolean }[] = [{ root: first, ready: false }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      program.work.charge("checks");
      if (composed.has(top.root.result)) stack.pop();
      else if (top.ready) {
        stack.pop();
        composed.set(top.root.result, compose(top.root));
      } else {
        top.ready = true;
        for (const { operand } of shapeOf(top.root).operands)
          for (const part of reachOf(operand) ?? [])
            if ("join" in part && !composed.has(part.join))
              stack.push({ root: byResult.get(part.join)!, ready: false });
      }
    }
  };
  for (const root of order(roots)) {
    ensure(root);
    composed.get(root.result)!.report();
  }
}
