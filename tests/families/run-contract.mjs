// A run's record as the families tools write and read it (#1837): why a publication's oracle left questions unanswered,
// with each reason's stall-index group and the forms a record holds, the unit limit a run is held to, what a tree's
// build gives the runner, and when a run's heap is near its process's cap. The runner (`run.mjs`) grants, records and
// flags by it, the stall index (`stalls.mjs`) groups by it, and the stored baselines (`baselines.mjs`) write and read
// every stored run by it.

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

/** The oracle library's exports a publication run's grant is read from: one spelling for `questionsOf` and `capabilitiesOf`. */
const GRANT = Object.freeze({ perCell: "QUESTION_UNITS_PER_CELL", work: "questionWork" });

/** What `oracle` (a tree's oracle library) reports of its latest publication's questions, or none. */
export function questionsOf(oracle) {
  const work = oracle[GRANT.work];
  const reported = {
    perCell: oracle[GRANT.perCell],
    cells: typeof work === "function" ? work()?.cells : undefined,
  };
  return isRecordedQuestions(reported) && reported.cells > 0 ? reported : undefined;
}

/**
 * What the runner reads of a tree that its build lacks, by name, in this order: `publicationHashes` (else the runner
 * holds a publication's whole text), the grant's two exports (else no grant: a large publication stalls over the unit
 * limit) and `WorkLedger` (else no units and no unit limit). Each makes the runner go on in another way without a word,
 * so the runner names them (`capabilities`) and a compiled test asserts the built tree lacks none. `oracle` is the
 * tree's oracle library, `ledger` its work ledger or `null`.
 */
export function capabilitiesOf({ oracle, ledger }) {
  return [
    ["publicationHashes", typeof oracle.publicationHashes === "function"],
    [GRANT.perCell, Number.isInteger(oracle[GRANT.perCell]) && oracle[GRANT.perCell] > 0],
    [GRANT.work, typeof oracle[GRANT.work] === "function"],
    ["WorkLedger", ledger !== null],
  ]
    .filter(([, given]) => !given)
    .map(([name]) => name);
}

/**
 * The share of a source's process's heap limit (V8's `heap_size_limit`, what its abort is against) above which a run's
 * sampled peak heap is near the cap. The runner counts such runs (`nearCap`) and names them, advisory only: a sampled
 * peak varies with when the collector runs, so it never decides a stall or an exit status. At the default 2,048 MB the
 * highest peak sampled over 36 runs near the cap (W19-sources, W24-varied and W24-alias-group at 256 to 1,024, every
 * mode) was 79 % of the limit, the oracle's `memory` stop holding its questions about 512 MiB under it.
 */
export const NEAR_CAP = 0.8;

/** Whether a run's peak heap (`peak`) is near the cap `limit`, both in MiB; never where either is unknown. */
export const isNearCap = (peak, limit) =>
  Number.isFinite(peak) && Number.isFinite(limit) && limit > 0 && peak > NEAR_CAP * limit;

/**
 * The units a run may charge (#1647, #1837): `units` times its program's allowance, and for a publication run its
 * oracle's units per cell for each cell its questions returned (`questions`), so that its questions' own bound, not the
 * runner's, ends them; nothing more where none is reported.
 */
export const limitOf = (units, allowance, questions) =>
  units * allowance + (questions === undefined ? 0 : questions.perCell * questions.cells);
