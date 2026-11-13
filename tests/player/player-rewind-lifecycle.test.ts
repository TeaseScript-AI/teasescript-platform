import assert from "node:assert/strict";
import test from "node:test";

import { advanceLifecycle, type LifecycleAction } from "../../player/debug/rewind-lifecycle.js";
import {
  explore,
  play,
  start,
  type Decide,
  type Move,
  type World,
} from "../helpers/player/rewind-lifecycle-schedules.js";

// The schedules this file drives, and the oracle that judges them: `tests/helpers/player/rewind-lifecycle-schedules.ts`.

const INITIAL = start();
const OPEN = play(INITIAL, ["debugOn", "renewed"]).world;
const INSPECTING = play(OPEN, ["stepAsked", "stepPrepared", "gateOk", "commitAcknowledged"]).world;
/** Debug off's gate A, a new session, a later inspection of its history, and Debug off's gate B: A obsolete, B current. */
const TWO_GATES = play(INSPECTING, [
  "debugOff",
  "newSession",
  "closeOk",
  "debugOn",
  "renewed",
  "stepAsked",
  "stepPrepared",
  "gateOk",
  "commitAcknowledged",
  "debugOff",
]).world;

/** The exhaustive runs, shared by the rules' test and the posting axis's coverage check. */
let exhaustiveRuns: ReturnType<typeof explore>[] | null = null;
const exhaustive = () =>
  (exhaustiveRuns ??= [explore(INITIAL, 6), explore(OPEN, 5), explore(INSPECTING, 5)]);

test("the deciding function keeps every rule over every schedule of its grammar", () => {
  assert.equal(OPEN.held, 12);
  assert.equal(INSPECTING.inspecting, true);
  const runs = exhaustive();
  assert.deepEqual(
    runs.flatMap(({ failures }) => failures),
    [],
  );
  const schedules = runs.reduce((sum, { schedules }) => sum + schedules, 0);
  assert.ok(schedules > 1_000_000, `${schedules} schedules`);
});

