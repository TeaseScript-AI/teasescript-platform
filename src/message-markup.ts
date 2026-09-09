export type MessageMarkupLineEnding = "" | "\n" | "\r\n";

interface MessageMarkupSpanBase {
  readonly start: number;
  readonly end: number;
  readonly depth: number;
}

export interface MessageMarkupPlainSpan extends MessageMarkupSpanBase {
  readonly kind: "italic" | "bold" | "strikethrough" | "code" | "underline" | "spoiler";
}

export interface MessageMarkupColorSpan extends MessageMarkupSpanBase {
  readonly kind: "color" | "backgroundColor";
  readonly value: string;
}

export interface MessageMarkupWeightSpan extends MessageMarkupSpanBase {
  readonly kind: "weight";
  readonly value: "thin" | "light" | "normal" | "medium" | "semibold" | "bold" | "black";
}

export interface MessageMarkupSizeSpan extends MessageMarkupSpanBase {
  readonly kind: "size";
  readonly value: "small" | "normal" | "large" | "x-large";
}

export interface MessageMarkupLinkSpan extends MessageMarkupSpanBase {
  readonly kind: "link";
  readonly target: string;
}

export type MessageMarkupSpan =
  | MessageMarkupPlainSpan
  | MessageMarkupColorSpan
  | MessageMarkupWeightSpan
  | MessageMarkupSizeSpan
  | MessageMarkupLinkSpan;

export interface MessageMarkupLine {
  readonly text: string;
  readonly spans: readonly MessageMarkupSpan[];
  readonly ending: MessageMarkupLineEnding;
}

export interface MessageMarkupParagraph {
  readonly kind: "paragraph";
  readonly lines: readonly MessageMarkupLine[];
}

export interface MessageMarkupHeading {
  readonly kind: "heading";
  readonly level: 1 | 2 | 3;
  readonly line: MessageMarkupLine;
}

export interface MessageMarkupQuote {
  readonly kind: "quote";
  readonly lines: readonly MessageMarkupLine[];
}

export interface MessageMarkupListItem {
  readonly ordinal: string | null;
  readonly line: MessageMarkupLine;
}

export interface MessageMarkupList {
  readonly kind: "list";
  readonly ordered: boolean;
  readonly items: readonly MessageMarkupListItem[];
}

export type MessageMarkupBlock =
  MessageMarkupParagraph | MessageMarkupHeading | MessageMarkupQuote | MessageMarkupList;

export interface MessageMarkup {
  readonly kind: "messageMarkup";
  readonly blocks: readonly MessageMarkupBlock[];
  readonly visibleText: string;
}

interface InputUnit {
  readonly character: string;
  readonly escaped: boolean;
}

type SpanKind = MessageMarkupSpan["kind"];
type FrameKind = "root" | Exclude<SpanKind, "code" | "link">;

interface SpanSegment {
  readonly kind: "span";
  readonly spanKind: SpanKind;
  readonly value: string | null;
  readonly children: readonly InlineSegment[];
}

interface GroupSegment {
  readonly kind: "group";
  readonly children: readonly InlineSegment[];
}

type InlineSegment = string | SpanSegment | GroupSegment;

interface InlineFrame {
  readonly kind: FrameKind;
  readonly opener: string;
  readonly value: string | null;
  readonly width: number;
  readonly children: InlineSegment[];
  readonly pendingText: string[];
  hasNonWhitespace: boolean;
}

interface ParsedSegments {
  readonly segments: readonly InlineSegment[];
  readonly hasNonWhitespace: boolean;
}

interface ParsedLineContent {
  readonly text: string;
  readonly spans: readonly MessageMarkupSpan[];
}

interface SourceLine {
  readonly text: string;
  readonly ending: MessageMarkupLineEnding;
}

type LineClassification =
  | { readonly kind: "paragraph"; readonly contentStart: number }
  | { readonly kind: "heading"; readonly contentStart: number; readonly level: 1 | 2 | 3 }
  | { readonly kind: "quote"; readonly contentStart: number }
  | {
      readonly kind: "list";
      readonly contentStart: number;
      readonly ordered: boolean;
      readonly ordinal: string | null;
    };

