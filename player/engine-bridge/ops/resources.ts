import type { ActionCompletionOutcome } from "../../../src/playback.js";
import {
  answerPlayerRuntimeCapture,
  answerPlayerRuntimeFileStore,
  answerPlayerRuntimeLock,
  type PlayerCaptureAnswer,
  type PlayerFileStoreAnswer,
  type PlayerLockAnswer,
  type PlayerRuntimeControlResult,
  type PlayerRuntimeSession,
} from "../../runtime/runtime-adapter.js";
import type { CapturedMediaAdmission } from "../../../src/runtime/actions/capture.js";
import { exactly, isRecord } from "../argument-checks.js";
import { admissionOf, isHeldMedia, type HeldMedia } from "../held-media.js";
import type { PlayerOpsContext } from "../player-ops.js";
import type { BridgeOp, BridgeOps } from "../worker-host.js";
import { publishing, sessionOp } from "./session.js";

/** What an answer op takes: the action it answers, the answer, and what the Player's store holds of its references. */
interface AnswerArguments<A> {
  readonly actionId: number;
  readonly answer: A;
  /** `null` for an answer the Player gives without its store, as the fallback answers. */
  readonly held: HeldMedia | null;
}

/** A capture answer as `isCaptureAnswer` admits it: the engine decides the reason. */
type CaptureAnswerShape =
  | { readonly kind: "captured"; readonly reference: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * A capture answer, exactly: the adapter turns any other kind into an unavailable camera and drops other keys, so the
 * engine could not refuse it. The engine still decides which references and reasons it admits.
 */
const isCaptureAnswer = (answer: Record<string, unknown>): answer is CaptureAnswerShape =>
  (answer.kind === "captured" &&
    exactly(answer, ["kind", "reference"]) &&
    typeof answer.reference === "string") ||
  (answer.kind === "unavailable" &&
    exactly(answer, ["kind", "reason"]) &&
    typeof answer.reason === "string");

/**
 * An op that answers a pending action with `answer` and continues on success; a refusal changes nothing and keeps the
 * earlier basis accepted. File store and lock answers reach the engine as their payload, which it validates.
 */
function answerOp<A, C extends Record<string, unknown> = Record<string, unknown>>(
  checkAnswer: ((answer: Record<string, unknown>) => answer is C) | (() => true),
  answer: (
    session: PlayerRuntimeSession,
    actionId: number,
    answer: A,
    capturedMedia: CapturedMediaAdmission | undefined,
  ) => PlayerRuntimeControlResult<ActionCompletionOutcome>,
): BridgeOp {
  return sessionOp(
    (
      args,
    ): args is { readonly actionId: number; readonly answer: C; readonly held: HeldMedia | null } =>
      isRecord(args) &&
      exactly(args, ["actionId", "answer", "held"]) &&
      typeof args.actionId === "number" &&
      Number.isSafeInteger(args.actionId) &&
      args.actionId >= 0 &&
      isRecord(args.answer) &&
      checkAnswer(args.answer) &&
      (args.held === null || isHeldMedia(args.held)),
    (held, args) => {
      // EVIDENCE: validation: checkArguments accepted these arguments before run.
      const { actionId, answer: given, held: media } = args as AnswerArguments<A>;
      held.endCatchUp();
      const result = answer(
        held.sessionForOperation(),
        actionId,
        given,
        media === null ? undefined : admissionOf(media),
      );
      return publishing(held, result.session, result.outcome);
    },
  );
}

/** The ops of family L5e (the L5 series): capture, file store and lock answers. */
export function resourceOps(_context: PlayerOpsContext): BridgeOps {
  return {
    answerCapture: answerOp<PlayerCaptureAnswer, CaptureAnswerShape>(
      isCaptureAnswer,
      answerPlayerRuntimeCapture,
    ),
    answerFileStore: answerOp<PlayerFileStoreAnswer>(
      (): true => true,
      answerPlayerRuntimeFileStore,
    ),
    answerLock: answerOp<PlayerLockAnswer>((): true => true, answerPlayerRuntimeLock),
  };
}
