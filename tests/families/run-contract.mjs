// A run's record as the families tools write and read it (#1837): why a publication's oracle left questions unanswered,
// with each reason's stall-index group and the forms a record holds, and the unit limit a run is held to. The runner
// (`run.mjs`) grants and records by it, the stall index (`stalls.mjs`) groups by it, and the stored baselines
// (`baselines.mjs`) write and read every stored run by it.

/**
 * The reasons a tree's oracle gives (its `unansweredBy.reason`): `questions` (its questions passed their bound or the
 * analysis's work), `memory` (their room in the heap), `read-depth` (a question past the read-depth limit), `stopped`
 * (the analysis itself stopped in one of its phases).
 */
export const STOP_REASONS = Object.freeze(["questions", "memory", "read-depth", "stopped"]);

/** The reason recorded where a tree's oracle names none (a library before #1837): its place is `node: null`. */
export const UNKNOWN_REASON = "unknown";

/** A recorded reason's stall-index group (`stalls.mjs`). */
export const groupOf = (reason) => `unanswered: ${reason}`;

/** Every recorded reason's group, in the list's order, `unknown`'s last. */
export const REASON_GROUPS = Object.freeze([...STOP_REASONS, UNKNOWN_REASON].map(groupOf));

/**
 * Whether `by` is a reason in a form a record holds: a reason of the list with the first node left (`{reason, node}`)
 * or the binding where the answers' own questions stopped (`{reason, binding}`), each a whole number; or `unknown` with
 * no node (`{reason: "unknown", node: null}`). A stored line written before #1837's places holds a reason of the list
 * with `node: null` too.
 */
export function isRecordedReason(by) {
  if (by === null || typeof by !== "object" || Array.isArray(by)) return false;
  const keys = Object.keys(by).sort().join(",");
  if (by.reason === UNKNOWN_REASON) return keys === "node,reason" && by.node === null;
  if (!STOP_REASONS.includes(by.reason)) return false;
  return (
    (keys === "node,reason" && (by.node === null || Number.isInteger(by.node))) ||
    (keys === "binding,reason" && Number.isInteger(by.binding))
  );
}

/**
 * What a publication run's oracle reported of its own questions (`questionWork`) at the run's end or at its cut, as a
 * record holds it: its units per cell (`QUESTION_UNITS_PER_CELL`) and the cells its questions returned, both whole
 * numbers, the units above 0; or none where the oracle reports none.
 */
export function isRecordedQuestions(questions) {
  if (questions === null || typeof questions !== "object" || Array.isArray(questions)) return false;
  return (
    Object.keys(questions).sort().join(",") === "cells,perCell" &&
    Number.isInteger(questions.perCell) &&
    questions.perCell > 0 &&
    Number.isInteger(questions.cells) &&
    questions.cells >= 0
  );
}

/** What `oracle` (a tree's oracle library) reports of its latest publication's questions, or none. */
export function questionsOf(oracle) {
  const reported = {
    perCell: oracle.QUESTION_UNITS_PER_CELL,
    cells: typeof oracle.questionWork === "function" ? oracle.questionWork()?.cells : undefined,
  };
  return isRecordedQuestions(reported) && reported.cells > 0 ? reported : undefined;
}

/**
 * The units a run may charge (#1647, #1837): `units` times its program's allowance, and for a publication run its
 * oracle's units per cell for each cell its questions returned (`questions`), so that its questions' own bound, not the
 * runner's, ends them; nothing more where none is reported.
 */
export const limitOf = (units, allowance, questions) =>
  units * allowance + (questions === undefined ? 0 : questions.perCell * questions.cells);
