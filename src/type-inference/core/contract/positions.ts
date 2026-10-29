import type { PlaceId } from "../../graph.js";
import { joinParts } from "../budget.js";
import type { Contract } from "../contract.js";
import { keyOf, keyPath, keyPlace, type Key } from "../definitions.js";
import { withWriter } from "../exact-path.js";
import { mergeItems, type Item } from "../items.js";
import { selectsElement } from "../method-categories.js";
import { Position, positions, UNPOSITIONED } from "../positions.js";
import { stepName } from "../program.js";
import type { Proof, ProofDemand, Proven, Work } from "../solver.js";
import { holdsBelow, keyThrough } from "./key-contract.js";
import { heldReference, propertyOnly } from "./kinds.js";
import { pathAt, stepsOf } from "./literal-index.js";
import { marksNothing } from "./marks.js";
import type { ChainRoot, LoneRead, Owner } from "./model.js";

// G3 3a's positioned frontier on the contract side: a read's position one step below its parent's, past wrappers.

/** A position's or an occurrence answer's demand, made since the last stop, which the next stop forgets (`stop`). */
export function remember(contract: Contract, demand: string): void {
  contract.occurrences.push(demand);
}

/**
 * A property or index read's contract (`contractOfValue`), a demand at its occurrence that proves its position (G3 3a,
 * `advance`); any other read its owner's one step down.
 */
export function projected(
  contract: Contract,
  value: PlaceId,
  projection: { readonly owner: PlaceId; readonly step: string },
): ProofDemand<Proof> {
  const at = contract.pass.program.places[value]?.site ?? null;
  const step = stepName(projection.step);
  return {
    key: joinParts("cpv", value),
    kind: "contract",
    file: at?.file ?? -1,
    offset: at?.start ?? -1,
    proves: true,
    make: () => {
      contract.remember(joinParts("cpv", value));
      return advance(contract, { value: projection.owner }, step, () =>
        contract.contractOfValueAt(projection.owner, [step]),
      );
    },
  };
}

/**
 * A key's contract as a demand that proves its position (G3 3a, `advance`): a key of a binding by property steps
 * whose first step passes a wrapper (`wrapperHop`), so a key `k·s` stands one step below `k`'s; its own computation
 * (`keyThrough`) where it does not.
 */
export function positioned(
  contract: Contract,
  key: Key,
  path: readonly string[],
): ProofDemand<Proof> {
  const site = contract.pass.program.places[keyPlace(key)]?.site ?? null;
  return {
    key: joinParts("cp", key),
    kind: "contract",
    file: site?.file ?? -1,
    offset: site?.start ?? -1,
    proves: true,
    make: () => {
      contract.remember(joinParts("cp", key));
      const parent = keyOf(keyPlace(key), path.slice(0, -1));
      return advance(contract, { key: parent, length: path.length - 1 }, path.at(-1)!, () =>
        keyThrough(contract, key, 0),
      );
    },
  };
}

/**
 * Whether a key's contract stands at a position (`positioned`): a binding's key whose steps are all property steps,
 * the first passing a wrapper (`wrapperHop`), outside `withoutPositions`.
 */
export function positionable(contract: Contract, key: Key, path: readonly string[]): boolean {
  const place = keyPlace(key);
  return (
    positions() &&
    path.length > 0 &&
    contract.pass.program.places[place]?.kind.kind === "binding" &&
    path.every(propertyOnly) &&
    contract.wrapperHop(place, path[0]!) !== null
  );
}

/**
 * G3 3a: a read one `step` below a read whose position is known (`owner`: a property read's occurrence, a read, or a
 * key with `length` steps, the key's own `owner` its parent's), advanced one step: where every receiver on the way holds
 * a structure and no reference (F19a, `receiverWalk`'s walk, the owner's checked here), a read past a wrapper is its
 * frontier's read at its path below with the outermost wrapper's writer (the wrapper's lemma: `wrapperHop`), and its
 * frontier passes the next wrapper where it stands at one; before the first wrapper, and wherever a receiver fails, the
 * read's own computation (`own`), which every read answers outside positions.
 */
function* advance(
  contract: Contract,
  owner: Owner,
  step: string,
  own: () => Work<readonly Item[]>,
): Work<Proven<Proof>> {
  const from = propertyOnly(step) ? yield* positionOf(contract, owner) : null;
  // (a read whose frontier passes no wrapper now, and passed none above, is its own read: no position below it)
  const hop = from !== null && from.rest === 0 ? contract.wrapperHop(from.read, step) : null;
  if (from === null || (!from.hopped && hop === null))
    return { items: yield* own(), proof: UNPOSITIONED };
  // F19a (`receiverWalk`): the owner's receiver holds no reference, and a structure, as every one above it did
  const receiver =
    "key" in owner
      ? yield* contract.receiverKinds(owner.key)
      : yield* contract.valueReceiver(owner.value);
  const noRef = from.noRef && !heldReference(receiver);
  const clean = from.clean && noRef && receiver.some(holdsBelow);
  if (!clean) return { items: yield* own(), proof: UNPOSITIONED };
  const items = from.hopped
    ? mergeItems(
        withWriter(
          yield* contract.contractOfValueAt(from.read, stepsBelow(contract, from.rest, step)),
          from.writer,
        ),
        contract.pass.program.scope,
      )
    : yield* own();
  return {
    items,
    proof:
      hop === null
        ? new Position(
            from.read,
            pathAt(contract, from.rest, step),
            null,
            true,
            from.writer,
            true,
            true,
          )
        : new Position(hop.read, 0, null, true, from.writer ?? hop.writer, true, true),
  };
}

