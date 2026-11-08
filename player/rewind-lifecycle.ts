/*
 * The page side of Debug's rewind handoff (DEBUGGER.md "Rewind"; the host's side is `advanceHistory`,
 * `engine-bridge/history/core.ts`): one pure deciding function over the Player's rewind state. Every event, a reply, a
 * settled gate or an adoption's outcome included, re-enters it with the state as it is then, and it returns the
 * actions the Player applies, in order. Nothing else decides when a history opens or closes, when a prepared step is
 * committed or dropped, or what shows.
 */

/** Why a history closes. */
export type LifecycleClose = "debugOff" | "replacement" | "import" | "clear" | "disposal";

/** The restart gates (`rewind.beforeRestart()`): a step's commit, Return, and Debug off's reinstatement. */
export type LifecycleGate = "step" | "return" | "reinstate";

/** The Player's rewind state. */
export interface LifecycleState {
  /** Terminal: the Player was disposed, or its connection lost. */
  readonly sealed: "disposal" | "loss" | null;
  /** A close the host refused or rejected on a live connection: nothing opens any more. */
  readonly blocked: boolean;
  /** Whether Debug's features run. */
  readonly debug: boolean;
  /** The history serial asked to open and not yet answered, or `null`. */
  readonly opening: number | null;
  /** The newest open sent to the host (0 before any): it replaced every history opened before it there. */
  readonly sent: number;
  /** The open history, or `null`. */
  readonly history: number | null;
  /** Whether the page shows a restored state, as its committed handoffs say. */
  readonly inspecting: boolean;
  /** The step in flight: asked, prepared (its token known), at its gate, or committed and not yet acknowledged. */
  readonly step: {
    readonly phase: "asked" | "gate" | "committed";
    readonly token: number | null;
    /** The history it was sent to. */
    readonly history: number;
    /** Debug off, a new session or a retirement took the page from it: it is dropped when it settles. */
    readonly abandoned: boolean;
  } | null;
  /** Whether an adoption of the shown restored state was admitted and has not settled. */
  readonly adopting: boolean;
  /**
   * Debug off waiting: for an adoption's outcome, or for its reinstatement's gate; or holding its history after that
   * gate failed, unreinstated, until a new session, a retirement or the Player's disposal closes it.
   */
  readonly closing: "adoption" | "gate" | "failed" | null;
  /** Whether Return waits at its gate. */
  readonly returning: boolean;
  /** The serial of the newest gate asked, `0` before any: each gate's identity, which its settlement names. */
  readonly gates: number;
  /**
   * The gate of each kind asked and still current, by its identity, or `null`: a settlement of any other is obsolete,
   * and decides nothing.
   */
  readonly gate: { readonly [Gate in LifecycleGate]: number | null };
  /** The outcome of an adoption Debug off waited for, which its close carries; `null` when none. */
  readonly adopted: boolean | null;
}

export const INITIAL_LIFECYCLE: LifecycleState = Object.freeze({
  sealed: null,
  blocked: false,
  debug: false,
  opening: null,
  sent: 0,
  history: null,
  inspecting: false,
  step: null,
  adopting: false,
  closing: null,
  returning: false,
  gates: 0,
  gate: { step: null, return: null, reinstate: null },
  adopted: null,
});

/** What happens: the user's actions, the host's replies, the gates, and the Player's lifecycle. */
export type LifecycleEvent =
  | { readonly kind: "debugOn"; readonly intent: number }
  | { readonly kind: "openDue"; readonly intent: number }
  | { readonly kind: "opened"; readonly intent: number; readonly history: number }
  | { readonly kind: "openFailed"; readonly intent: number }
  | { readonly kind: "newSession"; readonly intent: number }
  | { readonly kind: "retired"; readonly by: "clear" | "import"; readonly intent: number }
  | { readonly kind: "lost" }
  | { readonly kind: "disposal" }
  | { readonly kind: "debugOff" }
  | { readonly kind: "stepAsked" }
  | { readonly kind: "stepPrepared"; readonly token: number; readonly mayShow: boolean }
  | { readonly kind: "stepFailed" }
  | {
      readonly kind: "gateSettled";
      readonly gate: LifecycleGate;
      /** The gate's identity (`gates`), as it was asked. */
      readonly id: number;
      readonly ok: boolean;
      readonly mayShow: boolean;
    }
  | { readonly kind: "commitAcknowledged" }
  | { readonly kind: "adoptionBegun" }
  | { readonly kind: "adoptionSettled"; readonly succeeded: boolean }
  | { readonly kind: "return" }
  /** The user retries a reinstatement whose gate failed, through the same gate. */
  | { readonly kind: "retryReinstate" }
  | { readonly kind: "closeSettled"; readonly ok: boolean };

