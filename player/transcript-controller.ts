import type {
  PlayerSpeakerPresentation,
  PlayerTranscriptEntryPresentation,
} from "./model.js";
import { createTranscriptEntryElement } from "./render.js";

const WINDOW_SIZE = 120;
const WINDOW_BUFFER = 32;
const FOLLOW_DISTANCE_PX = 36;
const SCROLL_SETTLE_MS = 140;
const DEFAULT_MESSAGE_EXTENT_PX = 78;

export interface TranscriptController {
  setEntries(
    entries: readonly PlayerTranscriptEntryPresentation[],
    speakers: Readonly<Record<string, PlayerSpeakerPresentation>>,
  ): void;
  appendEntry(
    entry: PlayerTranscriptEntryPresentation,
    speakers: Readonly<Record<string, PlayerSpeakerPresentation>>,
  ): void;
  sync(): void;
}

export function createTranscriptController(
  transcript: HTMLElement,
  returnToLatest: HTMLButtonElement,
): TranscriptController {
  let entries: readonly PlayerTranscriptEntryPresentation[] = [];
  let speakers: Readonly<Record<string, PlayerSpeakerPresentation>> = {};
  let windowStart = 0;
  let renderedStart = 0;
  let renderedEnd = 0;
  let averageMessageExtent = DEFAULT_MESSAGE_EXTENT_PX;
  let followingLatest = true;
  let scrollSettled = true;
  let scrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
  let programmaticScroll = false;

  transcript.addEventListener("scroll", () => {
    if (programmaticScroll) return;
    scrollSettled = false;
    followingLatest = distanceFromBottom() <= FOLLOW_DISTANCE_PX;
    scheduleScrollSettled();
    syncWindowForScroll();
    syncReturnControl();
  }, { passive: true });

  transcript.addEventListener("touchstart", markInteractionActive, { passive: true });
  transcript.addEventListener("pointerdown", markInteractionActive, { passive: true });
  transcript.addEventListener("wheel", markInteractionActive, { passive: true });

  returnToLatest.addEventListener("click", () => {
    followingLatest = true;
    scrollSettled = true;
    windowStart = latestWindowStart();
    renderWindow();
    scrollToLatest("smooth");
    syncReturnControl();
  });

  function setEntries(
    nextEntries: readonly PlayerTranscriptEntryPresentation[],
    nextSpeakers: Readonly<Record<string, PlayerSpeakerPresentation>>,
  ): void {
    const preserveViewport = !followingLatest;
    const previousAnchor = preserveViewport ? captureAnchor() : null;
    entries = nextEntries;
    speakers = nextSpeakers;

    if (followingLatest) {
      windowStart = latestWindowStart();
    } else {
      windowStart = Math.min(windowStart, latestWindowStart());
    }
    renderWindow();

    if (followingLatest) scrollToLatest("auto");
    else restoreAnchor(previousAnchor);
    syncReturnControl();
  }

  function appendEntry(
    entry: PlayerTranscriptEntryPresentation,
    nextSpeakers: Readonly<Record<string, PlayerSpeakerPresentation>>,
  ): void {
    const wasFollowing = followingLatest;
    const previousAnchor = wasFollowing ? null : captureAnchor();
    speakers = nextSpeakers;
    entries = [...entries, entry];

    if (wasFollowing) windowStart = latestWindowStart();
    else windowStart = Math.min(windowStart, latestWindowStart());
    renderWindow();

    if (wasFollowing) scrollToLatest("auto");
    else restoreAnchor(previousAnchor);
    syncReturnControl();
  }

  function sync(): void {
    updateAverageExtent();
    if (followingLatest) {
      windowStart = latestWindowStart();
      renderWindow();
      scrollToLatest("auto");
    } else {
      syncWindowForScroll();
    }
    syncReturnControl();
  }

  function markInteractionActive(): void {
    scrollSettled = false;
    scheduleScrollSettled();
  }

  function scheduleScrollSettled(): void {
    if (scrollSettleTimer !== null) clearTimeout(scrollSettleTimer);
    scrollSettleTimer = setTimeout(() => {
      scrollSettleTimer = null;
      scrollSettled = true;
      if (distanceFromBottom() <= FOLLOW_DISTANCE_PX) followingLatest = true;
      syncReturnControl();
    }, SCROLL_SETTLE_MS);
  }

  function syncReturnControl(): void {
    const awayFromLatest = !followingLatest && distanceFromBottom() > FOLLOW_DISTANCE_PX;
    returnToLatest.hidden = !(awayFromLatest && scrollSettled);
  }

  function latestWindowStart(): number {
    return Math.max(0, entries.length - WINDOW_SIZE);
  }

  function syncWindowForScroll(): void {
    if (entries.length <= WINDOW_SIZE) return;
    const estimatedAbsoluteOffset = transcript.scrollTop + (renderedStart * averageMessageExtent);
    const visibleIndex = Math.max(0, Math.floor(estimatedAbsoluteOffset / averageMessageExtent));
    const desiredStart = clamp(
      visibleIndex - WINDOW_BUFFER,
      0,
      latestWindowStart(),
    );
    if (Math.abs(desiredStart - windowStart) < WINDOW_BUFFER) return;

    const anchor = captureAnchor();
    windowStart = desiredStart;
    renderWindow();
    restoreAnchor(anchor);
  }

  function renderWindow(): void {
    const start = Math.min(windowStart, latestWindowStart());
    const end = Math.min(entries.length, start + WINDOW_SIZE);
    const fragment = document.createDocumentFragment();

    if (start > 0) fragment.append(createSpacer(start * averageMessageExtent, "before"));
    for (let index = start; index < end; index += 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      fragment.append(createTranscriptEntryElement(entry, speakers));
    }
    if (end < entries.length) {
      fragment.append(createSpacer((entries.length - end) * averageMessageExtent, "after"));
    }

    transcript.replaceChildren(fragment);
    renderedStart = start;
    renderedEnd = end;
    requestAnimationFrame(updateAverageExtent);
  }

  function createSpacer(blockSize: number, position: "before" | "after"): HTMLElement {
    const spacer = document.createElement("div");
    spacer.className = "transcript-window-spacer";
    spacer.dataset.windowSpacer = position;
    spacer.style.blockSize = `${Math.max(0, blockSize)}px`;
    spacer.setAttribute("aria-hidden", "true");
    return spacer;
  }

  function updateAverageExtent(): void {
    const renderedEntries = [...transcript.querySelectorAll<HTMLElement>(".message, .session-event")];
    if (renderedEntries.length === 0) return;
    const first = renderedEntries[0];
    const last = renderedEntries.at(-1);
    if (first === undefined || last === undefined) return;

    const firstRect = first.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    const extent = Math.max(1, lastRect.bottom - firstRect.top);
    averageMessageExtent = Math.max(1, extent / renderedEntries.length);

    const before = transcript.querySelector<HTMLElement>('[data-window-spacer="before"]');
    if (before !== null) before.style.blockSize = `${renderedStart * averageMessageExtent}px`;
    const after = transcript.querySelector<HTMLElement>('[data-window-spacer="after"]');
    if (after !== null) after.style.blockSize = `${(entries.length - renderedEnd) * averageMessageExtent}px`;
  }

  function captureAnchor(): { readonly id: string; readonly offset: number } | null {
    const transcriptTop = transcript.getBoundingClientRect().top;
    for (const element of transcript.querySelectorAll<HTMLElement>(".message, .session-event")) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom < transcriptTop) continue;
      const id = element.dataset.transcriptEntryId;
      if (id !== undefined) return { id, offset: rect.top - transcriptTop };
    }
    return null;
  }

  function restoreAnchor(anchor: { readonly id: string; readonly offset: number } | null): void {
    if (anchor === null) return;
    const element = [...transcript.querySelectorAll<HTMLElement>(".message, .session-event")]
      .find((candidate) => candidate.dataset.transcriptEntryId === anchor.id);
    if (element === undefined) return;
    const transcriptTop = transcript.getBoundingClientRect().top;
    const delta = (element.getBoundingClientRect().top - transcriptTop) - anchor.offset;
    if (Math.abs(delta) < 0.5) return;
    setScrollTop(transcript.scrollTop + delta);
  }

  function scrollToLatest(behavior: ScrollBehavior): void {
    requestAnimationFrame(() => {
      programmaticScroll = true;
      transcript.scrollTo({ top: transcript.scrollHeight, behavior });
      requestAnimationFrame(() => {
        programmaticScroll = false;
        followingLatest = true;
        syncReturnControl();
      });
    });
  }

  function setScrollTop(value: number): void {
    programmaticScroll = true;
    transcript.scrollTop = Math.max(0, value);
    requestAnimationFrame(() => {
      programmaticScroll = false;
    });
  }

  function distanceFromBottom(): number {
    return Math.max(0, transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop);
  }

  return { setEntries, appendEntry, sync };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
