/**
 * How long a message's pacing gate holds by default (RUNTIME.md "Smart-autoplay session settings"): a base delay plus the
 * longer of a delay per word and a delay per character of its visible text. The runtime paces with a session's
 * settings; the compiler measures with the defaults.
 */
export interface ChatPacingSettings {
  readonly baseDelayMs: number;
  readonly delayPerWordMs: number;
  readonly delayPerCharacterMs: number;
}

export const DEFAULT_CHAT_PACING_SETTINGS: ChatPacingSettings = Object.freeze({
  baseDelayMs: 1500,
  delayPerWordMs: 300,
  delayPerCharacterMs: 30,
});

export function calculateSmartPacingDurationMs(
  visibleText: string,
  settings: ChatPacingSettings,
): number {
  const wordDelayMs =
    settings.delayPerWordMs === 0
      ? 0
      : multiplyPacingValues(countWords(visibleText), settings.delayPerWordMs);
  const characterDelayMs =
    settings.delayPerCharacterMs === 0
      ? 0
      : multiplyPacingValues(countCodePoints(visibleText), settings.delayPerCharacterMs);
  return addPacingValues(settings.baseDelayMs, Math.max(wordDelayMs, characterDelayMs));
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
