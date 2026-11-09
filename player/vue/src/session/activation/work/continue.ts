import type { TracingIntent } from "../../../../../engine-bridge/player-ops.js";
import type { TemporalCapture } from "../useSessionActivation.js";
import type { RunOrigin } from "../useActivationRun.js";
import type { SessionTarget } from "./target.js";

/*
 * Continue's work (session split S2): the begin of a restored session's activation, acting only through its target
 * and the scheduler's checks. Its order is the Continue's as it was: the random release, the click's capture, the
 * recording, the trace's epoch, the kept draw, Debug mode, the adoption, the continue.
 */

/** What Continue's work needs from its scheduler, each call-time. */
export interface ContinueWork {
  /** Whether this Player's random control was issued, so the restored session gives it up first. */
  readonly randomIssued: () => boolean;
  /** Throws once the Continue was replaced, re-prepared or unmounted, or its activation retired: it goes no further. */
  readonly owned: () => void;
  /** The click's capture, or what sampling it threw. */
  readonly capture: () => TemporalCapture;
  /** This Player's newest tracing intent, or `undefined`. */
  readonly tracing: () => TracingIntent | undefined;
  /** Whether Debug is on now. */
  readonly debugModeOn: () => boolean;
  /** Gives the continued session this Player's random control, for `origin`. */
  readonly adopt: (target: SessionTarget, origin: RunOrigin) => void;
  /** Whether a failure of the trace's epoch is no error stop any more (the Player stopped or was unmounted). */
  readonly quiet: (error: unknown) => boolean;
  /** The activation error-stop sink. */
  readonly report: (origin: RunOrigin, error: unknown) => void;
}

/** Continues `restored` for `origin`: its target once the host continued it. */
export async function continueRestored(
  restored: SessionTarget,
  origin: RunOrigin,
  work: ContinueWork,
): Promise<SessionTarget> {
  // A restored session runs without Debug's random control until its kept draw went on naturally, as before: one a
  // Start or an adoption gave this Player's control first gives it up (`adopt` below takes it again).
  if (work.randomIssued()) restored.releaseRandom();
  // Continue records the zone, presentation and clock of the click (#1886), before any reply or wait. A capture that
  // throws fails the Continue where it failed before: after its recording began, so the failure's recording is the
  // restored session's, not the previous one's.
  let taken: { readonly capture: TemporalCapture } | { readonly error: unknown };
  try {
    taken = { capture: work.capture() };
  } catch (error) {
    taken = { error };
  }
  // The recording of a restored session starts from the state it continues, and so does a new epoch of the host's
  // value trace, once the Continue owns the UI. The epoch's request is not awaited: the host runs it before what
  // follows (a draw's resume, Debug mode, Continue).
  await restored.beginRecording();
  work.owned();
  const tracing = work.tracing();
  if (tracing?.on)
    void restored.restartTrace(tracing).catch((error: unknown) => {
      if (!work.quiet(error)) work.report(origin, error);
    });
  let continued = restored.latest();
  // A session kept while paused at a random draw goes on with its natural outcome first: until then, the engine takes
  // no other input. It runs without Debug's random control until then, as before, and adopts it after (`adopt` below).
  const draw = continued.snapshot().randomDrawId;
  if (draw !== null) {
    await continued.resolveDrawNaturally(draw);
    work.owned();
    continued = continued.latest();
  }
  // The script reads whether Debug is on now.
  if (continued.snapshot().debugMode !== work.debugModeOn()) {
    await continued.setDebugMode(work.debugModeOn());
    work.owned();
    continued = continued.latest();
  }
  work.adopt(continued, origin);
  if (!("capture" in taken)) throw taken.error;
  await continued.continueWith(taken.capture);
  work.owned();
  return continued.latest();
}