type MutableBlock =
  | { readonly kind: "paragraph"; readonly lines: MessageMarkupLine[] }
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly line: MessageMarkupLine }
  | { readonly kind: "quote"; readonly lines: MessageMarkupLine[] }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: MessageMarkupListItem[] };

interface ExtensionOpening {
  readonly kind: Exclude<FrameKind, "root" | "italic" | "bold" | "strikethrough">;
  readonly opener: string;
  readonly value: string | null;
  readonly length: number;
}

interface ExtensionClosing {
  readonly kind: ExtensionOpening["kind"];
  readonly text: string;
  readonly length: number;
}

interface MutableSpan {
  readonly kind: SpanKind;
  readonly start: number;
  readonly depth: number;
  readonly value: string | null;
  end: number;
}

type FlattenWork =
  | { readonly kind: "segment"; readonly segment: InlineSegment; readonly depth: number }
  | { readonly kind: "finish"; readonly span: MutableSpan };

const ESCAPABLE_CHARACTERS = new Set([
  "\\",
  "*",
  "~",
  "`",
  "[",
  "]",
  "(",
  ")",
  "#",
  ">",
  "-",
  ".",
  ":",
]);
const WEIGHTS = new Set(["thin", "light", "normal", "medium", "semibold", "bold", "black"]);
const SIZES = new Set(["small", "normal", "large", "x-large"]);
const EXTENSION_CLOSING_KINDS = new Map<string, ExtensionOpening["kind"]>([
  ["[/u]", "underline"],
  ["[/color]", "color"],
  ["[/bg]", "backgroundColor"],
  ["[/weight]", "weight"],
  ["[/size]", "size"],
  ["[/spoiler]", "spoiler"],
]);
const URL_BOUNDARY_CHARACTER = /[\p{L}\p{M}\p{N}_]/u;
const URL_STOP_CHARACTER = /[\s\u0000-\u001f\u007f<>"'`*~\[\]]/u;
const NON_WHITESPACE = /\S/u;

export function parseMessageMarkup(text: string): MessageMarkup {
  const mutableBlocks: MutableBlock[] = [];
  for (const sourceLine of splitLines(text)) {
    const units = tokenizeLine(sourceLine.text);
    const classification = classifyLine(units);
    const parsed = flattenSegments(
      parseInlineSegments(units, classification.contentStart, units.length, true).segments,
    );
    const line = Object.freeze({
      text: parsed.text,
      spans: parsed.spans,
      ending: sourceLine.ending,
    });
    appendBlock(mutableBlocks, classification, line);
  }

  const blocks = Object.freeze(mutableBlocks.map(freezeBlock));
  const visibleText = visibleTextFromBlocks(blocks);
  return Object.freeze({ kind: "messageMarkup", blocks, visibleText });
}

export function messageMarkupVisibleText(message: MessageMarkup): string {
  return visibleTextFromBlocks(message.blocks);
}

export function escapeMarkup(text: string): string {
  const escaped: string[] = [];
  for (const character of text) {
    if (ESCAPABLE_CHARACTERS.has(character)) escaped.push("\\");
    escaped.push(character);
  }
  return escaped.join("");
}

function splitLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    const hasCarriageReturn = index > start && text.charCodeAt(index - 1) === 13;
    lines.push({
      text: text.slice(start, hasCarriageReturn ? index - 1 : index),
      ending: hasCarriageReturn ? "\r\n" : "\n",
    });
    start = index + 1;
  }
  lines.push({ text: text.slice(start), ending: "" });
  return lines;
}

function tokenizeLine(text: string): InputUnit[] {
  const units: InputUnit[] = [];
  for (let index = 0; index < text.length;) {
    const character = String.fromCodePoint(text.codePointAt(index)!);
    if (character === "\\" && index + 1 < text.length) {
      const next = String.fromCodePoint(text.codePointAt(index + 1)!);
      if (ESCAPABLE_CHARACTERS.has(next)) {
        units.push({ character: next, escaped: true });
        index += 1 + next.length;
        continue;
      }
    }
    units.push({ character, escaped: false });
    index += character.length;
  }
  return units;
}

