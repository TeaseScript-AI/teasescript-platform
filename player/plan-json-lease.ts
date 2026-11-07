/*
 * Who holds a plan's JSON, the text a new session's first save stores, while a page plays: the one place that decides it
 * (L5h.1). The host writes the JSON in a task of its own when the page asks (#1707) and holds it per plan token; a keep's
 * capture takes it from the host (`ops/persistence.ts`), and the page then holds it until the save is stored, or for the
 * next Start of the same plan. `settle` is pure: a state and an event give the next state and the host messages the
 * event implies, which the composable posts. Nothing else changes the state.
 *
 * Its invariants, which `tests/player-plan-json-lease.test.ts` checks over a generated family of event orders:
 * - the host holds a plan's JSON only while the page is live and the plan is its current one;
 * - the JSON is written only where no copy of it exists: in the host, in a capture's reply, or on the page;
 * - nothing is posted once the page closed.
 */

/** A plan's JSON the page holds. */
export interface PlanJson {
  readonly plan: string;
  readonly json: string;
}

export interface PlanJsonLease {
  /** The page's current plan token, or `null` before its first preparation. */
  readonly current: string | null;
  /** Whether the page is open. */
  readonly live: boolean;
  /** The plans whose JSON the host holds or is writing because the page asked. */
  readonly asked: readonly string[];
  /** The keep whose capture is taking a plan's JSON from the host, while its reply is out. */
  readonly capture: { readonly plan: string; readonly prepareAfter: boolean } | null;
  /** The JSON a save took and has not yet stored, so that a retry stores the same bytes. */
  readonly unsaved: PlanJson | null;
  /** The JSON the next first save of its plan takes, when the host need not write it again. */
  readonly prepared: PlanJson | null;
}

/** What `settle` asks the host to do: write a plan's JSON in a later task, or let go of it. */
export type PlanJsonMessage =
  | { readonly kind: "write"; readonly plan: string }
  | { readonly kind: "release"; readonly plan: string };

export type PlanJsonEvent =
  /** The page's preparation now runs `plan`: a plan it replaces needs no JSON any more. */
  | { readonly kind: "replace"; readonly plan: string }
  /** A Start of `plan` is prepared: its first save will need the JSON. */
  | { readonly kind: "prepare"; readonly plan: string }
  /** A keep of a session of `plan` needs its JSON: from the page if it holds it, else taken from the host. */
  | { readonly kind: "captureStart"; readonly plan: string }
  /** The capture's reply arrived: the JSON it took (`null` when the host held none and the session was gone). */
  | {
      readonly kind: "captureReply";
      readonly plan: string;
      readonly json: string | null;
      readonly saved: boolean;
    }
  /** The capture's request ended without a reply, with the Worker: the host and what it held are gone. */
  | { readonly kind: "captureLost"; readonly plan: string }
  /** The save that took `entry` stored it. */
  | { readonly kind: "stored"; readonly entry: PlanJson }
  /** The page closed. */
  | { readonly kind: "dispose" };

/** Where a keep's plan JSON comes from: the page's own copy, or the host. */
export type PlanJsonSource =
  { readonly kind: "page"; readonly entry: PlanJson } | { readonly kind: "host" };

export interface PlanJsonSettled {
  readonly lease: PlanJsonLease;
  readonly messages: readonly PlanJsonMessage[];
  /** For `captureStart`: where the keep takes the JSON. */
  readonly source?: PlanJsonSource;
  /** For `captureReply` of a save: the JSON the save stores, which `unsaved` now holds. */
  readonly saving?: PlanJson | null;
}

export const EMPTY_PLAN_JSON_LEASE: PlanJsonLease = Object.freeze({
  current: null,
  live: true,
  asked: Object.freeze([]),
  capture: null,
  unsaved: null,
  prepared: null,
});

const without = (asked: readonly string[], plan: string) => asked.filter((held) => held !== plan);

/** The next state of `lease` after `event`, and the host messages it implies. */
export function settle(lease: PlanJsonLease, event: PlanJsonEvent): PlanJsonSettled {
  const next = (changes: Partial<PlanJsonLease>, messages: readonly PlanJsonMessage[] = []) => ({
    lease: Object.freeze({ ...lease, ...changes }),
    messages,
  });
  if (!lease.live && event.kind !== "captureReply" && event.kind !== "captureLost")
    return {
      lease,
      messages: [],
      ...(event.kind === "captureStart" ? { source: { kind: "host" } as const } : {}),
    };
  switch (event.kind) {
    case "replace": {
      const old = lease.current;
      if (old === event.plan) return { lease, messages: [] };
      const released = old !== null && lease.asked.includes(old);
      return next(
        {
          current: event.plan,
          asked: old === null ? lease.asked : without(lease.asked, old),
          prepared: lease.prepared?.plan === old ? null : lease.prepared,
        },
        released ? [{ kind: "release", plan: old }] : [],
      );
    }
    case "prepare": {
      const { plan } = event;
      if (lease.unsaved?.plan === plan) return next({ prepared: lease.unsaved });
      if (lease.prepared?.plan === plan || lease.asked.includes(plan))
        return { lease, messages: [] };
      if (lease.capture?.plan === plan) return next({ capture: { plan, prepareAfter: true } });
      return next({ asked: [...lease.asked, plan] }, [{ kind: "write", plan }]);
    }
    case "captureStart": {
      const { plan } = event;
      if (lease.unsaved?.plan === plan)
        return { lease, messages: [], source: { kind: "page", entry: lease.unsaved } };
      if (lease.prepared?.plan === plan)
        return {
          ...next({ prepared: null, unsaved: lease.prepared }),
          source: { kind: "page", entry: lease.prepared },
        };
      // The capture takes the host's copy, so the page no longer asks the host to hold it.
      return {
        ...next({ capture: { plan, prepareAfter: false }, asked: without(lease.asked, plan) }),
        source: { kind: "host" },
      };
    }
    case "captureReply": {
      const { plan, json } = event;
      const prepareAfter = lease.capture?.plan === plan && lease.capture.prepareAfter;
      const capture = lease.capture?.plan === plan ? null : lease.capture;
      if (!lease.live) return { ...next({ capture }), saving: null };
      const entry: PlanJson | null = json === null ? null : { plan, json };
      if (event.saved && entry !== null)
        return {
          ...next({
            capture,
            unsaved: entry,
            prepared: prepareAfter && plan === lease.current ? entry : lease.prepared,
          }),
          saving: entry,
        };
      // Not saved: the JSON stays for the plan's next first save while the plan is current; without one, a Start that was
      // prepared meanwhile has the host write it.
      if (entry !== null)
        return {
          ...next({ capture, prepared: plan === lease.current ? entry : lease.prepared }),
          saving: null,
        };
      if (prepareAfter && plan === lease.current && !lease.asked.includes(plan))
        return {
          ...next({ capture, asked: [...lease.asked, plan] }, [{ kind: "write", plan }]),
          saving: null,
        };
      return { ...next({ capture }), saving: null };
    }
    case "captureLost":
      return next({ capture: lease.capture?.plan === event.plan ? null : lease.capture });
    case "stored":
      return lease.unsaved === event.entry ? next({ unsaved: null }) : { lease, messages: [] };
    case "dispose":
      return next(
        { live: false, asked: [], unsaved: null, prepared: null },
        lease.asked.map((plan) => ({ kind: "release", plan })),
      );
  }
}
