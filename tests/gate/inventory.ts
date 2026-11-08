import type {
  FormField,
  InteractionTemporalKind,
  InteractionUiPayload,
} from "../../src/plan/model.js";
import type {
  RuntimeLockActionSnapshot,
  RuntimePendingActionSnapshot,
} from "../../src/runtime/actions/model.js";
import type { ActionCompletedEvent, InterpreterEvent } from "../../src/runtime/events.js";
import { CANDIDATE_OPS, type CandidateOp } from "./candidates.js";
import { OUTCOMES, UnfamiliarResult } from "./outcomes.js";
import type { TapeEntry } from "./tape.js";

/*
 * What a tape met, read from its recorded replies rather than from the proposals that made them: every action kind its
 * publications show in the foreground or the background (an interaction by its UI kind, a temporal one by its temporal
 * kind, a form's field kinds, a lock by its phase), every event kind, every settlement its `actionCompleted` events
 * report, and every op it got accepted. `MECHANISMS` is the complete list, each part checked against its runtime type by
 * `satisfies`, so a census can name what no tape met.
 */

type ShownKind =
  | Exclude<RuntimePendingActionSnapshot["kind"], "interaction" | "lock">
  | `interaction:${Exclude<InteractionUiPayload["kind"], "temporal">}`
  | `interaction:temporal:${InteractionTemporalKind}`
  | `form field:${FormField["kind"]}`
  | `lock:${RuntimeLockActionSnapshot["phase"]}`;
type Settlement = ActionCompletedEvent["settlement"];
type SettlementKey<S> = S extends {
  readonly actionKind: infer A extends string;
  readonly settlementKind: infer K extends string;
}
  ? S extends { readonly outcome: infer O extends string }
    ? `${A}:${K}:${O}`
    : `${A}:${K}`
  : never;

const SHOWN = {
  delay: true,
  chatPacingGate: true,
  mediaPlayback: true,
  storageWrite: true,
  capture: true,
  fileStore: true,
  timer: true,
  media: true,
  permanentButton: true,
  "interaction:button": true,
  "interaction:text": true,
  "interaction:number": true,
  "interaction:temporal:date": true,
  "interaction:temporal:time": true,
  "interaction:temporal:datetime": true,
  "interaction:password": true,
  "interaction:choice": true,
  "interaction:popup": true,
  "interaction:url": true,
  "interaction:export": true,
  "interaction:image": true,
  "interaction:form": true,
  "form field:boolean": true,
  "form field:cycle": true,
  "form field:integer": true,
  "form field:number": true,
  "form field:text": true,
  "form field:date": true,
  "form field:time": true,
  "form field:datetime": true,
  "lock:work": true,
  "lock:ask": true,
} as const satisfies Record<ShownKind, true>;
const EVENTS = {
  say: true,
  messageUpdated: true,
  messageRemoved: true,
  exit: true,
  actionRequested: true,
  actionCompleted: true,
  playerTranscript: true,
  permanentButtonPressed: true,
  developerWarning: true,
  runtimeFailure: true,
  scriptStorageEdited: true,
} as const satisfies Record<InterpreterEvent["kind"], true>;
const SETTLEMENTS = {
  "delay:completed": true,
  "interaction:completed": true,
  "interaction:timedOut": true,
  "chatPacingGate:completed": true,
  "chatPacingGate:skipped": true,
  "mediaPlayback:completed:loaded": true,
  "mediaPlayback:completed:finished": true,
  "mediaPlayback:completed:stopped": true,
  "mediaPlayback:completed:failed": true,
  "storageWrite:completed:stored": true,
  "storageWrite:completed:failed": true,
  "capture:completed": true,
  "fileStore:completed:stored": true,
  "fileStore:completed:read": true,
  "fileStore:completed:hashed": true,
  "fileStore:completed:failed": true,
  "lock:completed:locked": true,
  "lock:completed:opened": true,
  "lock:completed:notOpened": true,
  "lock:completed:unreadable": true,
  "lock:completed:failed": true,
  "lock:completed:ask": true,
  "lock:completed:submitted": true,
  "lock:completed:cancelled": true,
  "timer:finished": true,
  "timer:stopped": true,
  "media:finished": true,
  "media:stopped": true,
  "permanentButton:removed": true,
} as const satisfies Record<SettlementKey<Settlement>, true>;

/** A settlement's key: its action kind, its settlement kind and its outcome, when it has one. */
const settlementKey = (settlement: Settlement): string =>
  [
    settlement.actionKind,
    settlement.settlementKind,
    "outcome" in settlement ? settlement.outcome : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(":");

const prefixed = (prefix: string, keys: Readonly<Record<string, true>>) =>
  Object.keys(keys).map((key) => `${prefix} ${key}`);

/** Every mechanism a tape can meet, by its inventory key. */
export const MECHANISMS: readonly string[] = [
  ...prefixed("shown", SHOWN),
  ...prefixed("event", EVENTS),
  ...prefixed("settlement", SETTLEMENTS),
  ...CANDIDATE_OPS.map((op) => `accepted ${op}`),
];

const shownKind = (action: RuntimePendingActionSnapshot): ShownKind => {
  if (action.kind === "lock") return `lock:${action.phase}`;
  if (action.kind !== "interaction") return action.kind;
  return action.ui.kind === "temporal"
    ? `interaction:temporal:${action.ui.temporalKind}`
    : `interaction:${action.ui.kind}`;
};

interface Publication {
  readonly state?: {
    readonly foregroundAction: RuntimePendingActionSnapshot | null;
    readonly backgroundActions: readonly RuntimePendingActionSnapshot[];
  };
  readonly events?: readonly InterpreterEvent[];
}

/** Whether `result` accepted `op`; a result the op's reading does not know (a harness error's) accepted nothing. */
function accepted(op: CandidateOp, result: unknown): boolean {
  try {
    return OUTCOMES[op](result).accepted;
  } catch (error) {
    if (error instanceof UnfamiliarResult) return false;
    throw error;
  }
}

const CANDIDATE_OP_NAMES: readonly string[] = CANDIDATE_OPS;
const isCandidateOp = (op: string): op is CandidateOp => CANDIDATE_OP_NAMES.includes(op);

/** The mechanisms `entries` met, sorted, by their `MECHANISMS` keys. */
export function inventoryOf(entries: readonly TapeEntry[]): string[] {
  const met = new Set<string>();
  for (const entry of entries) {
    if (!entry.reply.ok) continue;
    // EVIDENCE: validation: a reply's view is a bridge publication from the same build.
    const view = entry.reply.view as Publication | null;
    const actions = [
      view?.state?.foregroundAction ?? null,
      ...(view?.state?.backgroundActions ?? []),
    ];
    for (const action of actions) {
      if (action === null) continue;
      met.add(`shown ${shownKind(action)}`);
      if (action.kind === "interaction" && action.ui.kind === "form")
        for (const field of action.ui.fields) met.add(`shown form field:${field.kind}`);
    }
    for (const event of view?.events ?? []) {
      met.add(`event ${event.kind}`);
      if (event.kind === "actionCompleted")
        met.add(`settlement ${settlementKey(event.settlement)}`);
    }
    if (isCandidateOp(entry.op) && accepted(entry.op, entry.reply.result))
      met.add(`accepted ${entry.op}`);
  }
  return [...met].sort();
}
