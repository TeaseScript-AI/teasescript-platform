/*
 * Who owns what the host allocates on a connection (#2006). An op's delivery runs from just before the op runs until
 * its success reply is posted; a facade call's runs until its result has been handed to the bridge. Each allocation
 * registers its undo with its delivery before the retained reference is published (`own`). A delivery that is posted
 * (`posted`) hands what it allocated to the owners it was installed under: the connection, a plan, a slot, a session, a
 * ticket. One that fails (`abort`) undoes it: a throw before the outcome, in building, encoding or posting the success
 * reply. Closing the connection (`close`) is permanent: it aborts every open delivery, and from then on the owner admits
 * no delivery and no allocation, so late work cannot refill what the connection's cleanup cleared.
 *
 * Two deliveries can be open at once, in either order. A facade call can run while an op's delivery is open, awaiting;
 * and a facade's factory can begin a request whose op opens its delivery inside the facade's, and that delivery can
 * outlive the facade's. So an allocation registers with the innermost open delivery (`scope`) only where it runs inside
 * its own op; the facade names its own delivery for every allocation it makes (`in-process.ts`). Work that runs later for
 * an owner already established (a plan-text timer, a source-view continuation of a committed cache) writes to that
 * owner's resource, checked by identity; it does not register with whatever delivery is open then.
 */

/** A delivery's identity: only the owner that began it knows it. */
export interface Delivery {
  readonly delivery: number;
}

/** What may happen to a delivery, or to its owner: the closed set `advanceDelivery` decides. */
export type DeliveryEvent =
  | { readonly kind: "begin" }
  | { readonly kind: "own"; readonly undo: () => void }
  | { readonly kind: "posted" }
  | { readonly kind: "abort" }
  | { readonly kind: "close" };

/** An allocation, or a delivery, that its owner does not admit: nothing was installed. */
export class DeliveryRefusedError extends Error {
  override readonly name = "DeliveryRefusedError";
}

/** The owner of one connection's deliveries; see the module comment. */
export interface DeliveryOwner {
  /** Opens a delivery, the innermost scope until it ends. */
  begin(): Delivery;
  /** Registers `undo` of an allocation with `delivery`, before the allocation is published. */
  own(delivery: Delivery, undo: () => void): void;
  /** Ends `delivery` posted: what it allocated stays with the owners it was installed under. */
  commit(delivery: Delivery): void;
  /** Ends `delivery` failed: its undos run once, the latest first. */
  rollback(delivery: Delivery): void;
  /** Ends the connection for good: every open delivery is aborted, and nothing is admitted from then on. */
  close(): void;
  /** The innermost open delivery, which an allocation registers with now; refused when there is none. */
  scope(): Delivery;
  /** Whether the connection was closed. */
  readonly closed: boolean;
}

/** An owner's state: whether it is closed, and its open deliveries, innermost last, with their undos. */
interface OwnerState {
  closed: boolean;
  readonly report: (error: unknown) => void;
  readonly open: { readonly delivery: Delivery; readonly undos: (() => void)[] }[];
  next: number;
}

const states = new WeakMap<DeliveryOwner, OwnerState>();

/**
 * Runs every undo, the latest first, also when one throws; each failure goes to `report`, never to the caller, so the
 * cleanup that follows an abort or a close always runs. A report that fails in turn is dropped: a diagnostic can never
 * stop the undos, the release or the client's settlement.
 */
function undoAll(undos: readonly (() => void)[], report: (error: unknown) => void): void {
  for (const undo of [...undos].reverse()) attempt(undo, report);
}

/** Runs `step`; a failure goes to `report`, and a report that fails is dropped: the caller always goes on. */
function attempt(step: () => void, report: (error: unknown) => void): void {
  try {
    step();
  } catch (error) {
    try {
      report(error);
    } catch {
      // The diagnostic failed; the cleanup goes on.
    }
  }
}

/** Where an undo's failure goes by default: the host's console, as a host error (there is no client to tell). */
function reportUndoFailure(error: unknown): void {
  console.error("[engine host] an allocation could not be undone", error);
}

/**
 * The one deciding function: advances `owner` by `event` on `delivery` (`null` for `close`, and for `begin`, which
 * returns the new delivery). An unknown, foreign or ended delivery is refused for `own` and `posted`, and is nothing to
 * abort. A closed owner admits no `begin`, and as closing ended every open delivery, an `own` after it names an ended
 * one and is refused as such. `close` is idempotent.
 */
export function advanceDelivery(
  owner: DeliveryOwner,
  delivery: Delivery | null,
  event: DeliveryEvent,
): Delivery | null {
  const state = states.get(owner);
  if (state === undefined) throw new DeliveryRefusedError("An unknown delivery owner.");
  const at = delivery === null ? -1 : state.open.findIndex((each) => each.delivery === delivery);
  switch (event.kind) {
    case "begin": {
      if (state.closed) throw new DeliveryRefusedError("The connection is closed.");
      const begun: Delivery = Object.freeze({ delivery: ++state.next });
      state.open.push({ delivery: begun, undos: [] });
      return begun;
    }
    case "own":
      if (at < 0) throw new DeliveryRefusedError("No open delivery owns this allocation.");
      state.open[at]!.undos.push(event.undo);
      return delivery;
    case "posted":
      if (at < 0) throw new DeliveryRefusedError("No open delivery was posted.");
      state.open.splice(at, 1);
      return delivery;
    case "abort": {
      if (at < 0) return delivery;
      const [ended] = state.open.splice(at, 1);
      undoAll(ended!.undos, state.report);
      return delivery;
    }
    case "close": {
      if (state.closed) return null;
      state.closed = true;
      const ended = state.open.splice(0);
      undoAll(
        ended.flatMap((each) => each.undos),
        state.report,
      );
      return null;
    }
    default:
      throw new DeliveryRefusedError("An unknown delivery event.");
  }
}