/** Wraps the function with one defect: the oracle must find it. */
const mutants: readonly { readonly rule: string; readonly from: World; readonly decide: Decide }[] =
  [
    {
      rule: "a prepared step left without its drop",
      from: OPEN,
      decide: (state, event) => {
        const outcome = advanceLifecycle(state, event);
        return { ...outcome, actions: outcome.actions.filter((action) => action.kind !== "drop") };
      },
    },
    {
      rule: "a Debug-off close without its adoption's outcome",
      from: INSPECTING,
      decide: (state, event) => {
        const outcome = advanceLifecycle(state, event);
        return {
          ...outcome,
          actions: outcome.actions.map((action) =>
            action.kind === "close"
              ? { kind: "close", history: action.history, by: action.by }
              : action,
          ),
        };
      },
    },
    {
      rule: "a busy Return not refused",
      from: INSPECTING,
      decide: (state, event) => {
        const outcome = advanceLifecycle(state, event);
        return event.kind === "return" && state.step !== null ? { state, actions: [] } : outcome;
      },
    },
    {
      rule: "a renewed history neither installed nor closed",
      from: INITIAL,
      decide: (state, event) => {
        const outcome = advanceLifecycle(state, event);
        return event.kind === "renewed" && !state.debug ? { ...outcome, actions: [] } : outcome;
      },
    },
    {
      rule: "a renewal after a failed close",
      from: OPEN,
      // The defect design-r1 D-03 named on the page side: a failed close does not block the next renewal.
      decide: (state, event) =>
        advanceLifecycle(
          event.kind === "closeSettled" ? state : { ...state, blocked: false },
          event,
        ),
    },
    {
      rule: "a new session's renewal does not wait for its session",
      from: OPEN,
      // The defect design-r1 D-02 named: a new session's renewal posted at once, before its session is known.
      decide: (state, event) => {
        const outcome = advanceLifecycle(state, event);
        if (event.kind !== "newSession" || !outcome.state.awaiting) return outcome;
        return {
          state: { ...outcome.state, awaiting: false, sent: event.intent },
          actions: [...outcome.actions, { kind: "renew", intent: event.intent, closes: [] }],
        };
      },
    },
    {
      rule: "a renewal waiting for its session not posted at its follow",
      from: OPEN,
      // The defect design-r1 D-02 named: an ended generation's `null` follow leaves its renewal waiting.
      decide: (state, event) =>
        event.kind === "follow" ? { state, actions: [] } : advanceLifecycle(state, event),
    },
    {
      rule: "a history left held by a new session, retirement, or disposal",
      from: INSPECTING,
      decide: (state, event) => {
        const outcome = advanceLifecycle(state, event);
        if (event.kind !== "newSession" || state.debug) return outcome;
        return { ...outcome, actions: outcome.actions.filter((action) => action.kind !== "close") };
      },
    },
    {
      rule: "a current gate's failure not reported",
      from: INSPECTING,
      // A failed reinstatement gate taken for a success: it reinstates, unreported.
      decide: (state, event) =>
        advanceLifecycle(
          state,
          event.kind === "gateSettled" && event.gate === "reinstate"
            ? { ...event, ok: true }
            : event,
        ),
    },
    {
      rule: "a failed reinstatement gate not reported once",
      from: INSPECTING,
      // Its failure reported twice.
      decide: (state, event) => {
        const outcome = advanceLifecycle(state, event);
        return event.kind === "gateSettled" && event.gate === "reinstate" && !event.ok
          ? { ...outcome, actions: [...outcome.actions, { kind: "reportFailure" }] }
          : outcome;
      },
    },
    {
      rule: "a wanted renewal's failure not reported",
      from: INITIAL,
      decide: (state, event) => {
        const outcome = advanceLifecycle(state, event);
        return {
          ...outcome,
          actions: outcome.actions.filter((action) => action.kind !== "reportFailure"),
        };
      },
    },
    {
      rule: "a commit not followed by its show",
      from: OPEN,
      decide: (state, event) => {
        const outcome = advanceLifecycle(state, event);
        return {
          ...outcome,
          actions: outcome.actions.filter((action) => action.kind !== "showCandidate"),
        };
      },
    },
    {
      rule: "a drop sent to another history",
      from: OPEN,
      decide: (state, event) => {
        const outcome = advanceLifecycle(state, event);
        if (event.kind !== "stepPrepared" || state.step === null || state.history === null)
          return outcome;
        // The defect r3's sibling had: the drop names the history open now.
        return state.step.history === state.history
          ? outcome
          : { ...outcome, actions: [{ kind: "drop", history: state.history, token: event.token }] };
      },
    },
    {
      rule: "a successful Return gate did not return",
      from: INSPECTING,
      decide: (state, event) =>
        event.kind === "gateSettled" && event.gate === "return" && event.ok
          ? { state: { ...state, returning: false }, actions: [] }
          : advanceLifecycle(state, event),
    },
    {
      rule: "a successful reinstatement gate did not reinstate",
      from: INSPECTING,
      decide: (state, event) =>
        event.kind === "gateSettled" &&
        event.gate === "reinstate" &&
        event.ok &&
        state.closing === "gate"
          ? { state, actions: [] }
          : advanceLifecycle(state, event),
    },
    {
      rule: "a failed reinstatement gate did not reinstate",
      from: INSPECTING,
      // The base's hold (#2230): the failure reported, the history and the restored state kept.
      decide: (state, event) =>
        event.kind === "gateSettled" &&
        event.gate === "reinstate" &&
        !event.ok &&
        state.closing === "gate"
          ? { state, actions: [{ kind: "reportFailure" }] }
          : advanceLifecycle(state, event),
    },
    {
      rule: "an adoption admitted that may not begin",
      from: INSPECTING,
      decide: (state, event) => {
        const outcome = advanceLifecycle(state, event);
        return event.kind === "adoptionBegun" ? { ...outcome, admitted: true } : outcome;
      },
    },
    {
      rule: "a stale adoption's completion accepted",
      from: INSPECTING,
      decide: (state, event) => {
        const outcome = advanceLifecycle(state, event);
        return event.kind === "adoptionSettled" ? { ...outcome, admitted: true } : outcome;
      },
    },
    {
      rule: "the page's inspection is not what shows",
      from: INSPECTING,
      decide: (state, event) => {
        const outcome = advanceLifecycle(state, event);
        // Stale: Return's reinstatement leaves the page inspected.
        return event.kind === "gateSettled" && event.gate === "return" && event.ok
          ? { ...outcome, state: { ...outcome.state, inspecting: state.inspecting } }
          : outcome;
      },
    },
    {
      rule: "an obsolete gate decided something",
      from: TWO_GATES,
      // The defect Sol r5 found: a gate settles by its kind alone, whichever one was asked.
      decide: (state, event) =>
        advanceLifecycle(
          state,
          event.kind === "gateSettled" && event.gate !== "step"
            ? { ...event, id: state.gate[event.gate] ?? event.id }
            : event,
        ),
    },
    {
      rule: "a renewed history neither installed nor closed",
      from: INITIAL,
      // R3-01's M1: the watermark taken from the decision, not from the posting. The reply of the renewal posted before
      // an unposted one is taken as replaced, which only a renewal posted after it does (witness 1).
      decide: (state, event) => {
        if (event.kind === "renewPosted") return { state, actions: [] };
        const outcome = advanceLifecycle(state, event);
        const renewal = outcome.actions.find((action) => action.kind === "renew");
        return renewal?.kind === "renew"
          ? { ...outcome, state: { ...outcome.state, sent: renewal.intent } }
          : outcome;
      },
    },
    {
      rule: "a history open on the host that the page neither owns nor failed to close",
      from: OPEN,
      // R3-01's M2: an unposted renewal's carried closes dropped.
      decide: (state, event) =>
        event.kind === "renewUnposted" ? { state, actions: [] } : advanceLifecycle(state, event),
    },
  ];