function classifyLine(units: readonly InputUnit[]): LineClassification {
  let hashes = 0;
  while (hashes < units.length && unitIs(units[hashes], "#")) hashes += 1;
  const level = headingLevel(hashes);
  if (level !== null && unitIs(units[hashes], " ")) {
    return { kind: "heading", level, contentStart: hashes + 1 };
  }
  if (unitIs(units[0], ">") && unitIs(units[1], " ")) {
    return { kind: "quote", contentStart: 2 };
  }
  if (unitIs(units[0], "-") && unitIs(units[1], " ")) {
    return { kind: "list", ordered: false, ordinal: null, contentStart: 2 };
  }
  if (unitIsAsciiNonzeroDigit(units[0])) {
    let index = 1;
    while (unitIsAsciiDigit(units[index])) index += 1;
    if (unitIs(units[index], ".") && unitIs(units[index + 1], " ")) {
      return {
        kind: "list",
        ordered: true,
        ordinal: unitsText(units, 0, index),
        contentStart: index + 2,
      };
    }
  }
  return { kind: "paragraph", contentStart: 0 };
}

function appendBlock(
  blocks: MutableBlock[],
  classification: LineClassification,
  line: MessageMarkupLine,
): void {
  const previous = blocks.at(-1);
  switch (classification.kind) {
    case "paragraph":
      if (previous?.kind === "paragraph") previous.lines.push(line);
      else blocks.push({ kind: "paragraph", lines: [line] });
      return;
    case "heading":
      blocks.push({ kind: "heading", level: classification.level, line });
      return;
    case "quote":
      if (previous?.kind === "quote") previous.lines.push(line);
      else blocks.push({ kind: "quote", lines: [line] });
      return;
    case "list": {
      const item = Object.freeze({ ordinal: classification.ordinal, line });
      if (previous?.kind === "list" && previous.ordered === classification.ordered) {
        previous.items.push(item);
      } else {
        blocks.push({ kind: "list", ordered: classification.ordered, items: [item] });
      }
    }
  }
}

function freezeBlock(block: MutableBlock): MessageMarkupBlock {
  switch (block.kind) {
    case "paragraph":
      return Object.freeze({ kind: "paragraph", lines: Object.freeze(block.lines) });
    case "heading":
      return Object.freeze(block);
    case "quote":
      return Object.freeze({ kind: "quote", lines: Object.freeze(block.lines) });
    case "list":
      return Object.freeze({
        kind: "list",
        ordered: block.ordered,
        items: Object.freeze(block.items),
      });
  }
}

