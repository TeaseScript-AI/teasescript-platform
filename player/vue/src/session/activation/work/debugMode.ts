import type { PlayerSession } from "../../../../../runtime/runtime-view.js";
import type { Origin } from "../useActivationRun.js";
import type { SessionTarget } from "./target.js";

/*
 * Debug mode's completion (session split S2): telling the running session whether Debug is on, for the activation that
 * shows it. Its publications show, its success keeps the session, and its failure stops the Player, each only while
 * that activation lives; the request's marker is cleared whether or not it does (resource-bound cleanup).
 */

/** What Debug mode's completion needs from the Debug owner. */
export interface DebugModePage {
  readonly admits: (origin: Origin) => boolean;
  /** Shows a publication of the session while it owns the UI. */
  readonly publish: (next: PlayerSession) => void;
  /** Clears the request's marker, iff it is still this request's. */
  readonly clearMarker: () => void;
  /** Whether the session it asked of still shows (its lineage). */
  readonly stillShown: () => boolean;
  /** Keeps the session, coalesced (a transfer into the persistence owner). */
  readonly keep: () => void;
  /** Whether a failure ends quietly. */
  readonly quiet: (error: unknown) => boolean;
  /** Whether a failure is still the Player's error stop (it lives, has not stopped, and still shows the session). */
  readonly reportable: () => boolean;
  /** The activation error-stop sink, which admits `origin`. */
  readonly report: (origin: Origin, error: unknown) => void;
}

/** Sets Debug mode `on` in `target`'s session, for `origin`. */
export function completeDebugMode(
  target: SessionTarget,
  on: boolean,
  origin: Origin,
  page: DebugModePage,
): void {
  void target
    .setDebugModeShown(on, page.publish)
    .finally(page.clearMarker)
    .then(
      (outcome) => {
        if (!page.admits(origin)) return;
        if (outcome.kind === "set" && page.stillShown()) page.keep();
      },
      (error: unknown) => {
        if (!page.quiet(error) && page.reportable()) page.report(origin, error);
      },
    );
}
