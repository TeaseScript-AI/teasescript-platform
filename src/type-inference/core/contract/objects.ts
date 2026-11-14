import {
  each,
  steps,
  some,
  copied,
  sorted,
  indexed,
  concatenated,
  sliced,
  joined,
} from "../charged-iteration.js";
import type { PlaceId } from "../../graph.js";
import { joinParts, keptArray } from "../budget.js";
import type { Contract } from "../contract.js";
import { keyOf, keyPlace, SELECTED_TEXT, SELECTED_VALUE, type Key } from "../definitions.js";
import { firstWriter, type Writer } from "../items.js";
import { stepName } from "../program.js";
import type { ProofDemand, Proven, Work } from "../solver.js";
import { pushedSlot } from "./frontier.js";
import { receiverWalk } from "./key-contract.js";
import {
  canonicalKey,
  keyBelowIn,
  keptKeyBelowIn,
  keyWalk,
  memberStepOf,
  restRef,
  isPathSteps,
  stepsRest,
} from "./key-ids.js";
import { ABSENT, HELD_REFERENCE } from "./kinds.js";
import { lackingAt, nodeAt, pathAt } from "./literal-index.js";
import { measuresLength, selectsElement } from "../method-categories.js";
import type { ObjectsProof, ObjectSite, PrefixEntry } from "./model.js";
import { othersAt, readGroupsAt } from "./class-groups.js";
import { termAt, writtenOf } from "./terms.js";
import { resultOf, valueRoute } from "./value-kinds.js";

// #1747: the objects a contract read holds at a path, and the earliest object lacking a property below it.

/**
 * #1747: the objects a contract read of `value` at `rest` holds, as a proof: each literal node's object
 * list it reaches at the path (`ObjectSite`), the pure `missing` writers its read meets on the way (a prefix's missing
 * property, a stored `missing`), and the keys whose own stores and written type at a further property it does not
 * cover. Its read at `rest.s` for a property `s` then names its pure `missing` by `absentWriterAt` without reading `s`.
 * A demand once per value and path, read through `Solver.proven`; a route it does not follow declines (`complete`
 * false).
 */
export function objectsAt(
  contract: Contract,
  value: PlaceId,
  rest: readonly string[],
): ProofDemand<ObjectsProof> {
  contract.work.charge("objectSteps");
  const site = contract.pass.program.places[value]?.site ?? null;
  return {
    key: joinParts("ob", value, joined(contract.work, "objectSteps", rest, ".")),
    kind: "contract",
    file: site?.file ?? -1,
    offset: site?.start ?? -1,
    proves: true,
    make: () => {
      contract.work.charge("objectSteps");
      // #1668: the objects query's own run names provenance, never the read's items
      return valueObjects(contract, value, rest);
    },
  };
}

/** `objectsAt` for a key (`contractOf`'s read of it and a property below), once per key. */
export function keyObjects(contract: Contract, asked: Key): ProofDemand<ObjectsProof> {
  contract.work.charge("objectSteps");
  const key = canonicalKey(contract, asked);
  const site = contract.pass.program.places[keyPlace(key)]?.site ?? null;
  return {
    key: joinParts("obk", key),
    kind: "contract",
    file: site?.file ?? -1,
    offset: site?.start ?? -1,
    proves: true,
    make: () => {
      contract.work.charge("objectSteps");
      // #1668: the objects query's own run names provenance, never the read's items
      return keyObjectsMade(contract, key);
    },
  };
}

/**
 * #1747: the pure `missing` writer of `value`'s contract read at `rest.s` (the earliest), from its objects at `rest`
 * (`objectsAt`): the writers met on the way and, of each object list there, its first object lacking `s`
 * (`lackingAt`); `covered` false where the query declines, `s` is stored or typed below a key it reads or that key's
 * read at `s` stopped, or an entry stands at `s` below a list. Each support node of the proof once. Test-only.
 */
