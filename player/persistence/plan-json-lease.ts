/*
 * How long the host holds a plan's JSON, the text a new session's first save stores and a Continue compares: the one
 * place that decides it (L5h.1). The host writes the JSON in a task of its own when the page asks (#1707), and holds it
 * for the page's current plan while the page is open; every reader of it (a Continue's comparison, a keep's capture, an
 * import's save) borrows it there and keeps nothing (`ops/persistence.ts`). `settle` is pure: a state and an event give
 * the next state and the host messages the event implies, which the composable posts. Nothing else changes the state.
 *
 * Its invariant, which `tests/player-plan-json-lease.test.ts` checks over a generated family: once its messages are
 * processed, the host holds a plan's JSON only for the live page's current plan, written once for it; nothing is posted
 * once the page closed.
 */

export interface PlanJsonLease {
  /** The page's current plan token, or `null` before its first preparation. */
  readonly current: string | null;
  /** Whether the page is open. */
  readonly live: boolean;
  /** The plan whose JSON the host holds or is writing because the page asked: the current one, or none. */
  readonly reserved: string | null;
}

/** What `settle` asks the host to do: write a plan's JSON in a later task and hold it, or let go of it. */
export type PlanJsonMessage =
  | { readonly kind: "write"; readonly plan: string }
  | { readonly kind: "release"; readonly plan: string };

export type PlanJsonEvent =
  /** The page's preparation now runs `plan`: a plan it replaces needs no JSON any more. */
  | { readonly kind: "replace"; readonly plan: string }
  /** The current plan's JSON will be read: by a Continue's comparison, a first save, or an import's save. */
  | { readonly kind: "prepare"; readonly plan: string }
  /** The page closed. */
  | { readonly kind: "dispose" };

export interface PlanJsonSettled {
  readonly lease: PlanJsonLease;
  readonly messages: readonly PlanJsonMessage[];
}

export const EMPTY_PLAN_JSON_LEASE: PlanJsonLease = Object.freeze({
  current: null,
  live: true,
  reserved: null,
});

const unchanged = (lease: PlanJsonLease): PlanJsonSettled => ({ lease, messages: [] });

/** The next state of `lease` after `event`, and the host messages it implies. */
export function settle(lease: PlanJsonLease, event: PlanJsonEvent): PlanJsonSettled {
  if (!lease.live) return unchanged(lease);
  switch (event.kind) {
    case "replace": {
      if (lease.current === event.plan) return unchanged(lease);
      const released = lease.reserved;
      return {
        lease: Object.freeze({ ...lease, current: event.plan, reserved: null }),
        messages: released === null ? [] : [{ kind: "release", plan: released }],
      };
    }
    case "prepare":
      if (event.plan !== lease.current || lease.reserved === event.plan) return unchanged(lease);
      return {
        lease: Object.freeze({ ...lease, reserved: event.plan }),
        messages: [{ kind: "write", plan: event.plan }],
      };
    case "dispose":
      return {
        lease: Object.freeze({ ...lease, live: false, reserved: null }),
        messages: lease.reserved === null ? [] : [{ kind: "release", plan: lease.reserved }],
      };
  }
}
