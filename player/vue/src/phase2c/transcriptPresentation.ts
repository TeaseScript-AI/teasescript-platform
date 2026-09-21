/**
 * What a transcript entry looks like, worked out from the entry alone.
 *
 * Kept apart from the transcript itself, which owns scrolling: these are plain functions
 * over one entry and its neighbours, so they can be read and tested without a viewport.
 * The appearance they describe is recorded in `docs/ui/PLAYER-UI.md`.
 */
import type {
  PlayerSpeakerPresentation,
  PlayerTranscriptEntryPresentation,
} from "../../../model.js";
import { inkFor, scrimFor } from "./messageContrast";

/** The theme colours a message has to be resolved against, read from the live page. */
export interface TranscriptPalette {
  /** The player's own bubble. */
  readonly surface: string;
  /** The page a passage with no panel of its own is read against. */
  readonly canvas: string;
  /** The colour the page paints a link, where the message does not paint it itself. */
  readonly link: string;
}

/**
 * A speaker's colour is a colour for words, and what it means for a given message is the
 * runtime's to work out; nothing here reads it back off the speaker. The player's own
 * lines are authored by nobody and stay theme-owned. The same resolved presentation also
 * says whether an entry is meant to be read or heard.
 */
function authoredOn(entry: PlayerTranscriptEntryPresentation) {
  return entry.kind === "message" ? (entry.presentation ?? null) : null;
}

/** Bubble or prose, or nothing at all for an entry that carries no authored message. */
function presentationOf(entry: PlayerTranscriptEntryPresentation | undefined) {
  if (entry === undefined || entry.kind !== "message") return null;
  return authoredOn(entry)?.kind === "prose" ? "prose" : "bubble";
}

/**
 * Whether two entries belong to one visual group. One speaker can both say something and
 * set a passage apart, and those are not the same kind of thing on the page: a change of
 * kind ends a run as plainly as a change of speaker does. This is the single definition
 * that name, avatar, spacing and corners all read.
 */
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

/**
 * The name is the author's to give. A speaker who was given none shows none, and the
 * space it would have taken goes with it; nothing here supplies a stand-in.
 */
export function nameOf(
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>,
  entry: PlayerTranscriptEntryPresentation,
) {
  return entry.kind === "message" ? (speakers[entry.speakerId]?.name ?? "").trim() : "";
}

/**
 * Flattening the touching corners makes a run read as one block instead of separate
 * cards. Only the speaker's own side is flattened: bubbles all start there, so they truly
 * meet, while the free side ends wherever the text happens to wrap. Tailwind scans for
 * literal class names, so every corner is spelled out.
 */
export function cornerClass(continues: boolean, continued: boolean, player: boolean) {
  const classes: string[] = [];
  if (continues) classes.push(player ? "rounded-tr-sm" : "rounded-tl-sm");
  if (continued) classes.push(player ? "rounded-br-sm" : "rounded-bl-sm");
  return classes.join(" ");
}

/** Everything about one entry's appearance that depends on colour rather than layout. */
export function resolveAppearance(
  entry: PlayerTranscriptEntryPresentation,
  palette: TranscriptPalette,
) {
  const authored = authoredOn(entry);
  const words = authored?.color ?? null;
  const written = authored?.background ?? null;
  // A bubble stands on the player's own surface; a passage set apart has none of its own
  // and stands on the page. Measuring either against the wrong one answers a question
  // nobody asked.
  const surface = written ?? (authored?.kind === "prose" ? palette.canvas : palette.surface);
  return {
    panel: written,
    // Where both colours are the author's, he wrote them in one breath and was looking
    // straight at the pairing, so it stands as written. Where only the words are his, the
    // cover goes behind the words and no further: a bubble repainted whole would announce
    // a decision the author never made.
    cover: written === null && words !== null ? scrimFor(words, surface) : null,
    // An unchosen placement arrives as null, and centred is what fills it in.
    placement:
      authored?.kind !== "prose"
        ? null
        : { position: authored.position ?? "center", text: authored.align ?? "center" },
    ink: words ?? (written === null ? null : inkFor(written)),
    backdrop: surface,
    // A link is painted blue by the page unless the message carries a fill of its own, in
    // which case it is set in the message's own colour. Whichever it is, that is the
    // colour a reader has to read, so that is the colour its cover has to answer for.
    link: written === null ? palette.link : (words ?? inkFor(written)),
    // A named typeface is only ever a request: the theme's own stack stays behind it to
    // catch the devices that do not have it.
    typeface: authored?.font == null ? null : `${authored.font}, var(--transcript-typeface)`,
  };
}
