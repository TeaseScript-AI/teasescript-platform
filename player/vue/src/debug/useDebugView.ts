import { shallowRef, watch, type ShallowRef } from "vue";
import type { DebugView, DebugViewRequest } from "../../../debug-view.js";
import type { PlayerSessionHost } from "../session/usePlayerSession";

/**
 * A view of Debug's value trace that the host makes for the shown session (`debugView`), kept current: `request` gives
 * what the view shows now from its state, or `null` while it shows nothing new (a hidden tab keeps the last view). A
 * request goes out whenever the session's publication, the trace or `request` changes; only the reply to the latest
 * one shows, and only while it is of the shown publication and the host's trace now. Another session or trace shows no
 * earlier view meanwhile.
 */
export function useDebugView(
  player: Pick<PlayerSessionHost, "session" | "traceId" | "debugView">,
  request: () => DebugViewRequest | null,
): ShallowRef<DebugView | null> {
  const view = shallowRef<DebugView | null>(null);
  let latest = 0;
  let shownFor: { readonly lineage: object | null; readonly traceId: number | null } | null = null;
  // What the latest request was for, so that the same publication, trace and request are asked once.
  let askedFor: {
    readonly session: unknown;
    readonly traceId: number | null;
    readonly key: string;
  } | null = null;
  watch(
    () => {
      const asked = request();
      return {
        session: player.session.value,
        traceId: player.traceId.value,
        key: asked === null ? null : JSON.stringify(asked),
        asked,
      };
    },
    ({ session, traceId, key, asked }) => {
      const lineage = session?.lineage ?? null;
      if (shownFor !== null && (shownFor.lineage !== lineage || shownFor.traceId !== traceId)) {
        view.value = null;
        shownFor = null;
      }
      if (session === null || traceId === null) {
        latest += 1;
        askedFor = null;
        view.value = null;
        return;
      }
      if (asked === null || key === null) return;
      // A shown view is of the shown publication only: a newer one shows nothing until its own view arrives.
      if (view.value !== null && view.value.revision !== session.revision) view.value = null;
      // A plain copy: the view's state may be reactive, which the bridge does not carry.
      // EVIDENCE: invariant: `key` is `JSON.stringify` of a `DebugViewRequest`, which is plain JSON data.
      const plain = JSON.parse(key) as DebugViewRequest;
      if (askedFor?.session === session && askedFor.traceId === traceId && askedFor.key === key)
        return;
      askedFor = { session, traceId, key };
      const serial = ++latest;
      void player.debugView(plain).then((made) => {
        const shown = player.session.value;
        if (
          serial !== latest ||
          made === null ||
          shown === null ||
          made.revision !== shown.revision ||
          made.traceId !== player.traceId.value
        )
          return;
        view.value = made;
        shownFor = { lineage: shown.lineage, traceId: made.traceId };
      });
    },
    { immediate: true },
  );
  return view;
}
