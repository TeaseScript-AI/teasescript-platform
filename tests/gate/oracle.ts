import { compilePlayerProject } from "../../player/compile-project.js";
import type { StartOptions } from "../../player/engine-bridge/ops/session.js";
import type { PlayerProject } from "../../player/runtime-adapter.js";
import {
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  playerRuntimeSnapshot,
  restorePlayerRuntimeSessionAt,
  type PlayerRuntimeSession,
} from "../../player/runtime-adapter.js";
import { ADAPTER_OPS } from "../helpers/replay-harness.js";
import type { TapeEntry } from "./tape.js";

/*
 * The tapes' oracle: the adapter, independent of the bridge's dispatch, transport and publication. It compiles the
 * tape's project itself, starts its own session from the same Start options, and gives it every request the tape
 * sent, declines and `null` included, through `ADAPTER_OPS` (`tests/helpers/replay-harness.ts`). Each reply's result
 * must be the adapter's; each publication's state and new events must be the adapter session's; the final checkpoint
 * must be the adapter's. It judges the bridge against the adapter, not the engine's own semantics.
 */

export interface OracleDifference {
  readonly index: number;
  readonly op: string;
  readonly what: string;
}

const json = (value: unknown) => JSON.stringify(value ?? null);

/** The view's state and new events as the host publishes them from `session`: its state without the calls. */
function published(session: PlayerRuntimeSession, from: number) {
  const { calls: _calls, ...state } = session.state;
  return { state: json(state), events: json(session.events.slice(from)) };
}

/** Judges `entries` (a tape of `project` started with `options`) against the adapter; `null` when all agree. */
export function judgeTape(project: PlayerProject, options: StartOptions, entries: readonly TapeEntry[]): OracleDifference | null {
  const plan = compilePlayerProject(project).plan;
  let session: PlayerRuntimeSession | null = null;
  for (const [index, entry] of entries.entries()) {
    const differ = (what: string): OracleDifference => ({ index, op: entry.op, what });
    const reply = entry.reply;
    if (entry.op === "prepare") {
      if (reply.ok !== (plan !== null)) return differ("the adapter's compile and the bridge's prepare disagree");
      continue;
    }
    if (entry.op === "start") {
      if (plan === null || !reply.ok) return differ("a Start without a plan or a reply");
      session = createPlayerRuntimeSession(plan, options);
      // EVIDENCE: validation: a Start's reply view is its introduction, a publication from event 0.
      const view = reply.view as { state: unknown; events: unknown };
      const expected = published(session, 0);
      if (json(view.state) !== expected.state) return differ("Start's state differs from the adapter's");
      if (json(view.events) !== expected.events) return differ("Start's events differ from the adapter's");
      continue;
    }
    if (session === null) return differ("a request before Start");
    if (entry.op === "captureCheckpoint") {
      // EVIDENCE: validation: the capture's result is a `CheckpointCapture` from the same build.
      const capture = reply.ok ? (reply.result as { checkpointJson: string }) : null;
      if (capture?.checkpointJson !== createPlayerRuntimeRestorePoint(session).checkpointJson)
        return differ("the final checkpoint differs from the adapter's");
      continue;
    }
    const call = ADAPTER_OPS[entry.op];
    if (call === undefined) return differ(`'${entry.op}' has no oracle path (ADAPTER_OPS)`);
    // EVIDENCE: validation: every op the tapes send takes an object of arguments.
    const args = entry.args as Record<string, unknown>;
    if (!reply.ok) {
      // A thrown op must throw the same on the adapter, on a copy the throw leaves unusable; a refused request changed nothing.
      if (reply.kind !== "engine") continue;
      const copy = restorePlayerRuntimeSessionAt(session.plan, JSON.stringify(playerRuntimeSnapshot(session)), []);
      try {
        call(copy, args);
      } catch (error) {
        if (error instanceof Error && error.name === reply.name) continue;
      }
      return differ(`it threw ${reply.name} over the bridge but not on the adapter`);
    }
    const made = call(session, args);
    if (made === null) {
      if (reply.result !== null) return differ("the adapter did nothing but the bridge answered");
      continue;
    }
    if (json(reply.result) !== json(made.outcome)) return differ("its result differs from the adapter's");
    if (made.session === session) continue;
    // EVIDENCE: validation: a reply that published carries the publication's view from the same build.
    const view = reply.view as { state: unknown; from: number; events: unknown } | null;
    if (view === null) return differ("the adapter changed the session but the bridge published nothing");
    const expected = published(made.session, view.from);
    if (json(view.state) !== expected.state) return differ("the publication's state differs from the adapter's");
    if (json(view.events) !== expected.events) return differ("the publication's events differ from the adapter's");
    session = made.session;
  }
  return null;
}
