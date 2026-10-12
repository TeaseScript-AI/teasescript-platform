import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import {
  assembleDebugExport,
  chooseDebugCategory,
  chooseDebugPhoto,
  NO_PERSONAL_CONTENT,
  type DebugCategory,
  type DebugExportCandidate,
  type DebugExportChoices,
  type DebugExportPart,
} from "../../debug-export-assembly.js";
import {
  DEBUG_EXPORT_MAX_JSON_BYTES,
  debugExportFileName,
  debugExportJson,
  measuredDebugExportFile,
  type DebugExport,
} from "../../debug-export.js";
import { gzipSupported } from "../../transfer-encoding.js";
import type { PlayerSessionHost } from "./usePlayerSession";

/** The largest file the Player offers, safely under GitHub's 25 MB attachment limit. */
const MAX_FILE_BYTES = 24_000_000;
/** How much of the readable sections the preview shows. */
const PREVIEW_CHARACTERS = 20_000;

export interface PreparedDebugExport {
  readonly url: string;
  readonly size: number;
  readonly parts: readonly DebugExportPart[];
  readonly omissions: readonly string[];
  readonly replay: "complete" | "incomplete" | "none";
  readonly preview: string;
  /** Why it cannot be downloaded, such as its size; `null` when it can. */
  readonly problem: string | null;
}

/**
 * The debug export dialog's state. Opening freezes what the export can contain; every choice starts off and is never
 * kept. Each change of the choices prepares the file again, so the size and preview always describe the file that
 * Download saves, which happens only from the player's own press.
 */
export function useDebugExport(
  player: PlayerSessionHost,
  name: () => string,
  details: () => Pick<DebugExportCandidate, "player" | "host">,
) {
  const open = ref(false);
  const candidate = shallowRef<DebugExportCandidate | null>(null);
  const choices = shallowRef<DebugExportChoices>(NO_PERSONAL_CONTENT);
  const prepared = shallowRef<PreparedDebugExport | "preparing" | "failed">("preparing");
  const gzip = gzipSupported();
  // Each opening and each preparation has its own number; a later one discards the results of earlier ones.
  let generation = 0;

  function release() {
    if (typeof prepared.value === "object") URL.revokeObjectURL(prepared.value.url);
    prepared.value = "preparing";
  }

  watch(open, async (isOpen) => {
    const current = ++generation;
    release();
    candidate.value = null;
    choices.value = NO_PERSONAL_CONTENT;
    if (!isOpen) return;
    try {
      const frozen = await player.debugExportCandidate(details());
      if (current === generation) candidate.value = frozen;
    } catch {
      if (current === generation) prepared.value = "failed";
    }
  });
  watch([candidate, choices], async ([frozen, chosen]) => {
    if (frozen === null) return;
    const current = ++generation;
    release();
    try {
      const { exported, parts } = await assembleDebugExport(frozen, chosen);
      const { file, jsonBytes } = await measuredDebugExportFile(exported, gzip);
      if (current !== generation) return;
      prepared.value = {
        url: URL.createObjectURL(file),
        size: file.size,
        parts,
        omissions: exported.omissions,
        replay:
          exported.replay === null ? "none" : exported.replay.complete ? "complete" : "incomplete",
        preview: preview(exported),
        problem:
          file.size > MAX_FILE_BYTES || jsonBytes > DEBUG_EXPORT_MAX_JSON_BYTES
            ? "This export is too large to attach to an issue. Leave out photos or replay data."
            : null,
      };
    } catch {
      if (current === generation) prepared.value = "failed";
    }
  });
  onScopeDispose(() => {
    generation++;
    release();
  });

  const fileName = computed(() =>
    debugExportFileName(name() || (candidate.value?.package.id ?? ""), gzip),
  );

  return {
    open,
    candidate,
    choices,
    prepared,
    fileName,
    /** Whether there is a session, or a failure of the Player, to export. */
    available: computed(() => player.session.value !== null || player.hostError.value !== null),
    choose(category: DebugCategory, on: boolean) {
      if (candidate.value !== null)
        choices.value = chooseDebugCategory(choices.value, candidate.value, category, on);
    },
    choosePhoto(reference: string, on: boolean) {
      choices.value = chooseDebugPhoto(choices.value, reference, on);
    },
  };
}

export type DebugExportState = ReturnType<typeof useDebugExport>;

/** The readable sections as the file has them, cut to a length a dialog can show. */
function preview(exported: DebugExport): string {
  const text = debugExportJson(exported.sections);
  return text.length > PREVIEW_CHARACTERS
    ? `${text.slice(0, PREVIEW_CHARACTERS)}\n… (${text.length - PREVIEW_CHARACTERS} more characters in the file)`
    : text;
}
