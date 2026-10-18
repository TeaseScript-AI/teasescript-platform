import assert from "node:assert/strict";

import type { InstructionPlan } from "../../src/plan/model.js";
import { run } from "../../src/runtime/engine.js";
import type { InterpreterEvent } from "../../src/runtime/events.js";
import { completeAction } from "../../src/runtime/operations/complete-action.js";
import { reportMediaLoad } from "../../src/runtime/operations/media-reports.js";
import { observeTime } from "../../src/runtime/operations/observe-time.js";
import { pressPermanentButton } from "../../src/runtime/operations/press-permanent-button.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import type { FreshRuntimeOptions, RuntimeSnapshot } from "../../src/runtime/snapshot/state.js";
import { compileValidPlan } from "./compile-valid-plan.js";
import { createFreshRuntimeSnapshot } from "../../src/runtime/snapshot/snapshot-construction.js";

/** A session at the default reading speed, driven by time observations, skips, and permanent-button clicks. */
export class Story {
  readonly plan: InstructionPlan;
  snapshot: RuntimeSnapshot;
  readonly events: InterpreterEvent[] = [];

  constructor(
    source: string,
    options: Pick<FreshRuntimeOptions, "persistentScriptStorage" | "wallClockMs"> = {},
  ) {
    this.plan = compileValidPlan(source);
    this.snapshot = createFreshRuntimeSnapshot(this.plan, options);
    this.#run();
  }

  #run(): void {
    const result = run(this.plan, this.snapshot);
    this.events.push(...result.events);
    this.snapshot = result.snapshot;
  }

  /** Observes `nowMs`, with the playback progress of each `[mediaId, progressMs]`. */
  at(nowMs: number, ...progress: readonly (readonly [number, number])[]): this {
    const reports = progress.map(([mediaId, progressMs]) => {
      const media = this.snapshot.backgroundActions.find(
        (action) => action.kind === "media" && action.media.mediaId === mediaId,
      );
      const segment = media?.kind === "media" ? media.media.segment : 0;
      return { mediaId, segment, progressMs };
    });
    const observed = observeTime(this.plan, this.snapshot, nowMs, reports);
    assert.equal(observed.outcome.kind, "observed");
    this.events.push(...observed.events);
    this.snapshot = observed.snapshot;
    this.#run();
    return this;
  }

  skip(): this {
    const gate = this.snapshot.foregroundAction;
    assert.equal(gate?.kind, "chatPacingGate", "a reading time runs");
    const skipped = completeAction(this.plan, this.snapshot, {
      actionId: gate!.actionId,
      actionKind: "chatPacingGate",
      payload: { kind: "skip" },
    });
    assert.equal(skipped.outcome.kind, "completed");
    this.events.push(...skipped.events);
    this.snapshot = skipped.snapshot;
    this.#run();
    return this;
  }

  load(mediaId: number, durationMs: number): this {
    const loaded = reportMediaLoad(this.plan, this.snapshot, mediaId, {
      kind: "loaded",
      durationMs,
    });
    assert.equal(loaded.outcome.kind, "accepted");
    this.events.push(...loaded.events);
    this.snapshot = loaded.snapshot;
    this.#run();
    return this;
  }

  press(buttonId: number): string {
    const pressed = pressPermanentButton(this.plan, this.snapshot, buttonId);
    this.events.push(...pressed.events);
    this.snapshot = pressed.snapshot;
    this.#run();
    return pressed.outcome.kind;
  }

  said(): string[] {
    return this.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
  }

  /** The kinds of the actions requested so far, in order. */
  requested(): string[] {
    return this.events.flatMap((event) =>
      event.kind === "actionRequested" ? [event.action.kind] : [],
    );
  }

  reading(): boolean {
    return this.snapshot.foregroundAction?.kind === "chatPacingGate";
  }

  binding(name: string): SerializableRuntimeValue | undefined {
    return this.snapshot.frames[0]?.bindings.find((binding) => binding.name === name)?.value;
  }
}
