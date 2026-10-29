import type { PlaceId } from "../../graph.js";
import { keepText, keptSteps, pathText } from "../budget.js";
import type { Contract } from "../contract.js";
import {
  keptKey,
  keptKeyBelow,
  keyBelow,
  keyOf,
  keyPath,
  keyPlace,
  type Key,
} from "../definitions.js";
import { methodCategory } from "../method-categories.js";
import { stepName } from "../program.js";
import { holderAt, holderOfKey, newHolder } from "./marks.js";
import type { Identity, IdentityWork, StoredChoiceKeys } from "./model.js";
import { writtenOf } from "./terms.js";
import { resultOf } from "./value-kinds.js";

// The one identity function (§8 r4.15): the key a value copies, a key's and a value's source identity, structures.

/** The key a value copies, through its projections: `seed.f0` reads `seed|f0`; `null` for no read. */
export function copiedKey(contract: Contract, value: PlaceId): Key | null {
  const { program } = contract.pass;
  const binding = program.occurrenceOf.get(value);
  if (binding !== undefined) return keyOf(binding, []);
  // (G3 3b: a projection's key is its owner's and its step, once per projection, never its whole chain again)
  const known = contract.copiedKeys.get(value);
  if (known !== undefined) return known;
  const pending: PlaceId[] = [];
  let current = value;
  let below: Key | null = null;
  for (;;) {
    const projection = program.projOf.get(current);
    if (projection === undefined || projection.step === "iteration") {
      below = null;
      break;
    }
    program.work.charge("invSteps");
    pending.push(current);
    const owner = program.occurrenceOf.get(projection.owner);
    const memo = owner === undefined ? contract.copiedKeys.get(projection.owner) : undefined;
    if (owner !== undefined || memo !== undefined) {
      below = owner !== undefined ? keyOf(owner, []) : memo!;
      break;
    }
    current = projection.owner;
  }
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const at = pending[index]!;
    if (below !== null)
      below = keptKeyBelow(contract.work, below, [stepName(program.projOf.get(at)!.step)]);
    contract.keep(1);
    contract.copiedKeys.set(at, below);
  }
  return pending.length === 0 ? null : (contract.copiedKeys.get(value) ?? null);
}

/** A call's result read further (`snapshot()`, `snapshot().data`): the callee's result key (F20), else `null`. */
export function resultKey(contract: Contract, value: PlaceId): Key | null {
  const { program } = contract.pass;
  const steps: string[] = [];
  let current = value;
  for (let projection = program.projOf.get(current); projection !== undefined;) {
    if (projection.step === "iteration") return null;
    program.work.charge("invSteps");
    steps.push(stepName(projection.step));
    current = projection.owner;
    projection = program.projOf.get(current);
  }
  return program.callOutOf.has(current)
    ? keyOf(resultOf(contract, current), steps.reverse())
    : null;
}

/** A place that only copies hold: no host, speaker or literal place. */
export function copyOnly(contract: Contract, place: PlaceId): boolean {
  const { program } = contract.pass;
  return (
    program.places[place] !== undefined &&
    !program.isHost(place) &&
    !program.speakerPlaces.has(place) &&
    !program.cellOwner.has(place) &&
    !program.hasOf.has(place)
  );
}

/**
 * Per key, whether a store goes below a property named `value`, and one named `text` (a choice object changed after it
 * is made): then a held choice object's button value is read by that key, not per record (V30 §19).
 */
export function choiceKeysStored(contract: Contract): StoredChoiceKeys {
  if (contract.storedChoiceKeys === null) {
    let value = false;
    let text = false;
    for (const [key] of contract.pass.definitions.byKey) {
      contract.pass.program.work.charge("invSteps");
      const path = keyPath(key);
      value ||= path.includes("value");
      text ||= path.includes("text");
      if (value && text) break;
    }
    contract.storedChoiceKeys = { value, text };
  }
  return contract.storedChoiceKeys;
}

/** The keys of a place that have definitions. */
function keysOfPlace(contract: Contract, place: PlaceId): readonly Key[] {
  if (contract.placeKeys === null) {
    contract.placeKeys = new Map();
    for (const [key] of contract.pass.definitions.byKey) {
      contract.pass.program.work.charge("invSteps");
      const list = contract.placeKeys.get(keyPlace(key));
      if (list === undefined) contract.placeKeys.set(keyPlace(key), [key]);
      else list.push(key);
    }
  }
  return contract.placeKeys.get(place) ?? [];
}

