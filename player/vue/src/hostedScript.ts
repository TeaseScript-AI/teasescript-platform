import { shallowRef, type ShallowRef } from "vue";
import type { PackageProblem } from "../../../playground/package-catalog.js";
import {
  compilePlayerProject,
  createPlayerRuntimeSession,
  type PlayerProject,
} from "../../runtime-adapter.js";
import type { ScriptFailure } from "./ScriptProblems.vue";
import type { PlayerSessionHost } from "./usePlayerSession";
import { MAIN_FILE_PATH } from "../../../src/index.js";
import { lex } from "../../../src/lexer.js";
import { readScriptHeader } from "../../../src/script-header.js";

/** The trusted host of one script: its storage scope, how its references resolve, and how its project loads. */
export interface ScriptHost {
  readonly storageScope: string;
  resolveAsset(path: string): string | null;
  load(): Promise<{
    readonly project: string | PlayerProject;
    readonly problems: readonly PackageProblem[];
  }>;
}

/**
 * Compiles the host's script, without running it, and prepares Start; a script that does not compile, or a package
 * that cannot be opened, yields the failure the Player shows instead. Stored values are read before Start too, so Start
 * runs within the player's activation.
 */
export function prepareHostedScript(
  player: PlayerSessionHost,
  host: ScriptHost,
): ShallowRef<ScriptFailure | null> {
  const failure = shallowRef<ScriptFailure | null>(null);
  void Promise.all([host.load(), player.loadScriptStorage()]).then(
    ([{ project, problems }]) => {
      // The title names the script where saved data of several scripts is listed.
      const title = scriptTitle(project);
      if (title !== null) player.rememberScriptName(title);
      const compilation = compilePlayerProject(project);
      const plan = compilation.plan;
      if (plan === null) {
        failure.value = {
          title: "This script cannot start",
          problems: [...compilation.diagnostics, ...problems],
        };
        return;
      }
      player.prepare((recording) =>
        createPlayerRuntimeSession(plan, {
          ...recording,
          ...player.scriptStorageOptions(),
          // Captured at Start: the session keeps this zone, presentation, and clock until a Continue.
          ...player.temporalCapture(),
        }),
      );
    },
    (error: unknown) => {
      failure.value = {
        title: "This package cannot be opened",
        problems: [{ message: error instanceof Error ? error.message : String(error) }],
      };
    },
  );
  return failure;
}

/** The `title` of `main.tease`'s header, or `null`. */
function scriptTitle(project: string | PlayerProject): string | null {
  const source =
    typeof project === "string"
      ? project
      : project.files.find((file) => file.path === MAIN_FILE_PATH)?.source;
  if (source === undefined) return null;
  const title = readScriptHeader(lex(source)).header?.title ?? null;
  return title === null || title.trim() === "" ? null : title.trim();
}
