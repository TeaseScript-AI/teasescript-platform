import { globMatches, isPathGlob } from "../../../../src/project-paths.js";
import type { SerializableRuntimeValue } from "../../../../src/runtime/values/serializable-values.js";
import {
  type DerivedContent,
  type DerivedStore,
  type Syntax,
  Underivable,
} from "./type-core-derived.js";
import { type CheckEvent, evaluate, type PredictedRun } from "./type-core-derived-runs.js";

/*
 * The derived oracle's runs across files (#2488's step 1c): a run evaluates the entry file by the rules (`evaluate`);
 * where that file ends at a `goto` to a file, the file it names is evaluated afresh, its variables new, as the runtime
 * starts a file from its top, and its `say`s follow the earlier files'. A quoted glob names the files it matches that
 * run something, as the runtime draws them: one is that file, several a pick, underivable. A `script(…)` path that is
 * no text fails with TSR058 at the call, a path no file of the project has with TSR069 at the statement. Like
 * `evaluate`, it reads the sources and the derived stores, never the plan. A transfer to a file the run has already
 * been in, a target of any other form, and a file without statements (which the runtime refuses to start) are
 * underivable.
 */

/** A file of the project as the oracle reads it: its path, its syntax and what `derive` gives for it. */
export interface DerivedFile {
  readonly path: string;
  readonly syntax: Syntax;
  readonly stores: readonly DerivedStore[];
  readonly content?: DerivedContent;
}

/** A run of the project from its first file, with `inputs` the host globals' values; `through` as `evaluate`'s. */
export function evaluateProject(
  files: readonly DerivedFile[],
  inputs: Readonly<Record<string, SerializableRuntimeValue>>,
  through = false,
): { readonly run: PredictedRun; readonly events: readonly CheckEvent[] } {
  const said: PredictedRun["said"][number][] = [];
  const events: CheckEvent[] = [];
  const entered = new Set<string>();
  const failed = (code: string, [start, end]: readonly [number, number]) => ({
    run: { status: "failed" as const, failure: `${code}@${start}:${end}`, said },
    events,
  });
  for (let file = files[0]; file !== undefined;) {
    entered.add(file.path);
    const ended = evaluate(file.syntax, file.stores, inputs, through, file.content, files);
    said.push(...ended.run.said);
    events.push(...ended.events);
    if (ended.transfer === null || ended.run.failure !== null)
      return { run: { ...ended.run, said }, events };
    const { statement, path } = ended.transfer;
    const span = [statement.span.start.offset, statement.span.end.offset] as const;
    const { target } = statement;
    const call = target.kind === "scriptTarget" ? target.expression : null;
    if (target.kind === "labelTarget" || (call !== null && call.kind !== "callExpression"))
      throw new Underivable("a goto statement to no file");
    if (typeof path !== "string")
      return failed(
        "TSR058",
        call === null ? span : [call.span.start.offset, call.span.end.offset],
      );
    const named =
      target.kind === "fileTarget" && isPathGlob(path)
        ? globMatches(
            path,
            files
              .filter((candidate) => candidate.syntax.statements.length > 0)
              .map(({ path: at }) => at),
          )
        : [path];
    if (named.length !== 1) throw new Underivable(`a pick among ${named.length} files`);
    const next = files.find((candidate) => candidate.path === named[0]);
    if (next === undefined) return failed("TSR069", span);
    if (entered.has(next.path) || next.syntax.statements.length === 0)
      throw new Underivable(
        `a transfer to ${next.path}, which the run has been in or which runs nothing`,
      );
    file = next;
  }
  throw new Underivable("a project without files");
}
