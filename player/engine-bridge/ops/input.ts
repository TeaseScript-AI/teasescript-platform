import type { DebugAnswerInput } from "../../debug/debug-export.js";
import {
  activatePlayerRuntimeButton,
  answeredByPlayerInput,
  answerPlayerRuntimeImage,
  applyPlayerRuntimeStorageEdit,
  cancelPlayerRuntimeForm,
  clearPlayerRuntimeFormField,
  closePlayerRuntimeExport,
  closePlayerRuntimePopup,
  completePlayerRuntimeStorageWrite,
  dismissPlayerRuntimeFormField,
  draftPlayerRuntimeForm,
  openPlayerRuntimeUrl,
  pressPlayerRuntimePermanentButton,
  selectPlayerRuntimeChoice,
  skipPlayerRuntimeImage,
  stepPlayerRuntimeFormField,
  submitPlayerRuntimeComposer,
  submitPlayerRuntimeForm,
  type PlayerRuntimeSession,
} from "../../runtime/runtime-adapter.js";
import { activePlayerRuntimeInteraction } from "../../runtime/runtime-view.js";
import type { SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import { exactly, isRecord } from "../argument-checks.js";
import { admissionOf, isHeldMedia, type HeldMedia } from "../held-media.js";
import type { PlayerOpsContext } from "../player-ops.js";
import type { BridgeOps, OpOutcome } from "../worker-host.js";
import { sessionOp, type HeldSession } from "./session.js";

/*
 * The ops of family L5c (the L5 series), input and storage: the player's answers to the presented interaction, the
 * permanent buttons, and the script's storage writes and Debug's storage edits. None reads a basis: an input's staleness
 * is its action ID, which the host checks against the presented action as today's target check does, and the engine's
 * own checks decide the rest at the state the op runs on, as today's synchronous call did.
 */

// How the player answered, which the recorder keeps (`answeredByPlayerInput`); a kind missing here fails to compile.
const INPUT_SET = { enter: true, send: true, button: true, preselectedKey: true } satisfies Record<
  DebugAnswerInput,
  true
>;
const isInput = (value: unknown): value is DebugAnswerInput | null =>
  value === null || (typeof value === "string" && Object.hasOwn(INPUT_SET, value));
const isDraft = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/** What an adapter op returns: a session and its outcome, or `null` when it answers nothing there. */
type Answer = { readonly session: PlayerRuntimeSession; readonly outcome: unknown } | null;

/**
 * Applies an adapter op's result (`HeldSession.adoptResult`): no answer adopts nothing, and a new revision also ends a
 * late observation's catch-up, as input moves the session on.
 */
function answered(held: HeldSession, result: Answer): OpOutcome {
  if (result === null) return { result: null, view: null };
  const adoption = held.adoptResult(result.session);
  if (adoption.kind !== "published") return { result: result.outcome, view: null };
  held.endCatchUp();
  return {
    result: result.outcome,
    eventsThrough: adoption.view.eventsThrough,
    view: adoption.view,
  };
}

/**
 * An answer to the presented interaction `args.actionId`, with the further arguments `fields` checks. Another presented
 * action is refused as `staleAction` without effect; `input`, when given, is recorded as how the player answered.
 */
function interactionOp<
  F extends Record<string, unknown> = Record<string, unknown>,
  Answers extends boolean = true,
>(
  fields: readonly string[],
  checkFields: ((args: Record<string, unknown>) => args is F) | (() => true),
  run: (session: PlayerRuntimeSession, args: Record<string, unknown>) => Answer,
  answers: Answers | true = true,
) {
  const keys = ["actionId", ...fields, ...(answers ? ["input"] : [])];
  return sessionOp(
    (args): args is InteractionArguments<Answers> & F =>
      isRecord(args) &&
      exactly(args, keys) &&
      typeof args.actionId === "number" &&
      (!answers || isInput(args.input)) &&
      checkFields(args),
    (held, args) => {
      // EVIDENCE: validation: checkArguments accepted these arguments before run.
      const checked = args as Record<string, unknown> & {
        readonly actionId: number;
        readonly input?: DebugAnswerInput | null;
      };
      const { actionId } = checked;
      if (activePlayerRuntimeInteraction(held.sessionForOperation().state)?.actionId !== actionId)
        return { result: { kind: "staleAction", actionId }, view: null };
      const session = held.sessionForOperation();
      const input = checked.input ?? null;
      return answered(
        held,
        input === null
          ? run(session, checked)
          : answeredByPlayerInput(session, input, () => run(session, checked)),
      );
    },
    false,
  );
}

/**
 * What an interaction op's own check admits besides its fields: the action, and, for an op that answers, how the player
 * answered.
 */
type InteractionArguments<Answers extends boolean> = {
  readonly actionId: number;
} & (Answers extends true ? { readonly input: DebugAnswerInput | null } : unknown);

/** The field check of an interaction op without fields: a constant `true`, the one non-predicate a builder accepts. */
const none = (): true => true;

export function inputOps(_context: PlayerOpsContext): BridgeOps {
  return {
    submitComposer: interactionOp(
      ["text"],
      (args): args is { readonly text: string } => typeof args.text === "string",
      (session, args) => {
        // EVIDENCE: validation: checkFields accepted `text` as a string.
        const { text } = args as { readonly text: string };
        return submitPlayerRuntimeComposer(session, text);
      },
    ),
    selectChoice: interactionOp(
      ["optionId"],
      (args): args is { readonly optionId: string } => typeof args.optionId === "string",
      (session, args) => {
        // EVIDENCE: validation: checkFields accepted `optionId` as a string.
        const { optionId } = args as { readonly optionId: string };
        return selectPlayerRuntimeChoice(session, optionId);
      },
    ),
    activateButton: interactionOp([], none, (session) => activatePlayerRuntimeButton(session)),
    stepFormField: interactionOp(
      ["fieldId", "draft"],
      (args): args is { readonly fieldId: string; readonly draft: string | null } =>
        typeof args.fieldId === "string" && isDraft(args.draft),
      (session, args) => {
        // EVIDENCE: validation: checkFields accepted `fieldId` as a string and `draft` as a string or null.
        const { fieldId, draft } = args as {
          readonly fieldId: string;
          readonly draft: string | null;
        };
        return stepPlayerRuntimeFormField(session, fieldId, draft ?? undefined);
      },
      false,
    ),
    dismissFormField: interactionOp([], none, dismissPlayerRuntimeFormField, false),
    clearFormField: interactionOp([], none, clearPlayerRuntimeFormField, false),
    draftForm: interactionOp(
      ["fieldId", "text"],
      (args): args is { readonly fieldId: string; readonly text: string } =>
        typeof args.fieldId === "string" && typeof args.text === "string",
      (session, args) => {
        // EVIDENCE: validation: checkArguments accepted `actionId` as a number, `fieldId` and `text` as strings.
        const { actionId, fieldId, text } = args as {
          readonly actionId: number;
          readonly fieldId: string;
          readonly text: string;
        };
        return draftPlayerRuntimeForm(session, { actionId, fieldId }, text);
      },
      false,
    ),
    submitForm: interactionOp(
      ["draft"],
      (args): args is { readonly draft: string | null } => isDraft(args.draft),
      (session, args) => {
        // EVIDENCE: validation: checkFields accepted `draft` as a string or null.
        const { draft } = args as { readonly draft: string | null };
        return submitPlayerRuntimeForm(session, draft ?? undefined);
      },
    ),
    cancelForm: interactionOp([], none, cancelPlayerRuntimeForm),
    skipImage: interactionOp([], none, skipPlayerRuntimeImage),
    answerImage: interactionOp(
      ["reference", "held"],
      (args): args is { readonly reference: string; readonly held: HeldMedia } =>
        typeof args.reference === "string" && isHeldMedia(args.held),
      (session, args) => {
        // EVIDENCE: validation: checkFields accepted `reference` as a string and `held` with `isHeldMedia`.
        const { reference, held } = args as {
          readonly reference: string;
          readonly held: HeldMedia;
        };
        return answerPlayerRuntimeImage(session, reference, admissionOf(held));
      },
    ),
    openUrl: interactionOp([], none, openPlayerRuntimeUrl),
    closePopup: interactionOp([], none, closePlayerRuntimePopup),
    closeExport: interactionOp([], none, closePlayerRuntimeExport),
    pressPermanentButton: sessionOp(
      (args): args is { readonly buttonId: number } =>
        isRecord(args) && exactly(args, ["buttonId"]) && typeof args.buttonId === "number",
      (held, args) => {
        // EVIDENCE: validation: checkArguments accepted `buttonId` as a number.
        const { buttonId } = args as { readonly buttonId: number };
        return answered(
          held,
          pressPlayerRuntimePermanentButton(held.sessionForOperation(), buttonId),
        );
      },
      false,
    ),
    completeStorageWrite: sessionOp(
      (args): args is { readonly actionId: number; readonly stored: boolean } =>
        isRecord(args) &&
        exactly(args, ["actionId", "stored"]) &&
        typeof args.actionId === "number" &&
        typeof args.stored === "boolean",
      (held, args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { actionId, stored } = args as {
          readonly actionId: number;
          readonly stored: boolean;
        };
        return answered(
          held,
          completePlayerRuntimeStorageWrite(held.sessionForOperation(), actionId, stored),
        );
      },
      false,
    ),
    applyStorageEdit: sessionOp(
      // The engine validates the edit itself (`invalidEdit`), as it does today.
      (args): args is { readonly key: string; readonly value: unknown } =>
        isRecord(args) &&
        exactly(args, ["key", "value"]) &&
        typeof args.key === "string" &&
        "value" in args,
      (held, args) => {
        // EVIDENCE: validation: checkArguments accepted the shape; the engine validates the value.
        const edit = args as { readonly key: string; readonly value: SerializableRuntimeValue };
        const result = applyPlayerRuntimeStorageEdit(held.sessionForOperation(), edit);
        // The edit's mark, in the edit's own host step: the publication that shows the edit carries it.
        if (result.outcome.kind === "applied") held.marksEdited();
        return answered(held, result);
      },
      false,
    ),
  };
}
