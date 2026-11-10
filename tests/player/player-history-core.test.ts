import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

import { createPlayerRuntimeSession } from "../../player/runtime/compile-project.js";
import {
  CANNOT_KEEP,
  HistoryCore,
  advanceHistory,
  decideAdmission,
  transferLineages,
  type HistoryDelta,
  type HistoryObservation,
  type HistoryOutcome,
  type InspectionState,
  type LineageTransition,
  type PublicationCandidate,
} from "../../player/engine-bridge/history/core.js";
import {
  observePlayerRuntimeTime,
  playerRuntimeSnapshotJson,
  restorePlayerRuntimeSessionAt,
  selectPlayerRuntimeChoice,
  type PlayerRuntimeSession,
} from "../../player/runtime/runtime-adapter.js";
import { playerRuntimeForeground } from "../../player/runtime/runtime-view.js";
import { deliveryOwner } from "../../player/engine-bridge/delivery.js";
import { HistoryRegistry } from "../../player/engine-bridge/history/registry.js";
import { DebugHistoryView } from "../../player/debug/debug-history.js";
import type { HistoryMarks } from "../../player/debug/debug-history-marks.js";
import { CheckpointError } from "../../src/runtime/snapshot/checkpoint-json.js";
import { obligations, transferCoverage } from "../helpers/player/rewind-transfer-domain.js";
import { coverageGaps, product, type Coordinates } from "../helpers/family-coverage.js";

/*
 * L5i.6's host history core (`player/engine-bridge/history/core.ts`), at its own layer: the lineage transfers agree
 * with the declared domain (`helpers/player/rewind-transfer-domain.ts`), a point's state and position come from one
 * publication (#1981), admission and its stops, response routing, the steps' effects, closing, and that only
 * `advance` writes the core's state.
 */

const NO_MARKS: HistoryMarks = { editedWhileDebugging: null, rewoundWhileDebugging: null };

/** The core's transition and the inspection state an obligation names. */
function moveOf(transition: string, variant: string, caseName: string): LineageTransition {
  switch (transition) {
    case "back":
    case "forward":
    case "return":
    case "adopt begun":
      return { transition };
    case "adopt ended":
      return { transition, succeeded: variant.startsWith("succeeded") };
    default: {
      const by = transition.replace("close by ", "");
      assert.ok(
        ["debugOff", "replacement", "import", "clear", "disposal"].includes(by),
        transition,
      );
      return {
        transition: "close",
        // EVIDENCE: validation: checked as one of the close reasons above.
        by: by as "debugOff",
        ...(caseName.includes("success")
          ? { adoptionSucceeded: true }
          : caseName.includes("failure")
            ? { adoptionSucceeded: false }
            : {}),
      };
    }
  }
}

test("transferLineages agrees with every declared transfer obligation", () => {
  const all = obligations();
  const decided = all.filter((each) => !each.case.endsWith("guard fails"));
  const checked: string[] = [];
  for (const each of decided) {
    const outcome = transferLineages(
      moveOf(each.transition, each.variant, each.case),
      // EVIDENCE: validation: the generator's states are the core's `InspectionState` names.
      each.inspection as InspectionState,
    );
    const expected =
      each.expect.kind === "transfer"
        ? { kind: "transfer", parked: each.expect.parked, shown: each.expect.shown }
        : { kind: each.expect.kind };
    assert.deepEqual(outcome, expected, each.key);
    checked.push(each.key);
  }
  // Guard failures leave ownership unchanged before any transfer is decided: they are the op adapter's (slice 3).
  const guards = all.filter((each) => each.case.endsWith("guard fails")).map((each) => each.key);
  assert.deepEqual(transferCoverage(all, [...checked, ...guards]), { missing: [], unexpected: [] });
  assert.equal(guards.length, 11);
});

// The sessions the core sees, as the host holds them.
const SCRIPT =
  'let a = askChoice "A1", "A2"\nwait 1 s\nlet b = askChoice "B1", "B2"\nwait 1 s\nlet c = askChoice "C1", "C2"\nsay "done", instant\nexit';

function candidate(
  session: PlayerRuntimeSession,
  marks = NO_MARKS,
  log = "s1",
): PublicationCandidate {
  return { session, log, marks, snapshotJson: () => playerRuntimeSnapshotJson(session) };
}
function choose(session: PlayerRuntimeSession, index = 0): PlayerRuntimeSession {
  const foreground = playerRuntimeForeground(session);
  assert.ok(foreground?.kind === "choose");
  return selectPlayerRuntimeChoice(session, foreground.options[index]!.id)!.session;
}
function advanced(outcome: HistoryOutcome): Extract<HistoryOutcome, { kind: "advanced" }> {
  if (outcome.kind === "refused") assert.fail(outcome.reason);
  return outcome;
}
const core = (budget?: number, notify?: (delta: HistoryDelta | null) => void) =>
  new HistoryCore(1, 1, () => Promise.resolve(null), budget, notify);

