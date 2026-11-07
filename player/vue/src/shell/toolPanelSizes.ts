export const toolPanelSizes = { Small: 14, Medium: 18, Large: 24, "Extra Large": 32 } as const;
export type ToolPanelSize = keyof typeof toolPanelSizes;
