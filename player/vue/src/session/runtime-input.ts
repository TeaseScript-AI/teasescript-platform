import type { DebugAnswerInput } from "../../../debug/debug-export.js";
import type { OpArgs, OpResult, SessionOp } from "../../../engine-bridge/op-catalogue.js";
import type { PlayerSession } from "../../../runtime/runtime-view.js";
import type { SectionWork } from "./useRuntimeSceneClock.js";

/*
 * The player's input over the engine's bridge (the L5 series, L5c): the chain `RuntimeInteraction` runs for an answer,
 * and the op each control answers with. The chain is one section of the shown session: the clock observes the session at
 * its now (the `inputAnswer` row), then the chain checks that the session still owns the UI and that the action the player acted on is still presented,
 * runs the main side's own effect (a URL's tab), and posts the op. Each step runs only while the session owns the UI, so a
 * replaced, stopped or unmounted session never opens its tab or receives its answer.
 */

/** What an input op replies: the catalogue's result of the input ops, so no second list of outcomes. */
export type InputOutcome = NonNullable<OpResult<InputOp>>;

/** What `send` resolves with when the section's session no longer owns the UI, or the host refused it as stopped. */
export const RETIRED: unique symbol = Symbol("retired");

/** A section of the shown session, for input (`usePlayerSession`'s `inputSection`). */
export interface InputSection {
  /** Whether the section's session still owns the UI. */
  owned(): boolean;
  /** Posts one op of the session while it owns the UI; its publication shows as the Player's publications do. */
  send<O extends SessionOp>(
    ...call: O extends unknown ? [op: O, args: OpArgs<O>] : never
  ): Promise<OpResult<O> | typeof RETIRED>;
  /** The session's latest publication. */
  readonly session: PlayerSession;
}

/** The clock's section rows (`SectionWork`) that input sections run under. */
export type InputWork = Extract<
  SectionWork,
  "inputAnswer" | "inputDraft" | "storageEdit" | "storageWriteDone"
>;

/**
 * Runs `body` in an input section of the shown session that the clock opens for `work`, with the clock's observation
 * for that row: the session at its now, `null` once it no longer owns the UI (replaced, stopped, unmounted), or the
 * section's session for a row that observes nothing. `null` without a session, or once a Player error stopped it.
 */
export type InputSectionHost = <T>(
  work: InputWork,
  body: (section: InputSection, observed: PlayerSession | null) => Promise<T>,
) => Promise<T | null>;

/** An op a control answers with: a session op that takes the presented action's `actionId`. */
export type InputOp = {
  [O in SessionOp]: OpArgs<O> extends { readonly actionId: number } ? O : never;
}[SessionOp];

/** An input op's arguments but the `actionId` the send inserts (`runInput`). */
export type InputArgs<O extends InputOp> = Omit<OpArgs<O>, "actionId">;

/**
 * What a control answers on the observed session: its op and arguments but `actionId`, each op with its own; or `null`
 * when it answers nothing there.
 */
export type InputAnswer<O extends InputOp = InputOp> = O extends unknown
  ? {
      readonly op: O;
      readonly args: InputArgs<O>;
      /**
       * The main side's work between the checks and the op, such as opening a URL's tab: synchronous, after the
       * observation, only while the session owns the UI. `false` sends nothing.
       */
      readonly effect?: () => boolean;
      /** Settles what the answer took along, with the op's outcome, or `null` when it was not posted or was refused. */
      readonly settle?: (outcome: InputOutcome | null) => void;
    }
  : never;
export type InputIntent = (observed: PlayerSession) => InputAnswer | null;

export type InputResult =
  /** The session no longer owns the UI, or the host refused the op as stopped: nothing to show, no feedback. */
  | { readonly kind: "retired" }
  /** Another action is presented than the one the player acted on. */
  | { readonly kind: "unavailable" }
  /** The control answers nothing there: a text that matches no button, a blocked tab. */
  | { readonly kind: "unanswered" }
  | { readonly kind: "answered"; readonly session: PlayerSession; readonly outcome: InputOutcome };

/** The fields of an input op's arguments that `answer`'s `args` gives: all but `actionId` and `input`. */
type AnswerFields<O extends InputOp> = Omit<InputArgs<O>, "input">;

/**
 * `answer`'s call for each input op, distributed so that an op and its arguments stay paired: `args` where the op has
 * fields besides `actionId` and `input`, and `input` where its arguments require one.
 */
export type AnswerCall<O extends InputOp> = O extends unknown
  ? Record<never, never> extends AnswerFields<O>
    ? InputArgs<O> extends { readonly input: unknown }
      ? [op: O, args: undefined, input: InputArgs<O>["input"]]
      : [op: O, args?: undefined]
    : InputArgs<O> extends { readonly input: unknown }
      ? [op: O, args: () => AnswerFields<O>, input: InputArgs<O>["input"]]
      : [op: O, args: () => AnswerFields<O>]
  : never;

