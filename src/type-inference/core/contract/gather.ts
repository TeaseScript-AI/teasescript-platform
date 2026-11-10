import type { PlaceId } from "../../graph.js";
import { joinParts } from "../budget.js";
import type { Contract } from "../contract.js";
import { withWriter } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import { marked } from "../indexes/guards.js";
import {
  differsIn,
  holdsLeaves,
  leafNodes,
  MIXED_LEAF,
  mergeItems,
  type IngressNode,
  type Item,
} from "../items.js";
import type { Work } from "../solver.js";
import type { FlowSink } from "./contributions.js";
import { WIDE } from "./choices.js";
import { boundOf, classParts } from "./classes.js";
import { ingressLeafOf } from "./ingress.js";
import { ABSENT } from "./kinds.js";
import { loadsBelow, nodeAt, pathOrder, stepsOf } from "./literal-index.js";
import { annotated } from "./marks.js";
import type {
  ClassGroup,
  GatherSite,
  IndexNode,
  IndexSite,
  OtherGroup,
  Selection,
  SelectionPiece,
  ValueEntry,
} from "./model.js";
import { othersAt, readGroupsAt } from "./others.js";
import { keyBelowIn, restPart, restSteps, stepsText, type Rest, type Steps } from "./key-ids.js";
import { selectedObject, selectionOf, selectionPieces } from "./selections.js";

// The value side's wide gathers (S10 part 2b): a gather site's contributions, its groups, its selections' runs.

/**
 * F12: below a read that stands below an element step, the read's contract answer at the rest of the path
 * (definite by P3, else possible; context `member`), with the read's ingress stores and guard mark.
 */
function* belowRead(contract: Contract, read: PlaceId, below: Steps): Work<readonly Item[]> {
  const { program, guards } = contract.pass;
  let root = read;
  for (let projection = program.projOf.get(root); projection !== undefined;) {
    root = projection.owner;
    projection = program.projOf.get(root);
  }
  const copied = contract.copiedKey(read)!;
  const node = program.occNode.get(root);
  // #1668: the value side's copies below an element step: its includer records `opaque`
  const items = contract.entered(
    root,
    node === undefined || node === null
      ? yield* contract.contractOf(keyBelowIn(contract, copied, below))
      : yield* contract.contractRead(keyBelowIn(contract, copied, below), node, "member"),
  );
  return guards.guardedReadAt(read, stepsText(below)) ? marked(items) : items;
}

/**
 * V30 §19: the button values of the options a literal holds at `path`, read at `after` below them,
 * per record alternative: the `value` of a record that has the key (`byValue`), the `text` of one that has none (the
 * property's own cell, its sources kept); a value that is no record is its own button's value, and a record whose keys
 * are unknown, or a reference, has the runtime's (both with the `value`s). With the number of alternatives it chooses
 * among, whichever key it reads: each is a contribution of the read (§3.4: the element step over the options).
 */
/**
 * A wide gather of the value side's (S10 part 2b): a site's contributions [lo, hi) (a literal's exact entries, its
 * copies past an element step or its computed values' groups at `path`, or a selection's objects), read at `rest` and
 * merged by kind (`mergeItems`, as every caller's merge takes them anyway, in their order), as a balanced tree of
 * demands: where the contributions' answers change one by one (a component of N5's stores reading them), a change
 * re-runs only the nodes above it, never the whole gather.
 */
export function* gathered(
  contract: Contract,
  site: GatherSite,
  node: FlowNode | null,
  rest: Rest,
  lo: number,
  hi: number,
  flow: FlowSink | null = null,
): Work<readonly Item[]> {
  const { program } = contract.pass;
  const at = program.places[site.literal]?.site ?? null;
  const flags =
    site.kind === "selected" || site.kind === "absent"
      ? `${site.byValue ? "v" : ""}${site.below ? "b" : ""}${site.kind === "absent" && site.exact ? "x" : ""}`
      : site.deeper
        ? "d"
        : "";
  const key = joinParts(
    "lp",
    site.kind,
    site.literal,
    lo,
    hi,
    node?.id ?? "-",
    flags,
    stepsOf(contract, site.path),
    restPart(rest),
  );
  flow?.include(key, "gather");
  return yield {
    key,
    kind:
      site.kind === "reads" || site.kind === "groups" || (site.kind === "absent" && !site.exact)
        ? "contract"
        : "value",
    file: at?.file ?? -1,
    offset: at?.start ?? -1,
    // #1668: the demand's own run: its frame's flow, taken as it starts
    make: () => gatheredMade(contract, site, node, rest, lo, hi),
  };
}

