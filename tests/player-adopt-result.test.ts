import assert from "node:assert/strict";
import test from "node:test";

import { createPlayerRuntimeSession } from "../player/compile-project.js";
import { inputOps } from "../player/engine-bridge/ops/input.js";
import { HeldSession, publishing } from "../player/engine-bridge/ops/session.js";
import { playerOpsContext } from "../player/engine-bridge/player-ops.js";
import type { HostSessions } from "../player/engine-bridge/worker-host.js";
import {
  beginPlayerRuntimeCatchUp,
  observePlayerRuntimeTime,
  withPlayerRuntimeDebugTrace,
} from "../player/runtime-adapter.js";
import { activePlayerRuntimeInteraction } from "../player/runtime-view.js";
import { RuntimeDebugContext } from "../src/runtime/debug/debug-trace.js";

/*
 * Clarity audit part 2, item 15: how an op's result session is adopted in the host is decided once
 * (`HeldSession.adoptResult`), for `publishing` and `answered` alike: the same session publishes nothing; another of
 * the same revision, as a trace-only wrapper, is kept without publishing (orchestrator 2's ruling: the UI never
 * received a same-revision view); a new revision is published once with its events. Each caller keeps its own outcome
 * and catch-up policy: `answered` ends a catch-up on a new revision, `publishing` leaves that to its op.
 */

/** A session the host holds, at a waiting button, with a catch-up begun on a copy of it. */
function held() {
  const raw = observePlayerRuntimeTime(
    createPlayerRuntimeSession(
      'timer async 1 s { say "tick", instant }\nshowButton "Go"\nsay "went", instant\nexit',
    ),
    100,
  ).session;
  const session = new HeldSession(raw, "plan", playerOpsContext());
  session.introduce(null);
  const catchUp = beginPlayerRuntimeCatchUp(raw, 500);
  session.beginCatchUp(catchUp);
  return { raw, session, catchUp };
}

test("the same session is adopted as it is: nothing published, the outcome and the catch-up kept", () => {
  const { raw, session, catchUp } = held();
  const delivered = session.delivered;
  assert.deepEqual(session.adoptResult(raw), { kind: "same" });
  assert.deepEqual(publishing(session, raw, "outcome"), { result: "outcome", view: null });
  assert.equal(session.publication, raw);
  assert.equal(session.catchUp, catchUp);
  assert.equal(session.delivered, delivered);
});

test("a same-revision trace wrapper is kept without publishing: no view, the cursor unchanged", () => {
  const { raw, session, catchUp } = held();
  const delivered = session.delivered;
  const wrapper = withPlayerRuntimeDebugTrace(raw, new RuntimeDebugContext());
  assert.notEqual(wrapper, raw);
  assert.equal(wrapper.revision, raw.revision);
  assert.deepEqual(publishing(session, wrapper, "outcome"), { result: "outcome", view: null });
  assert.equal(session.publication, wrapper, "the wrapper is retained");
  assert.equal(session.delivered, delivered, "no events handed out");
  assert.equal(session.catchUp, catchUp);
  // The deciding function says so itself.
  const again = withPlayerRuntimeDebugTrace(wrapper, null);
  assert.deepEqual(session.adoptResult(again), { kind: "kept" });
});

test("a new revision is published once with its events; publishing leaves the catch-up to its op", () => {
  const { raw, session, catchUp } = held();
  const next = observePlayerRuntimeTime(raw, 2_000).session;
  assert.notEqual(next.revision, raw.revision);
  const outcome = publishing(session, next, "observed");
  assert.equal(outcome.result, "observed");
  assert.ok(outcome.view !== null && outcome.view !== undefined, "one publication");
  assert.equal(outcome.eventsThrough, next.events.length);
  assert.equal(session.delivered, next.events.length);
  assert.equal(session.publication, next);
  assert.equal(session.catchUp, catchUp, "publishing does not end the catch-up");
});

test("an answer adopts through the same decision: a new revision ends the catch-up, no answer adopts nothing", async () => {
  const ops = inputOps(playerOpsContext());
  // An input op reads only the session it is given, as the host gives it.
  const none: HostSessions = {
    get: () => undefined,
    add: () => "",
    delete: () => {},
    clear: () => {},
  };
  const run = async (op: string, session: HeldSession, args: Record<string, unknown>) =>
    await ops[op]!.run(args, none, { id: "s1", value: session });
  // No answer: an image skip at a button.
  {
    const { raw, session, catchUp } = held();
    const actionId = activePlayerRuntimeInteraction(raw.state)!.actionId;
    assert.deepEqual(await run("skipImage", session, { actionId, input: null }), {
      result: null,
      view: null,
    });
    assert.equal(session.publication, raw);
    assert.equal(session.catchUp, catchUp);
  }
  // A new revision: the button's activation publishes once, with its events, and ends the catch-up.
  {
    const { raw, session } = held();
    const actionId = activePlayerRuntimeInteraction(raw.state)!.actionId;
    const outcome = await run("activateButton", session, { actionId, input: null });
    assert.ok(outcome.view !== null && outcome.view !== undefined);
    assert.notEqual(session.publication.revision, raw.revision);
    assert.equal(outcome.eventsThrough, session.publication.events.length);
    assert.equal(session.catchUp, null, "an answer ends the catch-up");
  }
});
