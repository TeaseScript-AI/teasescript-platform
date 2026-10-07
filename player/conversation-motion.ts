/**
 * How what newly appears in the conversation enters during live play (PLAYER-UI.md "Message presentation and
 * provenance"): it fades in while sliding up, and when the reader follows the newest content, the conversation glides up
 * to make room instead of jumping. The scroll position itself still moves at once, so following, measurement, and
 * reading history keep their rules; only what is drawn eases toward it. Framework-independent.
 */

/** The length of an entrance and of the glide that makes room for it. */
export const CONVERSATION_ENTRANCE_MS = 200;
/** How far an entering element rises while it fades in. */
export const CONVERSATION_ENTRANCE_RISE_PX = 8;
const EASING = "cubic-bezier(0.2, 0, 0, 1)";

/** The part of the Web Animations API the conversation uses. */
export interface MotionTarget {
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): MotionAnimation;
}
export interface MotionAnimation {
  currentTime: CSSNumberish | null;
  readonly playState: AnimationPlayState;
  cancel(): void;
}

/**
 * Draws the conversation where it was while the scroll position follows new content, then eases it to where it is.
 * Each new shift starts from what is drawn now, so shifts in quick succession continue one movement instead of queueing
 * up; a shift that would leave the drawn conversation further than `limit` from where it is shows at once, as more
 * content than can enter.
 */
export class ConversationGlide {
  #offset = 0;
  #startedAt = 0;
  #animations: MotionAnimation[] = [];

  constructor(
    private readonly now: () => number,
    private readonly limit: () => number,
  ) {}

  /**
   * The scroll position moved the conversation up by `delta` pixels; `targets` draw it. `false` when the conversation
   * shows where it is at once because it moved too far.
   */
  shift(targets: readonly MotionTarget[], delta: number): boolean {
    const offset = this.#current() + delta;
    this.stop();
    if (Math.abs(offset) > this.limit()) return false;
    if (Math.abs(offset) < 0.5) return true;
    this.#offset = offset;
    this.#startedAt = this.now();
    this.#animations = targets.map((target) =>
      target.animate([{ translate: `0 ${offset}px` }, { translate: "0 0" }], {
        duration: CONVERSATION_ENTRANCE_MS,
        easing: EASING,
      }),
    );
    return true;
  }

  /** Shows the conversation where it is at once. */
  stop(): void {
    for (const animation of this.#animations) animation.cancel();
    this.#animations = [];
    this.#offset = 0;
  }

  /** The offset drawn now: the eased remainder of the running glide. */
  #current(): number {
    if (this.#animations.length === 0) return 0;
    const progress = (this.now() - this.#startedAt) / CONVERSATION_ENTRANCE_MS;
    return progress >= 1 ? 0 : this.#offset * (1 - decelerate(progress));
  }
}

/**
 * The entries that entered during live play and when, so that each element plays its entrance once: when it is first
 * drawn, from as far into the entrance as time has gone on, and not at all once the entrance would be over.
 */
export class ConversationEntrances {
  readonly #entered = new Map<string, number>();
  readonly #playing = new Set<MotionAnimation>();

  constructor(private readonly now: () => number) {}

  /** `keys` entered now. */
  admit(keys: Iterable<string>): void {
    const at = this.now();
    for (const key of keys) this.#entered.set(key, at);
  }

  /** Plays the entrance of `key` on `target` if it is still due, once. */
  play(key: string, target: MotionTarget): void {
    const at = this.#entered.get(key);
    if (at === undefined) return;
    this.#entered.delete(key);
    this.#track(enter(target, this.now() - at));
  }

  /** Plays the entrance of `target`, which entered now. */
  enter(target: MotionTarget): void {
    this.#track(enter(target));
  }

  /** Shows what entered at once, and forgets every entry: history, and more than can enter, appear directly. */
  clear(): void {
    for (const animation of this.#playing) animation.cancel();
    this.#playing.clear();
    this.#entered.clear();
  }

  #track(animation: MotionAnimation | null): void {
    for (const playing of this.#playing)
      if (playing.playState === "finished") this.#playing.delete(playing);
    if (animation !== null) this.#playing.add(animation);
  }
}

/** Plays an entrance on `target`, `elapsed` milliseconds into it; `null` once it would be over. */
function enter(target: MotionTarget, elapsed = 0): MotionAnimation | null {
  if (elapsed >= CONVERSATION_ENTRANCE_MS) return null;
  const animation = target.animate(
    [
      { opacity: 0, translate: `0 ${CONVERSATION_ENTRANCE_RISE_PX}px` },
      { opacity: 1, translate: "0 0" },
    ],
    { duration: CONVERSATION_ENTRANCE_MS, easing: EASING },
  );
  if (elapsed > 0) animation.currentTime = elapsed;
  return animation;
}

/** `cubic-bezier(0.2, 0, 0, 1)` at `progress`, as the animations draw it. */
function decelerate(progress: number): number {
  // Solve x(t) = progress for the curve's parameter t, then return y(t).
  let low = 0;
  let high = 1;
  for (let step = 0; step < 24; step += 1) {
    const t = (low + high) / 2;
    if (bezier(t, 0.2, 0) < progress) low = t;
    else high = t;
  }
  return bezier((low + high) / 2, 0, 1);
}

function bezier(t: number, first: number, second: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t;
}
