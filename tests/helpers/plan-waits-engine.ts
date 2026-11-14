import { PlanControlFlow } from "../../src/plan/control-flow.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import { planWaits, type PlanWaits } from "../../src/plan/waits.js";
import type { InterpreterEvent } from "../../src/runtime/events.js";
import { createFreshRuntimeSession, type RuntimeSession } from "../../src/runtime/session.js";

/*
 * `planWaits` against today's engine: a session of the plan is played, and at every wait it enters each live part must
 * be marked: the waiting instruction itself (`waitsAt`), each running function or block (`functionMayWait`), and each
 * file call below it (`mayWaitAt` of its `call`). Each finding names a soundness defect of the analysis.
 *
 * Every wait counts, also one that catch-up settles inside the same operation: each foreground action the engine
 * requests is read from the operation's events, with the call frame it stands in (`ownerCallFrameId`). The frames below
 * it are those an instruction observer recorded when that frame ran its first instruction; a file call's frame is
 * checked at the instruction that completed last before it, its `call`.
 *
 * The play answers what it can without a Player: a delay or a reading time by observing its deadline (which also starts
 * the blocks due by then), a media load as loaded and 5 s long, a storage write as stored, a button by pressing it, a
 * choice by its first option and a text or number ask by "1". Any other wait ends the play after it was checked, as
 * does `maxOperations`. Instruction budgets are not used, so a run always stops at a wait or an ending.
 */

export interface WaitCheck {
  /** The waits checked. */
  readonly waits: number;
  /** One line per unmarked live part at a wait. */
  readonly unmarked: readonly string[];
  /** The session's status where the play ended. */
  readonly status: string;
  /** The functions and blocks seen live at some wait, by plan ID, so a test can tell that its case was reached. */
  readonly live: ReadonlySet<number>;
}

const FRESH = { seed: 1, wallClockMs: Date.UTC(2026, 0, 5, 9, 0, 0) };

/** A call frame as the observer first met it: what runs in it, and the frames up to it, outermost first. */
interface Frame {
  /** The function or block, or `null` for a file call's activation. */
  readonly functionId: number | null;
  /** For a file call's frame, the instruction that completed last before its first one: its `call`. */
  readonly callInstruction: number | null;
  readonly stack: readonly number[];
}

/** `waits` is the analysis under test: `planWaits(plan)`, unless a test checks the check with another. */
export function checkWaitsAgainstEngine(
  plan: InstructionPlan,
  maxOperations = 200,
  waits: PlanWaits = planWaits(plan),
): WaitCheck {
  const flow = new PlanControlFlow(plan);
  const session = createFreshRuntimeSession(plan, FRESH);
  const frames = new Map<number, Frame>();
  const unmarked: string[] = [];
  const live = new Set<number>();
  let checked = 0;
  let lastCompleted: number | null = null;
  const instructionObserver = {
    before: (instruction: number, call: number): void => {
      if (call === 0 || frames.has(call)) return;
      const definition = flow.functionOf(instruction);
      frames.set(call, {
        functionId: definition?.id ?? null,
        callInstruction: definition === null ? lastCompleted : null,
        stack: session.callFrameIds(),
      });
    },
    after: (instruction: number): void => {
      lastCompleted = instruction;
    },
  };
  const check = (events: readonly InterpreterEvent[]): void => {
    for (const event of events) {
      if (event.kind !== "actionRequested") continue;
      const action = event.action;
      // Background actions (timers, media, permanent buttons) leave the script running.
      if (action.kind === "timer" || action.kind === "media" || action.kind === "permanentButton")
        continue;
      checked += 1;
      if (!waits.waitsAt(action.owningInstruction))
        unmarked.push(
          `wait ${checked}: instruction ${action.owningInstruction} (${action.kind}) waits unmarked`,
        );
      const owner = action.ownerCallFrameId;
      if (owner === null) continue;
      const frame = frames.get(owner);
      if (frame === undefined) {
        unmarked.push(`wait ${checked}: its call frame ${owner} was never observed`);
        continue;
      }
      for (const id of frame.stack) {
        const below = frames.get(id);
        if (below === undefined)
          unmarked.push(`wait ${checked}: call frame ${id} was never observed`);
        else if (below.functionId !== null) {
          live.add(below.functionId);
          if (!waits.functionMayWait(below.functionId))
            unmarked.push(
              `wait ${checked}: function or block ${below.functionId} is live unmarked`,
            );
        } else if (below.callInstruction === null || !waits.mayWaitAt(below.callInstruction))
          unmarked.push(
            `wait ${checked}: the file call at ${below.callInstruction} is live unmarked`,
          );
      }
    }
  };
  check(session.run({ instructionObserver }).events);
  for (let operation = 0; ; operation += 1) {
    const status = session.view().status;
    if (status !== "waiting" || operation >= maxOperations || !answer(session))
      return { waits: checked, unmarked, status, live };
    check(session.run({ instructionObserver }).events);
  }
}

/** Settles the foreground action as the header says; `false` when the play cannot. */
function answer(session: RuntimeSession): boolean {
  const action = session.view().foregroundAction;
  if (action === null) return false;
  switch (action.kind) {
    case "delay":
    case "chatPacingGate":
      session.observeTime(action.deadlineMs);
      return true;
    case "mediaPlayback":
      if (action.until !== "loaded") return false;
      session.reportMediaLoad(action.mediaId, { kind: "loaded", durationMs: 5000 });
      return true;
    case "storageWrite":
      session.completeAction({
        actionId: action.actionId,
        actionKind: "storageWrite",
        payload: { kind: "stored" },
      });
      return true;
    case "interaction": {
      const base = {
        actionId: action.actionId,
        actionKind: "interaction",
        interactionKind: action.interactionKind,
      };
      if (action.interactionKind === "button")
        session.completeAction({ ...base, payload: { kind: "activate" } });
      else if (action.interactionKind === "choice")
        session.completeAction({ ...base, payload: { kind: "selectedOption", optionIndex: 0 } });
      else if (action.interactionKind === "text" || action.interactionKind === "number")
        session.completeAction({ ...base, payload: { kind: "submittedText", submittedText: "1" } });
      else return false;
      return true;
    }
    default:
      return false;
  }
}