/** Per place, the first steps of its live stores below the root (a preset's changed field). */
export function subFirstOf(contract: Contract, place: PlaceId): ReadonlySet<string> {
  if (contract.subFirst === null) {
    contract.subFirst = new Map();
    for (const [key, list] of contract.pass.definitions.byKey) {
      const path = keyPath(key);
      contract.pass.program.work.charge("invSteps");
      if (path.length > 0 && list.some((d) => contract.pass.lists.live(d))) {
        let steps = contract.subFirst.get(keyPlace(key));
        if (steps === undefined) contract.subFirst.set(keyPlace(key), (steps = new Set()));
        steps.add(path[0]!);
      }
    }
  }
  return contract.subFirst.get(place) ?? NO_STEPS;
}

/**
 * The key a place is an alias of: one whole store of a copy or of a call's result, no store below it, no written
 * type, its aliases followed, with the guard bit along the chain (§3.2). A cycle of aliases stops at itself. A loop up
 * the chain to a place answered or no alias, then each link answered from the top.
 */
function rootOfPlace(
  contract: Contract,
  place: PlaceId,
): { readonly key: Key; readonly guarded: boolean } {
  const known = contract.aliases.get(place);
  if (known !== undefined) return known;
  const { definitions, lists, program, guards } = contract.pass;
  const chain: { readonly place: PlaceId; readonly up: Key; readonly guarded: boolean }[] = [];
  let at = place;
  let top: { readonly key: Key; readonly guarded: boolean };
  for (;;) {
    const unaliased = { key: keptKey(contract.work, at, []), guarded: false };
    contract.aliases.set(at, unaliased);
    program.work.charge("invSteps");
    const stores = (definitions.byKey.get(keyOf(at, [])) ?? []).filter((d) => lists.live(d));
    const one =
      stores.length === 1 &&
      stores[0]!.kind === "whole" &&
      keysOfPlace(contract, at).length === 1 &&
      copyOnly(contract, at) &&
      writtenOf(program.place(at).kind) === null;
    const copied = one ? contract.copiedKey(stores[0]!.value!) : null;
    const up = copied ?? (one ? contract.resultKey(stores[0]!.value!) : null);
    if (up === null) {
      top = unaliased;
      break;
    }
    chain.push({
      place: at,
      up,
      guarded: copied !== null && guards.guardedRead(stores[0]!.value!),
    });
    const answered = contract.aliases.get(keyPlace(up));
    if (answered !== undefined) {
      top = answered;
      break;
    }
    at = keyPlace(up);
  }
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const link = chain[index]!;
    top = {
      key: keptKeyBelow(contract.work, top.key, keyPath(link.up)),
      guarded: top.guarded || link.guarded,
    };
    contract.aliases.set(link.place, top);
  }
  return contract.aliases.get(place)!;
}

/**
 * A key's source identity: the key itself through its aliases, and a place of whole copies of one source followed
 * to that source; with its holder (§8 r4.15, r4.23). A loop along those places, then each answered from the last.
 */
export function keyIdentity(contract: Contract, key: Key): Identity {
  if (!contract.keys.has(key)) contract.settle(keyIdentityWork(contract, key));
  return contract.keys.get(key)!;
}