/** A connection's delivery owner, open; an undo that fails is reported to `report` (`reportUndoFailure` by default). */
export function deliveryOwner(report: (error: unknown) => void = reportUndoFailure): DeliveryOwner {
  const owner: DeliveryOwner = {
    begin: () => advanceDelivery(owner, null, { kind: "begin" })!,
    own: (delivery, undo) => void advanceDelivery(owner, delivery, { kind: "own", undo }),
    commit: (delivery) => void advanceDelivery(owner, delivery, { kind: "posted" }),
    rollback: (delivery) => void advanceDelivery(owner, delivery, { kind: "abort" }),
    close: () => void advanceDelivery(owner, null, { kind: "close" }),
    scope: () => {
      const state = states.get(owner)!;
      const innermost = state.open.at(-1);
      if (innermost === undefined)
        throw new DeliveryRefusedError("No open delivery owns this allocation.");
      return innermost.delivery;
    },
    get closed() {
      return states.get(owner)!.closed;
    },
  };
  states.set(owner, { closed: false, report, open: [], next: 0 });
  return owner;
}

/**
 * A registry a connection retains, owned by its deliveries: the only way to add an entry (`set`) registers its undo with
 * a delivery first, the innermost open one unless the caller names its own (as the facade does). It adds new keys only,
 * and never restores: undoing removes the entry if it is still the one it added. Removing an entry is a release
 * (`delete`, `clear`), which registers nothing. The map it keeps is reachable only through it, so no entry can be added
 * unregistered.
 */
export class OwnedMap<K, V> {
  readonly #entries = new Map<K, V>();
  /** Each entry's insertion, which its undo names: a key released and set again is another insertion. */
  readonly #insertions = new Map<K, object>();
  readonly #owner: DeliveryOwner;
  readonly #retire: ((value: V, key: K) => void) | undefined;

  /**
   * `retire`, if given, runs once for every entry that leaves: undone, deleted or cleared. One that throws is reported
   * by the owner (`delivery.ts`), and the others still run.
   */
  constructor(owner: DeliveryOwner, retire?: (value: V, key: K) => void) {
    this.#owner = owner;
    this.#retire = retire;
  }

  get size(): number {
    return this.#entries.size;
  }
  get(key: K): V | undefined {
    return this.#entries.get(key);
  }
  has(key: K): boolean {
    return this.#entries.has(key);
  }
  keys(): MapIterator<K> {
    return this.#entries.keys();
  }
  values(): MapIterator<V> {
    return this.#entries.values();
  }
  entries(): MapIterator<[K, V]> {
    return this.#entries.entries();
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#entries.entries();
  }

  /**
   * Adds `value` under the new `key`, owned by `delivery` until it is posted. Refused, before anything changes, without
   * a delivery, or for a key it holds already: an entry is never replaced, so no undo has a value to restore.
   */
  set(key: K, value: V, delivery: Delivery = this.#owner.scope()): void {
    if (this.#entries.has(key))
      throw new DeliveryRefusedError("This registry holds that key already.");
    const insertion = {};
    this.#owner.own(delivery, () => {
      if (this.#insertions.get(key) === insertion) this.delete(key);
    });
    this.#entries.set(key, value);
    this.#insertions.set(key, insertion);
  }

  /** Releases the entry under `key`. */
  delete(key: K): boolean {
    if (!this.#entries.has(key)) return false;
    const value = this.#entries.get(key)!;
    this.#entries.delete(key);
    this.#insertions.delete(key);
    this.#retired(value, key);
    return true;
  }

  /** Releases every entry. */
  clear(): void {
    const entries = [...this.#entries];
    this.#entries.clear();
    this.#insertions.clear();
    for (const [key, value] of entries) this.#retired(value, key);
  }

  /** Runs `retire` for an entry that left, under the owner's reporting. */
  #retired(value: V, key: K): void {
    const retire = this.#retire;
    if (retire !== undefined) attempt(() => retire(value, key), states.get(this.#owner)!.report);
  }
}

/**
 * One value a connection retains as a cache, owned by its deliveries: setting it replaces the value, and undoing empties
 * it if it still holds the undone value, never restoring an earlier one. A cache is recomputed when it is empty.
 */
export class OwnedCell<T> {
  #value: T | null = null;
  readonly #owner: DeliveryOwner;

  constructor(owner: DeliveryOwner) {
    this.#owner = owner;
  }

  get value(): T | null {
    return this.#value;
  }

  /** Holds `value`, owned by `delivery` until it is posted: undoing empties the cell, if it still holds `value`. */
  set(value: T, delivery: Delivery = this.#owner.scope()): void {
    this.#owner.own(delivery, () => {
      if (this.#value === value) this.#value = null;
    });
    this.#value = value;
  }

  /** Releases the value. */
  clear(): void {
    this.#value = null;
  }
}
