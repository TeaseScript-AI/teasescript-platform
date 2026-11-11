/*
 * The type core's oracles, one library for the tests and for the generator corpus (`tests/families/`): the
 * diagnostics' identity a stop keeps (`stopIdentity`, `keptErrors`) and the merged stops' (`mergedIdentity`); what a
 * program publishes, exactly (`publishedAnswers`, `publishedRoute`, `publication`) and with two orders set aside
 * (`publishedUpToOrder`); the four modes they are compared in (`MODES`, `inMode`); which decisions
 * stop and when (`stopSet`); a compile's decision records, its receiving completion's included (`decisionRecords`); and a
 * stopped plan's part checks against the natural plan's (`partProblems`, #1682). A test or generator that needs another
 * projection adds it here.
 *
 * The code lives in the modules beside this one (`type-core-oracles-*.ts`). This entry re-exports what the tests and
 * the runners read of them, as the runners load each tree's library by this path
 * (`dist/tests/helpers/type-core-oracles.js`); a new projection goes into its module and is re-exported here.
 */

export { MODES, inOrder, inMode } from "./type-core-oracles-modes.js";
export type { Mode } from "./type-core-oracles-modes.js";
export {
  stopIdentity,
  sentences,
  keptErrors,
  mergedIdentity,
  stoppedRecord,
  stopSet,
} from "./type-core-oracles-stops.js";
export type { StopSet } from "./type-core-oracles-stops.js";
export {
  publishedAnswers,
  itemText,
  QUESTION_UNITS_PER_CELL,
  QUESTION_BYTES_PER_CELL,
  questionRoomOf,
  withQuestionMemory,
  withQuestionBound,
  questionWork,
  occurrences,
  publishedUpToOrder,
  orderedNames,
  everyAnswer,
  ingressAnswers,
  orderedItems,
  replayAnswer,
  settledAnswers,
} from "./type-core-oracles-answers.js";
export type { UnansweredBy, QuestionHeap } from "./type-core-oracles-answers.js";
export {
  jsonText,
  publishedRoute,
  publicationParts,
  publicationHashes,
  publication,
} from "./type-core-oracles-publication.js";
export type { PublicationParts, PublicationHashes } from "./type-core-oracles-publication.js";
export {
  requireRecords,
  decisionKey,
  decisionsByKey,
  decisionOf,
  decisionRecords,
} from "./type-core-oracles-decisions.js";
export type { DecisionRecords, DecisionRecordKind } from "./type-core-oracles-decisions.js";
export { partProblems } from "./type-core-oracles-part-checks.js";