/** The demand of `gathered`. */
function* gatheredMade(
  contract: Contract,
  site: GatherSite,
  node: FlowNode | null,
  rest: Rest,
  lo: number,
  hi: number,
): Work<readonly Item[]> {
  contract.pass.program.work.charge("invSteps");
  const flow = contract.pass.solver.sink();
  const out: Item[] = [];
  if (hi - lo <= WIDE)
    for (let at = lo; at < hi; at += 1)
      out.push(...(yield* gatherAt(contract, site, node, rest, at, flow)));
  else {
    const middle = (lo + hi) >> 1;
    out.push(...(yield* contract.gathered(site, node, rest, lo, middle, flow)));
    out.push(...(yield* contract.gathered(site, node, rest, middle, hi, flow)));
  }
  return mergeItems(out, contract.pass.program.scope);
}

/** How many contributions a gather site of a literal's index reads. */
export function gatherCount(contract: Contract, site: IndexSite): number {
  const at = siteNode(contract, site);
  if (site.kind === "exact") return at?.exact.length ?? 0;
  if (site.kind === "copies" || site.kind === "reads")
    return readGroupsAt(contract, at?.reads, site.kind === "copies").length;
  return gatherGroups(contract, site).length;
}

/** A gather site's node of its literal's index, `null` where the index holds none there. */
function siteNode(contract: Contract, site: GatherSite): IndexNode | null {
  return nodeAt(contract, contract.literalIndex(site.literal), site.path);
}

/** A gather site's computed values' groups at its path (`othersAt`), past a step those below it. */
function gatherGroups(contract: Contract, site: GatherSite): readonly (OtherGroup | null)[] {
  const groups = othersAt(contract, siteNode(contract, site)?.others, site.kind !== "groups");
  return (site.kind === "others" || site.kind === "groups") && site.deeper
    ? (contract.othersBelowOf.get(groups) ?? groups)
    : groups;
}

/** One contribution of a gather site, read at `rest`. */
export function* gatherAt(
  contract: Contract,
  site: GatherSite,
  node: FlowNode | null,
  rest: Rest,
  at: number,
  flow: FlowSink | null = null,
): Work<readonly Item[]> {
  const { values } = contract.pass;
  const index = contract.literalIndex(site.literal);
  const here = siteNode(contract, site);
  // (#1668: the contract side's gathers record their reads; the value side's (`exact`, `copies`, `others`, the
  // selections) record none of their own)
  if (site.kind !== "reads" && site.kind !== "groups") flow?.opaque("exact");
  if (site.kind === "exact") {
    const entry = here!.exact[at]!;
    // #1668: the value side's exact gather: its includer records `opaque`
    return yield* values.valueItems(entry.value, entry.g?.node ?? node, rest);
  }
  if (site.kind === "copies" || site.kind === "reads") {
    const copies = site.kind === "copies";
    const group = readGroupsAt(contract, here!.reads, copies)[at]!;
    const self = contract;
    return yield* groupItems(
      contract,
      group,
      copies,
      function* (entry) {
        const read = flow?.child() ?? null;
        const items = copies
          ? // #1668: the value side's copies: its includer records `opaque`
            yield* belowRead(self, entry.value, restSteps(rest))
          : yield* self.contractOfValueAt(entry.value, rest, read);
        if (read !== null) flow!.attach(read, "annotated");
        return annotated(self, entry, rest, items);
      },
      flow,
    );
  }
  if (site.kind === "groups") {
    const group = gatherGroups(contract, site)[at]!;
    if (group === null)
      return yield* loadsBelow(
        contract,
        othersAt(contract, here?.others, false),
        rest,
        false,
        null,
        flow,
      );
    return yield* groupItems(
      contract,
      group,
      false,
      (entry) => contract.contractOfValueAt(entry.value, rest, flow),
      flow,
    );
  }
  if (site.kind === "selected") {
    const selection = selectionOf(
      contract,
      site.literal,
      index,
      site.path,
      site.byValue,
      site.below,
      true,
    );
    // #1668: the value side's selected piece: its includer records `opaque`
    return yield* selectionPiece(
      contract,
      { ...site, kind: "absent", exact: true },
      selection,
      selectionPieces(contract, selection, rest)[at]!,
      rest,
      node,
    );
  }
  if (site.kind === "absent") {
    const selection = selectionOf(
      contract,
      site.literal,
      index,
      site.path,
      site.byValue,
      site.below,
      site.exact,
    );
    // #1668: the value side's absent run: its includer records `opaque`
    return yield* selectedObject(
      contract,
      selection.objects[selection.closed[at]!]!,
      site.byValue,
      [ABSENT],
      null,
      site.exact,
      site.below,
    );
  }
  const group = gatherGroups(contract, site)[at]!;
  if (group === null)
    // #1668: the value side's loads: its includer records `opaque`
    return yield* loadsBelow(contract, othersAt(contract, here?.others, true), rest, true, node);
  // #1668: the value side's groups: its includer records `opaque`
  return yield* groupItems(contract, group, true, (entry) =>
    values.valueItems(entry.value, entry.g?.node ?? node, rest),
  );
}