export function* keyIdentityWork(contract: Contract, key: Key): IdentityWork {
  if (contract.keys.has(key)) return;
  const { program } = contract.pass;
  const chain: { readonly key: Key; readonly rooted: Key; readonly guarded: boolean }[] = [];
  let at = key;
  let last: Identity;
  for (;;) {
    // a copy cycle stops here (each identity's id, a key's text, charged as kept)
    const placeholder = `k${at}`;
    keepText(contract.work, placeholder.length);
    contract.keys.set(at, {
      id: placeholder,
      key: at,
      guarded: false,
      holder: holderOfKey(contract, at),
    });
    program.work.charge("invSteps");
    const top = rootOfPlace(contract, keyPlace(at));
    const rooted = keptKeyBelow(contract.work, top.key, keyPath(at));
    keepText(contract.work, rooted.length + 1);
    let identity: Identity = {
      id: `k${rooted}`,
      key: rooted,
      guarded: top.guarded,
      holder: holderOfKey(contract, rooted),
    };
    const place = keyPlace(rooted);
    let inner: Key | null = null;
    if (
      top.key === keyOf(place, []) &&
      copyOnly(contract, place) &&
      writtenOf(program.place(place).kind) === null
    ) {
      // (a prefix under discovery whose own stores already hold more than copies has no single entry, whatever the rest
      // bring: so answered, never discovered again from its start, so a chain of k calls of one helper discovers its
      // parameter once, not once per link, #1257)
      const prefix = keyOf(place, []);
      const stores =
        contract.discovering.get(prefix)?.other === true
          ? null
          : yield* contract.needPrefix(prefix);
      const entry =
        stores !== null &&
        stores.list.length === 1 &&
        !stores.other &&
        stores.subs === null &&
        stores.also.length === 0
          ? stores.list[0]!
          : null;
      const path = keyPath(rooted);
      if (entry !== null && entry.key !== undefined) {
        inner = keyBelow(entry.key, path);
        chain.push({ key: at, rooted, guarded: identity.guarded || entry.guarded });
      } else if (entry !== null && entry.value !== undefined) {
        // (the lifted holder's reference keeps it as its shift, charged as kept)
        const within = keptSteps(contract.work, entry.at ?? [], path);
        const source = yield* contract.needValue(entry.value);
        identity = {
          id: contract.kept(`${source.id}@${pathText(within)}`),
          key: rooted,
          guarded: identity.guarded || entry.guarded,
          holder: holderAt(contract, source.holder, within),
        };
      }
    }
    if (inner === null) {
      contract.keys.set(at, identity);
      last = identity;
      break;
    }
    const answered = contract.keys.get(inner);
    if (answered !== undefined) {
      last = answered;
      break;
    }
    at = inner;
  }
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const link = chain[index]!;
    last = {
      id: last.id,
      key: link.rooted,
      guarded: link.guarded || last.guarded,
      holder: last.holder,
    };
    contract.keys.set(link.key, last);
  }
}

/**
 * A value's source identity: the key a read copies, its callee's result key for a call, a literal's structure, or the
 * value itself; the read's guard an annotation, each with its mark holder (§8 r4.23).
 */
export function identityOf(contract: Contract, value: PlaceId): Identity {
  if (!contract.identities.has(value)) {
    if (contract.indexing.has(value)) return contract.own(value);
    contract.settle(identityWork(contract, value));
  }
  return contract.identities.get(value)!;
}

export function* identityWork(contract: Contract, value: PlaceId): IdentityWork {
  if (contract.identities.has(value)) return;
  contract.pass.program.work.charge("invSteps");
  let identity: Identity;
  const copied = contract.copiedKey(value);
  if (copied !== null) {
    const source = yield* contract.needKey(copied);
    identity = {
      // S6-CARRIERS §3.1: an ingress occurrence is fresh, so no identity merge shares it (its leaf stays its own)
      id: contract.pass.definitions.ingress.has(value) ? `v${value}` : source.id,
      key: source.key,
      guarded: source.guarded || contract.pass.guards.guardedRead(value),
      holder: source.holder,
    };
  } else {
    const result = contract.resultKey(value);
    if (result !== null) {
      const source = yield* contract.needKey(result);
      identity = { id: source.id, key: result, guarded: false, holder: source.holder };
    } else if (contract.pass.program.hasOf.has(value)) {
      const id = yield* contract.needSignature(value);
      identity = {
        id,
        key: null,
        guarded: false,
        holder: contract.holders.get(id) ?? newHolder(contract, id),
      };
    } else {
      // a computed value (an operation's result): its own holder, so a guarded read of a copy of it is a mark there;
      // a value a carrier gives (`otherwise`, `get`, a copy of the elements, a removal, a list's `+`, a projection of
      // a computed value) by what it takes, so k such values of one source are one entry, as k copies are (F2)
      // (interned: an identity names its inputs by their own short identities, never by their expansions)
      const carried = carriedBy(contract, value, false);
      let id = `v${value}`;
      if (carried !== null) {
        const parts: string[] = [];
        for (const input of carried.of)
          parts.push(input === null ? "" : (yield* contract.needValue(input)).id);
        // (a value carrying a fresh one is fresh itself: §3.1, never shared across its occurrences)
        if (!parts.some((part) => part.startsWith("v"))) {
          const shape = `${carried.name}(${parts.join(",")})`;
          id = contract.carrierIds.get(shape) ?? `c${contract.carrierIds.size}`;
          contract.carrierIds.set(shape, id);
        }
      }
      identity = {
        id,
        key: null,
        guarded: false,
        holder: contract.holders.get(id) ?? newHolder(contract, id),
      };
    }
  }
  contract.identities.set(value, identity);
}

