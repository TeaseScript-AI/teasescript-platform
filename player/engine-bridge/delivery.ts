/*
 * Who owns what the host allocates on a connection (#2006). An op's delivery runs from just before the op runs until
 * its success reply is posted; a facade call's runs until its result has been handed to the bridge. Each allocation
 * registers its undo with its delivery before the retained reference is published (`own`). A delivery that is posted
 * (`posted`) hands what it allocated to the owners it was installed under: the connection, a plan, a slot, a session, a
 * ticket. One that fails (`abort`) undoes it: a throw before the outcome, in building, encoding or posting the success
 * reply. Closing the connection (`close`) is permanent: it aborts every open delivery, and from then on the owner admits
 * no delivery and no allocation, so late work cannot refill what the connection's cleanup cleared.
 *
 * Deliveries nest only synchronously: the host runs one op at a time, and a facade call's delivery opens and ends inside
 * one synchronous call, so the innermost open delivery is the scope an allocation registers with (`scope`). Work that
 * runs later for an owner already established (a plan-text timer, a source-view continuation of a committed cache)
 * writes to that owner's resource, checked by identity; it does not register with whatever delivery is open then.
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
  readonly open: { readonly delivery: Delivery; readonly undos: (() => void)[] }[];
  next: number;
}

const states = new WeakMap<DeliveryOwner, OwnerState>();

/** Runs every undo, the latest first, also when one throws; then throws the first failure. */
function undoAll(undos: readonly (() => void)[]): void {
  const failures: unknown[] = [];
  for (const undo of [...undos].reverse())
    try {
      undo();
    } catch (error) {
      failures.push(error);
    }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Undoing a delivery failed.");
}

/**
 * The one deciding function: advances `owner` by `event` on `delivery` (`null` for `close`, and for `begin`, which
 * returns the new delivery). A closed owner admits no `begin` and no `own`; an unknown, foreign or ended delivery is
 * refused for `own` and `posted`, and is nothing to abort; `close` is idempotent.
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
      if (state.closed) throw new DeliveryRefusedError("The connection is closed.");
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
      undoAll(ended!.undos);
      return delivery;
    }
    case "close": {
      if (state.closed) return null;
      state.closed = true;
      const ended = state.open.splice(0);
      undoAll(ended.flatMap((each) => each.undos));
      return null;
    }
  }
}

/** A connection's delivery owner, open. */
export function deliveryOwner(): DeliveryOwner {
  const owner: DeliveryOwner = {
    begin: () => advanceDelivery(owner, null, { kind: "begin" })!,
    own: (delivery, undo) => void advanceDelivery(owner, delivery, { kind: "own", undo }),
    commit: (delivery) => void advanceDelivery(owner, delivery, { kind: "posted" }),
    rollback: (delivery) => void advanceDelivery(owner, delivery, { kind: "abort" }),
    close: () => void advanceDelivery(owner, null, { kind: "close" }),
    scope: () => {
      const state = states.get(owner)!;
      const innermost = state.open.at(-1);
      if (state.closed || innermost === undefined)
        throw new DeliveryRefusedError("No open delivery owns this allocation.");
      return innermost.delivery;
    },
    get closed() {
      return states.get(owner)!.closed;
    },
  };
  states.set(owner, { closed: false, open: [], next: 0 });
  return owner;
}

/**
 * Registers `undo` with the innermost open delivery of `owner`, then returns: the caller publishes its allocation only
 * after. Refused, before anything is installed, when no delivery is open or the connection is closed.
 */
export function ownNow(owner: DeliveryOwner, undo: () => void): void {
  owner.own(owner.scope(), undo);
}
