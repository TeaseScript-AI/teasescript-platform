import { formatDuration } from "./duration.js";

/**
 * The rules of a wait's or timer's length, a `say` pacing, and an interaction's timeout, each with one message: compile
 * error `TSV011` where the compiler knows the value, and otherwise runtime error
 * `TSR050` (`TSR052` for an askForm). A message takes the value as the runtime shows it (`shown`), which the compiler
 * gives for a value it knows.
 */

/** Scene time is at most `Number.MAX_SAFE_INTEGER` milliseconds, so a longer length can never be reached. */
export function reachesSceneTime(milliseconds: number): boolean {
  return milliseconds <= Number.MAX_SAFE_INTEGER;
}

export function negativeDelayMessage(command: "wait" | "timer", shown: string): string {
  return `${command === "timer" ? "Timer" : "Wait"} duration must not be negative, but this is ${shown}.`;
}

export function zeroRoundMessage(shown: string): string {
  return `A repeating timer needs every round to last longer than zero, but this round can be ${shown}. Use a duration of at least 1 second.`;
}

export function sceneTimeMessage(command: "wait" | "timer"): string {
  return `This ${command} is too long for scene time to reach. Use a shorter duration.`;
}

export function pacingMessage(shown: string): string {
  return `Say pacing must be a duration of at least ${formatDuration(0)}, but this is ${shown}.`;
}

export function buttonTimeoutMessage(shown: string): string {
  return `A showButton timeout must be a duration greater than zero, but this is ${shown}. Remove 'timeout:' to wait for the click without a time limit.`;
}

export function timeoutSceneTimeMessage(command: "showButton" | "askForm"): string {
  return `This ${command} timeout is too long for scene time to reach. Use a shorter timeout, or remove 'timeout:' to wait without a time limit.`;
}
