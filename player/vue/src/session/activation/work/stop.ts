import type { Origin } from "../useActivationRun.js";
import type { StopTarget } from "./target.js";

/*
 * The Player error stop's work (session split S2): stopping the session at the error, its failure capture, and the
 * commit once the host acknowledged, each for the stop's origin and stop token. It acts on the page only through the
 * scheduler's page operations, each admitted at its action.
 */

/** What the stop's work needs from its scheduler. */
export interface StopPage {
  readonly admits: (origin: Origin) => boolean;
  /** Whether `stop` is still the activation's latest stop: no later activation, preparation or end replaced it. */
  readonly isCurrent: (stop: number) => boolean;
  /** Input stops and nothing renders until stop `stop` commits. */
  readonly haltUntil: (stop: number) => void;
  /** Ends the halting of stop `stop`, if it is still the stop halting. */
  readonly endHalting: (stop: number) => void;
  /** Shows the stopped session's final publication, then the error `name` (the first error stays). */
  readonly commit: (target: StopTarget, name: string) => void;
}

/**
 * Stops at `target` in `origin`'s run: once its store froze at the host's acknowledgement, its last publication is the
 * shown session, which the recording and export hold, and the stop renders. A later activation, preparation or unmount
 * supersedes it: a retired `origin` or a replaced `stop` stops nothing, and the halt and capture are not sent
 * (`false`).
 */
export function stopAt(
  target: StopTarget,
  name: string,
  stop: number,
  origin: Origin,
  page: StopPage,
): boolean {
  if (!page.admits(origin) || !page.isCurrent(stop)) {
    page.endHalting(stop);
    return false;
  }
  const acknowledged = target.halt(name, stop);
  target.captureFailure();
  const commit = () => {
    if (!page.admits(origin) || !page.isCurrent(stop)) return page.endHalting(stop);
    // The final publication shows, then the stop; the halt holds the session stopped until then, so nothing reacting
    // to that publication (the stop's call view, also of an unchanged state) sees it running for a moment.
    page.commit(target, name);
    page.endHalting(stop);
  };
  if (target.frozen()) {
    commit();
    return true;
  }
  page.haltUntil(stop);
  // The halt resolves once the store froze; were it to reject, the store froze too (`PlayerBridge.halt`).
  void acknowledged.then(commit, commit);
  return true;
}

/**
 * The stop of a Start still beginning when its Player error came: at its session once the host names it, or the
 * run's incident when it fails, while its activation lives and the stop is still current. A late session no stop
 * claims (its activation retired, or a later activation, preparation or end replaced the stop) is only stopped, with
 * no incident and no capture; a later error stop of the same Start claims it, with the first error.
 */
export function stopLateStart<T>(
  starting: Promise<T>,
  name: string,
  stop: number,
  origin: Origin,
  page: StopPage & {
    /** A target of the late session for `origin`. */
    readonly target: (begun: T) => StopTarget;
    /** Whether a later stop, still current, waits for the same Start: it claims the late session then. */
    readonly claimedLater: () => boolean;
    /** Plain-halts a late session no stop claims: resource-bound cleanup, no incident or capture. */
    readonly haltObsolete: (begun: T) => void;
    /** Shows the error `name` without a session (the first error stays), and commits the run's incident. */
    readonly incident: () => void;
  },
): void {
  page.haltUntil(stop);
  void starting.then(
    (begun) => {
      // A late session no stop claims is only stopped; one a later stop claims is that stop's to stop.
      if (!stopAt(page.target(begun), name, stop, origin, page) && !page.claimedLater())
        page.haltObsolete(begun);
    },
    () => {
      page.endHalting(stop);
      if (!page.isCurrent(stop) || !page.admits(origin)) return;
      page.incident();
    },
  );
}