/**
 * What a carrier's value takes, by the carrier (`identityWork`), or only what its result reads (`structural`: a
 * `get`'s receiver and default, never its key, §4.6); `null` for any other computed value.
 */
function carriedBy(
  contract: Contract,
  value: PlaceId,
  structural: boolean,
): { readonly name: string; readonly of: readonly (PlaceId | null)[] } | null {
  const { program } = contract.pass;
  const projection = program.projOf.get(value);
  if (projection !== undefined && projection.step !== "iteration")
    return { name: `.${projection.step}`, of: [projection.owner] };
  const c = program.opOf.get(value);
  if (c?.kind === "fallback") return { name: "otherwise", of: [c.left, c.right] };
  if (c?.kind === "get")
    return {
      name: "get",
      of: structural ? [c.receiver, c.fallback] : [c.receiver, c.key, c.fallback],
    };
  if (c?.kind !== "operation") return null;
  const { family, name } = c.contract;
  const gives =
    family === "method" && c.receiver !== null ? methodCategory(name)?.gives : undefined;
  if (
    gives?.kind === "copy" ||
    gives?.kind === "removed" ||
    (family === "operator" && name === "+")
  )
    return { name: `${family}.${name}`, of: [c.receiver, ...c.arguments] };
  return null;
}

/**
 * S6-CARRIERS §4.6: a value's structure identity, what its contract reads: a read's key and its guard, a call's
 * result key, a carrier by the structures of the operands its result reads (a `get`'s key apart) and their guards, a
 * literal by its cells' structures; fresh (`v`) where an ingress occurrence stands at a position its result reads,
 * so a structure shared by reference never merges an occurrence the result carries. A key's prefix entries are keyed
 * by it.
 */
export function structureOf(contract: Contract, value: PlaceId): string {
  if (!contract.structures.has(value)) {
    if (contract.indexing.has(value)) return `v${value}`;
    contract.settle(structureWork(contract, value));
  }
  return contract.structures.get(value)!;
}

export function* structureWork(contract: Contract, value: PlaceId): IdentityWork {
  if (contract.structures.has(value)) return;
  const { program, definitions } = contract.pass;
  program.work.charge("structureSteps");
  let id = `v${value}`;
  if (contract.copiedKey(value) !== null || contract.resultKey(value) !== null) {
    // (a read under a test of its path is marked, §3.2)
    if (!definitions.ingress.has(value)) {
      const identity = yield* contract.needValue(value);
      id = identity.guarded ? `${identity.id}g` : identity.id;
    }
  } else if (program.hasOf.has(value)) {
    const index = yield* contract.needIndex(value);
    program.work.charge("structureSteps");
    const shape = yield* contract.nodeShape(index.root, "str");
    if (shape.plain) {
      id = contract.internStructure(`l(${shape.name})`);
      if (shape.marked) contract.markedStructures.add(id);
    }
  } else {
    const carried = carriedBy(contract, value, true);
    if (carried !== null) {
      const parts: string[] = [];
      let marked = false;
      for (const input of carried.of) {
        if (input === null) {
          parts.push("");
          continue;
        }
        const part = yield* contract.needStructure(input);
        const below = guardsBelow(contract, input);
        marked ||= below !== "" || contract.markedStructures.has(part);
        parts.push(`${part}${below}`);
      }
      if (!parts.some((part) => part.startsWith("v"))) {
        // (the whole shape charged, its carrier's name with it: a property projection's is the author's name)
        const shape = `${carried.name}(${parts.join(",")})`;
        contract.keepText(shape.length);
        id = contract.internStructure(shape);
        if (marked) contract.markedStructures.add(id);
      }
    }
  }
  contract.structures.set(value, id);
}

/**
 * The tested paths below a carrier's operand read that the read is guarded at (§3.2), as part of the carrier's
 * structure: no holder records a carrier operand's marks, as a literal's holder records its reads' (r4.15), so two
 * carriers share a structure only where their operand reads are marked alike below them (Codex r20 B1). Each the
 * outermost of nested ones, the guard index's regions holding the read, never each tested path in turn (Codex r21 B1).
 */
export function guardsBelow(contract: Contract, operand: PlaceId): string {
  const { guards, definitions } = contract.pass;
  if (
    contract.copiedKey(operand) === null ||
    definitions.ingress.has(operand) ||
    contract.identityOf(operand).guarded
  )
    return "";
  const marked = guards.guardedBelowRead(operand);
  return marked.length === 0 ? "" : `g[${marked.join(";")}]`;
}

const NO_STEPS: ReadonlySet<string> = new Set();
