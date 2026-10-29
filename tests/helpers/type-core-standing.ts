import { compileProjectWithBackend } from "../../src/compiler.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import {
  type AdmittedType,
  type Answers,
  coreResult,
} from "../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { ingressLeaves, type Item, writerKey } from "../../src/type-inference/core/items.js";
import { propertyStep } from "../../src/type-inference/core/program.js";
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

/**
 * What a program publishes with two orders set aside (TABLE r4.185, G5's stops whose own entries merge into one): the
 * order of the items in an answer and of the kinds in a decided admitted type. Every binding's admitted type and decider
 * site at its root, its element and each known property two levels down; every occurrence's answer (each item with all
 * its marks, writer, context and ingress leaves), route, place and obligations, with its element's and its properties'
 * answers where it holds a collection or an object.
 */
export function publishedUpToOrder(answers: Answers, bindings: readonly PlaceId[]): string {
  const itemText = (item: Item): string =>
    [
      item.tag,
      item.cert,
      item.reasons,
      item.writer === null ? "" : writerKey(item.writer),
      item.context ?? "",
      item.word ?? "",
      `${item.guarded === true ? "g" : ""}${item.called === true ? "c" : ""}${item.loose === true ? "l" : ""}${item.extOnly === true ? "e" : ""}`,
      item.fan ?? "",
      item.ingress === undefined ? "" : ingressLeaves(item.ingress).map(writerKey).join("+"),
    ].join("|");
  const items = (list: readonly Item[]): string[] => list.map(itemText).sort();
  const admitted = (place: PlaceId, path: readonly string[]): AdmittedType => {
    const type = answers.place(place, path).admitted;
    return type.by === "decided"
      ? {
          by: type.by,
          kinds: [...type.kinds].sort(),
          decider: type.decider,
          inherited: type.inherited,
        }
      : type;
  };
  const places = bindings.map((place) => {
    const below: [string, AdmittedType][] = [];
    for (const first of [...answers.placeProperties(place, [])].sort()) {
      const one = [propertyStep(first)];
      below.push([first, admitted(place, one)]);
      for (const second of [...answers.placeProperties(place, one)].sort())
        below.push([`${first}.${second}`, admitted(place, [...one, propertyStep(second)])]);
    }
    return [place, admitted(place, []), admitted(place, ["element"]), below];
  });
  const occurrences = answers.graph.nodes.flatMap((node) => {
    const at = answers.at(node);
    if (at === null) return [];
    const tags = new Set(at.items.map((item) => item.tag));
    return [
      [
        node.id,
        at.route,
        at.place,
        items(at.items),
        at.obligations,
        tags.has("list") || tags.has("set") || tags.has("dict")
          ? items(answers.project(node, "element"))
          : null,
        tags.has("object")
          ? [...answers.properties(node)].map(([name, answer]) => [name, items(answer)])
          : null,
      ],
    ];
  });
  return JSON.stringify({ places, occurrences });
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
