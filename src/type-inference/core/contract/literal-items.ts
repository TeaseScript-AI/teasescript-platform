import type { PlaceId } from "../../graph.js";
import { joinParts } from "../budget.js";
import type { Contract } from "../contract.js";
import { SELECTED_TEXT, SELECTED_VALUE } from "../definitions.js";
import type { FlowNode } from "../flow-graph.js";
import { EMPTY, firstContext, makeItem, mergeItems, REASON, type Item } from "../items.js";
import type { Work } from "../solver.js";
import type { FlowSink } from "./contributions.js";
import { WIDE } from "./choices.js";
import { gatherAt, gatherCount, selectionPiece } from "./gather.js";
import { OPAQUE_MEMBER, unknownItem } from "./kinds.js";
import { lackingAt, nodeAt, pathAt } from "./literal-index.js";
import type { GatherSite, IndexNode, IndexSite, LiteralIndex } from "./model.js";
import {
  restPart,
  restRef,
  restSteps,
  someStepOf,
  stepsFrom,
  stepsRest,
  type Rest,
} from "./key-ids.js";
import { selectionOf, selectionPieces } from "./selections.js";

// A literal's items at a path from its index, and its type or its cell's stores at a path.

/**
 * A literal's items at a path from its index: the value side (`exact`:
 * docs/specifications/type-inference-accepted-record/contract.md#section-2-f12, a read below an element step is not
 * followed below its own kinds but takes its contract), else the contract.
 */
export function* indexItems(
  contract: Contract,
  literal: PlaceId,
  asked: Rest,
  node: FlowNode | null,
  exact: boolean,
  below = false,
  flow: FlowSink | null = null,
): Work<readonly Item[]> {
  const { program } = contract.pass;
  // (#1668: the value side's gathers are its own: a contract that reads a literal exactly records no flow of it)
  if (exact) flow?.opaque("exact");
  // (a cursor's span read one step at a time as far as the index goes, its rests views)
  const rest = restRef(contract, asked);
  const index = contract.literalIndex(literal);
  // an element cell, or a literal read as one (`below`): every path below lies below an element step
  const inElement = below || program.cellOwner.get(literal)?.kind === "cell";
  const out: Item[] = [];
  // the read passes an element step over a copy
  let overCopy = false;
  // the contributions the read gathers: past an element step, several of them are several elements, of which
  // positions do not tell which one
  let sources = 0;
  // each prefix of the path: its id and the index's node there, `null` past the deepest one the index holds
  const paths: ({ readonly id: number; readonly at: IndexNode } | null)[] = [
    { id: 0, at: index.root },
  ];
  for (let length = 0; length < rest.length; length += 1) {
    const above = paths[length]!;
    const at = above === null ? undefined : above.at.children.get(rest.at(length));
    if (above === null || at === undefined) {
      paths.push(null);
      break;
    }
    paths.push({ id: pathAt(contract, above.id, rest.at(length)), at });
  }
  for (const [tag, token] of paths[rest.length]?.at.terms ?? []) {
    out.push(makeItem(tag, token));
    sources += 1;
  }
  let elementAbove = inElement;
  for (let length = 0; length <= rest.length; length += 1) {
    program.work.charge("invSteps");
    if (length > 0 && rest.at(length - 1) === "element") elementAbove = true;
    const prefix = paths[length];
    if (prefix === null || prefix === undefined) break;
    const path = prefix.id;
    // (the rest below the path, made only for an entry that stands there)
    let tail: Rest | undefined;
    const after = (): Rest =>
      (tail ??=
        rest.kind === "span" ? rest.from(length) : stepsRest(stepsFrom(restSteps(asked), length)));
    if (!exact) {
      // (each kind read one by one, or past `WIDE` of them as a tree of demands, so a ring of copies through a wide
      // literal changes only the nodes above each changed read, never the whole literal, #1229)
      const deeper = length < rest.length;
      for (const kind of ["reads", "groups"] as const) {
        const site: IndexSite = { kind, literal, path, deeper };
        const count = gatherCount(contract, site);
        if (count <= WIDE)
          for (let at = 0; at < count; at += 1)
            out.push(...(yield* gatherAt(contract, site, node, after(), at, flow)));
        else
          for (const item of yield* contract.gathered(site, node, after(), 0, count, flow))
            out.push(item);
      }
    } else {
      const copies = length < rest.length && elementAbove ? prefix.at.reads : null;
      if (copies !== null && copies.length > 0) overCopy = true;
      // (each kind of contribution read one by one, or past `WIDE` of them as a tree of demands, `gathered`)
      const deeper = length < rest.length;
      for (const kind of [copies !== null ? "copies" : "exact", "others"] as const) {
        const site: IndexSite = { kind, literal, path, deeper };
        const count = gatherCount(contract, site);
        if (count <= WIDE)
          for (let at = 0; at < count; at += 1)
            // #1668: the value side's exact gather: its includer records `opaque`
            out.push(...(yield* gatherAt(contract, site, node, after(), at)));
        else
          // #1668: the value side's exact gather: its includer records `opaque`
          for (const item of yield* contract.gathered(site, node, after(), 0, count))
            out.push(item);
      }
      sources += (copies ?? prefix.at.exact).length + prefix.at.others.length;
    }
    // V30 §19: a choice object's button value, per record alternative here
    const step = length < rest.length ? rest.at(length) : undefined;
    if (step === SELECTED_VALUE || step === SELECTED_TEXT) {
      flow?.opaque("selection");
      // #1668: a selection's alternatives: its includer records `opaque`
      const selected = yield* selectedAt(
        contract,
        literal,
        index,
        path,
        step === SELECTED_VALUE,
        rest.kind === "span"
          ? rest.from(length + 1)
          : stepsRest(stepsFrom(restSteps(asked), length + 1)),
        node,
        exact,
        elementAbove,
      );
      // (one by one: a selection's alternatives grow with the source, past one call's arguments)
      for (const item of selected.items) out.push(item);
      // each alternative a selection takes is a contribution of the read (several past an element step)
      sources += selected.sources;
      break;
    }
    if (length === rest.length) break;
    // an object here without the next step contributes `missing`; a reference, an opaque member
    const lacking = lackingAt(contract, index, path, rest.at(length));
    if (lacking !== null)
      out.push(
        exact
          ? makeItem("unknown", lacking, { reasons: REASON.missing, context: "missing" })
          : unknownItem(REASON.missing, lacking),
      );
    if (prefix.at.reference) out.push(exact ? OPAQUE_MEMBER : unknownItem(REASON.opaque));
    // an empty collection on the way holds no element (the contract's emptiness mark below it; the value's at its end)
    if (
      rest.at(length) === "element" &&
      paths[length + 1]?.at.empty === true &&
      (!exact || length === rest.length - 1)
    )
      out.push(EMPTY);
  }
  // the route `literalRoute` reads: past an element step over a copy the contract answered
  if (exact && overCopy)
    contract.overCopy.add(contract.kept(joinParts(literal, restPart(asked), node?.id ?? "-")));
  // the exact path's word is the read's (`member` past an element step over a copy), shared by every known-kind
  // item, definite ones included, whatever its writer; an unknown keeps its reason's word. Past an element step that
  // gathers several elements the element read makes each kind only possible: its word too, by the precedence
  if (overCopy)
    return out.map((item) =>
      item.tag === "unknown" || item.tag === "empty" ? item : { ...item, context: "member" },
    );
  return exact && sources > 1 && (inElement || someStepOf(asked, (step) => step === "element"))
    ? out.map((item) =>
        item.tag === "unknown" || item.tag === "empty"
          ? item
          : { ...item, context: firstContext(item.context, "member") },
      )
    : out;
}