/** R3-01's rows, by their table: the renewals R1 to R6 and the closes C1 to C7. */
const RENEWAL_ROWS = ["R1", "R2", "R3", "R4", "R5", "R6"] as const;
const CLOSE_ROWS = ["C1", "C2", "C3", "C4", "C5", "C6", "C7"] as const;

/**
 * The table's rows no schedule of the grammar decides, and why: the coverage check below holds that none is ever met, so
 * a change that reaches one fails it.
 */
const UNREACHED: Readonly<Record<string, string>> = {
  // `closing` waits for an adoption or a gate only while a history is held: Debug off's close, a new session and a
  // retirement each end the wait (`closing` null) as they take the history, so it never settles with none.
  R3: "an adoption Debug off waited for never settles with no history",
  R6: "a reinstatement gate Debug off waited for never settles with no history",
  // A history is held only once every renewal posted before it was answered (the host's order), and none is posted
  // while it is held but the one carrying its close.
  "R4:unpost, an earlier reply held": "no renewal is unanswered while a history is held",
};

test("the posting axis meets every row of R3-01's table unposted, and the orders of both witnesses", () => {
  const met = new Set(exhaustive().flatMap((run) => [...run.met]));
  const unreached = (row: string) =>
    Object.keys(UNREACHED).some((gap) => row === gap || row.startsWith(`${gap}:`));
  assert.deepEqual([...met].filter(unreached), [], "a row the table holds unreached was met");
  const wanted = [
    ...[...RENEWAL_ROWS, ...CLOSE_ROWS].map((row) => `${row}:unpost`),
    // Witness 1's order: an unposted renewal while an earlier renewal's reply is still held.
    ...RENEWAL_ROWS.map((row) => `${row}:unpost, an earlier reply held`),
    // Witness 2's order: a carried close posted alone after its renewal could not be, then posted or not.
    ...["R4", "R5"].flatMap((row) => [
      `${row}'s carried close:post`,
      `${row}'s carried close:unpost`,
    ]),
  ];
  assert.deepEqual(
    wanted.filter((row) => !met.has(row) && !unreached(row)),
    [],
  );
  // No control is decided outside the table.
  assert.deepEqual(
    [...met].filter((row) => row.startsWith("a ")),
    [],
  );
});

test("the oracle finds each rule's defect (negative controls)", () => {
  for (const { rule, from, decide } of mutants) {
    const { failures } = explore(from, 6, decide, rule);
    assert.equal(failures.length, 1, `not found: ${rule}`);
  }
});

/** The actions of a run, flattened, as kinds with their reasons. */
const kinds = (batches: readonly { readonly actions: readonly LifecycleAction[] }[]) =>
  batches.flatMap(({ actions }) =>
    actions.map((action) => (action.kind === "close" ? `close:${action.by}` : action.kind)),
  );

test("Sol r2 B1: Debug off after the commit was sent, before its acknowledgement, reinstates the parked session", () => {
  const { batches } = play(OPEN, [
    "stepAsked",
    "stepPrepared",
    "gateOk",
    "debugOff",
    "reinstateGateOk",
  ]);
  assert.deepEqual(kinds(batches).slice(-3), ["close:debugOff", "showParked", "clearView"]);
});

test("Sol r2 B2: the Player's disposal during Debug off's gate closes as disposal, and nothing is reinstated", () => {
  const { batches } = play(INSPECTING, ["debugOff", "disposal", "reinstateGateOk"]);
  assert.deepEqual(kinds(batches), ["gate", "close:disposal", "clearView"]);
});