export function* absentWriterAt(
  contract: Contract,
  value: PlaceId,
  rest: readonly string[],
  step: string,
): Work<{ readonly covered: boolean; readonly writer: Writer | null }> {
  contract.work.charge("objectSteps");
  const { program, definitions, lists, solver } = contract.pass;
  let writer: Writer | null = null;
  const first = objectsAt(contract, value, rest);
  const seen = new Set<string>([first.key]);
  const open: ProofDemand<ObjectsProof>[] = [first];
  for (const _ of steps(program.work, "objectSteps", () => open.length > 0)) {
    // #1668: a query's proof names the writer of a read's `missing`, none of its items
    const { proof: node } = yield* solver.proven(open.pop()!);
    if (node === null || !node.complete) return UNCOVERED;
    for (const { key, place, path } of each(program.work, "objectSteps", node.keys)) {
      // (the read at the property is a key's own demand: stopped there, it answers no `missing` the query names)
      const below = keyBelowIn(contract, key, [step]);
      if (contract.keyStopped(below)) return UNCOVERED;
      for (const d of each(program.work, "objectSteps", definitions.byKey.get(below) ?? [])) {
        if (lists.live(d)) return UNCOVERED;
      }
      const written = writtenOf(program.place(place).kind);
      if (
        written !== null &&
        termAt(written, concatenated<string>(program.work, "objectSteps", [path, [step]])) !== null
      )
        return UNCOVERED;
    }
    for (const prior of each(program.work, "objectSteps", node.prior)) {
      writer = firstWriter(writer, prior);
    }
    for (const { literal, path } of each(program.work, "objectSteps", node.lists)) {
      const index = contract.literalIndex(literal);
      const below = nodeAt(contract, index, path)?.children.get(step);
      if (below !== undefined && below.reads.length + below.others.length + below.exact.length > 0)
        return UNCOVERED;
      writer = firstWriter(writer, lackingAt(contract, index, path, step));
    }
    // (each edge read, a child already seen too: a dense graph's edges, not only its nodes)
    for (const child of each(program.work, "objectSteps", node.children)) {
      if (!seen.has(child.key)) {
        contract.keepText(child.key.length);
        seen.add(child.key);
        open.push(child);
      }
    }
  }
  return { covered: true, writer };
}

const UNCOVERED = { covered: false, writer: null } as const;

/**
 * What a query gathers: its own sites, writers and keys, and the queries it reads, each once; declined at the first
 * route it does not follow. A query's proof names the queries it reads (their demands), never a copy of their
 * contents, so a support shared by k queries (a call's result, a `get`'s receiver) is held once.
 */
class Gathered {
  readonly #lists = new Map<string, ObjectSite>();
  readonly #prior = new Map<string, Writer>();
  readonly #keys = new Map<string, ObjectsProof["keys"][number]>();
  readonly #children = new Map<string, ProofDemand<ObjectsProof>>();
  complete = true;

  public constructor(private readonly contract: Contract) {
    contract.work.charge("objectSteps");
  }

  public list(site: ObjectSite): void {
    this.contract.work.charge("objectSteps");
    this.#add(this.#lists, joinParts(site.literal, site.path), site);
  }

  public writer(writer: Writer | null): void {
    this.contract.work.charge("objectSteps");
    if (writer !== null)
      this.#add(this.#prior, joinParts(writer.kind, writer.file, writer.start), writer);
  }

  public key(key: ObjectsProof["keys"][number]): void {
    this.contract.work.charge("objectSteps");
    this.#add(this.#keys, joinParts("k", key.key), key);
  }

