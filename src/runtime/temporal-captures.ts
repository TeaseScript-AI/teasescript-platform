import {
  frozenTemporalContext,
  isValidEpochMilliseconds,
  roundToMillisecond,
  temporalContextProblem,
  type TemporalContext,
} from "../temporal.js";

/**
 * What the host recorded about the player for part of a session (V30 §35): the zone and presentation, and the wall
 * clock. Session start records the first capture and every Continue another; each is in force from its boundary scene
 * time until the next one's, so saved catch-up before a Continue keeps the earlier capture.
 */
export interface RuntimeTemporalCapture {
  /** The scene time from which this capture is in force. */
  readonly boundaryMs: number;
  /**
   * The session's next event sequence when the capture was recorded: an action whose request event is earlier was
   * shown with an earlier capture, also at the same scene time.
   */
  readonly sinceEventSequence: number;
  /** The UTC wall clock at the boundary in epoch milliseconds, or `null` when the host supplied no clock. */
  readonly epochMs: number | null;
  readonly context: TemporalContext;
}

/**
 * The capture in force at scene time `atMs`: the last one whose boundary is not later. A valid list's first capture is
 * in force at the current scene time, so execution always finds one.
 */
export function temporalCaptureAt(
  captures: readonly RuntimeTemporalCapture[],
  atMs: number,
): RuntimeTemporalCapture {
  let found = captures[0]!;
  for (const capture of captures) if (capture.boundaryMs <= atMs) found = capture;
  return found;
}

/**
 * The capture an action requested by event `eventSequence` at scene time `atMs` was shown with: the last one recorded
 * before that event whose boundary is not later, or `undefined` when the list no longer has it.
 */
export function temporalCaptureShownAt(
  captures: readonly RuntimeTemporalCapture[],
  atMs: number,
  eventSequence: number,
): RuntimeTemporalCapture | undefined {
  let found: RuntimeTemporalCapture | undefined;
  for (const capture of captures)
    if (capture.boundaryMs <= atMs && capture.sinceEventSequence <= eventSequence) found = capture;
  return found;
}

/**
 * The wall clock at scene time `atMs` in whole epoch milliseconds, or `undefined` when the capture has no clock. Scene
 * time never decreases, so within one capture the result never decreases either.
 */
export function wallClockAt(capture: RuntimeTemporalCapture, atMs: number): number | undefined {
  if (capture.epochMs === null) return undefined;
  return roundToMillisecond(capture.epochMs + (atMs - capture.boundaryMs));
}

/** Copies the capture records; their contexts are frozen and shared. */
export function frozenTemporalCaptures(
  captures: readonly RuntimeTemporalCapture[],
): RuntimeTemporalCapture[] {
  return captures.map((capture) => ({
    boundaryMs: capture.boundaryMs,
    sinceEventSequence: capture.sinceEventSequence,
    epochMs: capture.epochMs,
    context: frozenTemporalContext(capture.context),
  }));
}

/**
 * Why `value` is not a valid capture list, or `null`: at least one capture, in recording order (boundaries and event
 * sequences not decreasing, and one of them increasing; boundaries not past `observedSessionTimeMs` and sequences not
 * past `nextEventSequence`), the first one in force at `currentSessionTimeMs`, and valid clocks and contexts.
 */
export function temporalCapturesProblem(
  value: unknown,
  currentSessionTimeMs: number,
  observedSessionTimeMs: number,
  nextEventSequence: number,
): string | null {
  if (!Array.isArray(value) || value.length === 0)
    return "Temporal captures must be a list of at least one entry.";
  let previous = -Infinity;
  let previousSequence = -Infinity;
  // Captures recorded in one session often share a context, which is checked once.
  const validContexts = new Set<unknown>();
  for (const capture of value) {
    if (
      typeof capture !== "object" ||
      capture === null ||
      Array.isArray(capture) ||
      Object.keys(capture).length !== 4 ||
      !("boundaryMs" in capture) ||
      !("sinceEventSequence" in capture) ||
      !("epochMs" in capture) ||
      !("context" in capture)
    )
      return "A temporal capture must be { boundaryMs, sinceEventSequence, epochMs, context }.";
    const { boundaryMs, sinceEventSequence, epochMs, context } = capture;
    if (
      typeof boundaryMs !== "number" ||
      !Number.isFinite(boundaryMs) ||
      boundaryMs < 0 ||
      boundaryMs < previous ||
      boundaryMs > observedSessionTimeMs
    )
      return "Temporal capture boundaries must not decrease or pass the observed time.";
    if (
      typeof sinceEventSequence !== "number" ||
      !Number.isSafeInteger(sinceEventSequence) ||
      sinceEventSequence < 0 ||
      sinceEventSequence < previousSequence ||
      (sinceEventSequence === previousSequence && boundaryMs === previous) ||
      sinceEventSequence > nextEventSequence
    )
      return "Temporal captures must be in recording order, each later in scene time or event sequence.";
    if (epochMs !== null && (typeof epochMs !== "number" || !isValidEpochMilliseconds(epochMs)))
      return "A temporal capture clock must be null or whole epoch milliseconds in the years 0000 to 9999.";
    if (!validContexts.has(context)) {
      const problem = temporalContextProblem(context);
      if (problem !== null) return problem;
      validContexts.add(context);
    }
    previous = boundaryMs;
    previousSequence = sinceEventSequence;
  }
  // EVIDENCE: validation: the loop above checked that every entry has a numeric boundary.
  if ((value[0] as RuntimeTemporalCapture).boundaryMs > currentSessionTimeMs)
    return "The first temporal capture must be in force at the current scene time.";
  return null;
}
