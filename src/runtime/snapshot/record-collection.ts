import { isPlainRecord } from "../values/plain-data.js";
import type { RuntimeSnapshot } from "./state.js";
import { recordValidationTestWork } from "../../validation-testing.js";

// Dropping the records of a snapshot that nothing reaches any more.

/**
 * Every value a state holds where a script can reach it: the bindings of each scope and of the globals, speaker
 * properties, for-loop sources, temporaries, and each call frame's saved temporaries and the supplied arguments it has
 * not bound yet. Validation finds the runtime identities a state refers to through them, and record collection the
 * records it still reaches.
 */
export function* identityRootValues(
  frames: unknown,
  speakers: unknown,
  loopFrames: unknown,
  temporaries: unknown,
  callFrames: unknown,
): Generator<unknown, void, undefined> {
  if (Array.isArray(frames)) {
    for (const frame of frames) {
      if (!isPlainRecord(frame) || !Array.isArray(frame.bindings)) continue;
      for (const binding of frame.bindings) {
        if (isPlainRecord(binding)) yield binding.value;
      }
    }
  }
  if (Array.isArray(speakers)) {
    for (const speaker of speakers) {
      if (!isPlainRecord(speaker) || !Array.isArray(speaker.properties)) continue;
      for (const property of speaker.properties) {
        if (isPlainRecord(property)) yield property.value;
      }
    }
  }
  if (Array.isArray(loopFrames)) {
    for (const loop of loopFrames) {
      if (isPlainRecord(loop) && loop.kind === "for") yield loop.source;
    }
  }
  if (Array.isArray(temporaries)) {
    for (const temporary of temporaries) {
      if (isPlainRecord(temporary)) yield temporary.value;
    }
  }
  if (Array.isArray(callFrames)) {
    for (const frame of callFrames) {
      if (!isPlainRecord(frame)) continue;
      if (Array.isArray(frame.callerTemporaries)) {
        for (const temporary of frame.callerTemporaries) {
          if (isPlainRecord(temporary)) yield temporary.value;
        }
      }
      if (Array.isArray(frame.arguments)) {
        for (const argument of frame.arguments) {
          if (isPlainRecord(argument) && argument.supplied === true && "value" in argument) {
            yield argument.value;
          }
        }
      }
    }
  }
}

/**
 * Drops the live records of messages and the settled media and timer records that nothing in `snapshot` reaches anymore.
 * A public operation does it before it returns, when every value of the state is in one of its roots; no handle to such
 * a message, media, or timer can appear again, so where an operation boundary falls does not change the state. A settled
 * media or timer record also stays while one of its blocks is queued or running.
 */
export function dropUnreachableRecords(snapshot: RuntimeSnapshot): void {
  if (
    snapshot.liveMessages.length === 0 &&
    snapshot.settledMedia.length === 0 &&
    snapshot.settledTimers.length === 0
  )
    return;
  // The records not reached yet. Once every record is reached nothing is dropped, so the search stops there.
  const unreached: UnreachedRecords = {
    messages: new Set(snapshot.liveMessages.map((message) => message.messageId)),
    media: new Set(snapshot.settledMedia.map((record) => record.mediaId)),
    timers: new Set(snapshot.settledTimers.map((record) => record.timerId)),
  };
  reachRecords(collectionRoots(snapshot), unreached);
  if (unreached.messages.size > 0) {
    let kept = 0;
    for (const message of snapshot.liveMessages) {
      if (!unreached.messages.has(message.messageId)) snapshot.liveMessages[kept++] = message;
    }
    snapshot.liveMessages.length = kept;
  }
  if (unreached.media.size > 0) {
    let kept = 0;
    for (const record of snapshot.settledMedia) {
      if (!unreached.media.has(record.mediaId)) snapshot.settledMedia[kept++] = record;
    }
    snapshot.settledMedia.length = kept;
  }
  if (unreached.timers.size > 0) {
    let kept = 0;
    for (const record of snapshot.settledTimers) {
      if (!unreached.timers.has(record.timerId)) snapshot.settledTimers[kept++] = record;
    }
    snapshot.settledTimers.length = kept;
  }
}

