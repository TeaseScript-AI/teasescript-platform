import { lex } from "../../src/lexer.js";
import { MAIN_FILE_PATH } from "../../src/project-paths.js";
import { readScriptHeader } from "../../src/script-header.js";
import type { PlayerProject } from "./runtime-adapter.js";

/** The `title` and `author` of a script's header, each `null` when the header does not give it. */
export interface ScriptIdentity {
  readonly title: string | null;
  readonly author: string | null;
}

/** The `title` and `author` of `main.tease`'s header, for the title bar; a blank field counts as absent. */
export function scriptIdentity(project: string | PlayerProject): ScriptIdentity {
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