/** Plays the script to its three asks, giving each publication to `history`, and returns the publications. */
function play(history: HistoryCore) {
  // Each publication with its event count and time as published: later publications grow the shared event array.
  const sessions: { session: PlayerRuntimeSession; eventCount: number; sceneTimeMs: number }[] = [];
  let session = createPlayerRuntimeSession(SCRIPT);
  const publish = (next: PlayerRuntimeSession) => {
    sessions.push({
      session: next,
      eventCount: next.events.length,
      sceneTimeMs: next.state.observedSessionTimeMs,
    });
    advanceHistory(history, { kind: "publication", candidate: candidate(next) });
    return next;
  };
  session = publish(session);
  session = publish(choose(session));
  session = publish(observePlayerRuntimeTime(session, 1_000).session);
  session = publish(choose(session, 1));
  session = publish(observePlayerRuntimeTime(session, 2_000).session);
  return { sessions, last: session };
}

test("each point's state and position come from its own publication (#1981)", async () => {
  const history = core();
  const { sessions } = play(history);
  const { points } = history.timeline();
  assert.deepEqual(points.map((point) => point.actionId).length, 3);
  for (const point of points) {
    const found = sessions.find(
      (each) => each.eventCount === point.eventCount && each.sceneTimeMs === point.sceneTimeMs,
    );
    assert.ok(found, `point ${point.id} names a publication`);
    const published = found.session;
    // The JSON is that publication's: restoring it reaches the same observed time.
    const restored = restorePlayerRuntimeSessionAt(
      published.plan,
      await history.snapshot(point.id),
      published.events.slice(0, point.eventCount),
      null,
      null,
    );
    assert.equal(restored.state.observedSessionTimeMs, point.sceneTimeMs);
  }
});

test("enrolling with no qualifying interaction takes no point and leaves no debt; the next interaction is a point", () => {
  const history = core();
  let session = createPlayerRuntimeSession('wait 1 s\nlet a = askChoice "A1", "A2"\nexit');
  assert.deepEqual(
    advanced(advanceHistory(history, { kind: "enrollCurrent", candidate: candidate(session) }))
      .delta,
    null,
  );
  assert.equal(history.timeline().points.length, 0);
  session = observePlayerRuntimeTime(session, 1_000).session;
  advanceHistory(history, { kind: "publication", candidate: candidate(session) });
  assert.equal(history.timeline().points.length, 1);
});

test("a repeated interaction is no second point; its answer links to its retained point", () => {
  const history = core();
  const session = createPlayerRuntimeSession(SCRIPT);
  advanceHistory(history, { kind: "publication", candidate: candidate(session) });
  advanceHistory(history, { kind: "publication", candidate: candidate(session) });
  assert.equal(history.timeline().points.length, 1);
  const delta = advanced(
    advanceHistory(history, { kind: "publication", candidate: candidate(choose(session)) }),
  ).delta!;
  assert.equal(delta.responses.length, 1);
  assert.equal(delta.responses[0]!.point, history.timeline().points[0]!.id);
  assert.equal(history.timeline().points[0]!.response?.text, "A1");
});

test("after collection stopped, a later answer still links to its retained point", () => {
  const history = core();
  const session = createPlayerRuntimeSession(SCRIPT);
  advanceHistory(history, { kind: "publication", candidate: candidate(session) });
  advanced(advanceHistory(history, { kind: "stopCollection", reason: "a test stop" }));
  assert.equal(history.timeline().complete, false);
  const delta = advanced(
    advanceHistory(history, { kind: "publication", candidate: candidate(choose(session)) }),
  ).delta!;
  assert.deepEqual(delta.appended, [], "no point after the stop");
  assert.equal(delta.responses[0]?.point, history.timeline().points[0]!.id);
  assert.equal(history.timeline().points[0]!.response?.text, "A1");
});

test("a state too large to save, another export failure, and a full budget each stop collection with the prefix kept", () => {
  for (const failure of ["TSK004", "other", "budget"] as const) {
    const history = core(failure === "budget" ? 1 : undefined);
    const session = createPlayerRuntimeSession(SCRIPT);
    const outcome = advanced(
      advanceHistory(history, {
        kind: "publication",
        candidate: {
          ...candidate(session),
          snapshotJson: () => {
            if (failure === "TSK004")
              throw new CheckpointError({ code: "TSK004", message: "too large", path: "$" });
            if (failure === "other") throw new Error("broken");
            return playerRuntimeSnapshotJson(session);
          },
        },
      }),
    );
    assert.equal(outcome.delta?.complete, false, failure);
    assert.equal(history.timeline().complete, false);
    assert.equal(history.timeline().points.length, 0);
    // No later point is taken.
    advanceHistory(history, {
      kind: "publication",
      candidate: candidate(observePlayerRuntimeTime(choose(session), 1_000).session),
    });
    assert.equal(history.timeline().points.length, 0, failure);
  }
});

