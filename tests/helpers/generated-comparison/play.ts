import { createHash } from "node:crypto";

import type {
  RuntimeForegroundActionSnapshot,
  RuntimeInteractionActionSnapshot,
} from "../../../src/runtime/actions/model.js";
import type { RuntimeSession } from "../../../src/runtime/session.js";
import type { PlayHost } from "./fixtures.js";
import type { MediaProgressReport } from "./generated-side.js";

/** Which option or outcome the play takes where it has a choice. */
export type PlayPolicy = "first" | "last" | { readonly seed: number };

/** How a play ended: both sides halted or failed alike, a bound was reached, or an action the play does not answer. */
export type PlayEnding = "halted" | "failed" | "bound" | `unanswered: ${string}`;

/** One host operation, applied alike to both sides. */
export type HostOperation =
  | { readonly kind: "run" }
  | {
      readonly kind: "observeTime";
      readonly nowMs: number;
      readonly reports: readonly MediaProgressReport[];
      /** The foreground wait it answers, or `null`; the sides are not given it. */
      readonly answers: number | null;
    }
  | { readonly kind: "completeAction"; readonly request: Readonly<Record<string, unknown>> }
  | { readonly kind: "updateInteraction"; readonly request: Readonly<Record<string, unknown>> }
  | { readonly kind: "reportMediaLoad"; readonly mediaId: number; readonly report: unknown }
  | { readonly kind: "pressPermanentButton"; readonly buttonId: number };

const LOADED_DURATION_MS = 10_000;
const TEXT = "test";
const TEMPORAL = { date: "2026-07-13", time: "09:30", datetime: "2026-07-13T09:30" } as const;

/**
 * The deterministic schedule of a play. It decides every operation from today's session, after both sides' records of
 * the last one were found equal, so deciding from either side would be the same. Each step drains runnable work first
 * (a waiting session with a dispatchable queued block is runnable), then reports media loads, then may press a
 * permanent button, then answers the foreground action. Time never passes the scene-time bound.
 */
