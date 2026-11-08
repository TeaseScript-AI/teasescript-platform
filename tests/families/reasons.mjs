// Why a publication's oracle left questions unanswered (#1837), as the families tools record it: the one list the runner
// (`run.mjs`), the stall index (`stalls.mjs`) and the stored baselines' line check (`baselines.mjs`) read, with each
// reason's stall-index group and the forms a record holds.

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
