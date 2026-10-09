import { formatDuration } from "../../duration.js";
import { MAX_RUNTIME_SESSION_TIME_MS } from "../state.js";

export { calculateSmartPacingDurationMs } from "../../chat-pacing.js";

/** The exact pacing of a message, from the milliseconds of its duration; zero is immediate. */
export function exactPacingMilliseconds(milliseconds: unknown): number {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError(`Say pacing must be a duration of at least ${formatDuration(0)}.`);
  }
  if (milliseconds === 0) return 0;
  if (milliseconds > MAX_RUNTIME_SESSION_TIME_MS) {
    throw new RangeError(
      `This say pacing of ${formatDuration(milliseconds)} is too long for scene time to reach. Use a shorter pause.`,
    );
  }
  return milliseconds;
}

export function calculatePacingDeadlineMs(
  currentSessionTimeMs: number,
  durationMs: number,
): number {
  if (!isSessionTime(currentSessionTimeMs)) {
    throw new RangeError("Current session time must be within the supported range.");
  }
  if (
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    durationMs > MAX_RUNTIME_SESSION_TIME_MS
  ) {
    throw new RangeError(
      "This say pacing is too long for scene time to reach. Use a shorter pause.",
    );
  }
  if (durationMs === 0) return currentSessionTimeMs;
  // At the last scene time, no positive pause has a later deadline.
  if (currentSessionTimeMs === MAX_RUNTIME_SESSION_TIME_MS) {
    throw new RangeError(
      "Scene time has reached its limit, so this say cannot pause. Use 'instant' instead.",
    );
  }

  const deadlineMs = currentSessionTimeMs + durationMs;
  if (!isSessionTime(deadlineMs) || deadlineMs <= currentSessionTimeMs) {
    throw new RangeError(
      isSessionTime(deadlineMs)
        ? "This say pacing is too short to measure this late in the scene. Use a longer pause."
        : "This say pacing is too long for scene time to reach. Use a shorter pause.",
    );
  }
  return deadlineMs;
}

function isSessionTime(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_RUNTIME_SESSION_TIME_MS
  );
}
