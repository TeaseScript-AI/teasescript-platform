import { MAX_RUNTIME_SESSION_TIME_MS, type ChatPacingSettings } from "../state.js";

export function calculateSmartPacingDurationMs(
  visibleText: string,
  settings: ChatPacingSettings,
): number {
  const wordDelayMs = settings.delayPerWordMs === 0
    ? 0
    : multiplyPacingValues(countWords(visibleText), settings.delayPerWordMs);
  const characterDelayMs = settings.delayPerCharacterMs === 0
    ? 0
    : multiplyPacingValues(countCodePoints(visibleText), settings.delayPerCharacterMs);
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
  let count = 0;
  const words = /\S+/gu;
  while (words.exec(text) !== null) count += 1;
  return checkedCount(count);
}

function countCodePoints(text: string): number {
  let count = 0;
  for (const _codePoint of text) count += 1;
  return checkedCount(count);
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