test("a spill write's failure stops collection and is notified with its delta", async () => {
  const deltas: (HistoryDelta | null)[] = [];
  const failing = {
    put: async () => {
      throw new DOMException("full", "QuotaExceededError");
    },
    get: async () => undefined,
    delete: async () => {},
    destroy: async () => {},
  };
  const history = new HistoryCore(
    1,
    1,
    () => Promise.resolve(failing),
    undefined,
    (delta) => deltas.push(delta),
  );
  await new Promise((resolve) => setImmediate(resolve));
  advanceHistory(history, {
    kind: "publication",
    candidate: candidate(createPlayerRuntimeSession(SCRIPT)),
  });
  for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0]?.complete, false);
  assert.equal(history.timeline().points.length, 1, "the admitted point stays");
});

/**
 * A step, as the host and the page take it: prepared, then committed with `candidate` the lineage its restored state
 * runs in. A refused preparation is the outcome.
 */
function stepTo(
  history: HistoryCore,
  step: Omit<Extract<HistoryObservation, { kind: "prepare" }>, "kind">,
  candidate: string,
): HistoryOutcome {
  const prepared = advanceHistory(history, { kind: "prepare", ...step });
  if (prepared.kind === "refused") return prepared;
  return advanceHistory(history, { kind: "commit", step: prepared.step!, candidate });
}

/** A history with three points, the live lineage `live`, ready for steps. */
function stepping() {
  const history = core();
  const { last } = play(history);
  const points = history.timeline().points;
  const parked = {
    lineage: "live",
    position: { log: "s1", eventCount: last.events.length, sceneTimeMs: 2_000, marks: NO_MARKS },
    json: playerRuntimeSnapshotJson(last),
    lastSequence: last.events.at(-1)?.sequence ?? -1,
  };
  return { history, points, parked };
}

test("Back by a point's ID parks the live lineage, Forward returns, Return reinstates and releases the restored ones", () => {
  const { history, points, parked } = stepping();
  const back = advanced(stepTo(history, { move: "back", point: points[1]!.id, parked }, "r1"));
  assert.deepEqual(back.effects.show, "r1");
  assert.equal(back.effects.marks?.rewoundWhileDebugging?.rewindCount, 1);
  assert.equal(history.inspectionState, "inspecting with a future");
  assert.equal(history.timeline().inspection?.points, 2);
  assert.deepEqual(back.effects.release, [], "the first Back parks the live lineage");
  // A second Back keeps the state shown for Forward, and releases its restored lineage.
  const again = advanced(stepTo(history, { move: "back", point: points[0]!.id }, "r2"));
  assert.deepEqual(again.effects.release, ["r1"]);
  // The point shown now is not before the state shown: refused.
  assert.equal(stepTo(history, { move: "back", point: points[0]!.id }, "r5").kind, "refused");
  // A point that does not lead to the state shown is refused.
  assert.equal(stepTo(history, { move: "back", point: points[2]!.id }, "r3").kind, "refused");
  const forward = advanced(stepTo(history, { move: "forward" }, "r4"));
  assert.equal(forward.effects.show, "r4");
  assert.deepEqual(forward.effects.release, ["r2"]);
  const returned = advanced(advanceHistory(history, { kind: "return" }));
  assert.equal(returned.effects.live, "live");
  assert.equal(history.inspectionState, "not inspecting");
  assert.deepEqual(returned.effects.release, ["r4"]);
});

test("Forward with no future, and Return or an adoption while not inspecting, are refused and change nothing", () => {
  const { history } = stepping();
  const revision = history.revision;
  for (const observation of [
    { kind: "prepare", move: "forward" },
    { kind: "return" },
    { kind: "adoptBegun" },
    { kind: "adoptEnded", succeeded: true },
  ] as const)
    assert.equal(advanceHistory(history, observation).kind, "refused", observation.kind);
  assert.equal(history.revision, revision);
});

test("an adoption truncates the future by point ID and links later answers to the retained point", () => {
  const { history, points, parked } = stepping();
  stepTo(history, { move: "back", point: points[1]!.id, parked }, "r1");
  advanced(advanceHistory(history, { kind: "adoptBegun" }));
  assert.equal(history.inspectionState, "adopting");
  const adopted = advanced(advanceHistory(history, { kind: "adoptEnded", succeeded: true }));
  assert.equal(adopted.effects.live, "r1");
  assert.ok(adopted.effects.release.includes("live"));
  assert.equal(adopted.delta?.retained, 2);
  assert.deepEqual(
    history.timeline().points.map((point) => point.id),
    [points[0]!.id, points[1]!.id],
    "the same points, by ID",
  );
  // Back by ID after the truncation restores the same point.
  assert.equal(history.pointBefore(points[0]!.id)?.id, points[0]!.id);
});

