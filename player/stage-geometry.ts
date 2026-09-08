export interface StageHeightConstraints {
  /** Width the stage can actually use after side tracks are reserved. */
  readonly availableWidth: number;
  /** Session-stable media aspect. A stage without media uses the default shape. */
  readonly aspect: number;
  /** Smallest useful stage; an empty stage never collapses below it. */
  readonly floor: number;
  /** Largest share of the usable height the stage may take. */
  readonly cap: number;
  /** Height left for stage plus transcript after composer, response lane and tray. */
  readonly remainingConversationHeight: number;
  /** Transcript height the conversation tries to keep, bounded by the real remainder. */
  readonly conversationReserve: number;
}

/**
 * Resolve the stage height from the space that actually exists rather than from
 * a fixed viewport fraction.
 *
 * The preferred height fits the session media aspect inside the available stage
 * width, so landscape media stops reserving empty side bands and portrait media
 * keeps its shape. The result is bounded by a floor that keeps an empty stage
 * present, a cap that keeps the conversation useful, and finally by the height
 * that is genuinely left once the composer, response lane and any control tray
 * have taken theirs. The transcript reserve is a target bounded by the real
 * remainder, never a hard minimum that could push content out of the Player.
 */
export function resolveStageHeight(constraints: StageHeightConstraints): number {
  const cap = nonNegative(constraints.cap);
  const floor = Math.min(nonNegative(constraints.floor), cap);
  const aspect = nonNegative(constraints.aspect);
  const width = nonNegative(constraints.availableWidth);
  const preferred = aspect > 0 && width > 0 ? width / aspect : floor;
  const bounded = Math.min(Math.max(preferred, floor), cap);

  const remaining = nonNegative(constraints.remainingConversationHeight);
  const reserve = Math.min(nonNegative(constraints.conversationReserve), remaining);
  return Math.round(Math.min(bounded, remaining - reserve));
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
