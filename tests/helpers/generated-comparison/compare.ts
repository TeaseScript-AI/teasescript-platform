import { GenerationRefused } from "../../../src/compiler/javascript/refusal.js";
import type { InstructionPlan, PlanSourceLocation } from "../../../src/plan/model.js";
import {
  createFreshRuntimeSession,
  type RuntimeSessionOptions,
} from "../../../src/runtime/session.js";
import type { FreshRuntimeOptions } from "../../../src/runtime/snapshot/state.js";
import { compareStructures, type StructureMismatch } from "../runtime-state-comparison.js";
import { PlayHost } from "./fixtures.js";
import {
  type ComparedSession,
  type GeneratedProgramText,
  type OperationResult,
  generatedSide,
  todaySide,
} from "./generated-side.js";
import { type HostOperation, Play, type PlayEnding, type PlayPolicy } from "./play.js";
import { projectRecord } from "./record.js";

/**
 * Whether generated code gave a player what today's engine gave, for one program and one play:
 * - `matched`: equal records after every operation, up to how the play ended (`unanswered` is never a whole-session
 *   match);
 * - `refused`: the generator does not admit a form of the plan yet;
 * - `differs`: the first operation whose records differ;
 * - `outside`: today's engine reached a limit of the resource-limit registry (`docs/RESOURCE-LIMITS.md`), which
 *   generated code need not reach the same way. A fault only the generated side reaches is a difference.
 */
export type ComparisonVerdict =
  | {
      readonly kind: "matched";
      readonly ended: PlayEnding;
      readonly answers: number;
      readonly operations: number;
    }
  | {
      readonly kind: "refused";
      readonly form: string;
      readonly instruction: number;
      readonly span: PlanSourceLocation | null;
    }
  | {
      readonly kind: "differs";
      readonly operation: number;
      readonly after: HostOperation["kind"];
      readonly mismatches: readonly StructureMismatch[];
    }
  | { readonly kind: "outside"; readonly limit: string; readonly operation: number };

export interface ComparisonInput {
  /** A validated plan. */
  readonly plan: InstructionPlan;
  readonly fresh?: FreshRuntimeOptions;
  /** Called once per side: the session's capabilities. */
  readonly host?: () => RuntimeSessionOptions;
  readonly play?: PlayPolicy;
  readonly end?: { readonly answers?: number; readonly sceneTimeMs?: number };
}

const FRESH: FreshRuntimeOptions = { seed: 20260713 };
const ANSWERS = 2_000;
const SCENE_TIME_MS = 6 * 60 * 60 * 1000;

/**
 * The runtime codes `docs/RESOURCE-LIMITS.md` registers; `generated-comparison.test.ts` keeps this list equal to it.
 */
export const RESOURCE_LIMIT_CODES: readonly string[] = [
  "TSR037",
  "TSR045",
  "TSR059",
  "TSR084",
  "TSR087",
  "TSR088",
];

/**
 * Compares the code the stage generates for `input.plan` with today's engine. `generate` defaults to a stub that refuses
 * every plan until S1. Only `GenerationRefused` becomes `refused`; any other exception propagates.
 */
export async function compareGenerated(
  input: ComparisonInput & { readonly generate?: (plan: InstructionPlan) => GeneratedProgramText },
): Promise<ComparisonVerdict> {
  let program: GeneratedProgramText;
  try {
    program = (input.generate ?? refuseEveryPlan)(input.plan);
  } catch (error) {
    if (!(error instanceof GenerationRefused)) throw error;
    return {
      kind: "refused",
      form: error.form,
      instruction: error.instruction,
      span: input.plan.instructions[error.instruction]?.span ?? null,
    };
  }
  return compareSessions(input, await generatedSide(program, input.plan));
}

/** The comparison over a generated side already made: the entry's play, also for stand-ins in tests. */
export function compareSessions(
  input: ComparisonInput,
  generated: ComparedSession,
): ComparisonVerdict {
  const fresh = input.fresh ?? FRESH;
  const session = createFreshRuntimeSession(input.plan, fresh, input.host?.() ?? {});
  const today = todaySide(session);
  const host = new PlayHost();
  const play = new Play(session, host, input.play ?? "first", {
    answers: input.end?.answers ?? ANSWERS,
    sceneTimeMs: input.end?.sceneTimeMs ?? SCENE_TIME_MS,
  });
  let operation: HostOperation = { kind: "run" };
  for (let index = 1; ; index += 1) {
    const mine = apply(today, operation, host);
    const theirs = apply(generated, operation, host);
    const todayState = today.state();
    const failure = todayState.snapshot.failure;
    if (failure !== null && RESOURCE_LIMIT_CODES.includes(failure.code))
      return { kind: "outside", limit: failure.code, operation: index };
    const compared = compareStructures(
      projectRecord({ ...mine, ...todayState }),
      projectRecord({ ...theirs, ...generated.state() }),
    );
    if (!compared.equal)
      return {
        kind: "differs",
        operation: index,
        after: operation.kind,
        mismatches: compared.mismatches,
      };
    const next = play.next(operation, mine.outcome);
    if (typeof next === "string")
      return { kind: "matched", ended: next, answers: play.answers, operations: index };
    operation = next;
  }
}

function apply(side: ComparedSession, operation: HostOperation, host: PlayHost): OperationResult {
  let result: OperationResult;
  switch (operation.kind) {
    case "run":
      result = side.run();
      break;
    case "observeTime":
      result = side.observeTime(operation.nowMs, operation.reports);
      break;
    case "completeAction":
      result = side.completeAction(operation.request, { capturedMedia: host.admission });
      break;
    case "updateInteraction":
      result = side.updateInteraction(operation.request);
      break;
    case "reportMediaLoad":
      result = side.reportMediaLoad(operation.mediaId, operation.report);
      break;
    case "pressPermanentButton":
      result = side.pressPermanentButton(operation.buttonId);
      break;
  }
  return { events: result.events, outcome: result.outcome };
}

/** The generator until S1: it admits no form, so it refuses the plan's first instruction. */
function refuseEveryPlan(plan: InstructionPlan): never {
  throw new GenerationRefused(`instruction:${plan.instructions[0]?.kind ?? "none"}`, 0);
}