export class Play {
  readonly #session: RuntimeSession;
  readonly #host: PlayHost;
  readonly #policy: PlayPolicy;
  readonly #answersBound: number;
  readonly #sceneTimeBoundMs: number;
  #random: number;
  #answers = 0;
  /** The scene time at which the play first saw each media segment playing: progress counts from there. */
  readonly #segmentStarts = new Map<string, number>();
  readonly #loadsReported = new Set<number>();
  /** Form edits still to make, for the form action they belong to. */
  #edits: {
    readonly actionId: number;
    readonly requests: Array<Readonly<Record<string, unknown>>>;
  } | null = null;
  #waits = 0;
  #lastForeground: number | null = null;
  #press: { readonly buttonId: number; retried: boolean } | null = null;
  /** An input refused with `executionPending`, kept across the runs that drain work until an answer is accepted. */
  #pending: HostOperation | null = null;
  /** The foreground wait an observation answered that has not settled yet: a block may run before it does. */
  #awaited: number | null = null;
  #lastObserved: { readonly nowMs: number; readonly answers: number | null } | null = null;

  public constructor(
    session: RuntimeSession,
    host: PlayHost,
    policy: PlayPolicy,
    end: { readonly answers: number; readonly sceneTimeMs: number },
  ) {
    this.#session = session;
    this.#host = host;
    this.#policy = policy;
    this.#answersBound = end.answers;
    this.#sceneTimeBoundMs = end.sceneTimeMs;
    this.#random = typeof policy === "object" ? policy.seed >>> 0 || 1 : 1;
  }

  /** How many foreground answers the play has completed. */
  public get answers(): number {
    return this.#answers;
  }

  /**
   * The next operation after `done`, whose outcome today's side gave, or how the play ends. An outcome that refuses an
   * answer ends the play as unanswered, except `executionPending`, after which runnable work drains and the answer is
   * decided again; the same input refused that way again, with only draining runs between, ends the play.
   */
  public next(done: HostOperation, outcome: unknown): HostOperation | PlayEnding {
    const kind = outcomeKind(outcome);
    this.#countSettledWait();
    if (kind === "executionPending" && done.kind === "pressPermanentButton") {
      // A press waits for the running block: it is pressed again once after the work drains, then given up.
      if (this.#press === null || this.#press.retried) this.#press = null;
      else this.#press.retried = true;
    } else if (kind === "executionPending") {
      if (this.#pending !== null && sameOperation(this.#pending, done))
        return `unanswered: ${operationLabel(done)}`;
      this.#pending = done;
    } else {
      if (done.kind !== "run") this.#pending = null;
      const refused = this.#accept(done, kind);
      if (refused !== null) return refused;
    }
    return this.#decide();
  }

  /** Counts an accepted answer; an answer refused another way ends the play. */
  #accept(done: HostOperation, kind: string | null): PlayEnding | null {
    switch (done.kind) {
      case "completeAction":
        if (kind !== "completed") return `unanswered: ${operationLabel(done)}`;
        this.#answers += 1;
        return null;
      case "updateInteraction":
        if (kind !== "updated" && kind !== "unchanged") return "unanswered: form";
        this.#edits?.requests.shift();
        return null;
      case "observeTime":
        if (kind !== "observed") return "unanswered: time";
        this.#lastObserved = { nowMs: done.nowMs, answers: done.answers };
        if (done.answers !== null) {
          this.#awaited = done.answers;
          this.#countSettledWait();
        }
        return null;
      case "reportMediaLoad":
        this.#loadsReported.add(done.mediaId);
        return null;
      case "pressPermanentButton":
        this.#press = null;
        return null;
      case "run":
        return null;
    }
  }

  /** Counts the observed wait once it has settled: neither foreground nor suspended by a running block. */
  #countSettledWait(): void {
    if (this.#awaited === null) return;
    const view = this.#session.view();
    if (
      view.foregroundAction?.actionId === this.#awaited ||
      view.suspendedAction?.actionId === this.#awaited
    )
      return;
    this.#awaited = null;
    this.#answers += 1;
  }

  #decide(): HostOperation | PlayEnding {
    const view = this.#session.view();
    if (view.status === "halted") return "halted";
    if (view.status === "failed") return "failed";
    if (view.runnable) return { kind: "run" };
    const now = view.currentSessionTimeMs;
    if (this.#answers >= this.#answersBound || now >= this.#sceneTimeBoundMs) return "bound";
    const media = this.#session.mediaPlaybackProjection();
    for (const item of media) {
      if (item.state === "running" && item.loaded) {
        const key = `${item.mediaId}/${item.segment}`;
        if (!this.#segmentStarts.has(key)) this.#segmentStarts.set(key, now);
      }
      if (!item.loaded && !this.#loadsReported.has(item.mediaId))
        return {
          kind: "reportMediaLoad",
          mediaId: item.mediaId,
          report: { kind: "loaded", durationMs: LOADED_DURATION_MS },
        };
    }
    const action = view.foregroundAction;
    if (action !== null && action.actionId !== this.#lastForeground) {
      this.#lastForeground = action.actionId;
      this.#waits += 1;
      if (typeof this.#policy === "object" && this.#waits % 3 === 0) {
        const button = this.#session.permanentButtonProjection().find((shown) => !shown.busy);
        if (button !== undefined) this.#press = { buttonId: button.buttonId, retried: false };
      }
    }
    if (this.#press !== null) {
      const buttonId = this.#press.buttonId;
      if (
        this.#session
          .permanentButtonProjection()
          .some((shown) => shown.buttonId === buttonId && !shown.busy)
      )
        return { kind: "pressPermanentButton", buttonId };
      this.#press = null;
    }
    if (action === null)
      return this.#observe(this.#nextTimerDeadline() ?? this.#sceneTimeBoundMs, null);
    return this.#answer(action);
  }

  #answer(action: RuntimeForegroundActionSnapshot): HostOperation | PlayEnding {
    const complete = (payload: Readonly<Record<string, unknown>>): HostOperation => ({
      kind: "completeAction",
      request: { actionId: action.actionId, actionKind: action.kind, payload },
    });
    switch (action.kind) {
      case "delay":
      case "chatPacingGate":
        return this.#observe(action.deadlineMs, action.actionId);
      case "mediaPlayback":
        return this.#observe(this.#mediaEnd(action.mediaId), action.actionId);
      case "interaction":
        return this.#interaction(action);
      case "storageWrite":
        return complete({ kind: this.#pick(["stored", "failed"]) });
      case "capture":
        return complete(
          this.#pick(["captured", "unavailable"]) === "captured"
            ? {
                kind: "captured",
                media: { kind: "image", reference: this.#host.freshReference("photo") },
              }
            : { kind: "unavailable", reason: "denied" },
        );
      case "fileStore":
        return complete(
          action.operation === "store"
            ? {
                kind: "stored",
                references: action.files.map(() => this.#host.freshReference("file")),
              }
            : action.operation === "read"
              ? { kind: "read", files: action.references.map((name) => this.#host.fileBytes(name)) }
              : {
                  kind: "hashed",
                  hashes: action.references.map((name) => this.#host.fileHash(name)),
                },
        );
      case "lock": {
        const payload = this.#host.lockAnswer(action);
        return payload === null ? "unanswered: lock" : complete(payload);
      }
    }
  }

  #interaction(action: RuntimeInteractionActionSnapshot): HostOperation {
    const base = {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: action.interactionKind,
    };
    const complete = (payload: Readonly<Record<string, unknown>>): HostOperation => ({
      kind: "completeAction",
      request: { ...base, payload },
    });
    const ui = action.ui;
    switch (ui.kind) {
      case "form": {
        if (this.#edits?.actionId !== action.actionId)
          this.#edits = { actionId: action.actionId, requests: this.#formEdits(ui.fields) };
        const update = this.#edits.requests[0];
        return update === undefined
          ? complete({ kind: "submit" })
          : { kind: "updateInteraction", request: { ...base, update } };
      }
      case "choice":
        return complete({ kind: "selectedOption", optionIndex: this.#index(ui.options.length) });
      case "text":
        return complete({ kind: "submittedText", submittedText: TEXT });
      case "number":
        return complete({ kind: "submittedText", submittedText: "1" });
      case "temporal":
        return complete({ kind: "submittedText", submittedText: TEMPORAL[ui.temporalKind] });
      case "image":
        return complete({ kind: "image", reference: this.#host.freshReference("image") });
      default:
        break;
    }
    switch (action.interactionKind) {
      case "password":
        return complete({ kind: "submittedPassword", hash: sha256(TEXT) });
      case "url":
        return complete({ kind: "opened" });
      case "export":
        return complete({ kind: "close" });
      default:
        // A button or a popup.
        return complete({ kind: "activate" });
    }
  }

  /** Every field of a form given a value: an option selected, or a typed value edited, drafted and committed. */
  #formEdits(
    fields: Extract<RuntimeInteractionActionSnapshot["ui"], { kind: "form" }>["fields"],
  ): Array<Readonly<Record<string, unknown>>> {
    const edits: Array<Readonly<Record<string, unknown>>> = [];
    for (const field of fields) {
      const fieldId = field.id;
      if (field.kind === "boolean" || field.kind === "cycle") {
        edits.push({
          kind: "select",
          fieldId,
          optionIndex: this.#index(field.options?.length ?? 2),
        });
        continue;
      }
      const text =
        field.kind === "text"
          ? TEXT
          : field.kind === "integer" || field.kind === "number"
            ? String(numberWithin(field.min, field.max, field.kind === "integer"))
            : TEMPORAL[field.kind];
      edits.push(
        { kind: "edit", fieldId },
        { kind: "draft", fieldId, text },
        { kind: "commit", fieldId },
      );
    }
    return edits;
  }

  /**
   * A time observation at `atMs`, never past the bound, with progress for every running, loaded medium's current
   * segment, counted from where the play first saw that segment playing. A time the same wait was already observed at
   * goes to the bound instead; observed there again, time no longer moves the play, which ends unanswered.
   */
  #observe(atMs: number, answers: number | null): HostOperation | PlayEnding {
    let nowMs = Math.min(atMs, this.#sceneTimeBoundMs);
    const last = this.#lastObserved;
    if (last !== null && last.answers === answers && nowMs <= last.nowMs) {
      if (last.nowMs >= this.#sceneTimeBoundMs) return "unanswered: time";
      nowMs = this.#sceneTimeBoundMs;
    }
    const reports: MediaProgressReport[] = [];
    for (const item of this.#session.mediaPlaybackProjection()) {
      const start = this.#segmentStarts.get(`${item.mediaId}/${item.segment}`);
      if (item.state !== "running" || !item.loaded || start === undefined) continue;
      const progressMs = Math.min(Math.max(0, nowMs - start), item.terminalProgressMs ?? Infinity);
      reports.push({ mediaId: item.mediaId, segment: item.segment, progressMs });
    }
    return { kind: "observeTime", nowMs, reports, answers };
  }

  /**
   * When a media wait can end: its segment's end if it runs and that end is known; otherwise (an endless medium, or one
   * paused, which progress does not move) the earliest timer deadline, else the bound.
   */
  #mediaEnd(mediaId: number): number {
    const item = this.#session.mediaPlaybackProjection().find((shown) => shown.mediaId === mediaId);
    const start =
      item === undefined ? undefined : this.#segmentStarts.get(`${mediaId}/${item.segment}`);
    if (item?.state === "running" && item.terminalProgressMs !== null && start !== undefined)
      return start + item.terminalProgressMs;
    return this.#nextTimerDeadline() ?? this.#sceneTimeBoundMs;
  }

  #nextTimerDeadline(): number | null {
    let earliest: number | null = null;
    for (const action of this.#session.view().backgroundActions) {
      if (action.kind !== "timer" || action.timer.state !== "running") continue;
      const deadline = action.timer.deadlineMs;
      if (deadline !== null && (earliest === null || deadline < earliest)) earliest = deadline;
    }
    return earliest;
  }

  #pick<T>(choices: readonly [T, T]): T {
    return choices[this.#index(2)]!;
  }

  /** The option the policy takes of `count`: the first, the last, or a draw of the seeded generator (xorshift32). */
  #index(count: number): number {
    if (this.#policy === "first") return 0;
    if (this.#policy === "last") return count - 1;
    let x = this.#random;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.#random = x >>> 0;
    return this.#random % count;
  }
}

function numberWithin(min: number | null, max: number | null, integer: boolean): number {
  const low = min === null ? null : integer ? Math.ceil(min) : min;
  const high = max === null ? null : integer ? Math.floor(max) : max;
  if (low !== null && low > 1) return low;
  if (high !== null && high < 1) return high;
  return 1;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function outcomeKind(outcome: unknown): string | null {
  return typeof outcome === "object" &&
    outcome !== null &&
    "kind" in outcome &&
    typeof outcome.kind === "string"
    ? outcome.kind
    : null;
}

function operationLabel(operation: HostOperation): string {
  if (operation.kind !== "completeAction") return operation.kind;
  const request = operation.request;
  return typeof request.interactionKind === "string"
    ? request.interactionKind
    : String(request.actionKind);
}

function sameOperation(left: HostOperation, right: HostOperation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
