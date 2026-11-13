// The written-type tests' shared setup (tests/type-core/written/): a source's request and decision in both orders, and
// its plan's checked stores.

import assert from "node:assert/strict";
import type { InstructionPlan, TypePlan } from "../../../../src/plan/model.js";
import { type Answers } from "../../../../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../../../../src/type-inference/core/consumers.js";
import {
  type CoreAnalysisRequest,
  CoreProgram,
} from "../../../../src/type-inference/core/program.js";
import type { PlaceId } from "../../../../src/type-inference/graph.js";
import { withSolverSeam } from "../../../../src/type-inference/core/solver.js";
import { coreRequest } from "../../type-core-analysis.js";

export function inBothOrders<T>(run: () => T): T {
  const forward = run();
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder((list) => [...list].reverse(), run),
  );
  assert.deepEqual(reversed, forward);
  return forward;
}

export const sorted = (kinds: readonly string[]): string[] => [...kinds].sort();

function typeText(type: TypePlan | null): string {
  if (type === null) return "any";
  if (type.kind === "union") return type.members.map(typeText).join("|");
  if (type.kind === "list" || type.kind === "set" || type.kind === "dict")
    return `${type.kind}<${typeText(type.element)}>`;
  return type.kind;
}

/** A plan's checked stores, each as `start:end type`. */
export function checksOf(plan: InstructionPlan): string[] {
  return plan.instructions.flatMap((instruction) =>
    (instruction.kind === "declareBinding" || instruction.kind === "assign") &&
    instruction.typeCheck !== undefined
      ? [`${instruction.span.so}:${instruction.span.eo} ${typeText(instruction.typeCheck.type)}`]
      : [],
  );
}

/** The host globals a source may read: the host value, and a host-started binding's own (`WrittenCase.globals`). */
export const GLOBALS = ["hostValue", "hostInit"];

/**
 * A source's request, its bindings' ids by name and every binding's place, once per exact source (a `CoreProgram` builds
 * its graph and dominators).
 */
const prepared = new Map<
  string,
  {
    readonly request: CoreAnalysisRequest;
    readonly ids: Map<string, PlaceId>;
    readonly bindings: readonly PlaceId[];
  }
>();

export function prepare(source: string) {
  let known = prepared.get(source);
  if (known === undefined) {
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
    assert.ok(request !== null, `${JSON.stringify(source)}: its file parses and resolves`);
    const ids = new Map<string, PlaceId>();
    const bindings: PlaceId[] = [];
    for (const { id, kind } of new CoreProgram(request).places)
      if (kind.kind === "binding") {
        bindings.push(id);
        if (!ids.has(kind.name)) ids.set(kind.name, id);
      }
    prepared.set(source, (known = { request, ids, bindings }));
  }
  return known;
}

/**
 * The place's admitted kinds at each prefix of `path`, and the program's C9 boundaries, sorted, each as `root level
 * [against] start:end` (`WrittenCase.boundaries`).
 */
export function decision(answers: Answers, id: PlaceId, path: readonly string[]) {
  return {
    levels: Array.from({ length: path.length + 1 }, (_, length) => {
      const admitted = answers.place(id, path.slice(0, length)).admitted;
      return admitted.by === "undecided" ? ["undecided"] : sorted(admitted.kinds);
    }),
    boundaries: answers.checks
      .filter((check) => check.boundary)
      .map((check) => {
        const steps = check.target.split(".");
        const level = steps.filter((step) => step === "element" || step === "entry").length;
        return `${steps[0]} ${level} [${sorted(check.against).join(",")}] ${check.site.start}:${check.site.end}`;
      })
      .sort(),
  };
}
