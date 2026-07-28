export { MAX_RUNTIME_SESSION_TIME_MS } from "../state.js";

export function isValidSessionTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

export function deadlineReached(nowMs: number, deadlineMs: number): boolean {
  return nowMs >= deadlineMs;
}
