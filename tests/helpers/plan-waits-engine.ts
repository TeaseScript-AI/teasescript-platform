import type { InstructionPlan } from "../../src/plan/model.js";
import { planWaits } from "../../src/plan/waits.js";
import { createFreshRuntimeSession, type RuntimeSession } from "../../src/runtime/session.js";

/*
 * `planWaits` against today's engine: a session of the plan is played, and at every wait each live part must be marked:
 * the waiting instruction itself (`waitsAt`), each running function or block (`functionMayWait`), and each file call
 * below it (`mayWaitAt` of its `call`). Each finding names a soundness defect of the analysis.
 *
 * The play answers what it can without a Player: a delay or a reading time by observing its deadline (which also starts
 * the blocks due by then), a storage write as stored, a button by pressing it, a choice by its first option and a text
 * or number ask by "1". Any other wait ends the play after it was checked, as does `maxOperations`. Instruction budgets
 * are not used, so a run always stops at a wait or an ending, where the engine starts a due block.
 */

export interface WaitCheck {
  /** The waits checked. */
  readonly waits: number;
  /** One line per unmarked live part at a wait. */
  readonly unmarked: readonly string[];
  /** The session's status where the play ended. */
  readonly status: string;
}

const FRESH = { seed: 1, wallClockMs: Date.UTC(2026, 0, 5, 9, 0, 0) };

export function checkWaitsAgainstEngine(plan: InstructionPlan, maxOperations = 200): WaitCheck {
  const waits = planWaits(plan);
  const session = createFreshRuntimeSession(plan, FRESH);
  const unmarked: string[] = [];
  let checked = 0;
  session.run();
  for (let operation = 0; ; operation += 1) {
    const view = session.view();
    if (view.status !== "waiting") return { waits: checked, unmarked, status: view.status };
    checked += 1;
    const action = view.foregroundAction;
    if (action !== null && !waits.waitsAt(action.owningInstruction))
      unmarked.push(
        `wait ${checked}: instruction ${action.owningInstruction} (${action.kind}) waits unmarked`,
      );
    for (const call of session.callStack()) {
      if (call.kind === "function") {
        if (!waits.functionMayWait(call.functionId))
          unmarked.push(
            `wait ${checked}: ${call.functionName} (${call.functionId}) is live unmarked`,
          );
      } else if (!waits.mayWaitAt(call.returnInstruction - 1))
        unmarked.push(
          `wait ${checked}: the file call at ${call.returnInstruction - 1} is live unmarked`,
        );
    }
    if (operation >= maxOperations || !answer(session))
      return { waits: checked, unmarked, status: "waiting" };
    session.run();
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
