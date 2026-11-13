// The runtime library that emitted programs call (research code of the JavaScript-route study; never merged, and
// nothing in src/ imports it). It is the EvaluationContext today's helpers take, so every fault, message and draw is
// today's: the emitted code inlines only the fast cases and calls these for everything else.
import { lazyDefaultCallOperation } from "../../dist/src/plan/expression-children.js";
import {
  acceptedDefault,
  noSpeaker,
  rangeBound,
  templateText,
  unitDuration,
} from "../../dist/src/runtime/evaluator.js";
import { haltForExit } from "../../dist/src/runtime/engine.js";
import { randomIntegerInRange } from "../../dist/src/runtime/evaluation/draws.js";
import { loweredLogicalOperator } from "../../dist/src/runtime/evaluation/lowered-operands.js";
import { notBoolean, notLogicalOperand } from "../../dist/src/runtime/evaluation/operators.js";
import { notIndexable } from "../../dist/src/runtime/evaluation/access.js";
import { fault } from "../../dist/src/runtime/evaluation/support.js";
import {
  declaredSpeaker,
  interpolationText,
  outputSpeaker,
  speakerById,
  textSayText,
} from "../../dist/src/runtime/evaluation/speakers.js";
import { callTooDeep } from "../../dist/src/runtime/instructions/functions.js";
import { forLoopSource } from "../../dist/src/runtime/instructions/loops.js";
import {
  checkedSpeakerProperty,
  contextualSpeakerValue,
  emitEvaluatedSay,
  finishSay,
  preparedSpeakerValue,
  readPreparedSpeaker,
  sayStage,
} from "../../dist/src/runtime/instructions/say.js";
import { resolveMessagePresentation } from "../../dist/src/runtime/message-presentation.js";
import { endWithoutCall } from "../../dist/src/runtime/operations/transfers.js";
import { assertCounterCanAdvance } from "../../dist/src/runtime/operations/support.js";
import { assertFallbackType, assertValueType } from "../../dist/src/runtime/values/value-types.js";
import { isRange } from "../../dist/src/runtime/values/value-predicates.js";
import { rangeLength } from "../../dist/src/range-checks.js";
import { copySpan } from "../../dist/src/plan/source-location.js";
import { referencePlaceLabel } from "../../dist/src/runtime/evaluation/support.js";
import {
  assertNativeIndexable,
  nativeIndexRead,
  nativeListPosition,
  nativeProperty,
  shown,
} from "../../dist/src/runtime/native/operations/access.js";
import { NEEDS_DEFAULT, nativeCall } from "../../dist/src/runtime/native/operations/calls.js";
import { nativeBinary, nativeUnary } from "../../dist/src/runtime/native/operations/operators.js";
import { fromCanonical } from "../../dist/src/runtime/native/values/codec.js";
import { copyNativeValue } from "../../dist/src/runtime/native/values/copy.js";
import { nativeEquals } from "../../dist/src/runtime/native/values/equality.js";
import { NativeDict, NativeObject, NativeSet } from "../../dist/src/runtime/native/values/native-value.js";

/** Thrown to unwind the program when it waits at a wait the session has not settled; the drive ends there. */
export const SUSPEND = Symbol("suspend");
/** Thrown to unwind the program after `exit`. */
export const EXIT = Symbol("exit");

export class Runtime {
  constructor(plan, snapshot, session) {
    this.plan = plan;
    this.snapshot = snapshot;
    this.trace = null;
    this.control = null;
    this.capabilities = {};
    this.drawId = 0;
    this.startValue = null;
    this.events = [];
    this.globals = [];
    this.depth = 0;
    /** The labels of prepared references by temporary, as `referencePlaceLabel` gives them. */
    this.referenceLabels = [];
    this.session = session;
    this.NEEDS = NEEDS_DEFAULT;
  }

  preparedReferenceLabel(temporaryId) {
    return this.referenceLabels[temporaryId] ?? null;
  }