/**
 * The contract position of a read (`advance`): a read occurrence's own, at no path; a property read's, its proof; a
 * key's (`length` steps), its own at a binding's root, else its proof; `null` for any other value or key, and outside
 * positions (`withoutPositions`).
 */
function* positionOf(contract: Contract, owner: Owner): Work<Position | null> {
  const { program, solver } = contract.pass;
  if (!positions()) return null;
  if ("key" in owner) {
    const { key, length } = owner;
    if (length === 0) return new Position(keyPlace(key), 0, null, false, null, true, true);
    const path = keyPath(key);
    if (!positionable(contract, key, path)) return null;
    const { proof } = yield* solver.proven(positioned(contract, key, path));
    return proof instanceof Position ? proof : null;
  }
  const { value } = owner;
  if (program.occurrenceOf.has(value)) return new Position(value, 0, null, false, null, true, true);
  const projection = program.projOf.get(value);
  const chain = contract.chainOf(value);
  // (a chain whose first step passes no wrapper never does below: its reads are their own)
  if (
    projection === undefined ||
    chain === null ||
    contract.wrapperHop(chain.root, chain.first) === null
  )
    return null;
  const { proof } = yield* solver.proven(projected(contract, value, projection));
  return proof instanceof Position ? proof : null;
}

/**
 * A chain of property reads of a read (`a.q.r`: a projection by property steps down to a read occurrence), by its read
 * and its first step; `null` for any other value and a read itself. Once per value and pass, down from the nearest
 * value already known.
 */
export function chainOf(contract: Contract, value: PlaceId): ChainRoot | null {
  const { program } = contract.pass;
  const known = contract.chains.get(value);
  if (known !== undefined) return known;
  const pending: PlaceId[] = [];
  let below: ChainRoot | null = null;
  for (let at = value; ;) {
    const projection = program.projOf.get(at);
    const step = projection === undefined ? null : stepName(projection.step);
    if (projection === undefined || selectsElement(projection.step) || !propertyOnly(step!)) {
      below = null;
      break;
    }
    pending.push(at);
    if (program.occurrenceOf.has(projection.owner)) {
      below = { root: projection.owner, first: step! };
      pending.pop();
      contract.chains.set(at, below);
      contract.keep(1);
      break;
    }
    const owner = contract.chains.get(projection.owner);
    if (owner !== undefined) {
      below = owner;
      break;
    }
    at = projection.owner;
  }
  contract.keep(pending.length);
  for (const at of pending) contract.chains.set(at, below);
  return contract.chains.get(value) ?? below;
}

/** The steps of the path `rest` (a path id) and one `step` below it, made fresh. */
function stepsBelow(contract: Contract, rest: number, step: string): string[] {
  const steps = stepsOf(contract, rest);
  contract.keep(steps.length + 1);
  steps.push(step);
  return steps;
}

/**
 * G3 3a: a literal's step to the one read it holds there (`wrapperHop`), or `null`: its root holds objects that all
 * have `step` and nothing else; at `step` it holds one read of a binding, unguarded, marking nothing whatever the path
 * and naming no ingress, and nothing else there or below. So its value and contract at a path through `step` are that
 * read's at the rest (its value read at the read's own node, `node`, where it has one). Once per literal and step.
 */
export function literalHop(contract: Contract, literal: PlaceId, step: string): LoneRead | null {
  const { program } = contract.pass;
  const memoKey = joinParts(literal, step);
  const known = contract.literalHops.get(memoKey);
  if (known !== undefined) return known;
  contract.keepText(memoKey.length);
  program.work.charge("invSteps");
  let found: LoneRead | null = null;
  const top = contract.literalIndex(literal).root;
  const objects = top.objects;
  const at = top.children.get(step);
  if (
    top.reads.length === 0 &&
    top.exact.length === 0 &&
    top.others.length === 0 &&
    !top.reference &&
    !top.empty &&
    objects !== null &&
    (objects.count.get(step) ?? 0) >= objects.list.length &&
    at !== undefined &&
    at.reads.length === 1 &&
    at.exact.length === 1 &&
    at.others.length === 0 &&
    at.objects === null &&
    !at.reference &&
    !at.empty &&
    at.terms.size === 0 &&
    at.children.size === 0
  ) {
    const own = at.reads[0]!;
    const exact = at.exact[0]!;
    if (
      own.value === exact.value &&
      !own.guarded &&
      marksNothing(contract, own.holder) &&
      own.ingress === undefined &&
      program.occurrenceOf.has(own.value) &&
      !program.projOf.has(own.value)
    ) {
      contract.keep(2);
      found = { read: own.value, node: exact.g?.node ?? null };
    }
  }
  contract.literalHops.set(memoKey, found);
  return found;
}