/**
 * A group's answer at a path (`othersAt`), on the contract side with the group's writer: its read members', and where
 * they hold external data, its other members' too, which differ from them only by the leaves they name (C9). Those
 * are read one by one where their leaves differ by more than their roles' (`othersLeaves`); else the read members'
 * external data names the others' leaves as well, so a class of k loads of host data read at k properties reads one
 * load at each (#1207).
 */
function* groupItems<E extends ValueEntry>(
  contract: Contract,
  group: ClassGroup<E>,
  exact: boolean,
  answer: (entry: E) => Work<readonly Item[]>,
  flow: FlowSink | null = null,
): Work<Item[]> {
  const out: Item[] = [];
  const answers: (readonly Item[])[] = [];
  const read = function* (entry: E): Work<readonly Item[]> {
    // #1668: I, the caller's read takes its flow
    const items = yield* answer(entry);
    return exact ? items : withWriter(items, group.writer);
  };
  for (const entry of group.read) {
    // #1668: I, the caller's read takes its flow
    const items = yield* read(entry);
    answers.push(items);
    for (const item of items) out.push(item);
  }
  // (a mixed class's values differ where their answer holds a leaf or an operand's identity)
  const differing = out.find((item) => differsIn(item, group.mixed));
  if (group.rest.length === 0 || differing === undefined) return out;
  const leaves = othersLeaves(contract, group, answers, exact);
  // (#1668: the other members' leaves named from the read ones' (C9): their own answers not read, a qualified inclusion)
  if (leaves !== null) {
    flow?.opaque("leaves");
    out.push({ ...differing, ingress: leaves });
    // #1668: I, the caller's read takes its flow
  } else for (const entry of group.rest) for (const item of yield* read(entry)) out.push(item);
  return out;
}

/**
 * #1207: the leaves a group's other members name (`groupItems`), where they differ from its read members' by their
 * roles' alone: a class mixed by leaves alone (`MIXED_LEAF`), each member naming its roles' leaves (`leafRoles`), and
 * each read member's external data here naming all of its own, so each other member's names its own in their place.
 * `null` where any of that fails, or a leaf lies in a fixpoint's growing cell.
 */