  // Values.
  copy(value) {
    return copyNativeValue(value);
  }
  eq(a, b) {
    return nativeEquals(a, b);
  }
  bin(expression, a, b) {
    return nativeBinary(this, expression, a, b);
  }
  binChecked(expression, a, b) {
    const value = nativeBinary(this, expression, a, b);
    if (expression.fallbackCheck !== undefined)
      assertFallbackType(shown(value), expression.fallbackCheck, expression.right.span);
    return value;
  }
  unary(expression, v) {
    return nativeUnary(this, expression, v);
  }
  notLogical(expression, value) {
    return notLogicalOperand(expression.operator, expression.left, shown(value), this.plan);
  }
  notBool(plan, value) {
    return notBoolean("A condition must be true or false (boolean)", plan, shown(value), plan.span, this.plan);
  }
  notLoweredLogical(temporaryId, plan, value) {
    return notLogicalOperand(loweredLogicalOperator(this.plan, temporaryId), plan, shown(value), this.plan);
  }
  indexable(receiver, value, span) {
    assertNativeIndexable(this, receiver, value, span);
    return true;
  }
  index(expression, object, index) {
    return nativeIndexRead(this, expression, expression.object, object, index);
  }
  prop(value, name, span) {
    return nativeProperty(value, name, span);
  }
  list(...items) {
    return items;
  }
  object(entries) {
    const object = new NativeObject();
    for (let i = 0; i < entries.length; i += 2) object.properties.set(entries[i], entries[i + 1]);
    return object;
  }
  interp(text, value, plan, span) {
    return templateText(text, interpolationText(this, shown(value), plan), span);
  }
  text(text, part, span) {
    return templateText(text, part, span);
  }
  range(expression, start, end) {
    return Object.freeze({
      kind: "range",
      start: rangeBound(expression, "start", shown(start), this.plan),
      end: rangeBound(expression, "end", shown(end), this.plan),
      inclusive: expression.inclusive,
    });
  }
  unit(expression, value) {
    return fromCanonical(unitDuration(expression, shown(value)));
  }
  typeCheck(value, check, span) {
    assertValueType(shown(value), check, span);
    return value;
  }
  failNoSpeaker(span) {
    throw noSpeaker(span);
  }
  throwIt(error) {
    throw error;
  }
  fallbackCheck(value, check, span) {
    assertFallbackType(shown(value), check, span);
    return value;
  }
  unset(name) {
    throw new Error(`study: a read of '${name}' before it has a value is not emitted`);
  }

  // Calls.
  call(expression, receiver, positional, named, lazy) {
    return nativeCall(this, expression, receiver, positional, named, lazy);
  }
  acceptDefault(expression, value, fallbackSpan) {
    acceptedDefault(
      lazyDefaultCallOperation(expression),
      shown(value),
      expression.typeCheck,
      fallbackSpan,
      expression.fallbackCheck,
    );
    return value;
  }
  randRange(expression, name, range) {
    if (!isRange(range))
      return nativeCall(this, expression, null, [range], {}, false);
    return randomIntegerInRange(this, range, expression.span, `${name}(range)`, name);
  }
  enter(span) {
    const snapshot = this.snapshot;
    if (this.depth >= snapshot.maxCallDepth) throw callTooDeep(snapshot.maxCallDepth, span);
    assertCounterCanAdvance(snapshot.nextCallFrameId, "nextCallFrameId");
    snapshot.nextCallFrameId += 1;
    this.depth += 1;
  }

  // Loops.
  forRange(instruction, value) {
    const source = forLoopSource(this.plan, instruction, shown(value));
    if (!isRange(source)) throw new Error("study: a 'for' loop over a list, set or dict is not emitted yet");
    return rangeLength(source);
  }

  // Stores.
  storeIndex(target, object, index, value) {
    if (object instanceof NativeSet) throw notIndexable(this, "TSR004", target.object, shown(object), target.span);
    if (object instanceof NativeDict) throw new Error("study: a store into a dict is not emitted yet");
    if (!Array.isArray(object)) throw notIndexable(this, "TSR005", target.object, shown(object), target.span);
    object[nativeListPosition(this, object, target.object, target.index, index, "assign")] = value;
  }
  checkIndexStore(target, object, index) {
    if (object instanceof NativeSet) throw notIndexable(this, "TSR004", target.object, shown(object), target.span);
    if (object instanceof NativeDict) throw new Error("study: a store into a dict is not emitted yet");
    if (!Array.isArray(object)) throw notIndexable(this, "TSR005", target.object, shown(object), target.span);
    nativeListPosition(this, object, target.object, target.index, index, "assign");
  }
  refLabel(temporaryId, rootName, steps) {
    this.referenceLabels[temporaryId] = referencePlaceLabel(rootName, steps);
  }

