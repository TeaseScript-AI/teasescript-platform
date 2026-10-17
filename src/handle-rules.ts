import { formatDuration } from "./duration.js";

/**
 * Rules of timers, media, and camera views and of their handles that the type checker and the runtime both check, each
 * with one predicate and one message. A message takes the value as the runtime shows it (`shown`), which the compiler
 * gives for a value it knows. The compile errors are `TSV034` for timers, `TSV036` for a play command or `showImage`,
 * `TSV037` for media handles, and `TSV059` for camera views. The members of the handles are in `handle-members.ts`.
 */

export function isTimerDisplay(value: unknown): value is "visible" | "mystery" | "hidden" {
  return value === "visible" || value === "mystery" || value === "hidden";
}

export function timerDisplayMessage(shown: string): string {
  return `Timer display must be "visible", "mystery", or "hidden", but this is ${shown}.`;
}

export function isCameraPlacement(value: unknown): value is "window" | "stage" {
  return value === "window" || value === "stage";
}

/** `shown` is `null` for a compound assignment, whose result the compiler cannot know but is never a placement. */
export function cameraPlacementMessage(shown: string | null): string {
  return `Camera placement must be "window" or "stage"${shown === null ? "" : `, but this is ${shown}`}.`;
}

export function isMediaVolume(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

export const MEDIA_VOLUME_RULE = "Media volume must be a number from 0 through 1";

export function mediaVolumeMessage(shown: string): string {
  return `${MEDIA_VOLUME_RULE}, but this is ${shown}.`;
}

/** What a play command or `showImage` (`command`) takes as its file. */
export function fileReferenceRule(command: string): string {
  return `${command} needs a file reference in text (string) or null`;
}

/** `repeat: true`, or `repeat` before the file, on media that blocks until it ends. */
export function blockingRepeatMessage(command: "playAudio" | "playVideo"): string {
  return `Blocking media cannot repeat indefinitely. Use '${command} async', a count such as 'repeat: 3 times', or a duration such as 'repeat: 60 s'.`;
}

export const FINISH_NEVER_RUNS_MESSAGE =
  "'finish' never runs for media that repeats indefinitely. Calling stop() does not run it either. Use a count such as 'repeat: 3 times' or a duration such as 'repeat: 60 s', or remove 'finish'.";

/** What `repeat:` takes, besides a count before `times`. */
export const MEDIA_REPEAT_RULE =
  "Media repeat must be true, false, a count such as '3 times', or a positive duration";

/** Whether media can play `count` times. */
export function isMediaRepeatCount(count: number): boolean {
  return Number.isSafeInteger(count) && count >= 1;
}

/** Whether media can repeat for `milliseconds`. */
export function isRepeatBudget(milliseconds: number): boolean {
  return Number.isFinite(milliseconds) && milliseconds > 0;
}

export const MEDIA_REPEAT_COUNT_RULE =
  "A repeat count must be a whole number of at least 1, such as '3 times'";

/** Whether a media position (`startAt`, `endAt`, or a cue position) of `milliseconds` lies in the media. */
export function isMediaPosition(milliseconds: number): boolean {
  return Number.isFinite(milliseconds) && milliseconds >= 0;
}

/** `subject` is `startAt`, `endAt`, or a cue's position, such as `at position`. */
export function mediaPositionMessage(subject: string, shown: string): string {
  return `Media ${subject} must be a duration of at least ${formatDuration(0)}, but this is ${shown}.`;
}

/** Whether media that plays from `startMs` to `endMs` plays anything. */
export function isMediaRange(startMs: number, endMs: number): boolean {
  return endMs > startMs;
}

export function mediaRangeMessage(end: string, start: string): string {
  return `Media endAt must be later than startAt, but endAt is ${end} and startAt is ${start}.`;
}
