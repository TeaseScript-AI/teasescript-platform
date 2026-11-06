import type { PlaceId } from "../../graph.js";
import { joinParts } from "../budget.js";
import type { Contract } from "../contract.js";
import { keyOf, keyPlace, SELECTED_TEXT, SELECTED_VALUE, type Key } from "../definitions.js";
import { firstWriter, REASON, type Writer } from "../items.js";
import { stepName } from "../program.js";
import type { ProofDemand, Proven, Work } from "../solver.js";
import { pushedSlot } from "./frontier.js";
import { receiverWalk } from "./key-contract.js";
import {
  canonicalKey,
  keyBelowIn,
  keyWalk,
  memberStepOf,
  restRef,
  stepsArray,
  stepsRest,
} from "./key-ids.js";
import { ABSENT, heldReference } from "./kinds.js";
import { lackingAt, nodeAt, pathAt } from "./literal-index.js";
import { measuresLength, selectsElement } from "../method-categories.js";
import type { ObjectsProof, ObjectSite, PrefixEntry } from "./model.js";
import { othersAt, readGroupsAt } from "./others.js";
import { termAt, writtenOf } from "./terms.js";
import { resultOf, valueRoute } from "./value-kinds.js";

// #1747 PR 1: the objects a contract read holds at a path, and the earliest object lacking a property below it.

/**
 * #1747 (TABLE r4.386): the objects a contract read of `value` at `rest` holds, as a proof: each literal node's object
 * list it reaches at the path (`ObjectSite`), the pure `missing` writers its read meets on the way (F11 at a prefix, a
 * stored `missing`), and the keys whose own stores and written type at a further property it does not cover. Its read
 * at `rest.s` for a property `s` then names its pure `missing` by `absentWriterAt` without reading `s`. A demand once
 * per value and path, read through `Solver.proven`; a route it does not follow declines (`complete` false), and the
 * reader then reads as before. Routed as `valueAt` routes (`valueRoute`).
 */
export function objectsAt(
  contract: Contract,
  value: PlaceId,
  rest: readonly string[],
): ProofDemand<ObjectsProof> {
  const site = contract.pass.program.places[value]?.site ?? null;
  return {
    key: joinParts("ob", value, rest),
    kind: "contract",
    file: site?.file ?? -1,
    offset: site?.start ?? -1,
    proves: true,
    make: () => valueObjects(contract, value, rest),
  };
}

/** `objectsAt` for a key (`contractOf`'s read of it and a property below), once per key. */
function keyObjects(contract: Contract, asked: Key): ProofDemand<ObjectsProof> {
  const key = canonicalKey(contract, asked);
  const site = contract.pass.program.places[keyPlace(key)]?.site ?? null;
  return {
    key: joinParts("obk", key),
    kind: "contract",
    file: site?.file ?? -1,
    offset: site?.start ?? -1,
    proves: true,
    make: () => keyObjectsMade(contract, key),
  };
}

/**
 * #1747: the pure `missing` writer of `value`'s contract read at `rest.s` (the earliest, F28), from its objects at
 * `rest` (`objectsAt`): the writers met on the way and, of each object list there, its first object lacking `s`
 * (F11, `lackingAt`); `covered` false where the query declines or `s` is stored or typed below a key it reads, or an
 * entry stands at `s` below a list.
 */
export function* absentWriterAt(
  contract: Contract,
  value: PlaceId,
  rest: readonly string[],
  step: string,
): Work<{ readonly covered: boolean; readonly writer: Writer | null }> {
  const { proof } = yield* contract.pass.solver.proven(objectsAt(contract, value, rest));
  if (proof === null || !proof.complete) return UNCOVERED;
  const { program, definitions, lists } = contract.pass;
  for (const { key, place, path } of proof.keys) {
    program.work.charge("invSteps");
    const stored = definitions.byKey.get(keyBelowIn(contract, key, [step])) ?? [];
    if (stored.some((d) => lists.live(d))) return UNCOVERED;
    const written = writtenOf(program.place(place).kind);
    if (written !== null && termAt(written, [...path, step]) !== null) return UNCOVERED;
  }
  let writer: Writer | null = null;
  for (const each of proof.prior) writer = firstWriter(writer, each);
  for (const { literal, path } of proof.lists) {
    program.work.charge("invSteps");
    const index = contract.literalIndex(literal);
    const below = nodeAt(contract, index, path)?.children.get(step);
    if (below !== undefined && below.reads.length + below.others.length + below.exact.length > 0)
      return UNCOVERED;
    writer = firstWriter(writer, lackingAt(contract, index, path, step));
  }
  return { covered: true, writer };
}

const UNCOVERED = { covered: false, writer: null } as const;

