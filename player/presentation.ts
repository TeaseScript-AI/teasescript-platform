import type {
  PlayerForegroundOptionPresentation,
  PlayerRightControlPresentation,
} from "./model.js";

export function timerProgressPercent(remainingSeconds: number, totalSeconds: number): number {
  if (!Number.isFinite(remainingSeconds) || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return 0;
  }
  const remainingRatio = Math.min(1, Math.max(0, remainingSeconds / totalSeconds));
  return Math.round((1 - remainingRatio) * 100);
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

export function matchForegroundChoiceByVisibleText(
  options: readonly PlayerForegroundOptionPresentation[],
  submittedText: string,
): PlayerForegroundOptionPresentation | null {
  const matches = options.filter((option) => option.label === submittedText);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function orderRightControls(
  controls: readonly PlayerRightControlPresentation[],
): readonly PlayerRightControlPresentation[] {
  return controls
    .map((control, index) => ({ control, index }))
    .sort((left, right) => {
      const leftHasPriority = left.control.priority !== undefined;
      const rightHasPriority = right.control.priority !== undefined;
      if (leftHasPriority !== rightHasPriority) return leftHasPriority ? -1 : 1;
      if (leftHasPriority && rightHasPriority) {
        const priorityDifference = (left.control.priority ?? 0) - (right.control.priority ?? 0);
        if (priorityDifference !== 0) return priorityDifference;
      }
      return left.index - right.index;
    })
    .map(({ control }) => control);
}

export function readableControlText(fill: string): "#000000" | "#ffffff" {
  const match = /^#(?<red>[0-9a-f]{2})(?<green>[0-9a-f]{2})(?<blue>[0-9a-f]{2})$/iu.exec(fill);
  if (match?.groups === undefined) throw new Error(`Unsupported authored control fill: ${fill}`);

  const channels = [match.groups.red, match.groups.green, match.groups.blue].map((channel) => {
    const encoded = Number.parseInt(channel ?? "00", 16) / 255;
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? "#000000" : "#ffffff";
}
