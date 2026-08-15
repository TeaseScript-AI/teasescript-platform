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
