export function timerProgressRatio(remainingSeconds: number, totalSeconds: number): number {
  if (!Number.isFinite(remainingSeconds) || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return 0;
  }
  const remainingRatio = Math.min(1, Math.max(0, remainingSeconds / totalSeconds));
  return 1 - remainingRatio;
}

export function formatTimer(totalSeconds: number): string {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const seconds = safeSeconds % 60;
  if (safeSeconds < 3600) {
    return `${Math.floor(safeSeconds / 60)}:${String(seconds).padStart(2, "0")}`;
  }

  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The text of a Player Debug countdown at display scene time `nowMs`: whole seconds rounded up, and an elapsed deadline
 * whose action has not settled yet says so instead of counting below zero.
 */
export function debugCountdownText(
  countdown: { readonly kind: "wait" | "button" | "pacing"; readonly deadlineMs: number },
  nowMs: number,
): string {
  const seconds = Math.ceil(Math.max(0, countdown.deadlineMs - nowMs) / 1000);
  if (seconds === 0) return "Wait elapsed · waiting for script";
  switch (countdown.kind) {
    case "wait":
      return `Debug · Continues in ${seconds} s`;
    case "button":
      return `Debug · Press within ${seconds} s`;
    case "pacing":
      return `Debug · Pacing: ${seconds} s remaining`;
  }
}

/** The state of the Stage image in Player Debug's Now view. */
export type DebugStageImageStatus =
  "hidden" | "unresolved" | "covered" | "failed" | "displayed" | "loading";

/**
 * The Stage image's state from the session's image, its resolved source, and what the Stage reports about the source
 * it shows: hidden without an image, unresolved when the host has no file for it, covered while the camera view or a
 * video occupies the Stage, then failed, displayed, or still loading. The Stage's reports count only for the source the
 * image resolves to now.
 */
export function debugStageImageStatus(stage: {
  readonly image: string | null;
  readonly source: string | null;
  readonly covered: boolean;
  readonly loaded: string | null;
  readonly failed: string | null;
}): DebugStageImageStatus {
  if (stage.image === null) return "hidden";
  if (stage.source === null) return "unresolved";
  if (stage.covered) return "covered";
  if (stage.failed === stage.source) return "failed";
  if (stage.loaded === stage.source) return "displayed";
  return "loading";
}
