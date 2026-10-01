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
