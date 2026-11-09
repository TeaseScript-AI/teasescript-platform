import type { PlayerSession } from "../runtime/runtime-view.js";

/**
 * A draw's identity: the session it waits in, its site and its ID. Draw IDs repeat across sessions, so every consumer of
 * a draw's sameness derives it from here: the picker's history cache, its replies, its resolution guard, and the
 * picker component's key and state (`drawKey`). A session's ID is its bridge's, and a Player has one bridge.
 */
export interface DrawIdentity {
  readonly session: string;
  readonly site: string;
  readonly drawId: number;
}

export function drawIdentity(
  draw: { readonly drawId: number; readonly site: string } | null,
  session: PlayerSession | null,
): DrawIdentity | null {
  return draw === null || session === null
    ? null
    : { session: session.id, site: draw.site, drawId: draw.drawId };
}

export function sameDraw(one: DrawIdentity | null, other: DrawIdentity | null): boolean {
  return one !== null && other !== null && drawKey(one) === drawKey(other);
}

/** A draw's identity as one string, for the picker component's key and its state. */
export function drawKey(identity: DrawIdentity): string {
  return JSON.stringify([identity.session, identity.site, identity.drawId]);
}
