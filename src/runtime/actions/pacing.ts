import { MAX_RUNTIME_SESSION_TIME_MS } from "../state.js";
import type { SerializableRuntimeValue } from "../serializable-values.js";
import { describeShownValue } from "../value-types.js";

export { calculateSmartPacingDurationMs } from "../../chat-pacing.js";

export function secondsToPacingMilliseconds(seconds: SerializableRuntimeValue): number {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    const shown = describeShownValue(seconds);
    throw new RangeError(
      typeof seconds === "number" && seconds < 0
        ? `Say pacing must not be negative, but this is ${shown}.`
        : `Say pacing is a number of seconds, but this is ${shown}.`,
    );
  }
  if (seconds === 0) return 0;

  const milliseconds = seconds * 1000;
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > MAX_RUNTIME_SESSION_TIME_MS
  ) {
    throw new RangeError(
      `This say pacing of ${seconds} seconds is too long for scene time to reach. Use a shorter pause.`,
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
