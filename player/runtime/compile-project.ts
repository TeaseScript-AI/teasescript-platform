import { compileProject, MAIN_FILE_PATH, type InstructionPlan } from "../../src/index.js";
import {
  createPlayerRuntimeSession as createPlanSession,
  type PlayerCompilation,
  type PlayerProject,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "./runtime-adapter.js";

/*
 * The compiler's part of the Player: compiling a script's source, and starting a session of source. The engine Worker
 * loads this module only on a source `prepare` (`engine-bridge/player-ops.ts`), so a Worker that plays published plans
 * never loads the compiler.
 */

/** Compiles a project, or a single source as the `main.tease` of a one-file project, without running it. */
export function compilePlayerProject(script: string | PlayerProject): PlayerCompilation {
  const project =
    typeof script === "string" ? { files: [{ path: MAIN_FILE_PATH, source: script }] } : script;
  const compilation = compileProject(project.files, {
    ...(project.images === undefined ? {} : { images: project.images }),
    ...(project.unreadableFiles === undefined ? {} : { unreadableFiles: project.unreadableFiles }),
  });
  return Object.freeze({
    plan: compilation.plan,
    diagnostics: Object.freeze(
      compilation.diagnostics.map((diagnostic) =>
        Object.freeze({
          path: diagnostic.path,
          line: diagnostic.span.start.line + 1,
          column: diagnostic.span.start.column + 1,
          severity: diagnostic.severity,
          code: diagnostic.code,
          message: diagnostic.message,
        }),
      ),
    ),
  });
}

/**
 * Starts a session of a script: a project, a single source as the `main.tease` of a one-file project, or the plan
 * `compilePlayerProject` made of one. A script that does not compile throws with its first error.
 */
export function createPlayerRuntimeSession(
  script: string | PlayerProject | InstructionPlan,
  options: PlayerRuntimeSessionOptions = {},
): PlayerRuntimeSession {
  return createPlanSession(isInstructionPlan(script) ? script : compiledPlan(script), options);
}

function isInstructionPlan(
  script: string | PlayerProject | InstructionPlan,
): script is InstructionPlan {
  return typeof script !== "string" && "instructions" in script;
}

function compiledPlan(script: string | PlayerProject): InstructionPlan {
  const compilation = compilePlayerProject(script);
  if (compilation.plan !== null) return compilation.plan;
  const error = compilation.diagnostics.find((diagnostic) => diagnostic.severity === "error");
  throw new Error(
    error === undefined
      ? "The script did not compile."
      : `${error.path}:${error.line}:${error.column}: ${error.message}`,
  );
}