/** The IDs of the records that the search for unreachable records has not reached yet, by kind. */
interface UnreachedRecords {
  readonly messages: Set<number>;
  readonly media: Set<number>;
  readonly timers: Set<number>;
}

/**
 * The values `identityRootValues` gives for `snapshot`, scope by scope without copying its scope lists, and then a
 * handle for the media or timer of each queued or running block: a media block binds its own handle when it runs, and
 * restore and transfers read the record of a timer block's timer.
 */
function* collectionRoots(snapshot: RuntimeSnapshot): Generator<unknown, void, undefined> {
  yield* identityRootValues(snapshot.frames, null, null, null, null);
  yield* identityRootValues(snapshot.retainedScopes, null, null, null, null);
  yield* identityRootValues([{ bindings: snapshot.globals }], null, null, null, null);
  yield* identityRootValues(
    null,
    snapshot.speakers,
    snapshot.loopFrames,
    snapshot.temporaries,
    snapshot.callFrames,
  );
  for (const invocation of snapshot.pendingTimerHandlers) {
    if ("mediaId" in invocation) yield { kind: "mediaHandle", mediaId: invocation.mediaId };
    else if ("timerId" in invocation) yield { kind: "timerHandle", timerId: invocation.timerId };
  }
  for (const frame of snapshot.callFrames) {
    if (frame.kind !== "function" || frame.timerInterruption === null) continue;
    const interruption = frame.timerInterruption;
    if ("mediaId" in interruption) yield { kind: "mediaHandle", mediaId: interruption.mediaId };
    else if ("timerId" in interruption)
      yield { kind: "timerHandle", timerId: interruption.timerId };
  }
}

/**
 * Removes from `unreached` the IDs that handles in `roots` name, looking into lists, sets, objects, and dicts, and stops
 * as soon as nothing is left. Each round takes the next root and moves every walk taken so far on by one value, so the
 * work done is bounded by how far the walk must go to reach the last record, not by values after it.
 */
function reachRecords(roots: Iterator<unknown>, unreached: UnreachedRecords): void {
  /** A container's values, from `next` on; `field` reads each value from a property or entry record. */
  interface Cursor {
    readonly values: readonly unknown[];
    readonly field: boolean;
    next: number;
  }
  const { messages, media, timers } = unreached;
  const searching = (): boolean => messages.size > 0 || media.size > 0 || timers.size > 0;
  let walks: Cursor[][] = [];
  let taking = true;
  while (searching()) {
    if (taking) {
      const root = roots.next();
      if (root.done === true) taking = false;
      else {
        recordValidationTestWork("recordReachVisits");
        walks.push([{ values: [root.value], field: false, next: 0 }]);
      }
    }
    if (walks.length === 0 && !taking) return;
    const continuing: Cursor[][] = [];
    for (const walk of walks) {
      if (!searching()) return;
      recordValidationTestWork("recordReachVisits");
      const cursor = walk.at(-1)!;
      const item = cursor.values[cursor.next];
      cursor.next += 1;
      if (cursor.next >= cursor.values.length) walk.pop();
      const value = cursor.field ? (isPlainRecord(item) ? item.value : undefined) : item;
      if (isPlainRecord(value)) {
        if (value.kind === "mediaHandle" && typeof value.mediaId === "number") {
          media.delete(value.mediaId);
        } else if (value.kind === "timerHandle" && typeof value.timerId === "number") {
          timers.delete(value.timerId);
        } else if (value.kind === "messageHandle" && typeof value.messageId === "number") {
          messages.delete(value.messageId);
        } else if (
          (value.kind === "list" || value.kind === "set") &&
          Array.isArray(value.items) &&
          value.items.length > 0
        ) {
          walk.push({ values: value.items, field: false, next: 0 });
        } else if (
          value.kind === "object" &&
          Array.isArray(value.properties) &&
          value.properties.length > 0
        ) {
          walk.push({ values: value.properties, field: true, next: 0 });
        } else if (
          value.kind === "dict" &&
          Array.isArray(value.entries) &&
          value.entries.length > 0
        ) {
          walk.push({ values: value.entries, field: true, next: 0 });
        }
      }
      if (walk.length > 0) continuing.push(walk);
    }
    walks = continuing;
  }
}