/** What the Player does, in order. A `close` is awaited before the actions after it. */
export type LifecycleAction =
  /** An open, due once every close before it settled: the Player then answers `openDue`. */
  | { readonly kind: "open"; readonly intent: number }
  /** The open sent to the host now. */
  | { readonly kind: "sendOpen"; readonly intent: number }
  | { readonly kind: "enroll"; readonly history: number }
  | {
      readonly kind: "close";
      readonly history: number;
      readonly by: LifecycleClose;
      readonly adoptionSucceeded?: boolean;
    }
  | { readonly kind: "clearView" }
  | { readonly kind: "readOnly" }
  | { readonly kind: "sendStep" }
  | { readonly kind: "refuse" }
  | { readonly kind: "gate"; readonly gate: LifecycleGate; readonly id: number }
  | { readonly kind: "drop"; readonly history: number; readonly token: number }
  | { readonly kind: "commit"; readonly history: number; readonly token: number }
  | { readonly kind: "showCandidate" }
  | { readonly kind: "sendReturn"; readonly history: number }
  | { readonly kind: "showParked" }
  | { readonly kind: "adoptBegin"; readonly history: number }
  | { readonly kind: "adoptEnd"; readonly history: number; readonly succeeded: boolean }
  /** A failed open of the history asked for now, or a current gate's failure: the Player's to report. */
  | { readonly kind: "reportFailure" };

export interface LifecycleOutcome {
  readonly state: LifecycleState;
  readonly actions: readonly LifecycleAction[];
  /**
   * A request's decision, which its caller acts on alone: whether an adoption may begin (`adoptionBegun`), and whether
   * its completion is the page's (`adoptionSettled`). Absent for a fact, and for a request a sealed Player refuses.
   */
  readonly admitted?: boolean;
}

/** `outcome` with the decision on the request it answers. */
const decided = (admitted: boolean, outcome: LifecycleOutcome): LifecycleOutcome => ({
  ...outcome,
  admitted,
});

const done = (state: LifecycleState, ...actions: LifecycleAction[]): LifecycleOutcome => ({
  state: Object.freeze(state),
  actions,
});

/**
 * The drop a step's exit takes: one, for a known token before its commit, to the history it was sent to; none after its
 * commit, once that history closed (its close took the candidate), or on a lost connection.
 */
function exitStep(state: LifecycleState): LifecycleAction[] {
  const { step } = state;
  if (step === null || step.token === null || step.phase === "committed") return [];
  if (state.sealed === "loss" || step.history !== state.history) return [];
  return [{ kind: "drop", history: step.history, token: step.token }];
}

/** A step's state once the page was taken from it: dropped at once when prepared, else when it settles. */
function abandon(step: LifecycleState["step"]): LifecycleState["step"] {
  return step === null || step.phase === "committed" ? step : { ...step, abandoned: true };
}

/** Asks gate `which` anew, with the next identity, which only its own settlement names. */
function ask(state: LifecycleState, which: LifecycleGate): [LifecycleState, LifecycleAction] {
  const id = state.gates + 1;
  return [
    { ...state, gates: id, gate: { ...state.gate, [which]: id } },
    { kind: "gate", gate: which, id },
  ];
}

/** The open a Debug on asked for while Debug off still closed its history, due behind that close. */
const reopen = (state: LifecycleState): LifecycleAction[] =>
  state.debug && state.opening !== null ? [{ kind: "open", intent: state.opening }] : [];