test("a failed adoption leaves the restored state inspected", () => {
  const { history, points, parked } = stepping();
  stepTo(history, { move: "back", point: points[0]!.id, parked }, "r1");
  advanceHistory(history, { kind: "adoptBegun" });
  advanced(advanceHistory(history, { kind: "adoptEnded", succeeded: false }));
  assert.equal(history.inspectionState, "inspecting with a future");
});

test("closing: Debug off reinstates the parked lineage; a replacement retires it; a clear while inspecting is refused", () => {
  for (const by of ["debugOff", "replacement", "clear", "disposal"] as const) {
    const { history, points, parked } = stepping();
    stepTo(history, { move: "back", point: points[0]!.id, parked }, "r1");
    const outcome = advanceHistory(history, { kind: "close", by, bound: "s1" });
    if (by === "clear") {
      assert.equal(outcome.kind, "refused");
      assert.equal(history.closed, false);
      continue;
    }
    const { effects } = advanced(outcome);
    assert.equal(effects.live, by === "debugOff" ? "live" : null, by);
    assert.ok(effects.release.includes("r1"), by);
    assert.equal(effects.release.includes("live"), by !== "debugOff", by);
    assert.equal(history.closed, true);
    assert.equal(
      advanceHistory(history, {
        kind: "publication",
        candidate: candidate(createPlayerRuntimeSession(SCRIPT)),
      }).kind,
      "refused",
    );
  }
});

test("each point freezes the marks of its publication", () => {
  const history = core();
  const marks: HistoryMarks = {
    editedWhileDebugging: { firstEditSceneTimeMs: 5, editCount: 2 },
    rewoundWhileDebugging: null,
  };
  advanceHistory(history, {
    kind: "publication",
    candidate: candidate(createPlayerRuntimeSession(SCRIPT), marks),
  });
  assert.deepEqual(history.timeline().points[0]!.marks, marks);
});

