import type { PlayerSpeakerPresentation, PlayerTranscriptEntryPresentation } from "../../model.js";
import { authoredColorToOklch, blackOrWhiteInk } from "../../theme/color.js";
import { readabilityFor } from "./messageContrast";

export interface TranscriptPalette {
  readonly surface: string;
  /** The background of the player's own messages. */
  readonly reply: string;
  readonly canvas: string;
  /** The background where a Stage photo's vignette is strongest, or `null` without one. */
  readonly edge: string | null;
  readonly link: string;
}

function authoredOn(entry: PlayerTranscriptEntryPresentation) {
  return entry.kind === "message" ? (entry.presentation ?? null) : null;
}

function presentationOf(entry: PlayerTranscriptEntryPresentation | undefined) {
  if (entry === undefined || entry.kind !== "message") return null;
  return authoredOn(entry)?.kind === "prose" ? "prose" : "bubble";
}

/** Whether `entry` is a message that `remove()` took out of the conversation, which shows nothing of it (#836). */
export function isRemovedEntry(entry: PlayerTranscriptEntryPresentation | undefined): boolean {
  return entry?.kind === "message" && entry.removed === true;
}

/**
 * The index among the entries of the one the conversation shows at `position`. A removed message keeps its place among
 * the entries, so history and identities stay, but takes none in the conversation; `removed` lists the indexes of the
 * removed messages in ascending order. A position past the last shown entry gives an index past the entries.
 */
export function shownEntryIndex(removed: readonly number[], position: number): number {
  // `removed[j] - j` entries show before removed message `j`, a count that never decreases with `j`.
  let low = 0;
  let high = removed.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (removed[middle]! - middle <= position) low = middle + 1;
    else high = middle;
  }
  return position + low;
}

/** The position in the conversation of the entry at `index`, or, for a removed message, of the next entry it shows. */
export function shownPosition(removed: readonly number[], index: number): number {
  let low = 0;
  let high = removed.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (removed[middle]! < index) low = middle + 1;
    else high = middle;
  }
  return index - low;
}

export function adjoins(
  entries: readonly PlayerTranscriptEntryPresentation[],
  index: number,
  other: number,
) {
  const entry = entries[index];
  const neighbour = entries[other];
  if (entry?.kind !== "message" || neighbour?.kind !== "message") return false;
  return (
    neighbour.speakerId === entry.speakerId && presentationOf(neighbour) === presentationOf(entry)
  );
}

export function nameOf(
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>,
  entry: PlayerTranscriptEntryPresentation,
) {
  return entry.kind === "message" ? (speakers[entry.speakerId]?.name ?? "").trim() : "";
}

export function resolveAppearance(
  entry: PlayerTranscriptEntryPresentation,
  palette: TranscriptPalette,
  enhancedContrast = false,
) {
  const authored = authoredOn(entry);
  const authoredText = authored?.color ?? null;
  const authoredBackground = authored?.background ?? null;
  const panelInk =
    authoredBackground === null
      ? null
      : (authoredText ?? blackOrWhiteInk(authoredColorToOklch(authoredBackground)));
  // Prose sits on the background, which a Stage photo's vignette makes lighter or darker towards its edges.
  const backdrop =
    authoredBackground ??
    (authored?.kind !== "prose"
      ? entry.kind === "message" && entry.speakerId === "user"
        ? palette.reply
        : palette.surface
      : palette.edge === null
        ? palette.canvas
        : [palette.canvas, palette.edge]);
  const readability =
    authoredBackground === null && authoredText !== null
      ? readabilityFor(authoredText, backdrop, enhancedContrast)
      : null;
  return {
    panel: authoredBackground,
    authoredInk: authoredText,
    cover: readability?.cover ?? null,
    placement:
      authored?.kind !== "prose"
        ? null
        : { position: authored.position ?? "center", text: authored.align ?? "center" },
    ink: readability?.ink ?? authoredText ?? panelInk,
    backdrop,
    link: panelInk ?? palette.link,
    typeface: authored?.font == null ? null : `${authored.font}, var(--transcript-typeface)`,
  };
}
