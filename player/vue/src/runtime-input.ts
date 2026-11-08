import type { DebugAnswerInput } from "../../debug-export.js";
import type { PlayerRuntimeControlResult } from "../../runtime-adapter.js";
import type { PlayerSession } from "../../runtime-view.js";
import type { SectionWork } from "./useRuntimeSceneClock.js";

/*
 * The player's input over the engine's bridge (the L5 series, L5c): the chain `RuntimeInteraction` runs for an answer,
 * and the op each control answers with. The chain is one section of the shown session: the clock observes the session at
 * its now (the `inputAnswer` row), then the chain checks that the session still owns the UI and that the action the player acted on is still presented,
 * runs the main side's own effect (a URL's tab), and posts the op. Each step runs only while the session owns the UI, so a
 * replaced, stopped or unmounted session never opens its tab or receives its answer.
 */

/** What an input op replies: the engine's outcome of the answer. */
export type InputOutcome = PlayerRuntimeControlResult["outcome"];

/** What `send` resolves with when the section's session no longer owns the UI, or the host refused it as stopped. */
export const RETIRED: unique symbol = Symbol("retired");

/** A section of the shown session, for input (`usePlayerSession`'s `inputSection`). */
export interface InputSection {
  /** Whether the section's session still owns the UI. */
  owned(): boolean;
  /** Posts one op of the session while it owns the UI; its publication shows as the Player's publications do. */
  send<R>(op: string, args: unknown): Promise<R | typeof RETIRED>;
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

/** What a control answers on the observed session: its op and arguments, or `null` when it answers nothing there. */
export interface InputAnswer {
  readonly op: string;
  readonly args: Readonly<Record<string, unknown>>;
  /**
   * The main side's work between the checks and the op, such as opening a URL's tab: synchronous, after the
   * observation, only while the session owns the UI. `false` sends nothing.
   */
  readonly effect?: () => boolean;
  /** Settles what the answer took along, with the op's outcome, or `null` when it was not posted or was refused. */
  readonly settle?: (outcome: InputOutcome | null) => void;
}
export type InputIntent = (observed: PlayerSession) => InputAnswer | null;

export type InputResult =
  /** The session no longer owns the UI, or the host refused the op as stopped: nothing to show, no feedback. */
  | { readonly kind: "retired" }
  /** Another action is presented than the one the player acted on. */
  | { readonly kind: "unavailable" }
  /** The control answers nothing there: a text that matches no button, a blocked tab. */
  | { readonly kind: "unanswered" }
  | { readonly kind: "answered"; readonly session: PlayerSession; readonly outcome: InputOutcome };

/** The op `op`, with `args` read when the intent runs, after the observation, as today's operation read them. */
const answer = (
  op: string,
  args: () => Readonly<Record<string, unknown>> = () => ({}),
  input?: DebugAnswerInput | null,
): InputIntent => {
  return () => ({ op, args: input === undefined ? args() : { ...args(), input } });
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
    const outcome = await input.send<InputOutcome | null>("draftForm", { ...target, text });
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
    const outcome = await input.send<InputOutcome | null>(chosen.op, {
      ...chosen.args,
      actionId: presented,
    });
    chosen.settle?.(outcome === RETIRED ? null : outcome);
    if (outcome === RETIRED || !input.owned()) return { kind: "retired" } as const;
    if (outcome === null) return { kind: "unanswered" } as const;
    return { kind: "answered", session: input.session, outcome } as const;
  });
  return result ?? { kind: "retired" };
}