test("Sol r2 B3: a step whose gate rejects is dropped, and a later step may go", () => {
  const { batches } = play(OPEN, ["stepAsked", "stepPrepared", "gateRejected", "stepAsked"]);
  assert.deepEqual(kinds(batches), ["sendStep", "gate", "drop", "reportFailure", "sendStep"]);
});

test("Sol r2 B5: a clear's close that fails blocks the history it would reopen", () => {
  const { world, batches } = play(OPEN, ["retiredClear", "renewFailedClose"]);
  // The renewal carries the clear's close; its failure is reported once, and blocks.
  assert.deepEqual(kinds(batches), ["clearView", "renew", "reportFailure"]);
  const renewal = batches[0]!.actions.find((action) => action.kind === "renew");
  assert.deepEqual(renewal?.kind === "renew" && renewal.closes, [{ history: 12, by: "clear" }]);
  assert.equal(world.state.blocked, true);
  // A later Debug on and a new session renew nothing.
  assert.deepEqual(kinds(play(world, ["debugOff", "debugOn", "newSession"]).batches), [
    "clearView",
    "clearView",
  ]);
  assert.equal(play(world, ["debugOff", "debugOn", "newSession"]).world.state.awaiting, false);
});

test("Sol r2 S2 (page side): Debug off during an adoption carries its outcome", () => {
  for (const outcome of ["adoptionSucceeds", "adoptionFails"] as const) {
    const moves: Move[] = ["adoptionBegun", "debugOff", outcome];
    if (outcome === "adoptionFails") moves.push("reinstateGateOk");
    const close = play(INSPECTING, moves)
      .batches.flatMap(({ actions }) => actions)
      .find((action) => action.kind === "close");
    assert.ok(close?.kind === "close");
    assert.equal(close.adoptionSucceeded, outcome === "adoptionSucceeds", outcome);
  }
});

test("Return and a step wait for each other and for an adoption", () => {
  assert.deepEqual(kinds(play(INSPECTING, ["return", "stepAsked"]).batches), ["gate", "refuse"]);
  assert.deepEqual(kinds(play(INSPECTING, ["stepAsked", "return"]).batches), [
    "sendStep",
    "refuse",
  ]);
  assert.deepEqual(kinds(play(INSPECTING, ["adoptionBegun", "return"]).batches), [
    "adoptBegin",
    "refuse",
  ]);
});

test("Sol r3 B1: a new session or a retirement during Debug off's gate closes the history it held", () => {
  for (const [move, by] of [
    ["newSession", "replacement"],
    ["retiredClear", "clear"],
    ["retiredImport", "import"],
  ] as const) {
    const { world, batches } = play(INSPECTING, ["debugOff", move]);
    assert.deepEqual(kinds(batches), ["gate", `close:${by}`, "clearView"], move);
    assert.equal(world.held, null, move);
  }
});

test("Sol r3 B2: Debug off before the renewal's reply closes the history the reply opened", () => {
  const { batches } = play(INITIAL, ["debugOn", "debugOff", "renewed"]);
  assert.deepEqual(kinds(batches), ["renew", "clearView", "close:debugOff"]);
});

test("#2230: a failed reinstatement gate is reported once and reinstates the parked session, as its success does", () => {
  const { world, batches } = play(INSPECTING, ["debugOff", "reinstateGateRejected"]);
  assert.deepEqual(kinds(batches), [
    "gate",
    "close:debugOff",
    "showParked",
    "clearView",
    "reportFailure",
  ]);
  assert.equal(world.held, null, "the history is closed");
  assert.equal(world.state.inspecting, false, "the parked session shows");
  assert.deepEqual(kinds(play(world, ["debugOn"]).batches), ["renew"], "the next Debug on renews");
});

test("Sol r3 S1: the failure of the renewal asked for now is reported, an obsolete one's is not", () => {
  assert.deepEqual(kinds(play(INITIAL, ["debugOn", "renewFailedOpen"]).batches), [
    "renew",
    "reportFailure",
  ]);
  const moves: Move[] = ["debugOn", "newSession", "follow", "renewFailedOpen", "renewFailedOpen"];
  assert.deepEqual(kinds(play(INITIAL, moves).batches), [
    "renew",
    "clearView",
    "renew",
    "reportFailure",
  ]);
});