/**
 * V30 §19: the button values of the options a literal holds at `path`, read at `after` below them,
 * per record alternative: the `value` of a record that has the key (`byValue`), the `text` of one that has none (the
 * property's own cell, its sources kept); a value that is no record is its own button's value, and a record whose keys
 * are unknown, or a reference, has the runtime's (both with the `value`s). With the number of alternatives it chooses
 * among, whichever key it reads: each is a contribution of the read.
 */
function* selectedAt(
  contract: Contract,
  literal: PlaceId,
  index: LiteralIndex,
  path: number,
  byValue: boolean,
  after: Rest,
  node: FlowNode | null,
  exact: boolean,
  below: boolean,
): Work<{ readonly items: readonly Item[]; readonly sources: number }> {
  const out: Item[] = [];
  const here = nodeAt(contract, index, path);
  const terms = [...(here?.terms ?? [])].filter(([tag]) => tag !== "object");
  const objects = here?.objects?.list ?? [];
  const reference = here?.reference === true;
  const sources = terms.length + objects.length + (reference ? 1 : 0);
  if (byValue && after.length === 0)
    for (const [tag, token] of terms) out.push(makeItem(tag, token));
  if (byValue && reference) out.push(exact ? OPAQUE_MEMBER : unknownItem(REASON.opaque));
  const selection = selectionOf(contract, literal, index, path, byValue, below, exact);
  const pieces = selectionPieces(contract, selection, after);
  // (on the value side past `WIDE` parts as a tree of demands, `gathered`)
  if (exact && pieces.length > WIDE)
    // #1668: the value side's selection: its includer records `opaque`
    for (const item of yield* contract.gathered(
      { kind: "selected", literal, path, byValue, below },
      node,
      after,
      0,
      pieces.length,
    ))
      out.push(item);
  else {
    const site: GatherSite = { kind: "absent", literal, path, byValue, below, exact };
    for (const piece of pieces)
      // #1668: a selection's pieces: the selection records no flow (`opaque`)
      for (const item of yield* selectionPiece(contract, site, selection, piece, after, node))
        out.push(item);
  }
  return { items: out, sources };
}

/**
 * A literal's type at the path, or the stores into a literal cell (an empty collection's cell holds no element, so
 * nothing below it either).
 */
export function* contractOfLiteral(
  contract: Contract,
  literal: PlaceId,
  rest: Rest,
  given?: FlowSink | null,
): Work<readonly Item[]> {
  const { program, definitions } = contract.pass;
  // (#1668: read inline, its caller's flow; as its own demand (`cl|`), its run's, taken as the run starts)
  const flow = given === undefined ? contract.pass.solver.sink() : given;
  if (!program.hasOf.has(literal) && (definitions.cellDefs.get(literal) ?? []).length === 0)
    return [program.cellOwner.get(literal)?.kind === "cell" ? EMPTY : unknownItem(REASON.opaque)];
  return mergeItems(
    yield* contract.indexItems(literal, rest, null, false, false, flow),
    program.scope,
  );
}
