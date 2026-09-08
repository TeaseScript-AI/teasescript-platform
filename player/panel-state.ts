import type { LeftPanelMode, RightPanelMode } from "./model.js";

export function toggleLeftPanelMode(
  current: LeftPanelMode,
  usesWideDefaultLayout: boolean,
): Exclude<LeftPanelMode, "auto"> {
  const isOpen = current === "open" || (current === "auto" && usesWideDefaultLayout);
  return isOpen ? "closed" : "open";
}

export function toggleRightPanelMode(
  current: RightPanelMode,
  usesWideDefaultLayout: boolean,
): Exclude<RightPanelMode, "auto"> {
  const isDocked = current === "docked" || (current === "auto" && usesWideDefaultLayout);
  return isDocked ? "overlay" : "docked";
}

/**
 * Decide whether a side track can reserve horizontal space without pushing the
 * primary content column below the width it must keep.
 *
 * One rule serves both side regions: the tool track asks first because a tool
 * strip has no alternative geometry, and the long-lived control track asks with
 * the tool reservation already counted because it can fall back to a tray.
 */
export function canReserveSideTrack(
  availableWidth: number,
  otherReservedWidth: number,
  trackWidth: number,
  protectedContentWidth: number,
): boolean {
  return availableWidth - otherReservedWidth - trackWidth >= protectedContentWidth;
}