  /** A query this one reads: its node among this one's, or this one declined. */
  public *from(demand: ProofDemand<ObjectsProof>): Work<void> {
    this.contract.work.charge("objectSteps");
    // (every visit is charged before decline or duplicate paths).
    if (!this.complete) return;
    // #1668: a query this one reads, for its proof alone
    const { proof } = yield* this.contract.pass.solver.proven(demand);
    // (none yet: a query of its own component still running, whose least answer starts empty and whose proof reruns
    // this one when it changes; after a stop no query runs, `absentWriterAt` reading none as uncovered)
    if (proof === null) {
      this.#children.set(demand.key, demand);
      return;
    }
    if (proof === null || !proof.complete) {
      this.complete = false;
      return;
    }
    if (this.#children.has(demand.key)) return;
    this.contract.keepText(demand.key.length);
    this.#children.set(demand.key, demand);
  }

  public proven(): Proven<ObjectsProof> {
    this.contract.work.charge("objectSteps");
    if (!this.complete) return { items: [], proof: declined(this.contract) };
    const { contract } = this;
    // (its own parts and the queries it reads, by their names: equal for equal parts and readers, which a cycle of
    // queries reaches at once, each reader's support read through its own demand)
    const work = contract.work;
    const names = concatenated<string>(work, "objectSteps", [
      this.#lists.keys(),
      this.#prior.keys(),
      this.#keys.keys(),
    ]);
    const children = copied(work, "objectSteps", this.#children.keys());
    contract.keep(2 * (names.length + children.length));
    sorted(work, "objectSteps", names);
    sorted(work, "objectSteps", children);
    return {
      items: [],
      proof: {
        complete: true,
        lists: copied(work, "objectSteps", this.#lists.values()),
        prior: copied(work, "objectSteps", this.#prior.values()),
        keys: copied(work, "objectSteps", this.#keys.values()),
        children: copied(work, "objectSteps", this.#children.values()),
        signature: () => {
          contract.work.charge("objectSteps");
          contract.pass.program.work.charge("sigItems", names.length + children.length + 1);
          return joined(
            work,
            "objectSteps",
            concatenated<string>(work, "objectSteps", [names, ["<"], children]),
            "|",
          );
        },
      },
    };
  }

  #add<T>(map: Map<string, T>, name: string, value: T): void {
    this.contract.work.charge("objectSteps");
    if (map.has(name)) return;
    this.contract.keepText(name.length);
    map.set(name, value);
  }
}

function declined(contract: Contract): ObjectsProof {
  contract.work.charge("objectSteps");
  return {
    complete: false,
    lists: [],
    prior: [],
    keys: [],
    children: [],
    signature: () => {
      contract.work.charge("objectSteps");
      return "declined";
    },
  };
}

/**
 * Whether a path holds a choice's selection step, which the query does not follow: its entry and each step `some`
 * reads charged once, to the first selection (exported for that charging test).
 */
export function selecting(contract: Contract, rest: readonly string[]): boolean {
  contract.work.charge("objectSteps");
  return some(
    contract.work,
    "objectSteps",
    rest,
    (step) => step === SELECTED_VALUE || step === SELECTED_TEXT,
  );
}

/** `objectsAt`'s run: by the value's route (`valueRoute`), as `valueAt` reads it at `rest` and a property below. */
function* valueObjects(
  contract: Contract,
  value: PlaceId,
  rest: readonly string[],
): Work<Proven<ObjectsProof>> {
  contract.work.charge("objectSteps");
  const { program } = contract.pass;
  const out = new Gathered(contract);
  if (selecting(contract, rest)) {
    out.complete = false;
    return out.proven();
  }
  switch (valueRoute(program, value)) {
    case "binding":
      yield* out.from(
        keyObjects(
          contract,
          keptKeyBelowIn(contract, keyOf(program.occurrenceOf.get(value)!, []), rest),
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
      yield* out.from(
        objectsAt(
          contract,
          projection.owner,
          keptArray(
            contract.work,
            concatenated<string>(contract.work, "objectSteps", [[stepName(projection.step)], rest]),
          ),
        ),
      );
      return out.proven();
    }
    case "call":
      yield* out.from(
        keyObjects(contract, keptKeyBelowIn(contract, keyOf(resultOf(contract, value), []), rest)),
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
      // a receiver that may be a reference has the runtime's `get`
      // #1668: a receiver decision
      const receiver = yield* contract.valueReceiver(operation.receiver);
      if (some(contract.work, "objectSteps", receiver, (item) => item === HELD_REFERENCE)) break;
      yield* out.from(
        objectsAt(
          contract,
          operation.receiver,
          keptArray(
            contract.work,
            concatenated<string>(contract.work, "objectSteps", [["element"], rest]),
          ),
        ),
      );
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
 * A literal's objects at `rest` (`contractOfLiteral`'s index walk on the contract side, `indexItems`): the `missing`
 * writer at each prefix lacking the next step, the reads and computed values standing at each prefix read below it, and
 * the object list at the path itself.
 */
function* literalObjects(
  contract: Contract,
  out: Gathered,
  literal: PlaceId,
  rest: readonly string[],
): Work<void> {
  contract.work.charge("objectSteps");
  const { program, definitions } = contract.pass;
  if (!program.hasOf.has(literal) && (definitions.cellDefs.get(literal) ?? []).length === 0) {
    out.complete = false;
    return;
  }
  const index = contract.literalIndex(literal);
  let node = index.root;
  let id = 0;
  let length = 0;
  for (const _ of steps(program.work, "objectSteps", () => true)) {
    let below: readonly string[] | undefined;
    const belowSteps = (): readonly string[] => {
      contract.work.charge("objectSteps");
      return (below ??= sliced(program.work, "objectSteps", rest, length));
    };
    // (each group and entry visited charged, and the walk stops at the first decline: nothing after it changes it)
    for (const group of each(
      program.work,
      "objectSteps",
      readGroupsAt(contract, node.reads, false),
    )) {
      // (a mixed class reads its other members where their answers differ: that depends on the property)
      if (group.rest.length > 0 && group.mixed !== 0) {
        out.complete = false;
        return;
      }
      for (const entry of each(program.work, "objectSteps", group.read)) {
        yield* out.from(objectsAt(contract, entry.value, belowSteps()));
        if (!out.complete) return;
      }
    }
    const groups = othersAt(contract, node.others, false);
    for (const group of each(
      program.work,
      "objectSteps",
      contract.othersBelowOf.get(groups) ?? groups,
    )) {
      if (group === null || (group.rest.length > 0 && group.mixed !== 0)) {
        out.complete = false;
        return;
      }
      for (const entry of each(program.work, "objectSteps", group.read)) {
        yield* out.from(objectsAt(contract, entry.value, belowSteps()));
        if (!out.complete) return;
      }
    }
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
    length += 1;
  }
}

/** A key's entry's objects below its prefix at `rest` (`entryAt`). */
function* entryObjects(
  contract: Contract,
  out: Gathered,
  entry: PrefixEntry,
  rest: readonly string[],
): Work<void> {
  contract.work.charge("objectSteps");
  // (an opaque or deferred store: its unknown beside a `missing` joins their reasons)
  if (entry.unk !== undefined) {
    out.complete = false;
    return;
  }
  // a clear's or a removal's emptiness mark holds no property
  if (entry.empty === true) return;
  if (entry.elem !== undefined) {
    if (rest[0] === "element")
      yield* out.from(
        objectsAt(
          contract,
          entry.elem,
          keptArray(
            contract.work,
            concatenated<string>(contract.work, "objectSteps", [
              entry.at ?? [],
              sliced(contract.work, "objectSteps", rest, 1),
            ]),
          ),
        ),
      );
    return;
  }
  if (entry.key !== undefined) {
    // #1655: a pushed read's answer is the producer graph's, which the query does not follow
    if (pushedSlot(contract, entry, restRef(contract, stepsRest(rest))) !== null) {
      out.complete = false;
      return;
    }
    yield* out.from(keyObjects(contract, keptKeyBelowIn(contract, entry.key, rest)));
    return;
  }
  yield* out.from(
    objectsAt(
      contract,
      entry.value!,
      keptArray(
        contract.work,
        concatenated<string>(contract.work, "objectSteps", [entry.at ?? [], rest]),
      ),
    ),
  );
}

/**
 * A key's objects (`keyContract`): a literal's by its index; else each prefix's stores at the rest below it, above the
 * receiver's floor. A key through a built-in member, a reference's, with a layer of a replaced source's stores, or with
 * unknowns below a prefix that holds no structure declines.
 */
function* keyObjectsMade(contract: Contract, key: Key): Work<Proven<ObjectsProof>> {
  contract.work.charge("objectSteps");
  const { program } = contract.pass;
  const out = new Gathered(contract);
  const walk = keyWalk(contract, key);
  const { place } = walk;
  const path = isPathSteps(walk.path)
    ? keptArray(
        contract.work,
        copied(contract.work, "objectSteps", indexed(contract.work, "objectSteps", walk.path)),
      )
    : walk.path;
  if (
    contract.keyStopped(key) ||
    program.places[place] === undefined ||
    program.isHost(place) ||
    program.speakerPlaces.has(place) ||
    memberStepOf(contract, path, 0) >= 0 ||
    selecting(contract, path)
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
  let length = path.length;
  for (const _ of steps(
    program.work,
    "objectSteps",
    () => length >= 0 && length > receiver.floor,
  )) {
    const stores = contract.prefixStores(walk.prefix(length));
    // (#1466's layers of a replaced source's stores: not followed)
    if (stores.subs !== null || stores.also.length > 0) {
      out.complete = false;
      return out.proven();
    }
    let below: readonly string[] | undefined;
    const belowSteps = (): readonly string[] => {
      contract.work.charge("objectSteps");
      return (below ??= sliced(program.work, "objectSteps", path, length));
    };
    for (const entry of each(program.work, "objectSteps", stores.list)) {
      yield* entryObjects(contract, out, entry, belowSteps());
      if (!out.complete) return out.proven();
    }
    length -= 1;
  }
  return out.proven();
}
