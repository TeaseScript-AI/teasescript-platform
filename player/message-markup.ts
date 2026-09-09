import type {
  MessageMarkup,
  MessageMarkupBlock,
  MessageMarkupLine,
  MessageMarkupSpan,
} from "../src/message-markup.js";

export interface PlayerMarkupPiece {
  readonly text: string;
  readonly classes: readonly string[];
  readonly style: Readonly<Record<string, string>>;
  readonly href: string | null;
}

export interface PlayerMarkupGroup {
  readonly spoilerId: string | null;
  readonly pieces: readonly PlayerMarkupPiece[];
}

export interface PlayerMarkupLine {
  readonly groups: readonly PlayerMarkupGroup[];
  readonly ending: MessageMarkupLine["ending"];
}

export type PlayerMarkupBlock =
  | { readonly kind: "paragraph"; readonly lines: readonly PlayerMarkupLine[] }
  | { readonly kind: "quote"; readonly lines: readonly PlayerMarkupLine[] }
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly line: PlayerMarkupLine }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly items: readonly {
        readonly ordinal: string | null;
        readonly line: PlayerMarkupLine;
      }[];
    };

export function preparePlayerMessageMarkup(message: MessageMarkup): readonly PlayerMarkupBlock[] {
  return Object.freeze(message.blocks.map(prepareBlock));
}

function prepareBlock(block: MessageMarkupBlock): PlayerMarkupBlock {
  switch (block.kind) {
    case "paragraph":
    case "quote":
      return Object.freeze({
        kind: block.kind,
        lines: Object.freeze(block.lines.map(prepareLine)),
      });
    case "heading":
      return Object.freeze({ kind: "heading", level: block.level, line: prepareLine(block.line) });
    case "list":
      return Object.freeze({
        kind: "list",
        ordered: block.ordered,
        items: Object.freeze(
          block.items.map((item) =>
            Object.freeze({ ordinal: item.ordinal, line: prepareLine(item.line) }),
          ),
        ),
      });
  }
}

function prepareLine(line: MessageMarkupLine): PlayerMarkupLine {
  const boundaries = new Map<
    number,
    { readonly starting: MessageMarkupSpan[]; readonly ending: MessageMarkupSpan[] }
  >();
  boundaryAt(boundaries, 0);
  boundaryAt(boundaries, line.text.length);
  for (const span of line.spans) {
    if (span.start === span.end) continue;
    boundaryAt(boundaries, span.start).starting.push(span);
    boundaryAt(boundaries, span.end).ending.push(span);
  }

  const positions = [...boundaries.keys()].sort((left, right) => left - right);
  const active = new Map<MessageMarkupSpan["kind"], MessageMarkupSpan[]>();
  const groups: Array<{ spoilerId: string | null; pieces: PlayerMarkupPiece[] }> = [];
  for (let index = 0; index < positions.length - 1; index += 1) {
    const position = positions[index]!;
    const boundary = boundaries.get(position)!;
    boundary.ending.sort((left, right) => right.depth - left.depth);
    for (const span of boundary.ending) {
      const spans = active.get(span.kind);
      spans?.pop();
      if (spans?.length === 0) active.delete(span.kind);
    }
    boundary.starting.sort((left, right) => left.depth - right.depth);
    for (const span of boundary.starting) {
      const spans = active.get(span.kind) ?? [];
      spans.push(span);
      active.set(span.kind, spans);
    }

    const next = positions[index + 1]!;
    if (next === position) continue;
    const piece = pieceFor(line.text.slice(position, next), active);
    const spoiler = active.get("spoiler")?.[0];
    const spoilerId =
      spoiler === undefined ? null : `${spoiler.start}:${spoiler.end}:${spoiler.depth}`;
    const previous = groups.at(-1);
    if (previous?.spoilerId === spoilerId) previous.pieces.push(piece);
    else groups.push({ spoilerId, pieces: [piece] });
  }

  return Object.freeze({
    groups: Object.freeze(
      groups.map((group) =>
        Object.freeze({ spoilerId: group.spoilerId, pieces: Object.freeze(group.pieces) }),
      ),
    ),
    ending: line.ending,
  });
}

function boundaryAt(
  boundaries: Map<
    number,
    { readonly starting: MessageMarkupSpan[]; readonly ending: MessageMarkupSpan[] }
  >,
  position: number,
): { readonly starting: MessageMarkupSpan[]; readonly ending: MessageMarkupSpan[] } {
  const existing = boundaries.get(position);
  if (existing !== undefined) return existing;
  const created = { starting: [], ending: [] };
  boundaries.set(position, created);
  return created;
}

function pieceFor(
  text: string,
  active: ReadonlyMap<MessageMarkupSpan["kind"], readonly MessageMarkupSpan[]>,
): PlayerMarkupPiece {
  const classes: string[] = [];
  if (active.has("italic")) classes.push("markup-italic");
  if (active.has("bold")) classes.push("markup-bold");
  if (active.has("strikethrough")) classes.push("markup-strikethrough");
  if (active.has("code")) classes.push("markup-code");
  if (active.has("underline")) classes.push("markup-underline");
  const size = active.get("size")?.at(-1);
  if (size?.kind === "size") classes.push(`markup-size-${size.value}`);

  const style: Record<string, string> = {};
  const color = active.get("color")?.at(-1);
  if (color?.kind === "color") style.color = color.value;
  const background = active.get("backgroundColor")?.at(-1);
  if (background?.kind === "backgroundColor") style.backgroundColor = background.value;
  const weight = active.get("weight")?.at(-1);
  const bold = active.get("bold")?.at(-1);
  if (weight?.kind === "weight" && (bold === undefined || weight.depth > bold.depth)) {
    style.fontWeight = weightValue(weight.value);
  } else if (bold !== undefined) {
    style.fontWeight = "700";
  }
  const link = active.get("link")?.at(-1);
  return Object.freeze({
    text,
    classes: Object.freeze(classes),
    style: Object.freeze(style),
    href: link?.kind === "link" ? link.target : null,
  });
}

function weightValue(value: Extract<MessageMarkupSpan, { kind: "weight" }>["value"]): string {
  return {
    thin: "100",
    light: "300",
    normal: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
    black: "900",
  }[value];
}