  // Speakers and say.
  declareSpeaker(instruction, index) {
    const snapshot = this.snapshot;
    assertCounterCanAdvance(snapshot.nextSpeakerId, "nextSpeakerId");
    const speaker = { id: snapshot.nextSpeakerId, identifier: instruction.name, properties: [] };
    snapshot.nextSpeakerId += 1;
    snapshot.speakers.push(speaker);
    this.globals[index] = Object.freeze({
      kind: "speakerReference",
      speakerId: speaker.id,
      identifier: instruction.name,
    });
    for (const property of instruction.properties) {
      if (property.value.kind !== "literal") throw new Error("study: a computed speaker property is not emitted");
      speaker.properties.push({
        name: property.name,
        value: checkedSpeakerProperty(property.name, property.value.value, property.span),
      });
    }
  }
  speakerOf(name, value, span) {
    return declaredSpeaker(this, name, value === undefined ? undefined : shown(value), span);
  }
  setDefaultSpeaker(name, value, span) {
    this.snapshot.defaultSpeaker = this.speakerOf(name, value, span).id;
  }
  prepareSaySpeaker(instruction, value) {
    const snapshot = this.snapshot;
    const span = instruction.span;
    const speaker =
      instruction.speaker === null
        ? snapshot.defaultSpeaker === null
          ? null
          : speakerById(this, snapshot.defaultSpeaker, span)
        : this.speakerOf(instruction.speaker, value, span);
    const output = speaker === null ? null : outputSpeaker(this, speaker, span, this.events);
    return fromCanonical(preparedSpeakerValue(speaker, output));
  }
  contextualSpeaker(instruction, prepared) {
    return fromCanonical(contextualSpeakerValue(this, shown(prepared), instruction.span));
  }
  /**
   * A say, on today's stage (`sayStage`), as the native engine runs it. `parts` evaluates the say's expressions on the
   * stage: { speakerValue, prepared, presentation, value, pacing }. Gives true when the say waits.
   */
  say(instruction, parts, place) {
    const session = this.snapshot;
    const drive = this.events;
    const span = instruction.span;
    const staged = sayStage(instruction, session);
    const events = [];
    this.snapshot = staged;
    this.events = events;
    try {
      const got = parts();
      let prepared;
      if (instruction.speakerTemporary === undefined) {
        const speaker =
          instruction.speaker === null
            ? staged.defaultSpeaker === null
              ? null
              : speakerById(this, staged.defaultSpeaker, span)
            : this.speakerOf(instruction.speaker, got.speakerValue, span);
        prepared = {
          output: speaker === null ? null : outputSpeaker(this, speaker, span, events),
          speakerId: speaker?.id ?? null,
        };
      } else prepared = readPreparedSpeaker(shown(got.prepared), span);
      const speaker = prepared.speakerId === null ? null : speakerById(this, prepared.speakerId, span);
      const presentation = resolveMessagePresentation(
        got.presentation === undefined ? null : shown(got.presentation),
        speaker,
        copySpan(span),
      );
      const authoredText = textSayText(this, shown(got.value), instruction.value.span);
      if (authoredText === undefined) throw new Error("study: a say of a value shown in notation is not emitted");
      const pacingValue = typeof instruction.pacing === "object" ? shown(got.pacing) : instruction.pacing;
      staged.nextInstruction = place.pc;
      const said = emitEvaluatedSay(instruction, staged, events, session, {
        output: prepared.output,
        speaker,
        presentation,
        authoredText,
        pacingValue,
      });
      finishSay(staged, events, span, said, place);
    } finally {
      this.snapshot = session;
      this.events = drive;
    }
    Object.assign(session, staged);
    session.contextualSpeaker = null;
    for (const event of events) drive.push(event);
    return session.status === "waiting";
  }
  /** At a wait the program reached: true when the session settled it (the program goes on), else the drive ends. */
  waited() {
    if (this.session.settle(this)) return;
    throw SUSPEND;
  }
  exit(span, pc) {
    this.snapshot.nextInstruction = pc;
    haltForExit(this.snapshot, span, this.events);
    throw EXIT;
  }
  end(span) {
    throw endWithoutCall(span);
  }
  fault(code, message, span) {
    return fault(code, message, span);
  }
}
