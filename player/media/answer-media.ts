/*
 * Who owns the media a service makes for an answer (#1882): a photo taken for `takePhoto()`, the files a file store
 * stores, a locked or opened file. Until the runtime takes the answer, the media is the service's; once the answer will
 * never be handed off, the service discards it. It is discarded only on evidence that the runtime did not take it: an
 * answer whose request is in flight is decided by its reply, and a reply that may have taken it, or an error that leaves
 * this unknown, keeps it for good.
 */

import { refusalCode } from "../runtime/player-bridge.js";

/** An answer a service makes or delivers, for one step of one session generation. */
export interface AnswerRecord<A> {
  /** The step it answers. */
  readonly key: string;
  /** The session generation it belongs to. */
  readonly generation: number;
  readonly promise: Promise<A>;
  /** Whether a request carrying it is in flight. */
  sent: boolean;
  /** Whether the runtime may have taken it: then its media is never discarded. */
  kept: boolean;
}

export function answerRecord<A>(
  key: string,
  generation: number,
  promise: Promise<A>,
): AnswerRecord<A> {
  return { key, generation, promise, sent: false, kept: false };
}

/**
 * Discards the media `record`'s answer made, the references `made` names, once the answer is known, unless a request
 * carrying it is in flight or the runtime may have taken it. Call it when the service lets go of the record.
 */
export function dropAnswer<A>(
  record: AnswerRecord<A> | null,
  made: (answer: A) => readonly string[],
  media: { discard(reference: string): void },
): void {
  if (record === null || record.sent || record.kept) return;
  void record.promise.then(
    (answer) => {
      for (const reference of made(answer)) media.discard(reference);
    },
    // An answer that failed made nothing.
    () => {},
  );
}

/**
 * Sends `record`'s answer through `send`, in flight meanwhile. It is kept when the reply may mean the runtime took it, or
 * when an error other than a bridge refusal, which changed nothing, leaves this unknown. A record the service let go of
 * while it was in flight (`owned` false once the reply came) is dropped then, since nobody else will.
 */
export async function sendAnswer<A, R extends { readonly kind: string }>(
  record: AnswerRecord<A>,
  send: () => Promise<R>,
  owned: () => boolean,
  drop: (record: AnswerRecord<A>) => void,
): Promise<R> {
  record.sent = true;
  try {
    const outcome = await send();
    if (outcome.kind === "completed" || outcome.kind === "alreadySettled") record.kept = true;
    return outcome;
  } catch (error) {
    if (refusalCode(error) === null) record.kept = true;
    throw error;
  } finally {
    record.sent = false;
    if (!owned()) drop(record);
  }
}
