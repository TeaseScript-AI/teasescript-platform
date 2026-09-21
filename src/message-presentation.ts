import { isNormalizedColor } from "./color.js";

export interface MessagePresentation {
  readonly kind: "bubble" | "prose";
  /** Bubble placement is Player-owned; prose nulls select Player defaults after inheritance. */
  readonly position: "left" | "center" | "right" | null;
  readonly align: "left" | "center" | "right" | null;
  /** Null selects the Player theme role, rather than an authored colour. */
  readonly color: string | null;
  readonly background: string | null;
  readonly font: string | null;
}

export function isMessagePresentationOption(
  kind: MessagePresentation["kind"],
  name: string,
): boolean {
  return (
    ["color", "background", "font"].includes(name) ||
    (kind === "prose" && ["position", "align"].includes(name))
  );
}

export function isMessagePresentation(value: unknown): value is MessagePresentation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  // EVIDENCE: invariant: the object is narrowed above; every field is validated below.
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 6 &&
    (record.kind === "bubble" || record.kind === "prose") &&
    (record.kind !== "bubble" || (record.position === null && record.align === null)) &&
    (record.position === null ||
      (typeof record.position === "string" &&
        ["left", "center", "right"].includes(record.position))) &&
    (record.align === null ||
      (typeof record.align === "string" && ["left", "center", "right"].includes(record.align))) &&
    (record.color === null || isNormalizedColor(record.color)) &&
    (record.background === null || isNormalizedColor(record.background)) &&
    (record.font === null || typeof record.font === "string")
  );
}