test("only advance writes the core's state: its dispatcher alone calls each kind's method, once", () => {
  const text = readFileSync(
    new URL("../../../player/engine-bridge/history/core.ts", import.meta.url),
    "utf8",
  );
  const file = ts.createSourceFile("core.ts", text, ts.ScriptTarget.Latest, true);
  // The class member a node is in, by name.
  const memberOf = (node: ts.Node): string => {
    let at: ts.Node | undefined = node;
    while (at !== undefined && !ts.isClassElement(at)) at = at.parent;
    if (at === undefined) return "(outside a method)";
    return ts.isConstructorDeclaration(at)
      ? "constructor"
      : (at.name?.getText(file) ?? "(unnamed)");
  };
  // `#advance` dispatches each observation to its kind's method; six return their change to `#delta`.
  const kinds = [
    "#undoPublication",
    "#publish",
    "#prepare",
    "#commit",
    "#drop",
    "#return",
    "#adoptBegun",
    "#adoptEnded",
    "#stopCollection",
    "#close",
    "#refuseUnknown",
    "#delta",
  ];
  const shared = ["#forget", "#linkResponses", "#stop"];
  const writers = new Set<string>();
  // Each governed method's admitted call sites, by the member each is in; any other reference to one is an escape.
  const governed = new Set(["#advance", ...kinds, ...shared]);
  const callers = new Map<string, string[]>();
  const escapes: string[] = [];
  file.forEachChild(function visit(node): void {
    const assigned =
      (ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ? node.left
        : undefined) ??
      // Only `++` and `--` write; `!` and unary arithmetic read.
      ((ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
        ? node.operand
        : undefined);
    const mutating =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["push", "pop", "set", "delete", "add"].includes(node.expression.name.text)
        ? node.expression.expression
        : undefined;
    const target = assigned ?? mutating;
    if (target !== undefined && /this\.#|inspecting|inspecting!/u.test(target.getText(file)))
      writers.add(memberOf(node));
    // Every reference to a governed name but its method's own declaration. The one admitted form is a call
    // `this.#method(...)` directly in a member of the core, outside any nested function; every other form escapes.
    const { parent } = node;
    if (
      ts.isPrivateIdentifier(node) &&
      governed.has(node.text) &&
      !(ts.isMethodDeclaration(parent) && parent.name === node)
    ) {
      const site = ts.findAncestor(parent, ts.isFunctionLike);
      const direct =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent &&
        site !== undefined &&
        ts.isClassElement(site) &&
        ts.isClassDeclaration(site.parent) &&
        site.parent.name?.text === "HistoryCore";
      if (direct) callers.set(node.text, [...(callers.get(node.text) ?? []), memberOf(node)]);
      else {
        const form = ts.isPropertyAccessExpression(parent) ? parent.parent : parent;
        escapes.push(`${memberOf(node)}: ${form.getText(file).split("\n")[0]}`);
      }
    }
    node.forEachChild(visit);
  });
  assert.deepEqual(
    escapes,
    [],
    "a governed method is referenced only by a direct `this.#method(...)` call",
  );
  assert.deepEqual(
    [...writers].sort(),
    [
      ...kinds.filter((kind) => kind !== "#stopCollection"),
      ...shared,
      "advance",
      "constructor",
    ].sort(),
  );
  // `#advance` is `advance`'s body, which it wraps with the mutation count; each kind's method is called once, from the
  // dispatcher; the shared writers are reached only through the kinds' methods.
  assert.deepEqual(callers.get("#advance"), ["advance"], "#advance");
  for (const kind of kinds) assert.deepEqual(callers.get(kind), ["#advance"], kind);
  for (const helper of shared) {
    const sites = callers.get(helper) ?? [];
    assert.ok(
      sites.length > 0 && sites.every((site) => kinds.includes(site)),
      `${helper}: ${sites.join(", ")}`,
    );
  }
});

test("the admission policy: skip while not collecting, without an interaction or for one already taken; else admit or stop", () => {
  const session = createPlayerRuntimeSession(SCRIPT);
  const open = { collecting: true, newestActionId: -1, fits: () => true };
  assert.equal(decideAdmission(open, candidate(session)).kind, "admit");
  assert.equal(decideAdmission({ ...open, collecting: false }, candidate(session)).kind, "skip");
  assert.equal(
    decideAdmission({ ...open, newestActionId: 1_000_000 }, candidate(session)).kind,
    "skip",
  );
  assert.equal(decideAdmission({ ...open, fits: () => false }, candidate(session)).kind, "stop");
  const waiting = createPlayerRuntimeSession("wait 1 s\nexit");
  assert.equal(decideAdmission(open, candidate(waiting)).kind, "skip");
});

/*
 * The transition family over one declaration of the grammar (L5i.6): what the subject publication presents (no
 * interaction, a new one, or the one retained), how its capture ends, the terminal transition (a stop, or a close) and
 * whether the subject comes before or after it. A reference model gives each case's points, responses, completeness,
 * frozen marks and restored state; the coverage check binds the cases run to the feasible declaration.
 */
const GRAMMAR = {
  action: ["none", "new", "retained"],
  capture: ["ok", "TSK004", "other", "budget"],
  terminal: ["none", "stop", "close"],
  order: ["subject first", "terminal first"],
} as const;
type GrammarCase = { readonly [Axis in keyof typeof GRAMMAR]: (typeof GRAMMAR)[Axis][number] };
/** Only a new interaction is captured; with no terminal transition there is one order. */
const grammarFeasible = ({ action, capture, terminal, order }: Coordinates) =>
  !(action !== "new" && capture !== "ok") && !(terminal === "none" && order === "terminal first");
/** Every feasible case of the declaration. */
function grammarCases(): GrammarCase[] {
  const cases: GrammarCase[] = [];
  for (const action of GRAMMAR.action)
    for (const capture of GRAMMAR.capture)
      for (const terminal of GRAMMAR.terminal)
        for (const order of GRAMMAR.order) {
          const each: GrammarCase = { action, capture, terminal, order };
          if (grammarFeasible(each)) cases.push(each);
        }
  return cases;
}
const GRAMMAR_CASES = grammarCases();
const grammarRun: Coordinates[] = [];
const EDITED: HistoryMarks = {
  editedWhileDebugging: { firstEditSceneTimeMs: 0, editCount: 1 },
  rewoundWhileDebugging: null,
};

for (const each of GRAMMAR_CASES)
  test(`a history transition: ${Object.values(each).join(", ")}`, async () => {
    // The answer leaves no interaction, or presents the next at once.
    const source =
      each.action === "none"
        ? 'let a = askChoice "A1", "A2"\nwait 1 s\nlet b = askChoice "B1", "B2"\nexit'
        : 'let a = askChoice "A1", "A2"\nlet b = askChoice "B1", "B2"\nexit';
    const first = createPlayerRuntimeSession(source);
    const firstJson = playerRuntimeSnapshotJson(first);
    const firstEvents = first.events.length;
    // A budget the first point fits and a second does not.
    const history = core(each.capture === "budget" ? firstJson.length + 1 : undefined);
    advanced(advanceHistory(history, { kind: "publication", candidate: candidate(first) }));
    const subject = each.action === "retained" ? first : choose(first);
    const subjectView = {
      sceneTimeMs: subject.state.observedSessionTimeMs,
      actionId: subject.state.foregroundAction?.actionId ?? null,
      events: subject.events.length,
    };
    const subjectCandidate: PublicationCandidate = {
      ...candidate(subject, EDITED),
      snapshotJson: () => {
        if (each.capture === "TSK004")
          throw new CheckpointError({ code: "TSK004", message: "too large", path: "$" });
        if (each.capture === "other") throw new Error("broken");
        return playerRuntimeSnapshotJson(subject);
      },
    };
    const terminal = () => {
      if (each.terminal === "stop")
        advanced(advanceHistory(history, { kind: "stopCollection", reason: "a stop" }));
      if (each.terminal === "close")
        advanced(advanceHistory(history, { kind: "close", by: "debugOff", bound: "s1" }));
    };
    if (each.order === "terminal first") terminal();
    const outcome = advanceHistory(history, { kind: "publication", candidate: subjectCandidate });
    // The timeline as the subject left it, and its snapshots, read before any later close releases them.
    const left = history.timeline();
    const snapshots = await Promise.all(left.points.map((point) => history.snapshot(point.id)));
    if (each.order === "subject first") terminal();

    // The reference model.
    const closedFirst = each.terminal === "close" && each.order === "terminal first";
    const collecting = !(each.terminal === "stop" && each.order === "terminal first");
    const captured = each.action === "new" && collecting && !closedFirst;
    const newPoint = captured && each.capture === "ok";
    const answered = each.action !== "retained";
    const capturedComplete = !(captured && each.capture !== "ok");

    assert.equal(
      outcome.kind,
      closedFirst ? "refused" : "advanced",
      "a closed history takes nothing",
    );
    if (closedFirst) assert.deepEqual(left.points, [], "a closed history holds no points");
    else {
      assert.equal(left.points.length, newPoint ? 2 : 1, "the points");
      assert.equal(left.complete, collecting && capturedComplete, "complete");
      assert.equal(left.points[0]!.response?.text ?? null, answered ? "A1" : null, "the answer");
      // Each point keeps the marks and state of its own publication; the prefix stays restorable.
      assert.deepEqual(left.points[0]!.marks, NO_MARKS);
      assert.equal(left.points[0]!.eventCount, firstEvents);
      const restoredFirst = restorePlayerRuntimeSessionAt(
        first.plan,
        snapshots[0]!,
        first.events.slice(0, firstEvents),
        null,
        null,
      );
      assert.equal(restoredFirst.state.foregroundAction?.actionId, left.points[0]!.actionId);
      if (newPoint) {
        const second = left.points[1]!;
        assert.deepEqual(second.marks, EDITED);
        assert.deepEqual(
          { sceneTimeMs: second.sceneTimeMs, actionId: second.actionId, events: second.eventCount },
          subjectView,
        );
        const restored = restorePlayerRuntimeSessionAt(
          subject.plan,
          snapshots[1]!,
          subject.events.slice(0, second.eventCount),
          null,
          null,
        );
        assert.equal(restored.state.foregroundAction?.actionId, second.actionId);
        assert.equal(restored.state.observedSessionTimeMs, second.sceneTimeMs);
      }
    }
    // After the terminal transition: a stop keeps the prefix and takes no more; a close releases everything.
    const after = history.timeline();
    if (each.terminal === "close") {
      assert.deepEqual(after.points, [], "a close releases the points");
      await assert.rejects(history.snapshot(1), "and their snapshots");
    } else {
      assert.deepEqual(after.points, left.points);
      if (each.terminal === "stop") assert.equal(after.complete, false);
    }
    grammarRun.push(each);
  });

test("the transition family ran every feasible case of its declaration", () => {
  assert.deepEqual(
    coverageGaps(product(GRAMMAR).filter(grammarFeasible), grammarRun, { tuples: true }),
    [],
  );
  assert.equal(GRAMMAR_CASES.length, 30);
});

test("an observation outside the closed set is refused and stops collection with the prefix kept", () => {
  const history = core();
  advanceHistory(history, {
    kind: "publication",
    candidate: candidate(createPlayerRuntimeSession(SCRIPT)),
  });
  // EVIDENCE: validation: deliberately outside the observation union, as only an untyped caller could send it.
  const outcome = advanceHistory(history, JSON.parse('{"kind":"unknown"}') as HistoryObservation);
  assert.equal(outcome.kind, "refused");
  assert.match(outcome.kind === "refused" ? outcome.reason : "", /unknown observation/u);
  assert.equal(history.timeline().complete, false);
  assert.equal(history.timeline().points.length, 1);
  // EVIDENCE: validation: deliberately outside the transition union, as only an untyped caller could send it.
  const move = JSON.parse('{"transition":"unknown"}') as LineageTransition;
  assert.equal(transferLineages(move, "not inspecting").kind, "refused");
});

test("a prepared step changes nothing until its commit: no delta, no release, no inspection, and the reservation counted", () => {
  const { history, points, parked } = stepping();
  const before = history.timeline();
  const prepared = advanced(
    advanceHistory(history, { kind: "prepare", move: "back", point: points[1]!.id, parked }),
  );
  assert.equal(prepared.delta, null);
  assert.deepEqual(prepared.effects.release, []);
  assert.equal(prepared.effects.show, null);
  // The restored state's marks come with the preparation, before its introduction.
  assert.equal(prepared.effects.marks?.rewoundWhileDebugging?.rewindCount, 1);
  assert.equal(history.inspectionState, "not inspecting");
  assert.equal(history.revision, before.revision);
  assert.equal(history.timeline().memoryChars, before.memoryChars + parked.json.length);
  // A publication meanwhile leaves the pending step alone.
  advanceHistory(history, {
    kind: "publication",
    candidate: candidate(createPlayerRuntimeSession(SCRIPT)),
  });
  assert.equal(history.pendingStep, prepared.step);
  // Return, an adoption and another step wait for it.
  for (const observation of [
    { kind: "return" },
    { kind: "adoptBegun" },
    { kind: "prepare", move: "back", point: points[0]!.id, parked },
  ] as const)
    assert.equal(advanceHistory(history, observation).kind, "refused", observation.kind);
  const committed = advanced(
    advanceHistory(history, { kind: "commit", step: prepared.step!, candidate: "r1" }),
  );
  assert.equal(committed.effects.show, "r1");
  assert.equal(history.inspectionState, "inspecting with a future");
  assert.equal(history.pendingStep, null);
});

test("a drop releases only the candidate and the reservation; a consumed or foreign token changes nothing", () => {
  const { history, points, parked } = stepping();
  const before = history.timeline();
  const prepared = advanced(
    advanceHistory(history, { kind: "prepare", move: "back", point: points[1]!.id, parked }),
  );
  const step = prepared.step!;
  assert.equal(
    advanceHistory(history, { kind: "commit", step: step + 1, candidate: "x" }).kind,
    "refused",
    "a foreign token commits nothing",
  );
  const dropped = advanced(advanceHistory(history, { kind: "drop", step, candidate: "r1" }));
  assert.deepEqual(dropped.effects.release, ["r1"]);
  assert.equal(history.timeline().memoryChars, before.memoryChars);
  assert.deepEqual(history.timeline(), before);
  // A repeated drop is harmless, and a consumed token commits nothing.
  assert.deepEqual(
    advanced(advanceHistory(history, { kind: "drop", step, candidate: "r1" })).effects.release,
    [],
  );
  assert.equal(advanceHistory(history, { kind: "commit", step, candidate: "r1" }).kind, "refused");
  // Tokens are not taken again.
  const next = advanced(
    advanceHistory(history, { kind: "prepare", move: "back", point: points[1]!.id, parked }),
  );
  assert.notEqual(next.step, step);
});

test("a close takes a pending step's candidate with it", () => {
  const { history, points, parked } = stepping();
  advanced(
    advanceHistory(history, { kind: "prepare", move: "back", point: points[1]!.id, parked }),
  );
  const closed = advanced(
    advanceHistory(history, { kind: "close", by: "debugOff", candidate: "r1", bound: "s1" }),
  );
  assert.deepEqual(closed.effects.release, ["r1"]);
  assert.equal(history.closed, true);
});

test("the first Back's parked state is reserved within the admission bound, or the step is refused before anything", () => {
  const history = core();
  const { last } = play(history);
  const json = playerRuntimeSnapshotJson(last);
  const tight = core(history.timeline().memoryChars + json.length - 1);
  play(tight);
  const { points } = tight.timeline();
  const refused = advanceHistory(tight, {
    kind: "prepare",
    move: "back",
    point: points[1]!.id,
    parked: {
      lineage: "live",
      position: { log: "s1", eventCount: last.events.length, sceneTimeMs: 2_000, marks: NO_MARKS },
      json,
      lastSequence: last.events.at(-1)?.sequence ?? -1,
    },
  });
  assert.deepEqual(refused, { kind: "refused", reason: CANNOT_KEEP });
  assert.equal(tight.pendingStep, null);
});

/*
 * A publication's undo and its guard (`HistoryCore.undoPublication`). Through the real ops a publication and its
 * delivery's end come with nothing between them: every publishing op is synchronous from its publication to its reply's
 * post (`player-history-ops.test.ts`). So the guard is decided here, on the registry and a delivery owner of its own: a
 * later change, made and posted before the failed delivery's undo runs, must stand.
 */
function guardRow(later: "publication" | "step"): void {
  const owner = deliveryOwner();
  const registry = new HistoryRegistry(owner);
  const opened = owner.begin();
  registry.open(1);
  owner.commit(opened);
  const held = { historyKey: "l1", marks: NO_MARKS };
  let session = createPlayerRuntimeSession(SCRIPT);
  // The publication whose reply will fail: the first ask's point.
  const failing = owner.begin();
  registry.observePublication(held, session);
  const [point] = registry.core(1)!.timeline().points;
  // A later change before its undo, in a delivery of its own that posts: the next ask's publication, or a Back that
  // prepares a step to that point, which changes no field the publication changed.
  const posted = owner.begin();
  if (later === "publication") {
    session = observePlayerRuntimeTime(choose(session), 1_000).session;
    registry.observePublication(held, session);
  } else {
    const prepared = registry.advance(1, {
      kind: "prepare",
      move: "back",
      point: point!.id,
      parked: {
        lineage: "l1",
        position: { log: "l1", eventCount: session.events.length, sceneTimeMs: 0, marks: NO_MARKS },
        json: playerRuntimeSnapshotJson(session),
        lastSequence: session.events.at(-1)?.sequence ?? -1,
      },
    });
    assert.notEqual(prepared.outcome.kind, "refused", "Back prepares a step to the point");
  }
  owner.commit(posted);
  const after = registry.core(1)!.timeline();
  owner.rollback(failing);
  assert.deepEqual(registry.core(1)!.timeline(), after, `the later ${later} stands`);
  assert.equal(registry.bound(1), "l1", "and so does the binding");
  if (later === "step")
    assert.notEqual(registry.core(1)!.pendingStep, null, "the step is still prepared");
}

for (const later of ["publication", "step"] as const)
  test(`a failed publication's undo leaves a later ${later} standing (its guard)`, () =>
    guardRow(later));

test("a publication's undo without its guard overwrites the later change (negative control)", () => {
  const guard = Object.getOwnPropertyDescriptor(HistoryCore.prototype, "unchangedSince")!;
  Object.defineProperty(HistoryCore.prototype, "unchangedSince", { ...guard, value: () => true });
  try {
    for (const later of ["publication", "step"] as const)
      assert.throws(() => guardRow(later), assert.AssertionError, later);
  } finally {
    Object.defineProperty(HistoryCore.prototype, "unchangedSince", guard);
  }
});

/*
 * A spill failure's notice and a failed reply (`HistoryRegistry.observePublication`): a publication takes the deltas a
 * failed spill write left, and when its reply is never posted they go back, so the page still learns that collection
 * stopped from the next publication.
 */
async function owedRow(): Promise<void> {
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const owner = deliveryOwner();
  let failWrite!: (error: Error) => void;
  const write = new Promise<void>((_, fail) => (failWrite = fail));
  const spill = {
    put: () => write,
    get: async () => undefined,
    delete: async () => {},
    destroy: async () => {},
  };
  const registry = new HistoryRegistry(owner, async () => spill);
  const delivered = <T>(run: () => T): T => {
    const delivery = owner.begin();
    const result = run();
    owner.commit(delivery);
    return result;
  };
  const opened = delivered(() => registry.open(1))!;
  await turn();
  const held = { historyKey: "l1", marks: NO_MARKS };
  let session = createPlayerRuntimeSession(SCRIPT);
  const view = new DebugHistoryView(
    opened.timeline,
    () => session.events,
    async () => null,
  );
  view.applyAll(delivered(() => registry.observePublication(held, session)));
  assert.equal(view.timeline.complete, true);
  // The point's spill write fails: collection stops, and the notice waits for the next publication.
  failWrite(new Error("injected quota"));
  await turn();
  await turn();
  assert.equal(registry.core(1)!.timeline().complete, false);
  // The next publication's reply is never posted.
  session = observePlayerRuntimeTime(session, 1).session;
  const failing = owner.begin();
  registry.observePublication(held, session);
  owner.rollback(failing);
  // The one after it carries the notice, and the page learns that collection stopped.
  session = observePlayerRuntimeTime(session, 2).session;
  view.applyAll(delivered(() => registry.observePublication(held, session)));
  assert.equal(view.timeline.complete, false, "the page learns that collection stopped");
}

test("a spill failure's notice that a failed reply took goes with the next publication", () =>
  owedRow());

test("a failed reply that keeps the notice it took loses it (negative control)", async () => {
  const returned = Object.getOwnPropertyDescriptor(HistoryRegistry.prototype, "returnPending")!;
  Object.defineProperty(HistoryRegistry.prototype, "returnPending", {
    ...returned,
    value: () => {},
  });
  try {
    await assert.rejects(owedRow(), assert.AssertionError);
  } finally {
    Object.defineProperty(HistoryRegistry.prototype, "returnPending", returned);
  }
});
