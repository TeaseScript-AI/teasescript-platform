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
import { Evaluator } from "../../dist/src/runtime/evaluator.js";
import { executePlannedInstruction, haltForExit } from "../../dist/src/runtime/engine.js";
import { DICT_ACCESS } from "../../dist/src/dict-operations.js";
import { isRepeatCount } from "../../dist/src/loop-rules.js";
import { badRepeatCount } from "../../dist/src/runtime/instructions/loops.js";
import { collectionTooLong, MAX_COLLECTION_LENGTH } from "../../dist/src/runtime/values/collection-size.js";
import { NativeNotImplementedError } from "../../dist/src/runtime/native/operations/not-implemented.js";
import { randomIntegerInRange } from "../../dist/src/runtime/evaluation/draws.js";
import { nextXorShift32 } from "../../dist/src/runtime/random/random.js";
import { loweredLogicalOperator } from "../../dist/src/runtime/evaluation/lowered-operands.js";
import { notBoolean, notLogicalOperand } from "../../dist/src/runtime/evaluation/operators.js";
import { dictKey, notIndexable } from "../../dist/src/runtime/evaluation/access.js";
import { fault, USE_DEFAULT } from "../../dist/src/runtime/evaluation/support.js";
import { callCollection, callDict } from "../../dist/src/runtime/evaluation/collections.js";
import { listMethod } from "../../dist/src/list-methods.js";
import {
  declaredSpeaker,
  interpolationText,
  outputSpeaker,
  speakerById,
  textSayText,
} from "../../dist/src/runtime/evaluation/speakers.js";
import { callTooDeep } from "../../dist/src/runtime/instructions/functions.js";
import { startTimerHandler, timerHandlerDispatchable, returnFromTimerHandler } from "../../dist/src/runtime/operations/timer-handlers.js";
import { executionRunnable, processDueWork } from "../../dist/src/runtime/operations/observe-time.js";
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
/** Thrown by a `goto` to a file: the program's dispatcher starts that file. */
export class Goto {
  constructor(file) {
    this.file = file;
  }
}

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
    this.Goto = Goto;
    this.SUSPEND = SUSPEND;
    /** The closures of the blocks created so far, by function ID (the latest creation of each). */
    this.blocks = new Map();
    /** Part C way (2): the frames a wait saved, innermost first; on resume, the frames to give back, outermost first. */
    this.frames = [];
    this.resumeFrames = [];
    this.resuming = false;
    /** Point 5's check: rounds and calls left before the next look at the clock, and how long a drive may run. */
    this.fuel = 1_000_000;
    this.startedMs = Date.now();
    this.limitMs = 10_000;
    /** Each file's entry instruction, by file index (`emitProgram`). */
    this.fileEntries = [];
    this.NEEDS = NEEDS_DEFAULT;
    /** How many calls and expressions today's evaluator ran for the program (`bridge`). */
    this.bridged = 0;
    this.bridgedInstructions = 0;
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
  /** A property read: an object's own property natively; what the native layer lacks, by today's evaluator. */
  prop(value, name, span, synthetic) {
    if (value instanceof NativeObject) {
      const found = value.properties.get(name);
      if (found !== undefined) return found;
    }
    try {
      return nativeProperty(value, name, span);
    } catch (error) {
      if (!(error instanceof NativeNotImplementedError) || synthetic === undefined) throw error;
      this.bridged += 1;
      return this.bridge(synthetic, [value], -1);
    }
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
    // Not frozen (freezing each range was a fifth of the shot's time); no operation changes a range.
    return ({
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

  // Calls: the native operations, else today's evaluator over the evaluated parts (`bridge`).
  call(expression, synthetic, receiver, args, lazy) {
    const positional = [];
    const named = {};
    let next = 0;
    expression.arguments.forEach((argument, index) => {
      if (index === lazy) return;
      const value = args[next++];
      if (argument.kind === "positional") positional.push(value);
      else named[argument.name] = value;
    });
    try {
      return nativeCall(this, expression, receiver, positional, named, lazy !== -1);
    } catch (error) {
      if (!(error instanceof NativeNotImplementedError) || synthetic === null) throw error;
      this.bridged += 1;
      if (expression.callee.kind === "property" && (Array.isArray(receiver) || receiver instanceof NativeSet || receiver instanceof NativeDict))
        return this.collectionMethod(expression, synthetic, receiver, positional, named, lazy !== -1, args);
      // Today's evaluator would run the lazy default itself, which reads the program.
      if (lazy !== -1) throw error;
      return expression.callee.kind === "property"
        ? this.bridge(synthetic, [receiver, ...args], 0)
        : this.bridge(synthetic, args, -1);
    }
  }
  /**
   * A list, set or dict method by today's collection code, on the receiver's canonical form, whose changes the receiver
   * then takes (today's evaluator works on a copy of a receiver held in a temporary, so `bridge` loses them).
   */
  collectionMethod(expression, synthetic, receiver, positional, named, defaulted, evaluated) {
    const canonical = shown(receiver);
    const evaluator = new Evaluator(this.snapshot, this.capabilities, this.events, this.plan);
    const args = positional.map(shown);
    const shownNamed = Object.fromEntries(Object.entries(named).map(([k, v]) => [k, shown(v)]));
    let result;
    if (receiver instanceof NativeDict) result = callDict(evaluator, canonical, synthetic, args, shownNamed, defaulted);
    else {
      if (expression.indexCheck === true && Array.isArray(receiver) && args.length > 0 && !(typeof args[0] === "number" && Number.isInteger(args[0])))
        return this.bridge(synthetic, [receiver, ...evaluated], 0);
      const added = expression.typeCheck === undefined || expression.callee.name === "get" ? null : { check: expression.typeCheck, span: expression.arguments.at(-1).value.span };
      result = callCollection(evaluator, canonical, synthetic.callee.object, expression.callee.name, args, shownNamed, defaulted, expression.span, added);
    }
    if (receiver instanceof NativeDict || listMethod(expression.callee.name)?.changes !== undefined) syncInPlace(receiver, canonical);
    return result === USE_DEFAULT ? NEEDS_DEFAULT : fromCanonical(result);
  }
  /**
   * Today's evaluator on `synthetic`, an expression whose evaluated parts are temporaries 1e9 + i holding `values` as
   * canonical values; the value at `receiver` (a method's receiver, -1 for none) takes back what the call changed in it.
   */
  bridge(synthetic, values, receiver) {
    const snapshot = this.snapshot;
    const base = snapshot.temporaries.length;
    values.forEach((value, index) => snapshot.temporaries.push({ id: 1e9 + index, value: shown(value) }));
    const evaluator = new Evaluator(snapshot, this.capabilities, this.events, this.plan);
    try {
      return fromCanonical(evaluator.evaluate(synthetic));
    } finally {
      const changed = receiver >= 0 ? snapshot.temporaries[base + receiver].value : null;
      snapshot.temporaries.length = base;
      if (receiver >= 0) syncInPlace(values[receiver], changed);
    }
  }
  /** Today's `evaluateWithoutDefault` on `synthetic` over `values`: [value, whether the default is needed]. */
  withoutDefault(synthetic, values) {
    const snapshot = this.snapshot;
    const base = snapshot.temporaries.length;
    values.forEach((value, index) => snapshot.temporaries.push({ id: 1e9 + index, value: shown(value) }));
    this.bridged += 1;
    try {
      const { needed, value } = new Evaluator(snapshot, this.capabilities, this.events, this.plan).evaluateWithoutDefault(synthetic);
      return [fromCanonical(value), needed];
    } finally {
      snapshot.temporaries.length = base;
    }
  }
  /** A default that ran as instructions, checked as its call checks it (`StoreTemporaryInstruction.defaultOf`). */
  acceptDefaultOf(instruction, value) {
    acceptedDefault(instruction.defaultOf, shown(value), instruction.typeCheck, instruction.value.span, instruction.fallbackCheck);
    return value;
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
  /**
   * `randomInteger(a..b)` with the bounds evaluated: without random control, a trace, a start value or a host random
   * source, one xorshift draw sampled as today's `sampleRangeInteger`; anything else (and every fault) by today's path.
   */
  randInt(expression, name, rangeExpression, start, end) {
    if (this.control === null && this.trace === null && this.startValue === null && this.capabilities.random === undefined &&
      Number.isSafeInteger(start) && Number.isSafeInteger(end)) {
      const length = end - start + (rangeExpression.inclusive ? 1 : 0);
      if (length >= 1 && Number.isSafeInteger(length)) return start + Math.floor(nextXorShift32(this.snapshot.rng) * length);
    }
    return this.randRange(expression, name, this.range(rangeExpression, start, end));
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
  /** What a `for` loop goes through, as it is when the loop starts: a range's start and length, or its own items. */
  forSource(instruction, value) {
    const pair = instruction.valueVariable !== undefined;
    if (!pair && Array.isArray(value)) return { start: 0, length: value.length, items: copyNativeValue(value), values: null };
    if (!pair && value instanceof NativeSet) {
      const items = copyNativeValue(value).items;
      return { start: 0, length: items.length, items, values: null };
    }
    if (value instanceof NativeDict) {
      const keys = [...value.entries.keys()];
      const values = pair ? [...value.entries.values()] : null;
      return { start: 0, length: keys.length, items: keys, values };
    }
    const source = forLoopSource(this.plan, instruction, shown(value));
    if (!isRange(source)) throw new Error("study: forLoopSource accepted an unknown source");
    return { start: source.start, length: rangeLength(source), items: null, values: null };
  }
  repeatCount(expression, value) {
    if (typeof value !== "number" || !isRepeatCount(value)) throw badRepeatCount(expression, shown(value), this.plan);
    return value;
  }

  // Stores.
  storeIndex(target, object, index, value) {
    if (object instanceof NativeSet) throw notIndexable(this, "TSR004", target.object, shown(object), target.span);
    if (object instanceof NativeDict) {
      // A new key is added at the end; an existing key keeps its position.
      const key = dictKey(this, shown(index), target.index);
      if (object.entries.size >= MAX_COLLECTION_LENGTH && !object.entries.has(key))
        throw collectionTooLong("dict", DICT_ACCESS.store.grows, target.span, object.entries.size + 1);
      object.entries.set(key, value);
      return;
    }
    if (!Array.isArray(object)) throw notIndexable(this, "TSR005", target.object, shown(object), target.span);
    object[nativeListPosition(this, object, target.object, target.index, index, "assign")] = value;
  }
  /** A store into an object's existing property, natively; anything else (speakers, handles, faults) by today's engine. */
  storeProperty(target, object, value, requireExisting) {
    if (object instanceof NativeObject && object.properties.has(target.name)) {
      object.properties.set(target.name, value);
      return;
    }
    this.onTemporary(object, (evaluator) => evaluator.assign(target, shown(value), requireExisting));
  }
  checkPropertyStore(target, object) {
    if (object instanceof NativeObject) return;
    this.onTemporary(object, (evaluator) => evaluator.validateAssignmentTarget(target));
  }
  /** Today's evaluator with `value` in temporary 1e9. */
  onTemporary(value, f) {
    const snapshot = this.snapshot;
    const base = snapshot.temporaries.length;
    snapshot.temporaries.push({ id: 1e9, value: shown(value) });
    this.bridged += 1;
    try {
      f(new Evaluator(snapshot, this.capabilities, this.events, this.plan));
    } finally {
      snapshot.temporaries.length = base;
    }
  }
  checkIndexStore(target, object, index) {
    if (object instanceof NativeSet) throw notIndexable(this, "TSR004", target.object, shown(object), target.span);
    if (object instanceof NativeDict) {
      dictKey(this, shown(index), target.index);
      return;
    }
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
    // As today's engine: the speaker's global is in the state too, where today's helpers look a speaker up by name.
    snapshot.globals.push({ name: instruction.name, value: { kind: "speakerReference", speakerId: speaker.id, identifier: instruction.name } });
    for (const property of instruction.properties) {
      if (property.value.kind !== "literal") throw new Error("study: a computed speaker property is not emitted");
      speaker.properties.push({
        name: property.name,
        value: checkedSpeakerProperty(property.name, property.value.value, property.span),
      });
    }
  }
  declareGlobal(instruction, value) {
    this.snapshot.globals.push({ name: instruction.name, value: shown(value) });
    return value;
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
    let keptHandle = null;
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
      const authoredText = instruction.textTemporary === undefined ? textSayText(this, shown(got.value), instruction.value.span) : got.text;
      if (instruction.textTemporary !== undefined && typeof authoredText !== "string") throw new Error("study: prepared say text that is no text");
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
      if (instruction.destinationTemporary !== undefined) {
        // A say used as a value: its message's handle (today's `giveMessageHandle`), taken by the program after the call.
        staged.liveMessages.push({ messageId: said.sequence, sourceText: authoredText });
        this.messageHandle = fromCanonical({ kind: "messageHandle", messageId: said.sequence });
        keptHandle = { kind: "messageHandle", messageId: said.sequence };
      }
      finishSay(staged, events, span, said, place);
    } finally {
      this.snapshot = session;
      this.events = drive;
    }
    Object.assign(session, staged);
    session.contextualSpeaker = null;
    if (keptHandle !== null) this.keep(keptHandle);
    for (const event of events) drive.push(event);
    return session.status === "waiting";
  }
  refuel() {
    if (Date.now() - this.startedMs > this.limitMs)
      throw fault(
        "TSR037",
        `The script ran for ${Math.round(this.limitMs / 1000)} seconds without waiting, so it was stopped. Check for a loop that repeats without end.`,
        this.plan.files[this.file ?? 0].sourceSpan,
      );
    this.fuel = 1_000_000;
  }
  resumeFrame() {
    const frame = this.resumeFrames.shift();
    if (this.resumeFrames.length === 0) this.resuming = false;
    return frame;
  }
  /** At a wait the program reached: true when the session settled it (the program goes on), else the drive ends. */
  waited() {
    for (;;) {
      // The host's recorded operations at this wait; false: the drive ends here.
      if (!this.session.settle(this)) throw SUSPEND;
      if (this.runBlocks() && this.snapshot.status === "waiting") continue;
      if (this.snapshot.status === "waiting") throw SUSPEND;
      return;
    }
  }
  /**
   * The resumable form's wait, at first arrival and at each resume: catch-up toward the observed time and the blocks
   * due (none of which waits) run; true while the session still waits, so the program saves there.
   */
  afterWait() {
    const snapshot = this.snapshot;
    if (snapshot.status !== "waiting") return false;
    this.runBlocks();
    return snapshot.status === "waiting";
  }
  /**
   * The generator form's wait: as `waited` without the replay. The program yields, so the drive ends; the host acts on
   * the live state; the next drive resumes here, runs the blocks dispatched meanwhile (a block that can wait is a
   * generator too) and yields again while the session still waits.
   */
  /** Part F: a Debug stop; the drive ends here while `stopping` holds. */
  *stop(pc) {
    this.stops.push(pc);
    if (this.stopping) yield;
  }
  /** A statement that a plain function reached in a debug program, where no stop is possible (the probe expects none). */
  stopMissed(pc) {
    this.stops.push(pc);
    this.missedStops += 1;
  }
  *waitHere() {
    const snapshot = this.snapshot;
    for (;;) {
      if (snapshot.status === "waiting" && snapshot.currentSessionTimeMs <= snapshot.observedSessionTimeMs && !executionRunnable(snapshot))
        processDueWork(this.plan, snapshot, this.events, null, null);
      while (timerHandlerDispatchable(snapshot)) {
        startTimerHandler(this.plan, snapshot, null);
        const frame = snapshot.callFrames.at(-1);
        const block = this.blocks.get(frame.functionId);
        if (block === undefined) throw new Error("study: a block whose creating instruction did not run");
        this.depth += 1;
        const running = block();
        if (running !== null && typeof running?.next === "function") yield* running;
        this.depth -= 1;
        returnFromTimerHandler(this.plan, snapshot, frame, this.events, null, null);
      }
      if (snapshot.status !== "waiting") return;
      yield;
    }
  }
  /**
   * Today's engine at a wait: scene time catches up toward the observed time, and each block it then dispatches runs
   * (its closure), then returns to the wait. True when a block ran; the wait is then a new wait for the host.
   */
  runBlocks() {
    const snapshot = this.snapshot;
    if (snapshot.status === "waiting" && snapshot.currentSessionTimeMs <= snapshot.observedSessionTimeMs && !executionRunnable(snapshot))
      processDueWork(this.plan, snapshot, this.events, null, null);
    let ran = false;
    while (timerHandlerDispatchable(snapshot)) {
      startTimerHandler(this.plan, snapshot, null);
      const frame = snapshot.callFrames.at(-1);
      const block = this.blocks.get(frame.functionId);
      if (block === undefined) throw new Error("study: a block whose creating instruction did not run in this drive");
      this.depth += 1;
      block();
      this.depth -= 1;
      returnFromTimerHandler(this.plan, snapshot, frame, this.events, null, null);
      ran = true;
    }
    return ran;
  }
  exit(span, pc) {
    this.snapshot.nextInstruction = pc;
    haltForExit(this.snapshot, span, this.events);
    throw EXIT;
  }
  end(span) {
    throw endWithoutCall(span);
  }
  /**
   * Today's engine executes `synthetic`, an instruction whose operands are temporaries 1e9 + i holding `values`; the
   * temporaries `sources` (id, value pairs) go to the state first. Gives true when the instruction waits.
   */
  instruction(synthetic, pc, values, sources) {
    const snapshot = this.snapshot;
    const ids = new Set();
    values.forEach((value, index) => {
      snapshot.temporaries.push({ id: 1e9 + index, value: shown(value) });
      ids.add(1e9 + index);
    });
    for (let i = 0; i < sources.length; i += 2) {
      if (sources[i + 1] === undefined) continue;
      snapshot.temporaries.push({ id: sources[i], value: shown(sources[i + 1]) });
      ids.add(sources[i]);
    }
    snapshot.nextInstruction = pc;
    snapshot.status = "running";
    this.bridgedInstructions += 1;
    try {
      executePlannedInstruction(this.plan, synthetic, snapshot, new Evaluator(snapshot, this.capabilities, this.events, this.plan), this.events);
    } finally {
      for (let i = snapshot.temporaries.length - 1; i >= 0; i -= 1)
        if (ids.has(snapshot.temporaries[i].id)) snapshot.temporaries.splice(i, 1);
      snapshot.contextualSpeaker = null;
    }
    return snapshot.status === "waiting";
  }
  /** A `goto` to a file, executed by today's engine (its effects on timers, media and draws), then unwound to it. */
  transfer(synthetic, pc, values, sources) {
    this.instruction(synthetic, pc, values, sources);
    const file = this.fileEntries.indexOf(this.snapshot.nextInstruction);
    if (file < 0) throw new Error("study: a goto to a place that is no file's entry");
    this.depth = 0;
    throw new Goto(file);
  }
  /** The value an instruction of today's engine wrote to temporary `id`, taken off the state. */
  takeTemporary(id) {
    const temporaries = this.snapshot.temporaries;
    const index = temporaries.findIndex((temporary) => temporary.id === id);
    if (index < 0) return undefined;
    const [temporary] = temporaries.splice(index, 1);
    this.keep(temporary.value);
    return fromCanonical(temporary.value);
  }
  /**
   * Today's engine drops a message, timer or media record that nothing in its state reaches (record collection); the
   * program's variables are outside that state, so each handle the program receives is kept reachable in a state
   * temporary (2e9). The study's stand-in for giving record collection the program's roots: records are kept longer.
   */
  keep(value) {
    if (value === null || typeof value !== "object" || !/Handle$/.test(value.kind)) return;
    const temporaries = this.snapshot.temporaries;
    let kept = temporaries.find((temporary) => temporary.id === 2e9);
    if (kept === undefined) {
      kept = { id: 2e9, value: { kind: "list", items: [] } };
      temporaries.unshift(kept);
    }
    kept.value.items.push({ ...value });
  }
  fault(code, message, span) {
    return fault(code, message, span);
  }
}

/** Makes a native composite hold what its changed canonical form holds, keeping the composite's identity. */
function syncInPlace(target, canonical) {
  if (canonical === null || typeof canonical !== "object") return;
  const fresh = fromCanonical(canonical);
  if (Array.isArray(target) && Array.isArray(fresh)) {
    target.length = 0;
    for (const item of fresh) target.push(item);
  } else if (target instanceof NativeObject && fresh instanceof NativeObject) {
    target.properties.clear();
    for (const [k, v] of fresh.properties) target.properties.set(k, v);
  } else if (target instanceof NativeDict && fresh instanceof NativeDict) {
    target.entries.clear();
    for (const [k, v] of fresh.entries) target.entries.set(k, v);
  } else if (target instanceof NativeSet && fresh instanceof NativeSet) {
    target.items.length = 0;
    for (const item of fresh.items) target.items.push(item);
    target.membership = null;
  }
}
