import { compileProjectWithBackend } from "../../src/compiler.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import { type Answers, coreResult } from "../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { coreRecord } from "../../src/type-inference/core/result.js";
import type { PlaceId } from "../../src/type-inference/graph.js";
import type { SourceFile } from "./type-core-analysis.js";

/*
 * What a program publishes in one order, the sharing differential's standing projection (TABLE r4.72): the same with the
 * sharing on and off. `type-core-sharing.test.ts` compares it for its programs, `type-core-written.test.ts` for the
 * sources of its matrices of three layers, on the analyses and plans it observes.
 */

/** Two sites as (file index, start, end), in source order. */
function compareSites(a: readonly number[], b: readonly number[]): number {
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
}

/**
 * One analysis's part: its answers (the outcome, diagnostics and checks) and every binding's admitted types at its root
 * and its element (`text`); the record alone, its answers and the same serialized (`record`); and whether each of its
 * lists is in source order of its sites (r4.86 (1)).
 */
export function publishedAnswers(
  answers: Answers,
  bindings: readonly PlaceId[],
  paths: readonly string[],
): { readonly text: string; readonly record: string; readonly sited: boolean } {
  const admitted = bindings.map((place) => [
    place,
    answers.place(place, []).admitted,
    answers.place(place, ["element"]).admitted,
  ]);
  const record = {
    outcome: answers.outcome,
    diagnostics: answers.diagnostics,
    checks: answers.checks,
  };
  const serialized = coreRecord(coreResult(answers), paths);
  const sitesOf = (
    list: readonly {
      readonly site: { readonly file: number; readonly start: number; readonly end: number };
    }[],
  ) => list.map(({ site }) => [site.file, site.start, site.end]);
  const recordSites = (
    list: readonly {
      readonly site: { readonly file: string; readonly offset: number; readonly end: number };
    }[],
  ) => list.map(({ site }) => [paths.indexOf(site.file), site.offset, site.end]);
  const sited = [
    sitesOf(answers.diagnostics),
    sitesOf(answers.checks),
    recordSites(serialized.diagnostics),
    recordSites(serialized.runtimeChecks),
  ].every((sites) =>
    sites.every((site, index) => index === 0 || compareSites(sites[index - 1]!, site) <= 0),
  );
  return {
    text: JSON.stringify({ ...record, admitted }),
    record: JSON.stringify({ record, serialized }),
    sited,
  };
}

/** The candidate route's part: its plan and diagnostics of `files`, or the construct it rejects them at (`text`). */
export function publishedRoute(
  files: readonly SourceFile[],
  globals: readonly string[],
): { readonly plan: InstructionPlan | null | "outside"; readonly text: string } {
  try {
    const { plan, diagnostics } = compileProjectWithBackend(files, { globals }, CORE_BACKEND);
    return { plan, text: JSON.stringify({ plan, diagnostics }) };
  } catch (error) {
    if (!(error instanceof CandidateOutsideSlice)) throw error;
    return { plan: "outside", text: JSON.stringify({ outside: error.what }) };
  }
}