function othersLeaves(
  contract: Contract,
  group: ClassGroup<ValueEntry>,
  answers: readonly (readonly Item[])[],
  exact: boolean,
): IngressNode | null {
  if (group.mixed !== MIXED_LEAF) return null;
  let roles = -1;
  for (const [at, entry] of group.read.entries()) {
    const own = leafRoles(contract, entry.value, exact);
    if (own === null || (roles >= 0 && own.length !== roles)) return null;
    roles = own.length;
    for (const item of answers[at]!)
      if (differsIn(item, group.mixed) && !heldLeaves(contract, item.ingress, own)) return null;
  }
  if (contract.othersLeavesOf.has(group)) return contract.othersLeavesOf.get(group)!;
  // (#1573: each other member's leaves as one node (`rolesNode`), and those nodes, each once, as one node per sequence
  // of them (`setNode`))
  const nodes = new Set<IngressNode>();
  let complete = true;
  for (const entry of group.rest) {
    const own = leafRoles(contract, entry.value, exact);
    complete = own !== null && own.length === roles;
    if (!complete) break;
    nodes.add(rolesNode(contract, own!));
  }
  const leaves = complete ? setNode(contract, nodes) : null;
  contract.keep(1);
  contract.othersLeavesOf.set(group, leaves);
  return leaves;
}

/**
 * #1573: whether `node` holds every one of a member's leaves by role (`holdsLeaves`), once per node and roles, the read
 * members of k lists sharing their answers' nodes: each further check counts to its demand what the check charged
 * (`WorkLedger.repeat`), as when each list checked its own.
 */
function heldLeaves(
  contract: Contract,
  node: IngressNode | undefined,
  roles: readonly IngressNode[],
): boolean {
  const { scope, work } = contract.pass.program;
  if (node === undefined) return holdsLeaves(node, roles, scope);
  let known = contract.heldLeaves.get(node);
  if (known === undefined) contract.heldLeaves.set(node, (known = new WeakMap()));
  const checked = known.get(roles);
  if (checked !== undefined) {
    work.repeat(checked.units);
    return checked.held;
  }
  const before = work.total + work.finishing;
  const held = holdsLeaves(node, roles, scope);
  known.set(roles, { held, units: work.total + work.finishing - before });
  return held;
}

/** A member's leaves by role (`leafRoles`) as one node, unioned in their roles' order once per roles. */
function rolesNode(contract: Contract, roles: readonly IngressNode[]): IngressNode {
  let node = contract.rolesNodes.get(roles);
  if (node === undefined) {
    for (const leaf of roles) node = contract.pass.program.scope.ingress.union(node, leaf);
    contract.rolesNodes.set(roles, node!);
  }
  return node!;
}

/**
 * #1573: one node per sequence of the other members' nodes as a list holds them (`othersLeaves`): their fold in that
 * order, each step found by the ingress graph's own pair of the nodes so far and the next, so the lists of one sequence
 * share one node and no list makes more than the unshared route's merge of its members makes (Codex r2 on #1628: a
 * set found by a sum of its members' ids scanned other sets' members). Each step charged to the analysis as a shared
 * build, never to the demand that asks (`WorkLedger.shared`), which charged no such step before.
 */
function setNode(contract: Contract, members: ReadonlySet<IngressNode>): IngressNode {
  const { scope, work } = contract.pass.program;
  work.shared(() => work.charge("invSteps", members.size));
  let node: IngressNode | undefined;
  for (const member of members) node = scope.ingress.union(node, member);
  return node!;
}

/**
 * The leaves a value of a class mixed by leaves alone names where its answer holds external data, by role: of it and
 * its mixed parts (`classParts`) at any depth, in their roles' order, each ingress's own (`entered`), so a composite
 * (`load(…, default: hostValue) otherwise {…}`) names its load's and its default's (#1304), and a read of a bound
 * binding its value's (`boundOf`, #1313); a literal's read entry of host data each read's it stands for (its
 * unioned leaves, `indexWork`), so literals of one and of two reads of one global differ by their roles' count;
 * `null` where a mixed part is mixed by more than its leaves, a leaf lies in a fixpoint's cell, or none names one.
 * Once per value and side, on an explicit walk once per value it starts from (#1573: the reads of one binding in k
 * lists walk its value once, each further one counting to its demand what the walk charged, `WorkLedger.repeat`).
 */