/** What a query gathers: its sites, writers and keys, each once; declined at the first route it does not follow. */
class Gathered {
  readonly #lists = new Map<string, ObjectSite>();
  readonly #prior = new Map<string, Writer>();
  readonly #keys = new Map<string, ObjectsProof["keys"][number]>();
  complete = true;

  public constructor(private readonly contract: Contract) {}

  public list(site: ObjectSite): void {
    this.#add(this.#lists, joinParts(site.literal, site.path), site);
  }

  public writer(writer: Writer | null): void {
    if (writer !== null)
      this.#add(this.#prior, joinParts(writer.kind, writer.file, writer.start), writer);
  }

  public key(key: ObjectsProof["keys"][number]): void {
    this.#add(this.#keys, joinParts("k", key.key), key);
  }

  /** A query this one reads: its sites and writers united into this one's, or this one declined. */
  public *from(demand: ProofDemand<ObjectsProof>): Work<void> {
    if (!this.complete) return;
    const { proof } = yield* this.contract.pass.solver.proven(demand);
    if (proof === null || !proof.complete) {
      this.complete = false;
      return;
    }
    for (const site of proof.lists) this.list(site);
    for (const writer of proof.prior) this.writer(writer);
    for (const key of proof.keys) this.key(key);
  }

  public proven(): Proven<ObjectsProof> {
    if (!this.complete) return { items: [], proof: DECLINED };
    const lists = [...this.#lists.values()];
    const prior = [...this.#prior.values()];
    const keys = [...this.#keys.values()];
    // (its parts by their names, sorted: equal for two queries whose sites, writers and keys are equal)
    const names = [...this.#lists.keys(), ...this.#prior.keys(), ...this.#keys.keys()].sort();
    const contract = this.contract;
    return {
      items: [],
      proof: {
        complete: true,
        lists,
        prior,
        keys,
        signature: () => {
          contract.pass.program.work.charge("sigItems", names.length + 1);
          return joinParts("objects", ...names);
        },
      },
    };
  }

  #add<T>(map: Map<string, T>, name: string, value: T): void {
    if (map.has(name)) return;
    this.contract.keepText(name.length);
    map.set(name, value);
  }
}

const DECLINED: ObjectsProof = {
  complete: false,
  lists: [],
  prior: [],
  keys: [],
  signature: () => "declined",
};

/** Whether a path holds a choice's selection step, which the query does not follow. */
function selecting(rest: readonly string[]): boolean {
  return rest.some((step) => step === SELECTED_VALUE || step === SELECTED_TEXT);
}

/** `objectsAt`'s run: by the value's route (`valueRoute`), as `valueAt` reads it at `rest` and a property below. */
function* valueObjects(
  contract: Contract,
  value: PlaceId,
  rest: readonly string[],
): Work<Proven<ObjectsProof>> {
  const { program } = contract.pass;
  program.work.charge("invSteps");
  const out = new Gathered(contract);
  if (selecting(rest)) return out.proven();
  switch (valueRoute(program, value)) {
    case "binding":
      yield* out.from(
        keyObjects(
          contract,
          keyBelowIn(contract, keyOf(program.occurrenceOf.get(value)!, []), rest),
        ),
      );
      return out.proven();
    case "projection": {
      const projection = program.projOf.get(value)!;
      if (
        projection.step === "iteration" ||
        measuresLength(projection.step) ||
        selectsElement(projection.step)
      )
        break;
      yield* out.from(objectsAt(contract, projection.owner, [stepName(projection.step), ...rest]));
      return out.proven();
    }
    case "call":
      yield* out.from(
        keyObjects(contract, keyBelowIn(contract, keyOf(resultOf(contract, value), []), rest)),
      );
      return out.proven();
    case "literal":
      yield* literalObjects(contract, out, value, rest);
      return out.proven();
    case "composite": {
      const operation = program.opOf.get(value)!;
      if (operation.kind === "fallback") {
        yield* out.from(objectsAt(contract, operation.left, rest));
        yield* out.from(objectsAt(contract, operation.right, rest));
        return out.proven();
      }
      if (operation.kind !== "get") break;
      // F19a: a receiver that may be a reference has the runtime's `get`
      if (heldReference(yield* contract.valueReceiver(operation.receiver))) break;
      yield* out.from(objectsAt(contract, operation.receiver, ["element", ...rest]));
      yield* out.from(objectsAt(contract, operation.fallback, rest));
      return out.proven();
    }
    default:
      break;
  }
  out.complete = false;
  return out.proven();
}

/**
 * A literal's objects at `rest` (`contractOfLiteral`'s index walk on the contract side, `indexItems`): F11's writer at
 * each prefix lacking the next step, the reads and computed values standing at each prefix read below it, and the
 * object list at the path itself.
 */
function* literalObjects(
  contract: Contract,
  out: Gathered,
  literal: PlaceId,
  rest: readonly string[],
): Work<void> {
  const { program, definitions } = contract.pass;
  if (!program.hasOf.has(literal) && (definitions.cellDefs.get(literal) ?? []).length === 0) {
    out.complete = false;
    return;
  }
  const index = contract.literalIndex(literal);
  let node = index.root;
  let id = 0;
  for (let length = 0; ; length += 1) {
    program.work.charge("invSteps");
    const below = rest.slice(length);
    for (const group of readGroupsAt(contract, node.reads, false)) {
      // (a mixed class reads its other members where their answers differ: that depends on the property)
      if (group.rest.length > 0 && group.mixed !== 0) out.complete = false;
      for (const entry of group.read) yield* out.from(objectsAt(contract, entry.value, below));
    }
    const groups = othersAt(contract, node.others, false);
    for (const group of contract.othersBelowOf.get(groups) ?? groups) {
      if (group === null || (group.rest.length > 0 && group.mixed !== 0)) {
        out.complete = false;
        return;
      }
      for (const entry of group.read) yield* out.from(objectsAt(contract, entry.value, below));
    }
    // a reference here answers an opaque member below it (F19a), beside any `missing`
    if (node.reference) {
      out.complete = false;
      return;
    }
    if (length === rest.length) {
      out.list({ literal, path: id });
      return;
    }
    const step = rest[length]!;
    out.writer(lackingAt(contract, index, id, step));
    const child = node.children.get(step);
    if (child === undefined) return;
    id = pathAt(contract, id, step);
    node = child;
  }
}

/** A key's entry's objects below its prefix at `rest` (`entryAt`). */
function* entryObjects(
  contract: Contract,
  out: Gathered,
  entry: PrefixEntry,
  rest: readonly string[],
): Work<void> {
  contract.pass.program.work.charge("invSteps");
  if (entry.unk !== undefined) {
    if (entry.unk === REASON.missing) out.writer(entry.w);
    else out.complete = false;
    return;
  }
  // F6, F7: an emptiness mark holds no property
  if (entry.empty === true) return;
  // F5: an add's element, only below an element step
  if (entry.elem !== undefined) {
    if (rest[0] === "element")
      yield* out.from(objectsAt(contract, entry.elem, [...(entry.at ?? []), ...rest.slice(1)]));
    return;
  }
  if (entry.key !== undefined) {
    // #1655: a pushed read's answer is the producer graph's, which the query does not follow
    if (pushedSlot(contract, entry, restRef(contract, stepsRest(rest))) !== null) {
      out.complete = false;
      return;
    }
    yield* out.from(keyObjects(contract, keyBelowIn(contract, entry.key, rest)));
    return;
  }
  yield* out.from(objectsAt(contract, entry.value!, [...(entry.at ?? []), ...rest]));
}

/**
 * A key's objects (`keyContract`): a literal's by its index; else each prefix's stores at the rest below it, above the
 * receiver's floor. A key through a built-in member, a reference's, with a layer of a replaced source's stores, or with
 * unknowns below a prefix that holds no structure declines.
 */
function* keyObjectsMade(contract: Contract, key: Key): Work<Proven<ObjectsProof>> {
  const { program } = contract.pass;
  program.work.charge("invSteps");
  const out = new Gathered(contract);
  const walk = keyWalk(contract, key);
  const { place } = walk;
  const path = stepsArray(walk.path);
  if (
    contract.keyStopped(key) ||
    program.places[place] === undefined ||
    program.isHost(place) ||
    program.speakerPlaces.has(place) ||
    memberStepOf(contract, path, 0) >= 0 ||
    selecting(path)
  ) {
    out.complete = false;
    return out.proven();
  }
  if (program.cellOwner.has(place) || program.hasOf.has(place)) {
    yield* literalObjects(contract, out, place, path);
    return out.proven();
  }
  // (the receivers of every prefix of the key's read below it, the key's own included: any property below)
  const receiver = yield* receiverWalk(
    contract,
    keyWalk(contract, keyBelowIn(contract, key, [ABSENT])),
  );
  if (receiver.reference || receiver.below.length > 0) {
    out.complete = false;
    return out.proven();
  }
  // (a property below it: its own stores and the written type there, which `absentWriterAt` asks)
  out.key({ key, place, path });
  for (let length = path.length; length >= 0 && length > receiver.floor; length -= 1) {
    program.work.charge("invSteps");
    const stores = contract.prefixStores(walk.prefix(length));
    // (#1466's layers of a replaced source's stores: not followed)
    if (stores.subs !== null || stores.also.length > 0) {
      out.complete = false;
      return out.proven();
    }
    const below = path.slice(length);
    for (const entry of stores.list) yield* entryObjects(contract, out, entry, below);
    if (!out.complete) return out.proven();
  }
  return out.proven();
}
