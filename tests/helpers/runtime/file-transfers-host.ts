/*
 * The file-transfer tests' shared host (`runtime/file-transfers`, `semantic/file-transfer-checks`,
 * `semantic/file-transfer-check-runs`): projects, what a run said, and a clean plan. Orchestrator 2's; a change to the
 * exports the semantic files use names the O4 lead as required reviewer.
 */

import assert from "node:assert/strict";
import { compileProject, type ProjectSourceFile } from "../../../src/compiler.js";
import type { InstructionPlan } from "../../../src/plan/model.js";
import type { InterpreterEvent } from "../../../src/runtime/events.js";
import { assertRuntimeResumeEquivalent } from "../runtime-equivalence.js";

export function project(main: string, others: Record<string, string> = {}): ProjectSourceFile[] {
  return [
    { path: "main.tease", source: main },
    ...Object.entries(others).map(([path, source]) => ({ path, source })),
  ];
}

export function outputs(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "say"
      ? [event.text]
      : event.kind === "runtimeFailure"
        ? [`failure ${event.code}`]
        : event.kind === "exit"
          ? ["exit"]
          : [],
  );
}

/** Runs a project to its end, also stepwise with a checkpoint at every boundary, and returns what it said. */
export function said(
  files: readonly ProjectSourceFile[],
  options: Parameters<typeof assertRuntimeResumeEquivalent>[1] = {},
): string[] {
  return outputs(assertRuntimeResumeEquivalent(files, options).events);
}

/** The plan of a project whose only diagnostics are the TSV065 warnings of the files in `unstarted`, which nothing starts. */
export function compiled(
  files: readonly ProjectSourceFile[],
  unstarted: readonly string[] = [],
): InstructionPlan {
  const result = compileProject(files);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [diagnostic.path, diagnostic.code]),
    unstarted.map((path) => [path, "TSV065"]),
  );
  return result.plan!;
}