/**
 * The op `op`, with `args` read when the intent runs, after the observation, as today's operation read them; `input`
 * added when given. The call (`AnswerCall`) requires `args` and `input` where the op's arguments do.
 */
const answer = <O extends InputOp>(...[op, args, input]: AnswerCall<O>): InputIntent => {
  return () => {
    const fields = args === undefined ? {} : args();
    // EVIDENCE: invariant: `op`'s arguments, paired by `AnswerCall`, unseen in `args()` and `input` for a generic `O`.
    return { op, args: input === undefined ? fields : { ...fields, input } } as InputAnswer;
  };
};

/** The op each of the Player's controls answers with; `input` is how the player answered, which the recording keeps. */
export const intents = {
  // The values a control submits are those of the click; the composer is read-only while the answer is in flight.
  composer: (text: string, input: DebugAnswerInput) =>
    answer("submitComposer", () => ({ text }), input),
  /** A choice's option, or the button of `showButton` for `null`. */
  choice: (optionId: string | null, input: DebugAnswerInput) =>
    optionId === null
      ? answer("activateButton", undefined, input)
      : answer("selectChoice", () => ({ optionId }), input),
  formStep: (fieldId: string, draft: string | undefined) =>
    answer("stepFormField", () => ({ fieldId, draft: draft ?? null })),
  formSubmit: (draft: string | undefined, input: DebugAnswerInput) =>
    answer("submitForm", () => ({ draft: draft ?? null }), input),
  formCancel: (input: DebugAnswerInput) => answer("cancelForm", undefined, input),
  formDismiss: answer("dismissFormField"),
  formClear: answer("clearFormField"),
  imageSkip: (input: DebugAnswerInput) => answer("skipImage", undefined, input),
  popupClose: (input: DebugAnswerInput) => answer("closePopup", undefined, input),
  exportClose: (input: DebugAnswerInput) => answer("closeExport", undefined, input),
  /** `openUrl`: `open` opens the tab, and the op settles the request only if it did. */
  url:
    (open: (session: PlayerSession) => boolean, input: DebugAnswerInput | null): InputIntent =>
    (observed) => ({ op: "openUrl", args: { input }, effect: () => open(observed) }),
  /** The pacing gate's skip, which takes no `input`. */
  pacing: answer("skipPacing"),
} as const;

/**
 * Stores `text` as the draft of the form field `target`, as the draft timer does: without an observation, as today's
 * has none, and only while the session owns the UI. The session it published once the draft `updated`, or `null`.
 */
export async function draftInput(
  section: InputSectionHost,
  target: { readonly actionId: number; readonly fieldId: string },
  text: string,
): Promise<PlayerSession | null> {
  const drafted = await section("inputDraft", async (input) => {
    if (!input.owned()) return null;
    const outcome = await input.send("draftForm", { ...target, text });
    return outcome !== RETIRED && outcome?.kind === "updated" && input.owned()
      ? input.session
      : null;
  });
  return drafted ?? null;
}

/**
 * `RuntimeInteraction.complete`'s chain in one section: observe, check ownership and that `presented`, the action the
 * player acted on, is still `target`'s, then the intent, its effect, and the op with that action's ID.
 */
export async function runInput(
  section: InputSectionHost,
  presented: number | undefined,
  target: (session: PlayerSession) => number | undefined,
  intent: InputIntent,
): Promise<InputResult> {
  const result = await section("inputAnswer", async (input, observed) => {
    if (observed === null || !input.owned()) return { kind: "retired" } as const;
    if (target(observed) !== presented) return { kind: "unavailable" } as const;
    const chosen = presented === undefined ? null : intent(observed);
    if (chosen === null) return { kind: "unanswered" } as const;
    if (!input.owned()) {
      chosen.settle?.(null);
      return { kind: "retired" } as const;
    }
    if (chosen.effect !== undefined && !chosen.effect()) {
      chosen.settle?.(null);
      return { kind: "unanswered" } as const;
    }
    // `chosen` pairs its op with its arguments but `actionId` (`InputAnswer`), which TypeScript does not see once
    // inserted; the assertion drops only that pairing, and the result stays the input ops' own (`OpResult<InputOp>`).
    // EVIDENCE: invariant: the pair `chosen` holds, with the presented action's ID.
    const outcome = await (
      input as { send(op: InputOp, args: unknown): Promise<OpResult<InputOp> | typeof RETIRED> }
    ).send(chosen.op, { ...chosen.args, actionId: presented });
    chosen.settle?.(outcome === RETIRED ? null : outcome);
    if (outcome === RETIRED || !input.owned()) return { kind: "retired" } as const;
    if (outcome === null) return { kind: "unanswered" } as const;
    return { kind: "answered", session: input.session, outcome } as const;
  });
  return result ?? { kind: "retired" };
}
