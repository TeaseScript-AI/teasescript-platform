import { MAX_RUNTIME_SESSION_TIME_MS, type ChatPacingSettings } from "../state.js";

export function calculateSmartPacingDurationMs(
  visibleText: string,
  settings: ChatPacingSettings,
): number {
  const wordCount = countWords(visibleText);
  const visibleCharacterCount = countCodePoints(visibleText);
  const wordDelayMs = multiplyPacingValues(wordCount, settings.delayPerWordMs);
  const characterDelayMs = multiplyPacingValues(
    visibleCharacterCount,
    settings.delayPerCharacterMs,
  );
  return addPacingValues(settings.baseDelayMs, Math.max(wordDelayMs, characterDelayMs));
}

export function secondsToPacingMilliseconds(seconds: unknown): number {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError("Pacing seconds must be a finite non-negative number.");
  }
  if (seconds === 0) return 0;

  const milliseconds = seconds * 1000;
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > MAX_RUNTIME_SESSION_TIME_MS
  ) {
    throw new RangeError("Pacing seconds cannot produce a supported positive duration.");
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
    throw new RangeError("Pacing duration must be within the supported range.");
  }
  if (durationMs === 0) return currentSessionTimeMs;

  const deadlineMs = currentSessionTimeMs + durationMs;
  if (
    !isSessionTime(deadlineMs) ||
    deadlineMs <= currentSessionTimeMs
  ) {
    throw new RangeError("Pacing duration cannot produce a supported future deadline.");
  }
  return deadlineMs;
}

function countWords(text: string): number {
  return checkedCount(text.match(/\S+/gu)?.length ?? 0);
}

function countCodePoints(text: string): number {
  return checkedCount(Array.from(text).length);
}

function checkedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Smart pacing text count cannot be represented safely.");
  }
  return value;
}

function multiplyPacingValues(left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("Smart pacing duration cannot be represented safely.");
  }
  return result;
}

function addPacingValues(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("Smart pacing duration cannot be represented safely.");
  }
  return result;
}

function isSessionTime(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_RUNTIME_SESSION_TIME_MS;
}
