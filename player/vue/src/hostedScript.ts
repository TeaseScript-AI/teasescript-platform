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

/** The `title` and `author` of a script's header, each `null` when the header does not give it. */
export interface ScriptIdentity {
  readonly title: string | null;
  readonly author: string | null;
}

/**
 * Compiles the host's script, without running it, and prepares Start; a script that does not compile, or a package
 * that cannot be opened, yields the failure the Player shows instead. Stored values are read before Start too, so Start
 * runs within the player's activation. `identity` is the title and author of `main.tease`'s header, for the title bar.
 */
export function prepareHostedScript(
  player: PlayerSessionHost,
  host: ScriptHost,
): {
  readonly failure: ShallowRef<ScriptFailure | null>;
  readonly identity: ShallowRef<ScriptIdentity>;
} {
  const failure = shallowRef<ScriptFailure | null>(null);
  const identity = shallowRef<ScriptIdentity>({ title: null, author: null });
  void Promise.all([host.load(), player.loadScriptStorage()]).then(
    ([{ project, problems }]) => {
      identity.value = scriptIdentity(project);
      // The title names the script where saved data of several scripts is listed.
      if (identity.value.title !== null) player.rememberScriptName(identity.value.title);
      const compilation = compilePlayerProject(project);
      const plan = compilation.plan;
      if (plan === null) {
        failure.value = {
          title: "This script cannot start",
          problems: [...compilation.diagnostics, ...problems],
        };
        return;
      }
      player.prepare(
        (recording) =>
          createPlayerRuntimeSession(plan, {
            ...recording,
            ...player.scriptStorageOptions(),
            // Captured at Start: the session keeps this zone, presentation, and clock until a Continue.
            ...player.temporalCapture(),
          }),
        new Map(
          typeof project === "string"
            ? [[MAIN_FILE_PATH, project]]
            : project.files.map((file) => [file.path, file.source]),
        ),
      );
    },
    (error: unknown) => {
      failure.value = {
        title: "This package cannot be opened",
        problems: [{ message: error instanceof Error ? error.message : String(error) }],
      };
    },
  );
  return { failure, identity };
}

/** The `title` and `author` of `main.tease`'s header; a blank field counts as absent. */
function scriptIdentity(project: string | PlayerProject): ScriptIdentity {
  const source =
    typeof project === "string"
      ? project
      : project.files.find((file) => file.path === MAIN_FILE_PATH)?.source;
  const header = source === undefined ? null : readScriptHeader(lex(source)).header;
  const field = (value: string | null | undefined) => {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
  };
  return { title: field(header?.title), author: field(header?.author) };
}
