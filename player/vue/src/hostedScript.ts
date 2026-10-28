import { shallowRef, type ShallowRef } from "vue";
import {
  compilePlayerProject,
  createPlayerRuntimeSession,
  type PlayerProject,
} from "../../runtime-adapter.js";
import type { RuntimePlayerProfileInput } from "../../../src/runtime/host-data/player-profile.js";
import type { ScriptFailure } from "./ScriptProblems.vue";
import type { PlayerSessionHost } from "./usePlayerSession";
import { MAIN_FILE_PATH } from "../../../src/index.js";
import { lex } from "../../../src/lexer.js";
import { readScriptHeader } from "../../../src/script-header.js";

/** The code of a package file the host could not load (`docs/DIAGNOSTICS.md`). */
const UNREADABLE_FILE_CODE = "TSC011";

/** The trusted host of one script: its storage scope, how its references resolve, and how its project loads. */
export interface ScriptHost {
  readonly storageScope: string;
  /** The package's name, such as its folder, which the random draw picker's breadcrumb starts with, if known. */
  readonly name?: string;
  /** The person fields of the player's profile that the session starts with (V30 §37), if the host has them. */
  readonly playerProfile?: RuntimePlayerProfileInput;
  resolveAsset(path: string): string | null;
  /** The script, or the package as a project with the files the host could not load. */
  load(): Promise<{ readonly project: string | PlayerProject }>;
}

/** The `title` and `author` of a script's header, each `null` when the header does not give it. */
export interface ScriptIdentity {
  readonly title: string | null;
  readonly author: string | null;
}

/**
 * Compiles the host's script, without running it, and prepares Start, or Continue for the session the script keeps; a
 * script that does not compile, or a package that cannot be opened, yields the failure the Player shows instead. Stored
 * values are read ahead too, for the start page; Start reads them again. `identity` is the title and author of `main.tease`'s header, for the title bar.
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
    ([{ project }]) => {
      identity.value = scriptIdentity(project);
      // The title names the script where saved data of several scripts is listed.
      if (identity.value.title !== null) player.rememberScriptName(identity.value.title);
      const compilation = compilePlayerProject(project);
      const plan = compilation.plan;
      if (plan === null) {
        // Warnings are for the creator's tools, not the start page (PLAYER-UI "Session start and user activation").
        const errors = compilation.diagnostics.filter(
          (diagnostic) => diagnostic.severity === "error",
        );
        failure.value = {
          title: "This Tease cannot start",
          summary: errors.some((error) => error.code === UNREADABLE_FILE_CODE)
            ? "A file of this Tease cannot be read, so the Tease cannot start. The creator of this Tease needs to fix the file."
            : "This Tease contains an error, so the Tease cannot start. The creator of this Tease needs to fix the error.",
          problems: errors,
        };
        return;
      }
      void player.prepareScript(
        plan,
        (recording) =>
          createPlayerRuntimeSession(plan, {
            ...recording,
            ...player.scriptStorageOptions(),
            // Captured at Start: the session keeps this zone, presentation, and clock until a Continue.
            ...player.temporalCapture(),
            ...(host.playerProfile === undefined ? {} : { playerProfile: host.playerProfile }),
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
        summary: error instanceof Error ? error.message : String(error),
        problems: [],
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
