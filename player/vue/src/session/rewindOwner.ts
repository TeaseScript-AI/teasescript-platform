import { computed, ref, shallowRef } from "vue";
import { DebugHistoryView, rewindFutureOf } from "../../../debug/debug-history.js";
import type { HistoryDelta, HistoryTimeline } from "../../../engine-bridge/history/core.js";
import { endsQuietly, type PlayerBridge } from "../../../runtime/player-bridge.js";
import { postClose, postRenew, type RewindControlHost } from "./rewindControls.js";
import {
  INITIAL_LIFECYCLE,
  advanceLifecycle,
  type LifecycleAction,
  type LifecycleEvent,
  type LifecycleOutcome,
  type LifecycleState,
} from "../../../debug/rewind-lifecycle.js";
import type { PlayerSession } from "../../../runtime/runtime-view.js";

type Stepped = Awaited<ReturnType<PlayerBridge["historyStep"]>>;

/** What the function decided on a fact the Player reported: its actions, applied already; they permit nothing. */
export type LifecycleDisposition = readonly LifecycleAction[];
const NOTHING: LifecycleDisposition = Object.freeze([]);

/** What the owner needs of the Player. */
export interface RewindOwnerHost {
  readonly bridge: () => PlayerBridge | null;
  /** The session the page shows, or `null`. */
  readonly shown: () => PlayerSession | null;
  /** Whether the session may be left for a restored state now. */
  readonly ready: () => boolean;
  readonly generation: () => number;
  /** Takes the rewind's work for a step, so no input or adoption runs meanwhile; `null` when it may not begin. */
  readonly beginStep: () => (() => void) | null;
  /** Shows a session this rewind restored or reinstated, paused or running. */
  readonly show: (next: PlayerSession, paused: boolean) => void;
  /** The restart gate (`rewind.beforeRestart()`), read at each call. */
  readonly beforeRestart: () => void | Promise<void>;
  /** The page's error reporter, at the rewind owner's own events. */
  readonly reportPageError: (error: unknown) => void;
}

/**
 * Debug's rewind over the Player's lifetime (DEBUGGER.md "Rewind"): its state, decided by `advanceLifecycle` alone,
 * and the actions it returns, applied here. It outlives each Debug scope, which only opens and ends its features
 * (`debugOn`, `debugOff`) and presents what this holds: the history's view, the step's progress, and its problem.
 *
 * Requests are posted to the host in the order the function decided them, and the host runs them in that order: a
 * renewal never passes a close decided before it, and one the host refused or rejected blocks every later renewal there
 * and here. A session this rewind showed is held here while the history names it: the parked session, a prepared
 * candidate, and the event logs of both.
 */