test("a new session's renewal waits for its session's follow, and an ended generation's null follow posts it", () => {
  const { world, batches } = play(OPEN, ["newSession"]);
  assert.deepEqual(kinds(batches), ["close:replacement", "clearView"]);
  assert.equal(world.state.awaiting, true);
  const followed = play(world, ["follow"]);
  assert.deepEqual(kinds(followed.batches), ["renew"]);
  assert.equal(followed.world.state.awaiting, false);
  // Debug off before the follow: the renewal not posted yet goes.
  const off = play(world, ["debugOff"]).world;
  assert.equal(off.state.opening, null);
  assert.equal(off.state.awaiting, false);
});

test("Debug on during Debug off's reinstatement renews at the reinstated session's follow", () => {
  const { world, batches } = play(INSPECTING, ["debugOff", "debugOn", "reinstateGateOk", "follow"]);
  assert.deepEqual(kinds(batches), ["gate", "close:debugOff", "showParked", "clearView", "renew"]);
  assert.equal(world.state.awaiting, false);
});

test("the disposal closes every history once a renewal was posted, an unanswered one's included", () => {
  assert.deepEqual(kinds(play(INITIAL, ["debugOn", "disposal", "renewed"]).batches), [
    "renew",
    "close:disposal",
    "clearView",
  ]);
  assert.deepEqual(kinds(play(INITIAL, ["disposal"]).batches), []);
});

test("a step's drop goes to the history it was sent to, and none once that history closed", () => {
  const moves: Move[] = ["stepAsked", "newSession", "closeOk", "follow", "renewed", "stepPrepared"];
  assert.deepEqual(kinds(play(OPEN, moves).batches), [
    "sendStep",
    "close:replacement",
    "clearView",
    "renew",
    "install",
  ]);
});

test("after a loss a new session still ends the inspection, clears the view, and sends nothing", () => {
  const lost = play(INSPECTING, ["lost"]);
  assert.equal(lost.world.state.inspecting, true, "the lost page keeps what it showed");
  const { world, batches } = play(lost.world, ["newSession"]);
  assert.equal(world.state.inspecting, false, "the new session is no inspection");
  assert.deepEqual(kinds(batches), ["clearView"]);
});

test("Sol r5 B1: an obsolete reinstatement gate decides nothing; only the current one reinstates, or reports its failure", () => {
  // Gate A, then a new session; gate B for a later inspection of the new history.
  for (const settle of ["reinstateGateOk", "reinstateGateRejected"] as const) {
    const world = TWO_GATES;
    assert.equal(world.gates.reinstate.length, 2, "both gates wait");
    const obsolete = play(world, [settle]);
    assert.deepEqual(kinds(obsolete.batches), [], `${settle}: A decides nothing`);
    assert.equal(obsolete.world.state.inspecting, true, `${settle}: the later inspection stands`);
    const current = play(obsolete.world, [
      settle === "reinstateGateOk" ? "reinstateGateOk" : "reinstateGateRejected",
    ]);
    assert.deepEqual(
      kinds(current.batches),
      settle === "reinstateGateOk"
        ? ["close:debugOff", "showParked", "clearView"]
        : ["close:debugOff", "showParked", "clearView", "reportFailure"],
      `${settle}: B decides`,
    );
  }
});

test("R3-01 witness 1: a renewal that could not be posted replaced nothing, so an earlier renewal's late history closes", () => {
  const { world, batches } = play(INITIAL, ["debugOn", "debugOff", "debugOn", "unpost", "renewed"]);
  assert.deepEqual(kinds(batches), [
    "renew",
    "clearView",
    "renew",
    "reportFailure",
    "close:debugOff",
  ]);
  assert.equal(world.state.sent, 11, "the newest renewal posted");
  const closed = play(world, ["closeOk"]).world;
  assert.deepEqual([...closed.host], [], "nothing stays open on the host");
  assert.equal(closed.state.blocked, false);
});

test("R3-01 witness 2: a clear's renewal that could not be posted posts its carried close alone", () => {
  // Posted: the history closes on the host, and the open's failure is the one report.
  const posted = play(OPEN, ["retiredClear", "unpost", "post", "closeOk"]);
  assert.deepEqual(kinds(posted.batches), ["clearView", "renew", "close:clear", "reportFailure"]);
  assert.deepEqual([...posted.world.host], []);
  assert.equal(posted.world.state.blocked, false);
  // Not posted either: the failed close blocks and is the one report; the host keeps the history, owed, as at the base.
  const unposted = play(OPEN, ["retiredClear", "unpost", "unpost"]);
  assert.deepEqual(kinds(unposted.batches), ["clearView", "renew", "close:clear", "reportFailure"]);
  assert.deepEqual([...unposted.world.host], [12]);
  assert.equal(unposted.world.state.blocked, true);
});
