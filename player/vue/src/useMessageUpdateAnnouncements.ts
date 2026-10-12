import { nextTick, ref, watch, type Ref } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import { MessageUpdateAnnouncer } from "../../message-update-announcer.js";
import type { PlayerRuntimeSession } from "../../runtime-adapter.js";

/**
 * The text of the Player's status region for changed messages (PLAYER-UI.md "Conversation"). Only changes that live
 * play publishes are spoken: a new generation, such as Start, Continue, or a state Debug's rewind shows, begins again
 * from the messages as they are, and speaks nothing of its history.
 */
export function useMessageUpdateAnnouncements(player: {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly generation: Readonly<Ref<number>>;
}): Readonly<Ref<string>> {
  const text = ref("");
  // Counts announcements, so that only the latest is shown and equal texts are spoken again.
  let spoken = 0;
  const announcer = new MessageUpdateAnnouncer({
    now: () => Date.now(),
    schedule: (callback, delayMs) => {
      const timeout = setTimeout(callback, delayMs);
      return () => clearTimeout(timeout);
    },
    announce: (message) => {
      const turn = ++spoken;
      text.value = "";
      void nextTick(() => {
        if (turn === spoken) text.value = message;
      });
    },
  });
  let generation: number | null = null;
  let seenEvents = 0;
  // The visible text of each message as the player last saw it, by the event that created it.
  let seen = new Map<number, string>();

  watch(
    player.session,
    (session) => {
      if (session === null || player.generation.value !== generation) {
        announcer.reset();
        spoken += 1;
        text.value = "";
        generation = player.generation.value;
        seenEvents = session?.events.length ?? 0;
        seen = new Map();
        if (session !== null)
          for (const [messageId, index] of session.transcriptMessageRows) {
            const entry = session.transcriptEntries[index]!;
            if (entry.kind !== "message" || entry.removed !== true) seen.set(messageId, entry.text);
          }
        return;
      }
      const { events } = session;
      for (let index = seenEvents; index < events.length; index += 1) {
        const event = events[index]!;
        if (event.kind === "say") seen.set(event.sequence, event.text);
        else if (event.kind === "messageUpdated" || event.kind === "messageRemoved") {
          const before = seen.get(event.messageId);
          if (before === undefined) continue;
          const text = event.kind === "messageUpdated" ? event.text : null;
          if (text === null) seen.delete(event.messageId);
          else seen.set(event.messageId, text);
          const at = session.transcriptMessageRows.get(event.messageId);
          const row = at === undefined ? undefined : session.transcriptEntries[at];
          const speaker =
            row?.kind === "message" ? session.speakers[row.speakerId]?.name : undefined;
          announcer.update(event.messageId, speaker ?? "", before, text);
        }
      }
      seenEvents = events.length;
    },
    { immediate: true, flush: "sync" },
  );
  tryOnScopeDispose(() => announcer.reset());
  return text;
}