function parseInlineSegments(
  units: readonly InputUnit[],
  start: number,
  end: number,
  linksEnabled: boolean,
): ParsedSegments {
  const frames: InlineFrame[] = [createFrame("root", "", null, 0)];
  const nextBacktick = nextUnescapedIndexes(units, "`", start, end);
  const nextLabelSeparator = linksEnabled
    ? nextLinkLabelSeparators(units, start, end, nextBacktick)
    : null;
  const nextCloseParenthesis = linksEnabled ? nextUnescapedIndexes(units, ")", start, end) : null;

  for (let index = start; index < end;) {
    const unit = units[index]!;
    const current = frames.at(-1)!;
    if (unit.escaped) {
      appendText(current, unit.character);
      index += 1;
      continue;
    }

    if (unit.character === "`") {
      const close = nextBacktick[index + 1 - start] ?? -1;
      if (close === -1) {
        appendText(current, "`");
        index += 1;
        continue;
      }
      const content = unitsText(units, index + 1, close);
      const valid =
        content.length > 0 &&
        !isWhitespace(units[index + 1]!.character) &&
        !isWhitespace(units[close - 1]!.character) &&
        NON_WHITESPACE.test(content);
      if (valid) appendSpan(current, "code", null, [content], true);
      else appendText(current, `\`${content}\``);
      index = close + 1;
      continue;
    }

    if (linksEnabled && unit.character === "[") {
      const labelClose = nextLabelSeparator![index + 1 - start] ?? -1;
      if (labelClose !== -1) {
        const targetClose = nextCloseParenthesis![labelClose + 2 - start] ?? -1;
        if (targetClose !== -1) {
          const target = validLinkTarget(units.slice(labelClose + 2, targetClose));
          const label = parseInlineSegments(units, index + 1, labelClose, false);
          if (target !== null && label.hasNonWhitespace) {
            appendSpan(current, "link", target, label.segments, true);
          } else {
            appendText(current, unitsText(units, index, targetClose + 1));
          }
          index = targetClose + 1;
          continue;
        }
      }
    }

    if (unit.character === "[") {
      const opening = extensionOpeningAt(units, index, end);
      if (opening !== null) {
        frames.push(createFrame(opening.kind, opening.opener, opening.value, 0));
        index += opening.length;
        continue;
      }
      const closing = extensionClosingAt(units, index, end);
      if (closing !== null) {
        const active = frames.at(-1)!;
        if (active.kind === closing.kind) closeFrame(frames);
        else appendText(active, closing.text);
        index += closing.length;
        continue;
      }
    }

    if (unit.character === "*") {
      let run = 1;
      while (index + run < end && unitIs(units[index + run], "*")) run += 1;
      consumeAsteriskRun(frames, units, index, run, end);
      index += run;
      continue;
    }

    if (unit.character === "~") {
      let run = 1;
      while (index + run < end && unitIs(units[index + run], "~")) run += 1;
      if (run === 2) consumeStrikethrough(frames, units, index, end);
      else appendText(frames.at(-1)!, "~".repeat(run));
      index += run;
      continue;
    }

    if (linksEnabled) {
      const bareLink = bareLinkAt(units, index, end);
      if (bareLink !== null) {
        appendSpan(current, "link", bareLink.target, [bareLink.text], true);
        index = bareLink.end;
        continue;
      }
    }

    appendText(current, unit.character);
    index += 1;
  }

  while (frames.length > 1) unwindFrame(frames);
  const root = frames[0]!;
  flushText(root);
  return { segments: Object.freeze(root.children), hasNonWhitespace: root.hasNonWhitespace };
}

function consumeAsteriskRun(
  frames: InlineFrame[],
  units: readonly InputUnit[],
  index: number,
  run: number,
  end: number,
): void {
  let remaining = run;
  const canClose = index > 0 && !isWhitespace(units[index - 1]!.character);
  while (canClose && frames.length > 1) {
    const active = frames.at(-1)!;
    if (
      (active.kind !== "bold" && active.kind !== "italic") ||
      active.width > remaining ||
      !active.hasNonWhitespace
    ) {
      break;
    }
    remaining -= active.width;
    closeFrame(frames);
  }

  const canOpen = index + run < end && !isWhitespace(units[index + run]!.character);
  if (!canOpen) {
    appendText(frames.at(-1)!, "*".repeat(remaining));
    return;
  }
  while (remaining >= 2) {
    frames.push(createFrame("bold", "**", null, 2));
    remaining -= 2;
  }
  if (remaining === 1) frames.push(createFrame("italic", "*", null, 1));
}

function consumeStrikethrough(
  frames: InlineFrame[],
  units: readonly InputUnit[],
  index: number,
  end: number,
): void {
  const active = frames.at(-1)!;
  if (
    active.kind === "strikethrough" &&
    active.hasNonWhitespace &&
    index > 0 &&
    !isWhitespace(units[index - 1]!.character)
  ) {
    closeFrame(frames);
  } else if (index + 2 < end && !isWhitespace(units[index + 2]!.character)) {
    frames.push(createFrame("strikethrough", "~~", null, 2));
  } else {
    appendText(active, "~~");
  }
}

