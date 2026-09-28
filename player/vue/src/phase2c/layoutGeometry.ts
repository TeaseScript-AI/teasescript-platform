export interface LayoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface LayoutGridTrack {
  readonly offset: number;
  readonly size: number;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function nonNegative(value: number): number {
  return Math.max(0, finite(value));
}

export function captureRect(rect: DOMRect): LayoutRect {
  return {
    x: finite(rect.x),
    y: finite(rect.y),
    width: nonNegative(rect.width),
    height: nonNegative(rect.height),
    top: finite(rect.top),
    right: finite(rect.right),
    bottom: finite(rect.bottom),
    left: finite(rect.left),
  };
}

export function parseGridTracks(value: string, gap = 0): readonly LayoutGridTrack[] {
  const sizes = value
    .trim()
    .split(/\s+/u)
    .map((part) => (/^-?(?:\d+\.?\d*|\.\d+)px$/u.test(part) ? Number.parseFloat(part) : NaN));
  if (sizes.length === 0 || sizes.some((size) => !Number.isFinite(size) || size < 0)) return [];
  let offset = 0;
  return sizes.map((size) => {
    const track = { offset, size };
    offset += size + nonNegative(gap);
    return track;
  });
}

export function formatPixels(value: number): string {
  return `${Math.round(finite(value) * 10) / 10}px`;
}

export function formatRect(rect: LayoutRect | undefined): string {
  if (rect === undefined) return "not rendered";
  return `${formatPixels(rect.width)} × ${formatPixels(rect.height)} @ ${formatPixels(rect.left)}, ${formatPixels(rect.top)}`;
}
