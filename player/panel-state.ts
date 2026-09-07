import type { LeftPanelMode } from "./model.js";

export function toggleLeftPanelMode(
  current: LeftPanelMode,
  usesWideDefaultLayout: boolean,
): Exclude<LeftPanelMode, "auto"> {
  const isOpen = current === "open" || (current === "auto" && usesWideDefaultLayout);
  return isOpen ? "closed" : "open";
}
