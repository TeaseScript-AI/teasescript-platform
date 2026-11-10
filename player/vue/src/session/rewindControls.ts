import type { HistoryTimeline } from "../../../engine-bridge/history/core.js";
import { endsQuietly, type PlayerBridge } from "../../../runtime/player-bridge.js";
import type { LifecycleAction, LifecycleEvent } from "../../../debug/rewind-lifecycle.js";
import type { PlayerSession } from "../../../runtime/runtime-view.js";

/*
 * The posting of Debug's history controls that open and close a history (DEBUGGER.md "Rewind"): each is posted in the
 * turn the lifecycle decided it (`rewindOwner.ts`), and its outcome comes back to the lifecycle as an event. The host
 * runs them in that order, so a renewal never passes a close decided before it.
 */

/** What a control needs of the rewind owner. */
export interface RewindControlHost {
  /** Decides `event` with the lifecycle and applies its actions; returns whether a failure is to be reported. */
  readonly decide: (event: LifecycleEvent) => boolean;
  readonly reportPageError: (error: unknown) => void;
}

/**
 * Posts `action`'s close now. One that could not be posted, or that the host refused or rejected on a live connection,
 * blocks every later renewal (`closeSettled`); a close that could not be posted does so before this returns, so no
 * renewal decided after it is posted.
 */
export function postClose(
  bridge: PlayerBridge,
  action: Extract<LifecycleAction, { readonly kind: "close" }>,
  host: RewindControlHost,
): void {
  const failed = (error: unknown) => {
    // A lost connection takes its history with it.
    if (endsQuietly(error)) return;
    if (host.decide({ kind: "closeSettled", ok: false })) host.reportPageError(error);
  };
  const sent = bridge.historyClose({
    history: action.history,
    by: action.by,
    ...(action.adoptionSucceeded === undefined
      ? {}
      : { adoptionSucceeded: action.adoptionSucceeded }),
  });
  if (!sent.posted) return failed(sent.error);
  sent.reply
    .then(({ result }) => {
      if (result.kind !== "refused") return void host.decide({ kind: "closeSettled", ok: true });
      failed(new Error(`The rewind history could not close: ${result.reason}`));
    }, failed)
    .catch(host.reportPageError);
}

/**
 * Posts `action`'s renewal now, enrolling `shown`, or none, and decides its posting (`renewPosted`, `renewUnposted`). Its
 * reply decides `renewed` or `renewFailed`, with the timeline a current one installs (`timelines`, taken by `install`).
 */
export function postRenew(
  bridge: PlayerBridge,
  action: Extract<LifecycleAction, { readonly kind: "renew" }>,
  shown: PlayerSession | null,
  timelines: Map<number, HistoryTimeline>,
  host: RewindControlHost,
): void {
  const { intent } = action;
  const fail = (stage: "close" | "open", error: unknown) => {
    if (host.decide({ kind: "renewFailed", intent, stage }) && !endsQuietly(error))
      host.reportPageError(error);
  };
  const sent = bridge.historyRenew(intent, shown, action.closes);
  // Not posted: the host never saw the renewal, nor the closes it carries; a lost connection's are the loss's. Each
  // close is posted alone now, before any later decision posts, and what is left is the open's failure.
  if (!sent.posted) {
    if (endsQuietly(sent.error)) return;
    host.decide({ kind: "renewUnposted", intent, closes: action.closes });
    return fail("open", sent.error);
  }
  host.decide({ kind: "renewPosted", intent });
  sent.reply
    .then(
      ({ result: renewed }) => {
        switch (renewed.kind) {
          case "renewed": {
            const { history } = renewed.timeline;
            timelines.set(history, renewed.timeline);
            host.decide({ kind: "renewed", intent, history });
            // Installed, it was taken; else it is not shown.
            timelines.delete(history);
            return;
          }
          case "stale":
            return fail(
              "open",
              new Error(`The engine's host answered the renewal ${intent} as replaced.`),
            );
          case "closeFailed":
            return fail(
              "close",
              new Error(`The rewind history could not close: ${renewed.reason}`),
            );
          case "refused":
            return fail("open", new Error(`The rewind history could not open: ${renewed.reason}`));
        }
      },
      (error: unknown) => fail("open", error),
    )
    .catch(host.reportPageError);
}
