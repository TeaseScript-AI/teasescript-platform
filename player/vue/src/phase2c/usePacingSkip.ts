import type { ShallowRef } from "vue";
import {
  activePlayerRuntimeInteraction,
  playerRuntimePacingGate,
  skipPlayerRuntimePacing,
  type PlayerRuntimeSession,
} from "../../../runtime-adapter.js";

export function usePacingSkip(session: ShallowRef<PlayerRuntimeSession | null>) {
  function skipPacing() {
    const current = session.value;
    if (
      !current ||
      !playerRuntimePacingGate(current)?.skippable ||
      activePlayerRuntimeInteraction(current.snapshot)
    )
      return false;
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) return false;
    const result = skipPlayerRuntimePacing(current);
    if (!result) return false;
    session.value = result.session;
    return true;
  }

  function skipFromBackground(event: MouseEvent) {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (
      event.target.closest(
        "button, a, input, textarea, select, video, [role='button'], [role='separator'], [data-message-id], [data-foreground-controls], [data-composer-shell]",
      )
    )
      return;
    if (event.target.closest(".player-stage, .transcript-scroll, .conversation-region")) {
      skipPacing();
    }
  }

  function skipFromComposer(event: KeyboardEvent) {
    if (
      event.key !== " " ||
      event.repeat ||
      event.isComposing ||
      !(event.target instanceof HTMLTextAreaElement) ||
      !event.target.matches("[data-composer-input]") ||
      event.target.value !== ""
    )
      return;
    if (skipPacing()) event.preventDefault();
  }

  return { skipFromBackground, skipFromComposer };
}