/** The history ends with Debug off: reinstating the parked session through its gate when a restored state shows. */
function debugOffClose(state: LifecycleState): LifecycleOutcome {
  if (state.history === null) return done({ ...state, closing: null }, { kind: "clearView" });
  if (state.inspecting) return done(...ask({ ...state, closing: "gate" }, "reinstate"));
  const { history } = state;
  return done(
    { ...state, closing: null, history: null },
    { kind: "close", history, by: "debugOff" },
    { kind: "clearView" },
  );
}

/** The admitted adoption's outcome: the page's from then on, or Debug off's close, which waited for it. */
function settleAdoption(state: LifecycleState, succeeded: boolean): LifecycleOutcome {
  const settled = { ...state, adopting: false, inspecting: succeeded ? false : state.inspecting };
  // Debug off waited for it: its close carries the outcome, and only a failure reinstates the parked session.
  if (state.closing === "adoption") {
    if (state.history === null) return done({ ...settled, closing: null }, ...reopen(state));
    if (succeeded)
      return done(
        { ...settled, closing: null, history: null },
        { kind: "close", history: state.history, by: "debugOff", adoptionSucceeded: true },
        { kind: "clearView" },
        ...reopen(state),
      );
    return done(...ask({ ...settled, closing: "gate", adopted: false }, "reinstate"));
  }
  if (state.history === null) return done(settled);
  return done(settled, { kind: "adoptEnd", history: state.history, succeeded: succeeded });
}