function createFrame(
  kind: FrameKind,
  opener: string,
  value: string | null,
  width: number,
): InlineFrame {
  return { kind, opener, value, width, children: [], pendingText: [], hasNonWhitespace: false };
}

function closeFrame(frames: InlineFrame[]): void {
  const frame = frames.pop()!;
  if (frame.kind === "root") throw new Error("The root message-markup frame cannot be closed.");
  flushText(frame);
  appendSpan(frames.at(-1)!, frame.kind, frame.value, frame.children, frame.hasNonWhitespace);
}

function unwindFrame(frames: InlineFrame[]): void {
  const frame = frames.pop()!;
  const parent = frames.at(-1)!;
  flushText(frame);
  const children: InlineSegment[] = [frame.opener];
  for (const child of frame.children) children.push(child);
  appendSegment(parent, { kind: "group", children }, true);
}

function appendText(frame: InlineFrame, text: string): void {
  if (text.length === 0) return;
  frame.pendingText.push(text);
  if (NON_WHITESPACE.test(text)) frame.hasNonWhitespace = true;
}

function appendSpan(
  frame: InlineFrame,
  kind: SpanKind,
  value: string | null,
  children: readonly InlineSegment[],
  hasNonWhitespace: boolean,
): void {
  appendSegment(frame, { kind: "span", spanKind: kind, value, children }, hasNonWhitespace);
}

function appendSegment(
  frame: InlineFrame,
  segment: InlineSegment,
  hasNonWhitespace: boolean,
): void {
  if (typeof segment === "string") {
    appendText(frame, segment);
    return;
  }
  flushText(frame);
  frame.children.push(segment);
  if (hasNonWhitespace) frame.hasNonWhitespace = true;
}

function flushText(frame: InlineFrame): void {
  if (frame.pendingText.length === 0) return;
  frame.children.push(frame.pendingText.join(""));
  frame.pendingText.length = 0;
}