export function createRewindOwner(host: RewindOwnerHost) {
  let state: LifecycleState = INITIAL_LIFECYCLE;
  // The retirement stamp: it moves at every retirement (a clear, an import) and at the loss (`retired`, `lost`).
  let retirements = 0;
  const view = shallowRef<DebugHistoryView | null>(null);
  // The view changes in place; this counts its changes for what presents it.
  const revision = ref(0);
  const busy = ref(false);
  const problem = ref<string | null>(null);
  // The session Back first left, parked in the host while a restored state shows; the prepared candidate; the
  // timelines `historyRenew` replied with, until the history they open is installed.
  let parked: PlayerSession | null = null;
  let candidate: PlayerSession | null = null;
  const timelines = new Map<number, HistoryTimeline>();
  // The session the last Return or Debug-off close reinstated (`showParked`), which the Player's disposal releases
  // while it shows.
  let reinstated: PlayerSession | null = null;
  // Set while this rewind shows a session, which is no new session.
  let showing = false;
  // Settles the operation that asked (a step, Return) with whether it went ahead.
  let settleAsk: ((went: boolean) => void) | null = null;
  // The deltas that arrived before the timeline did, and the publication whose deltas were applied last.
  let early: HistoryDelta[] = [];
  let applied: { readonly lineage: object; readonly revision: number } | null = null;

  const changed = () => revision.value++;
  /** A guard for a reply: the view it began with is still the one shown, and no retirement or loss came since. */
  const current = () => {
    const at = { view: view.value, retirements };
    return () => view.value === at.view && retirements === at.retirements && at.view !== null;
  };
  /** A rejected reply is a host failure, unless the connection ended or `quiet` says the work it served is gone. */
  const reportUnless = (quiet: () => boolean) => (error: unknown) => {
    if (!quiet() && !endsQuietly(error)) host.reportPageError(error);
  };
  // A log is the events of a session the page holds: the shown one, the parked one, or a prepared candidate.
  const logOf = (key: string) => {
    for (const each of [host.shown(), parked, candidate])
      if (each?.historyKey === key) return (each.connection.latest(each) ?? each).events;
    return null;
  };

  function show(next: PlayerSession, paused: boolean) {
    showing = true;
    try {
      host.show(next, paused);
    } finally {
      showing = false;
    }
  }

  /** Decides `event` and applies its actions; the actions are returned for the caller that asked. */
  function dispatch(event: LifecycleEvent): LifecycleOutcome {
    const outcome = advanceLifecycle(state, event);
    // The page's inspection is this state's (`inspecting`): it changes in the same synchronous batch as the session
    // the actions show.
    const moved = outcome.state !== state;
    state = outcome.state;
    for (const action of outcome.actions) apply(action);
    // An ask whose step or Return ended with nothing left to await (its history closed meanwhile) went nowhere.
    const awaited = outcome.actions.some((action) =>
      ["drop", "commit", "gate", "refuse", "showParked"].includes(action.kind),
    );
    if (!awaited && state.step === null && !state.returning && event.kind !== "stepAsked")
      settle(false);
    if (moved) changed();
    return outcome;
  }

  function settle(went: boolean) {
    const waiting = settleAsk;
    settleAsk = null;
    waiting?.(went);
  }

  // What the history controls need of this owner (`rewindControls.ts`).
  const controls: RewindControlHost = {
    decide: (event) => dispatch(event).actions.some((action) => action.kind === "reportFailure"),
    reportPageError: (error) => host.reportPageError(error),
  };

  function apply(action: LifecycleAction): void {
    const bridge = host.bridge();
    switch (action.kind) {
      case "renew": {
        if (bridge === null) return;
        // The session shown now is the new history's first: a new session's, at its generation's first `follow`.
        const shown = host.shown();
        postRenew(bridge, action, shown?.connection === bridge ? shown : null, timelines, controls);
        return;
      }
      case "install":
        if (bridge !== null) install(bridge, action.history);
        return;
      case "close":
        if (bridge !== null) postClose(bridge, action, controls);
        return;
      case "reportFailure":
        // Applied by the open or the gate whose failure it is, which holds the error (`failed`, `gate`).
        return;
      case "clearView":
        view.value?.close();
        view.value = null;
        parked = null;
        candidate = null;
        early = [];
        changed();
        return;
      case "readOnly":
        view.value?.close();
        parked = null;
        candidate = null;
        changed();
        settle(false);
        return;
      case "sendStep":
        return;
      case "refuse":
        settle(false);
        return;
      case "gate":
        gate(action.gate, action.id);
        return;
      case "drop":
        if (bridge !== null)
          void bridge
            .historyStep("rewindDrop", { history: action.history, step: action.token })
            .catch(reportUnless(() => state.sealed !== null))
            .finally(() => {
              candidate = null;
              settle(false);
            });
        else settle(false);
        return;
      case "commit": {
        if (bridge === null) return;
        const holds = current();
        const shown = view.value;
        void bridge
          .historyStep("rewindCommit", { history: action.history, step: action.token })
          .then(({ result }) => {
            if (holds() && result.kind === "done" && result.delta !== null)
              shown!.apply(result.delta);
            else if (holds() && result.kind === "refused") {
              problem.value = result.reason;
              shown!.readAgain();
            }
          })
          // The page's handoff stands: a failed commit is reported, and never dropped.
          .catch(reportUnless(() => !holds()))
          .finally(() => {
            settle(true);
            dispatch({ kind: "commitAcknowledged" });
          });
        return;
      }
      case "showCandidate": {
        const next = candidate;
        candidate = null;
        if (next === null) return;
        // The first Back parks the session it leaves; a later one keeps the parked one.
        if (parked === null) parked = host.shown();
        show(next, true);
        return;
      }
      case "sendReturn": {
        if (bridge === null) return;
        const holds = current();
        const shown = view.value;
        void bridge
          .historyStep("rewindReturn", { history: action.history })
          .then(({ result }) => {
            if (holds() && result.kind === "done" && result.delta !== null)
              shown!.apply(result.delta);
          })
          .catch(reportUnless(() => !holds()));
        return;
      }
      case "showParked": {
        const left = parked;
        parked = null;
        if (left !== null && state.sealed === null) {
          show(left.connection.latest(left) ?? left, false);
          reinstated = left;
        }
        settle(true);
        return;
      }
      case "adoptBegin":
      case "adoptEnd": {
        if (bridge === null) return;
        const holds = current();
        const shown = view.value;
        if (action.kind === "adoptEnd" && action.succeeded) parked = null;
        void bridge
          .historyStep(
            "rewindAdopt",
            action.kind === "adoptBegin"
              ? { history: action.history, phase: "begin" }
              : { history: action.history, phase: "end", succeeded: action.succeeded },
          )
          .then(({ result }) => {
            if (holds() && result.kind === "done" && result.delta !== null)
              shown!.apply(result.delta);
          })
          .catch(reportUnless(() => !holds()));
        return;
      }
    }
  }

  /** Shows the history a current renewal opened, enrolled already, with the timeline its reply brought. */
  function install(bridge: PlayerBridge, history: number) {
    const timeline = timelines.get(history);
    timelines.delete(history);
    if (timeline === undefined) return;
    const made: DebugHistoryView = new DebugHistoryView(
      timeline,
      logOf,
      (each) =>
        bridge.historyTimeline(each).catch((error: unknown) => {
          reportUnless(() => view.value !== made)(error);
          throw error;
        }),
      changed,
    );
    view.value = made;
    for (const delta of early)
      if (delta.history === history && delta.from >= timeline.revision) made.apply(delta);
    early = [];
    changed();
  }

  function gate(which: "step" | "return" | "reinstate", id: number) {
    const generation = host.generation();
    let gated: void | Promise<void>;
    try {
      gated = host.beforeRestart();
    } catch (error) {
      gated = Promise.reject(error);
    }
    const mayShow = () => host.ready() && host.generation() === generation;
    void Promise.resolve(gated).then(
      () => dispatch({ kind: "gateSettled", gate: which, id, ok: true, mayShow: mayShow() }),
      (error: unknown) => {
        // A failure is reported only when the function says so (`reportFailure`): a step's as its problem, a Return's
        // or a reinstatement's as the Player's host failure. An obsolete gate's says nothing.
        const { actions } = dispatch({
          kind: "gateSettled",
          gate: which,
          id,
          ok: false,
          mayShow: mayShow(),
        });
        if (!actions.some((action) => action.kind === "reportFailure")) return;
        if (which === "step")
          problem.value = error instanceof Error ? error.message : String(error);
        else host.reportPageError(error);
      },
    );
  }

  /** Runs one rewind step through the function; resolves to whether it was committed. */
  async function step(
    send: (bridge: PlayerBridge, history: number) => Promise<Stepped> | null,
  ): Promise<boolean> {
    const bridge = host.bridge();
    const shown = view.value;
    if (bridge === null || shown === null || settleAsk !== null) return false;
    const done = host.beginStep();
    if (done === null) return false;
    const asked = dispatch({ kind: "stepAsked" }).actions;
    if (!asked.some((action) => action.kind === "sendStep")) {
      done();
      return false;
    }
    const history = state.history!;
    const generation = host.generation();
    const holds = current();
    const went = new Promise<boolean>((resolve) => (settleAsk = resolve));
    busy.value = true;
    problem.value = null;
    try {
      const sent = send(bridge, history);
      if (sent === null) {
        dispatch({ kind: "stepFailed" });
        settle(false);
        return await went;
      }
      let reply: Stepped;
      try {
        reply = await sent;
      } catch (error) {
        if (holds()) problem.value = error instanceof Error ? error.message : String(error);
        dispatch({ kind: "stepFailed" });
        settle(false);
        return await went;
      }
      const { result, restored } = reply;
      if (result.kind !== "prepared" || restored === null) {
        if (result.kind === "refused" && holds()) problem.value = result.reason;
        dispatch({ kind: "stepFailed" });
        settle(false);
        return await went;
      }
      candidate = restored;
      dispatch({
        kind: "stepPrepared",
        token: result.step,
        mayShow: holds() && host.ready() && host.generation() === generation,
      });
      return await went;
    } finally {
      busy.value = false;
      done();
    }
  }

  return {
    view: computed(() => {
      void revision.value;
      return view.value;
    }),
    revision: computed(() => revision.value),
    busy: computed(() => busy.value),
    problem: computed(() => problem.value),
    /** Whether this rewind is showing a session now, which is no new session. */
    get showing(): boolean {
      return showing;
    },
    /** The state the function decides from, for presentation and tests. */
    get state(): LifecycleState {
      return state;
    },
    /*
     * Facts the Player reports: each returns its disposition, the actions the function decided, which permit the caller
     * nothing (`LifecycleDisposition`).
     */
    debugOn: (): LifecycleDisposition => {
      const bridge = host.bridge();
      return bridge === null
        ? NOTHING
        : dispatch({ kind: "debugOn", intent: bridge.nextHistoryIntent() }).actions;
    },
    debugOff: (): LifecycleDisposition => dispatch({ kind: "debugOff" }).actions,
    newSession: (): LifecycleDisposition => {
      const bridge = host.bridge();
      // Without a connection there is no history; the inspection still ends (intent 0 opens nothing that is sent).
      return dispatch({ kind: "newSession", intent: bridge?.nextHistoryIntent() ?? 0 }).actions;
    },
    /** A retirement and the loss each move the retirement stamp first, also without a connection. */
    retired: (by: "clear" | "import"): LifecycleDisposition => {
      retirements++;
      const bridge = host.bridge();
      return bridge === null
        ? NOTHING
        : dispatch({ kind: "retired", by, intent: bridge.nextHistoryIntent() }).actions;
    },
    lost: (): LifecycleDisposition => {
      retirements++;
      return dispatch({ kind: "lost" }).actions;
    },
    /** The Player's disposal: the history closes as its disposal, and a session Return or Debug off reinstated goes. */
    disposal: (): LifecycleDisposition => {
      const { actions } = dispatch({ kind: "disposal" });
      const left = reinstated;
      reinstated = null;
      if (left !== null && host.shown()?.lineage === left.lineage) left.connection.release(left);
      return actions;
    },
    /*
     * Requests: each returns the function's decision, and the caller acts on it alone. An adoption begins, with its
     * capture and its provider write, only once admitted; its completion activates the page only once accepted.
     */
    adoptionBegun: (): boolean => dispatch({ kind: "adoptionBegun" }).admitted === true,
    adoptionSettled: (succeeded: boolean): boolean =>
      dispatch({ kind: "adoptionSettled", succeeded }).admitted === true,
    /** Retries a reinstatement whose gate failed, through the same gate; resolves to whether one began. */
    retryReturn: (): boolean =>
      dispatch({ kind: "retryReinstate" }).actions.some((action) => action.kind === "gate"),
    /** Whether the page shows a restored state for inspection: the function's state, the one account of it. */
    inspecting: computed(() => {
      void revision.value;
      return state.inspecting;
    }),
    /**
     * The return to the session for presentation: `pending` while a Return or Debug off's reinstatement waits (for its
     * gate, or for an adoption), `failed` once Debug off's reinstatement gate failed, which `retryReturn` retries.
     */
    reinstatement: computed((): "pending" | "failed" | null => {
      void revision.value;
      if (state.sealed !== null) return null;
      if (state.closing === "failed") return "failed";
      return state.closing !== null || state.returning ? "pending" : null;
    }),
    /**
     * Applies the deltas `session`'s publication carries, once per publication. The generation's first session, or its
     * `null`, posts the renewal that waits for it.
     */
    follow(session: PlayerSession | null) {
      if (state.awaiting) dispatch({ kind: "follow" });
      if (session === null) return;
      if (applied?.lineage === session.lineage && applied.revision >= session.revision) return;
      applied = { lineage: session.lineage, revision: session.revision };
      if (session.history.length === 0) return;
      if (view.value !== null) view.value.applyAll(session.history);
      else if (state.opening !== null) early.push(...session.history);
    },
    back: (point: number) =>
      step((bridge, history) => {
        const live = host.shown();
        const target = view.value?.timeline.points.find((each) => each.id === point);
        const events = target === undefined ? null : view.value!.eventsAt(target);
        if (live === null || events === null) return null;
        // The first Back leaves the shown session; a later one names the parked one.
        return bridge.historyStep("rewindBack", {
          history,
          point,
          live: state.inspecting && parked !== null ? parked.id : live.id,
          events,
        });
      }),
    forward: () =>
      step((bridge, history) => {
        const future = view.value?.timeline.inspection?.future ?? null;
        const events = future === null ? null : view.value!.eventsAt(future);
        return events === null ? null : bridge.historyStep("rewindForward", { history, events });
      }),
    /** Reinstates the session Back first left, through the restart gate; resolves to whether it was. */
    returnToSession: (): Promise<boolean> => {
      if (settleAsk !== null || parked === null) return Promise.resolve(false);
      const went = new Promise<boolean>((resolve) => (settleAsk = resolve));
      dispatch({ kind: "return" });
      return went;
    },
    future: computed(() => {
      void revision.value;
      return view.value === null ? null : rewindFutureOf(view.value);
    }),
  };
}

export type RewindOwner = ReturnType<typeof createRewindOwner>;
