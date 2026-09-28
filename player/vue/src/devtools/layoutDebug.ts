export interface LayoutDebugOptions {
  readonly enabled: boolean;
  readonly grid: boolean;
  readonly regions: boolean;
  readonly reserves: boolean;
  readonly safeAreas: boolean;
  readonly overflow: boolean;
  readonly constraints: boolean;
  readonly viewportOffsets: boolean;
}

export type LayoutDebugOption = keyof LayoutDebugOptions;

export const LAYOUT_DEBUG_OPTION_LABELS = {
  grid: "Grid tracks",
  regions: "Region bounds",
  reserves: "Reserved regions",
  safeAreas: "Safe areas",
  overflow: "Overflow and scroll",
  constraints: "Constraints vs measured",
  viewportOffsets: "Viewport offsets",
} as const satisfies Record<Exclude<LayoutDebugOption, "enabled">, string>;

export function createLayoutDebugOptions(
  initial: Partial<LayoutDebugOptions> = {},
): LayoutDebugOptions {
  return {
    enabled: false,
    grid: true,
    regions: true,
    reserves: true,
    safeAreas: true,
    overflow: true,
    constraints: true,
    viewportOffsets: true,
    ...initial,
  };
}

export function setLayoutDebugOption(
  options: LayoutDebugOptions,
  option: LayoutDebugOption,
  value: boolean,
): LayoutDebugOptions {
  return { ...options, [option]: value };
}