function extensionOpeningAt(
  units: readonly InputUnit[],
  index: number,
  end: number,
): ExtensionOpening | null {
  const text = shortBracketToken(units, index, end);
  if (text === null || text.startsWith("[/")) return null;
  if (text === "[u]") return extension("underline", text, null);
  if (text === "[spoiler]") return extension("spoiler", text, null);

  const color = /^\[color=(#[0-9a-fA-F]{6})\]$/u.exec(text);
  if (color !== null) return extension("color", text, color[1]!.toLowerCase());
  const background = /^\[bg=(#[0-9a-fA-F]{6})\]$/u.exec(text);
  if (background !== null) return extension("backgroundColor", text, background[1]!.toLowerCase());
  const weight = /^\[weight=([a-z]+)\]$/u.exec(text);
  if (weight !== null && WEIGHTS.has(weight[1]!)) return extension("weight", text, weight[1]!);
  const size = /^\[size=([a-z-]+)\]$/u.exec(text);
  if (size !== null && SIZES.has(size[1]!)) return extension("size", text, size[1]!);
  return null;
}

function extension(
  kind: ExtensionOpening["kind"],
  opener: string,
  value: string | null,
): ExtensionOpening {
  return { kind, opener, value, length: [...opener].length };
}

function extensionClosingAt(
  units: readonly InputUnit[],
  index: number,
  end: number,
): ExtensionClosing | null {
  const text = shortBracketToken(units, index, end);
  if (text === null) return null;
  const kind = EXTENSION_CLOSING_KINDS.get(text);
  return kind === undefined ? null : { kind, text, length: [...text].length };
}

function shortBracketToken(units: readonly InputUnit[], index: number, end: number): string | null {
  const maximumEnd = Math.min(end, index + 48);
  const characters: string[] = [];
  for (let cursor = index; cursor < maximumEnd; cursor += 1) {
    const unit = units[cursor]!;
    if (unit.escaped) return null;
    characters.push(unit.character);
    if (unit.character === "]") return characters.join("");
  }
  return null;
}

function bareLinkAt(
  units: readonly InputUnit[],
  index: number,
  end: number,
): { readonly target: string; readonly text: string; readonly end: number } | null {
  if (
    (index > 0 && URL_BOUNDARY_CHARACTER.test(units[index - 1]!.character)) ||
    (!unitsMatchCaseInsensitive(units, index, "http://") &&
      !unitsMatchCaseInsensitive(units, index, "https://"))
  ) {
    return null;
  }

  let targetEnd = index;
  while (targetEnd < end) {
    const unit = units[targetEnd]!;
    if (unit.escaped || unit.character === "\\" || URL_STOP_CHARACTER.test(unit.character)) break;
    targetEnd += 1;
  }
  let parenthesisBalance = delimiterBalance(units, index, targetEnd, "(", ")");
  let braceBalance = delimiterBalance(units, index, targetEnd, "{", "}");
  while (targetEnd > index) {
    const terminal = units[targetEnd - 1]!.character;
    if (/[.,;:!?]/u.test(terminal)) targetEnd -= 1;
    else if (terminal === ")" && parenthesisBalance < 0) {
      parenthesisBalance += 1;
      targetEnd -= 1;
    } else if (terminal === "}" && braceBalance < 0) {
      braceBalance += 1;
      targetEnd -= 1;
    } else break;
  }
  if (targetEnd === index) return null;

  const text = unitsText(units, index, targetEnd);
  const target = validUrl(text);
  return target === null ? null : { target, text, end: targetEnd };
}

function delimiterBalance(
  units: readonly InputUnit[],
  start: number,
  end: number,
  opener: string,
  closer: string,
): number {
  let balance = 0;
  for (let index = start; index < end; index += 1) {
    if (units[index]!.character === opener) balance += 1;
    else if (units[index]!.character === closer) balance -= 1;
  }
  return balance;
}

function validLinkTarget(units: readonly InputUnit[]): string | null {
  if (
    units.length === 0 ||
    units.some(
      (unit) =>
        unit.escaped ||
        unit.character === "(" ||
        unit.character === ")" ||
        unit.character === "\\" ||
        /[\s\u0000-\u001f\u007f]/u.test(unit.character),
    )
  )
    return null;
  return validUrl(unitsText(units, 0, units.length));
}

function validUrl(text: string): string | null {
  try {
    const url = new URL(text);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.host.length === 0)
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function nextUnescapedIndexes(
  units: readonly InputUnit[],
  character: string,
  start: number,
  end: number,
): readonly number[] {
  const indexes = new Array<number>(end - start + 1).fill(-1);
  let next = -1;
  for (let index = end - 1; index >= start; index -= 1) {
    if (unitIs(units[index], character)) next = index;
    indexes[index - start] = next;
  }
  return indexes;
}

function nextLinkLabelSeparators(
  units: readonly InputUnit[],
  start: number,
  end: number,
  nextBacktick: readonly number[],
): readonly number[] {
  const separators = new Set<number>();
  for (let index = start; index < end;) {
    if (unitIs(units[index], "`")) {
      const close = nextBacktick[index + 1 - start] ?? -1;
      if (close !== -1) {
        index = close + 1;
        continue;
      }
    }
    if (unitIs(units[index], "[")) {
      const token = extensionOpeningAt(units, index, end) ?? extensionClosingAt(units, index, end);
      if (token !== null) {
        index += token.length;
        continue;
      }
    }
    if (unitIs(units[index], "]") && unitIs(units[index + 1], "(")) separators.add(index);
    index += 1;
  }

  const indexes = new Array<number>(end - start + 1).fill(-1);
  let next = -1;
  for (let index = end - 1; index >= start; index -= 1) {
    if (separators.has(index)) next = index;
    indexes[index - start] = next;
  }
  return indexes;
}

function flattenSegments(segments: readonly InlineSegment[]): ParsedLineContent {
  const text: string[] = [];
  const spans: MutableSpan[] = [];
  const pending: FlattenWork[] = [];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    pending.push({ kind: "segment", segment: segments[index]!, depth: 0 });
  }
  let position = 0;
  while (pending.length > 0) {
    const work = pending.pop()!;
    if (work.kind === "finish") {
      work.span.end = position;
    } else if (typeof work.segment === "string") {
      text.push(work.segment);
      position += work.segment.length;
    } else if (work.segment.kind === "group") {
      for (let index = work.segment.children.length - 1; index >= 0; index -= 1) {
        pending.push({
          kind: "segment",
          segment: work.segment.children[index]!,
          depth: work.depth,
        });
      }
    } else {
      const span: MutableSpan = {
        kind: work.segment.spanKind,
        start: position,
        end: position,
        depth: work.depth,
        value: work.segment.value,
      };
      spans.push(span);
      pending.push({ kind: "finish", span });
      for (let index = work.segment.children.length - 1; index >= 0; index -= 1) {
        pending.push({
          kind: "segment",
          segment: work.segment.children[index]!,
          depth: work.depth + 1,
        });
      }
    }
  }
  return { text: text.join(""), spans: Object.freeze(spans.map(freezeSpan)) };
}

function freezeSpan(span: MutableSpan): MessageMarkupSpan {
  const base = { start: span.start, end: span.end, depth: span.depth };
  switch (span.kind) {
    case "italic":
    case "bold":
    case "strikethrough":
    case "code":
    case "underline":
    case "spoiler":
      return Object.freeze({ kind: span.kind, ...base });
    case "color":
    case "backgroundColor":
      return Object.freeze({ kind: span.kind, value: span.value!, ...base });
    case "weight":
      if (!isWeight(span.value))
        throw new Error("A message-markup weight span has no valid value.");
      return Object.freeze({ kind: "weight", value: span.value, ...base });
    case "size":
      if (!isSize(span.value)) throw new Error("A message-markup size span has no valid value.");
      return Object.freeze({ kind: "size", value: span.value, ...base });
    case "link":
      return Object.freeze({ kind: "link", target: span.value!, ...base });
  }
}

function visibleTextFromBlocks(blocks: readonly MessageMarkupBlock[]): string {
  const chunks: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "paragraph":
      case "quote":
        for (const line of block.lines) chunks.push(line.text, line.ending);
        break;
      case "heading":
        chunks.push(block.line.text, block.line.ending);
        break;
      case "list":
        for (const item of block.items) chunks.push(item.line.text, item.line.ending);
        break;
    }
  }
  return chunks.join("");
}

function unitsText(units: readonly InputUnit[], start: number, end: number): string {
  const characters: string[] = [];
  for (let index = start; index < end; index += 1) characters.push(units[index]!.character);
  return characters.join("");
}

function unitsMatchCaseInsensitive(
  units: readonly InputUnit[],
  start: number,
  expected: string,
): boolean {
  const characters = [...expected];
  if (start + characters.length > units.length) return false;
  return characters.every((character, offset) => {
    const unit = units[start + offset]!;
    return !unit.escaped && unit.character.toLowerCase() === character;
  });
}

function unitIs(unit: InputUnit | undefined, character: string): boolean {
  return unit !== undefined && !unit.escaped && unit.character === character;
}

function unitIsAsciiDigit(unit: InputUnit | undefined): boolean {
  return unit !== undefined && !unit.escaped && /^[0-9]$/u.test(unit.character);
}

function unitIsAsciiNonzeroDigit(unit: InputUnit | undefined): boolean {
  return unit !== undefined && !unit.escaped && /^[1-9]$/u.test(unit.character);
}

function isWhitespace(character: string): boolean {
  return /^\s$/u.test(character);
}

function headingLevel(value: number): 1 | 2 | 3 | null {
  if (value === 1 || value === 2 || value === 3) return value;
  return null;
}

function isWeight(value: string | null): value is MessageMarkupWeightSpan["value"] {
  return value !== null && WEIGHTS.has(value);
}

function isSize(value: string | null): value is MessageMarkupSizeSpan["value"] {
  return value !== null && SIZES.has(value);
}