function leafRoles(
  contract: Contract,
  value: PlaceId,
  exact: boolean,
): readonly IngressNode[] | null {
  const memo = contract.leafRolesOf[exact ? 1 : 0]!;
  if (memo.has(value)) return memo.get(value)!;
  const start = boundOf(contract, value, exact)?.value ?? value;
  const walked = contract.leafRolesFrom[exact ? 1 : 0]!;
  const { definitions, program } = contract.pass;
  const { work } = program;
  const known = walked.get(start);
  if (known !== undefined) {
    // (its own entry kept, and to its demand the rest of what its own walk charged: `WorkLedger.repeat`)
    contract.keep(1);
    work.repeat(known.units - 1);
    memo.set(value, known.roles);
    return known.roles;
  }
  // (the walk's units but its classes' (a class is made once, so a later walk would find it): what any walk charges)
  const spent = (): number => work.total + work.finishing;
  const before = spent();
  let classes = 0;
  const out: IngressNode[] = [];
  const seen = new Set<PlaceId>();
  const pending = [start];
  let found = true;
  while (found && pending.length > 0) {
    const at = pending.pop()!;
    const ahead = spent();
    const mixed = contract.classMixed(at, exact);
    classes += spent() - ahead;
    if (mixed === 0 || seen.has(at)) continue;
    seen.add(at);
    const leaf = definitions.ingress.has(at) ? ingressLeafOf(contract, at) : null;
    found = mixed === MIXED_LEAF && leaf !== undefined;
    if (leaf !== null && leaf !== undefined) out.push(leaf);
    const parts: PlaceId[] = [];
    if (!program.hasOf.has(at)) parts.push(...classParts(contract, at, exact));
    else {
      const index = contract.literalIndex(at);
      for (const [, node] of pathOrder(contract, index)) {
        program.work.charge("invSteps");
        for (const entry of node.reads)
          if (entry.ingress === undefined) parts.push(entry.value);
          else found &&= leafNodes(entry.ingress, out, program.scope);
        for (const entry of node.others) parts.push(entry.value);
      }
      contract.keep(parts.length);
    }
    for (let index = parts.length - 1; index >= 0; index -= 1) pending.push(parts[index]!);
  }
  const roles = found && out.length > 0 ? out : null;
  contract.keep(1 + out.length);
  walked.set(start, { roles, units: spent() - before - classes });
  memo.set(value, roles);
  return roles;
}

/** One part of a selection's answer (`selectionPieces`): an object's at `after`, or a run's (`absentRun`). */
export function* selectionPiece(
  contract: Contract,
  site: Extract<GatherSite, { readonly kind: "absent" }>,
  selection: Selection,
  piece: SelectionPiece,
  after: Rest,
  node: FlowNode | null,
): Work<readonly Item[]> {
  if (typeof piece === "number")
    // #1668: a selection's object: the selection records no flow (`opaque`)
    return yield* selectedObject(
      contract,
      selection.objects[piece]!,
      site.byValue,
      after,
      node,
      site.exact,
      site.below,
    );
  const out: Item[] = [];
  yield* absentRun(contract, site, 0, selection.closed.length, piece.lo, piece.hi, out);
  return out;
}

/**
 * A run [a, b) of a selection's closed objects, each read at `ABSENT`, from the balanced tree of demands over all of
 * them (`gathered`, node [lo, hi)): each node inside the run whole, a leaf's part object by object, in order. So a
 * run's answer re-runs where its objects' answers change, and a read reads O(log k) nodes of the tree, never k objects.
 */
function* absentRun(
  contract: Contract,
  site: Extract<GatherSite, { readonly kind: "absent" }>,
  lo: number,
  hi: number,
  a: number,
  b: number,
  out: Item[],
): Work<void> {
  contract.pass.program.work.charge("invSteps");
  if (b <= lo || hi <= a) return;
  if (a <= lo && hi <= b) {
    // #1668: a selection's absent run: the selection records no flow (`opaque`)
    for (const item of yield* contract.gathered(site, null, [], lo, hi)) out.push(item);
    return;
  }
  if (hi - lo <= WIDE) {
    for (let at = Math.max(lo, a); at < Math.min(hi, b); at += 1)
      // #1668: a selection's absent run: the selection records no flow (`opaque`)
      for (const item of yield* gatherAt(contract, site, null, [], at)) out.push(item);
    return;
  }
  const middle = (lo + hi) >> 1;
  yield* absentRun(contract, site, lo, middle, a, b, out);
  yield* absentRun(contract, site, middle, hi, a, b, out);
}