/** Decides `event` in `state`: the state after it, and the actions to apply. */
export function advanceLifecycle(state: LifecycleState, event: LifecycleEvent): LifecycleOutcome {
  // A sealed Player decides only its last close; a lost connection sends nothing. A new session still ends the
  // inspection the page shows, which this state is the one account of.
  if (state.sealed === "loss")
    return event.kind === "newSession"
      ? done({ ...state, inspecting: false, adopting: false, step: null, returning: false })
      : done(state);
  // A loss after disposal still seals it further: nothing is sent through the lost client.
  if (state.sealed === "disposal" && event.kind === "lost")
    return done({ ...state, sealed: "loss", step: null, returning: false });
  if (state.sealed === "disposal" && event.kind !== "opened" && event.kind !== "openDue") {
    // The disposal's close took the history's holdings, a prepared candidate's included: a step ends here.
    if (
      event.kind === "stepPrepared" ||
      event.kind === "gateSettled" ||
      event.kind === "stepFailed"
    )
      return done({ ...state, step: null, returning: false });
    return done(state);
  }
  switch (event.kind) {
    case "debugOn": {
      if (state.debug) return done(state);
      if (state.blocked) return done({ ...state, debug: true });
      // Debug off is still closing the history before: the new one opens behind that close (`reopen`).
      if (state.closing !== null) return done({ ...state, debug: true, opening: event.intent });
      return done(
        { ...state, debug: true, opening: event.intent, history: null },
        { kind: "open", intent: event.intent },
      );
    }
    case "openDue":
      // Sent only while still asked for: not after a failed close, the Player's end, Debug off, or a newer ask.
      if (state.blocked || state.sealed !== null || !state.debug || event.intent !== state.opening)
        return done(state);
      return done({ ...state, sent: event.intent }, { kind: "sendOpen", intent: event.intent });
    case "opened": {
      // A newer open was sent since: the host replaced this history with it already.
      if (event.intent < state.sent) return done(state);
      if (state.sealed === "disposal")
        return done(state, { kind: "close", history: event.history, by: "disposal" });
      // Asked for by no one any more, the history this opened closes.
      if (event.intent !== state.opening || !state.debug)
        return done(
          { ...state, opening: event.intent === state.opening ? null : state.opening },
          { kind: "close", history: event.history, by: "debugOff" },
        );
      return done(
        { ...state, opening: null, history: event.history, inspecting: false },
        { kind: "enroll", history: event.history },
      );
    }
    case "openFailed":
      // Only the open asked for now has a failure to report; an obsolete one's is quiet.
      return event.intent === state.opening && event.intent >= state.sent
        ? done({ ...state, opening: null }, { kind: "reportFailure" })
        : done(state);
    case "newSession": {
      // A Start's or Continue's session: the history it replaces closes, also one Debug off still holds at its gate,
      // and a new one opens when Debug runs.
      const next = {
        ...state,
        step: abandon(state.step),
        inspecting: false,
        adopting: false,
        closing: null,
        adopted: null,
        history: null,
        // A Return or a reinstatement waiting at its gate is obsolete with the history; a step's gate settles it.
        returning: false,
        gate: { ...state.gate, return: null, reinstate: null },
      };
      const close: LifecycleAction[] =
        state.history === null
          ? []
          : [{ kind: "close", history: state.history, by: "replacement" }];
      if (!state.debug || state.blocked) return done(next, ...close, { kind: "clearView" });
      return done(
        { ...next, opening: event.intent },
        ...close,
        { kind: "clearView" },
        { kind: "open", intent: event.intent },
      );
    }
    case "retired": {
      // The history it closes takes the inspection with it: no inspected state outlives the holdings it shows.
      const next = {
        ...state,
        step: abandon(state.step),
        closing: null,
        adopted: null,
        inspecting: false,
        adopting: false,
        returning: false,
        gate: { ...state.gate, return: null, reinstate: null },
      };
      if (state.history === null && state.opening === null) return done(next);
      const close: LifecycleAction[] =
        state.history === null ? [] : [{ kind: "close", history: state.history, by: event.by }];
      if (!state.debug || state.blocked)
        return done({ ...next, history: null, opening: null }, ...close, { kind: "clearView" });
      return done(
        { ...next, history: null, opening: event.intent, inspecting: false },
        ...close,
        { kind: "clearView" },
        { kind: "open", intent: event.intent },
      );
    }
    case "lost":
      return done(
        { ...state, sealed: "loss", step: null, closing: null, returning: false },
        { kind: "readOnly" },
      );
    case "disposal": {
      const sealed = { ...state, sealed: "disposal" as const, debug: false, closing: null };
      if (state.history === null) return done(sealed);
      // Terminal: every holding of the history goes, an adoption's or a step's included, and its view with them.
      return done(
        { ...sealed, history: null },
        { kind: "close", history: state.history, by: "disposal" },
        { kind: "clearView" },
      );
    }
    case "debugOff": {
      // An open asked for stays known: its late reply closes the history it opened.
      const next = { ...state, debug: false, step: abandon(state.step) };
      // Debug off already waits for its adoption or its gate: that one decides.
      if (state.closing === "adoption" || state.closing === "gate") return done(next);
      // An adoption under way settles first; its outcome decides (`adoptionSettled`).
      if (state.adopting) return done({ ...next, closing: "adoption" });
      return debugOffClose(next);
    }
    case "stepAsked": {
      if (
        !state.debug ||
        state.blocked ||
        state.history === null ||
        state.step !== null ||
        state.adopting ||
        state.closing !== null ||
        state.returning
      )
        return done(state, { kind: "refuse" });
      return done(
        {
          ...state,
          step: { phase: "asked", token: null, abandoned: false, history: state.history },
        },
        { kind: "sendStep" },
      );
    }
    case "stepPrepared": {
      if (state.step === null || state.step.phase !== "asked") {
        // No step asked for it: its candidate goes.
        if (state.history === null) return done(state);
        return done(state, { kind: "drop", history: state.history, token: event.token });
      }
      const prepared = { ...state.step, token: event.token };
      if (prepared.abandoned || !state.debug || !event.mayShow)
        return done({ ...state, step: null }, ...exitStep({ ...state, step: prepared }));
      return done(...ask({ ...state, step: { ...prepared, phase: "gate" } }, "step"));
    }
    case "stepFailed":
      return done({ ...state, step: null });
    case "gateSettled":
      return gateSettled(state, event);
    case "commitAcknowledged":
      return done({ ...state, step: state.step?.phase === "committed" ? null : state.step });
    case "adoptionBegun": {
      // Only Debug's own restored state is adopted into its history: not while Debug off closes it, and not while a
      // step, Return or another adoption is under way.
      if (
        state.history === null ||
        !state.inspecting ||
        !state.debug ||
        state.closing !== null ||
        state.step !== null ||
        state.returning ||
        state.adopting
      )
        return decided(false, done(state));
      return decided(
        true,
        done({ ...state, adopting: true }, { kind: "adoptBegin", history: state.history }),
      );
    }
    case "adoptionSettled": {
      // Only the adoption admitted, still the page's, completes for it: one a new session or a seal took is stale.
      if (!state.adopting) return decided(false, done(state));
      return decided(true, settleAdoption(state, event.succeeded));
    }
    case "retryReinstate":
      // A reinstatement whose gate failed goes through that gate again; Debug's state stays as it was asked.
      if (state.closing !== "failed" || state.history === null) return done(state);
      return done(...ask({ ...state, closing: "gate" }, "reinstate"));
    case "return": {
      if (
        !state.debug ||
        !state.inspecting ||
        state.step !== null ||
        state.adopting ||
        state.closing !== null ||
        state.returning ||
        state.history === null
      )
        return done(state, { kind: "refuse" });
      return done(...ask({ ...state, returning: true }, "return"));
    }
    case "closeSettled": {
      return event.ok ? done(state) : done({ ...state, blocked: true, opening: null });
    }
  }
  // An event outside the closed set changes nothing.
  return done(state);
}

