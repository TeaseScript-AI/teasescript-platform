import type { PlaceId } from "../../graph.js";
import { joinParts } from "../budget.js";
import type { Contract } from "../contract.js";
import { SELECTED_TEXT, SELECTED_VALUE } from "../definitions.js";
import type { FlowNode } from "../flow-graph.js";
import {
  EMPTY,
  firstContext,
  makeItem,
  mergeItems,
  REASON,
  type Item,
  type Writer,
} from "../items.js";
import type { Work } from "../solver.js";
import { WIDE } from "./choices.js";
import { gatherAt, gatherCount, selectionPiece } from "./gather.js";
import { OPAQUE_MEMBER, unknownItem } from "./kinds.js";
import { nodeAt, pathAt } from "./literal-index.js";
import type { GatherSite, IndexNode, IndexSite, LiteralIndex } from "./model.js";
import { selectionOf, selectionPieces } from "./selections.js";

// A literal's items at a path from its index, and its type or its cell's stores at a path.

/** F11: the first object at the path without the property, once per (path, property): its token, or `null`. */
function lackingAt(
  contract: Contract,
  index: LiteralIndex,
  path: number,
  step: string,
): Writer | null {
  const key = joinParts(path, step);
  const known = index.lacking.get(key);
  if (known !== undefined) return known;
  contract.keepText(key.length);
  const objects = nodeAt(contract, index, path)?.objects ?? null;
  let token: Writer | null = null;
  if (objects !== null && (objects.count.get(step) ?? 0) < objects.list.length)
    for (const object of objects.list) {
      contract.pass.program.work.charge("invSteps");
      if (!object.names.has(step)) {
        token = object.token;
        break;
      }
    }
  index.lacking.set(key, token);
  return token;
}

/**
 * A literal's items at a path from its index: the value side (`exact`: F12 r4.7, a read below an element step is not
 * followed below its own kinds but takes its contract), else the contract.
 */
export function* indexItems(
  contract: Contract,
  literal: PlaceId,
  rest: readonly string[],
  node: FlowNode | null,
  exact: boolean,
  below = false,
): Work<readonly Item[]> {
  const { program } = contract.pass;
  const index = contract.literalIndex(literal);
  // an element cell, or a literal read as one (`below`): every path below lies below an element step
  const inElement = below || program.cellOwner.get(literal)?.kind === "cell";
  const out: Item[] = [];
  // the read passes an element step over a copy (F12: X3)
  let overCopy = false;
  // the contributions the read gathers: past an element step, several of them are several elements, of which
  // positions do not tell which one (F12)
  let sources = 0;
  // each prefix of the path: its id and the index's node there, `null` past the deepest one the index holds
  const paths: ({ readonly id: number; readonly at: IndexNode } | null)[] = [
    { id: 0, at: index.root },
  ];
  for (let length = 0; length < rest.length; length += 1) {
    const above = paths[length]!;
    const at = above?.at.children.get(rest[length]!);
    paths.push(
      above === null || at === undefined
        ? null
        : { id: pathAt(contract, above.id, rest[length]!), at },
    );
  }
  for (const [tag, token] of paths[rest.length]?.at.terms ?? []) {
    out.push(makeItem(tag, token));
    sources += 1;
  }
  let elementAbove = inElement;
  for (let length = 0; length <= rest.length; length += 1) {
    program.work.charge("invSteps");
    if (length > 0 && rest[length - 1] === "element") elementAbove = true;
    const prefix = paths[length];
    if (prefix === null || prefix === undefined) break;
    const path = prefix.id;
    // (the rest below the path, made only for an entry that stands there)
    let tail: readonly string[] | undefined;
    const after = (): readonly string[] => (tail ??= rest.slice(length));
    if (!exact) {
      // (each kind read one by one, or past `WIDE` of them as a tree of demands, so a ring of copies through a wide
      // literal changes only the nodes above each changed read, never the whole literal, #1229)
      const deeper = length < rest.length;
      for (const kind of ["reads", "groups"] as const) {
        const site: IndexSite = { kind, literal, path, deeper };
        const count = gatherCount(contract, site);
        if (count <= WIDE)
          for (let at = 0; at < count; at += 1)
            out.push(...(yield* gatherAt(contract, site, node, after(), at)));
        else
          for (const item of yield* contract.gathered(site, node, after(), 0, count))
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
            out.push(...(yield* gatherAt(contract, site, node, after(), at)));
        else
          for (const item of yield* contract.gathered(site, node, after(), 0, count))
            out.push(item);
      }
      sources += (copies ?? prefix.at.exact).length + prefix.at.others.length;
    }
    // V30 §19, r4.46 (1): a choice object's button value, per record alternative here
    const step = rest[length];
    if (step === SELECTED_VALUE || step === SELECTED_TEXT) {
      const selected = yield* selectedAt(
        contract,
        literal,
        index,
        path,
        step === SELECTED_VALUE,
        rest.slice(length + 1),
        node,
        exact,
        elementAbove,
      );
      // (one by one: a selection's alternatives grow with the source, past one call's arguments)
      for (const item of selected.items) out.push(item);
      // each alternative a selection takes is a contribution of the read (§3.4: several past an element step)
      sources += selected.sources;
      break;
    }
    if (length === rest.length) break;
    // F11: an object here without the next step contributes `missing`; a reference, an opaque member (F19a)
    const lacking = lackingAt(contract, index, path, rest[length]!);
    if (lacking !== null)
      out.push(
        exact
          ? makeItem("unknown", lacking, { reasons: REASON.missing, context: "missing" })
          : unknownItem(REASON.missing, lacking),
      );
    if (prefix.at.reference) out.push(exact ? OPAQUE_MEMBER : unknownItem(REASON.opaque));
    // an empty collection on the way holds no element (the contract's M below it; the value's at its end)
    if (
      rest[length] === "element" &&
      paths[length + 1]?.at.empty === true &&
      (!exact || length === rest.length - 1)
    )
      out.push(EMPTY);
  }
  // S3 §1's route: past an element step over a copy the contract answered (F12)
  if (exact && overCopy)
    contract.overCopy.add(contract.kept(joinParts(literal, rest, node?.id ?? "-")));
  // §3.4 r4.11: the X word is the read's (`member` past an element step over a copy), shared by every known-kind
  // item, definite ones included, whatever its writer; an unknown keeps its reason's word. Past an element step that
  // gathers several elements the element read makes each kind only possible: its word too, by the precedence
  if (overCopy)
    return out.map((item) =>
      item.tag === "unknown" || item.tag === "empty" ? item : { ...item, context: "member" },
    );
  return exact && sources > 1 && (inElement || rest.includes("element"))
    ? out.map((item) =>
        item.tag === "unknown" || item.tag === "empty"
          ? item
          : { ...item, context: firstContext(item.context, "member") },
      )
    : out;
}

function* selectedAt(
  contract: Contract,
  literal: PlaceId,
  index: LiteralIndex,
  path: number,
  byValue: boolean,
  after: readonly string[],
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
  rest: readonly string[],
): Work<readonly Item[]> {
  const { program, definitions } = contract.pass;
  if (!program.hasOf.has(literal) && (definitions.cellDefs.get(literal) ?? []).length === 0)
    return [program.cellOwner.get(literal)?.kind === "cell" ? EMPTY : unknownItem(REASON.opaque)];
  return mergeItems(yield* contract.indexItems(literal, rest, null, false), program.scope);
}
