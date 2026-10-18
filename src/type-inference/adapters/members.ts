import type { ValueKind } from "../../value-kinds.js";
import * as clockTemporal from "./clock-temporal.js";
import * as collections from "./collections.js";
import * as handles from "./handles.js";
import type {
  OperandView,
  OperationInputs,
  OperationRelation,
  OperationResult,
} from "./relation.js";
import * as text from "./text.js";
import {
  alternativesOf,
  byReceiver,
  dynamicFrom,
  dynamicResult,
  INVALID,
  isBottom,
  kindsOf,
  UNCONSTRAINED,
  type MemberAnswer,
  type MemberRules,
} from "./views.js";

/**
 * The `method` family, and the property reads stage 3 resolves: the member rules of each receiver kind, composed
 * over a receiver that may be of several kinds. Every kind must have the member (ADR 0021 rule 3.5), except a
 * speaker beside kinds that have it, whose case the runtime checks.
 */
const RULES: readonly MemberRules[] = [
  collections.MEMBER_RULES,
  text.MEMBER_RULES,
  handles.MEMBER_RULES,
  clockTemporal.MEMBER_RULES,
];

function rulesFor(kind: ValueKind): MemberRules | undefined {
  return RULES.find((rules) => rules.kinds.includes(kind));
}

/** A member of a receiver the contract knows nothing about: a speaker, or a value the compiler cannot know. */
const UNKNOWN_MEMBER: OperationResult = dynamicResult("unknown member");

/** Reading `name` on a receiver of `kind`: held, computed, or no such member. */
export function memberOf(
  kind: ValueKind,
  name: string,
  receiver: OperandView,
): MemberAnswer | undefined {
  if (kind === "speaker") return UNKNOWN_MEMBER;
  return rulesFor(kind)?.property(kind, name, receiver);
}

/** The `method.<name>` relation: the receiver's kinds decide, as `memberMethodType` does for each member. */
export function methodRelation(name: string): OperationRelation {
  return {
    contract: { family: "method", name },
    result(inputs: OperationInputs): OperationResult {
      const receiver = inputs.receiver;
      if (receiver === null) return INVALID;
      if (isBottom(receiver)) return UNCONSTRAINED;
      const kinds = kindsOf(receiver);
      if (kinds.length === 0) return dynamicFrom(receiver, "unknown member");
      const answers = kinds.map((kind) => ({
        kind,
        result: kind === "speaker" ? undefined : rulesFor(kind)?.method(kind, name, inputs),
      }));
      const supported = answers.filter((answer) => answer.result !== undefined);
      // A receiver that may also hold data the compiler cannot know is never rejected here (the legacy holds it as
      // unknown): a kind without the method is the runtime's to check, as a speaker is.
      if (receiver.dynamic === null) {
        // A speaker alone has no methods; beside a kind that has the method, the runtime checks the speaker.
        if (supported.length === 0) return INVALID;
        if (answers.some((answer) => answer.kind !== "speaker" && answer.result === undefined))
          return INVALID;
      }
      // A kind's rule that still waits for an operand it reads makes the whole wait (the read-order rule, §3).
      if (answers.some((answer) => answer.result?.kind === "unconstrained")) return UNCONSTRAINED;
      const cases = answers.map((answer) => ({
        receiver: answer.kind,
        result: answer.result ?? UNKNOWN_MEMBER,
      }));
      const composed = byReceiver(cases);
      return receiver.dynamic === null
        ? composed
        : alternativesOf(composed, dynamicResult(receiver.dynamic));
    },
  };
}