function gateSettled(
  state: LifecycleState,
  event: Extract<LifecycleEvent, { kind: "gateSettled" }>,
): LifecycleOutcome {
  // Only the gate still current decides: an obsolete one's success authorizes nothing, and its failure is not reported.
  if (event.id !== state.gate[event.gate]) return done(state);
  const settled = { ...state, gate: { ...state.gate, [event.gate]: null } };
  switch (event.gate) {
    case "step": {
      const { step, history } = settled;
      if (step === null || step.phase !== "gate") return done(settled);
      // Its history closed meanwhile, and the close took its candidate.
      if (step.history !== history) return done({ ...settled, step: null });
      if (step.abandoned || !event.ok || !settled.debug || !event.mayShow)
        return done({ ...settled, step: null }, ...exitStep(settled));
      // The final handoff: the commit is sent before the candidate shows, and nothing awaits between them.
      return done(
        { ...settled, step: { ...step, phase: "committed" }, inspecting: true },
        { kind: "commit", history, token: step.token! },
        { kind: "showCandidate" },
      );
    }
    case "return": {
      const ready =
        settled.returning &&
        settled.debug &&
        settled.inspecting &&
        settled.step === null &&
        !settled.adopting &&
        settled.closing === null &&
        settled.history !== null;
      // The current gate's failure is the Player's host failure to report.
      if (!event.ok)
        return done(
          { ...settled, returning: false },
          { kind: "refuse" },
          { kind: "reportFailure" },
        );
      if (!ready) return done({ ...settled, returning: false }, { kind: "refuse" });
      return done(
        { ...settled, returning: false, inspecting: false },
        { kind: "sendReturn", history: settled.history! },
        { kind: "showParked" },
      );
    }
    case "reinstate": {
      if (settled.closing !== "gate") return done(settled);
      const { history } = settled;
      // The history it closes takes a Return still waiting at its gate with it.
      const closed = { ...settled, returning: false, gate: { ...settled.gate, return: null } };
      if (history === null)
        return done({ ...closed, closing: null }, { kind: "clearView" }, ...reopen(closed));
      // A failed gate restarts nothing: the history and its sessions stay as they are, and the next open waits; its
      // failure is the Player's host failure to report.
      if (!event.ok) return done({ ...settled, closing: "failed" }, { kind: "reportFailure" });
      // The close is sent before the parked session shows.
      return done(
        { ...closed, closing: null, history: null, inspecting: false, adopted: null },
        {
          kind: "close",
          history,
          by: "debugOff",
          ...(settled.adopted === null ? {} : { adoptionSucceeded: settled.adopted }),
        },
        { kind: "showParked" },
        { kind: "clearView" },
        ...reopen(settled),
      );
    }
  }
}
