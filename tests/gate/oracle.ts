import { compilePlayerProject } from "../../player/runtime/compile-project.js";
import type { StartOptions } from "../../player/engine-bridge/ops/session.js";
import type { PlayerProject } from "../../player/runtime/runtime-adapter.js";
import {
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  playerRuntimeSnapshot,
  restorePlayerRuntimeSessionAt,
  type PlayerRuntimeSession,
} from "../../player/runtime/runtime-adapter.js";
import { adapterCall } from "../helpers/replay-harness.js";
import type { TapeEntry, TapeReply } from "./tape.js";

/*
 * The tapes' oracle: the adapter, independent of the bridge's dispatch, transport and publication. It compiles the
 * tape's project itself, starts its own session from the same Start options, and gives it every request the tape sent,
 * declines and `null` included, through `ADAPTER_OPS` (`tests/helpers/replay-harness.ts`). One invariant holds every
 * reply: the oracle keeps its own revision and event cursor, so a request that changed the adapter's session must
 * publish exactly that change (its revision, its events from the cursor on, its state) and one that did not must
 * publish nothing at the current revision. `prepare` must match the oracle's compile, its diagnostics included, and
 * the final capture the adapter's checkpoint. It judges the bridge against the adapter, not the engine's semantics.
 */

export interface OracleDifference {
  readonly index: number;
  readonly op: string;
  readonly what: string;
}

const json = (value: unknown) => JSON.stringify(value ?? null);

interface View {
  readonly revision: number;
  readonly from: number;
  readonly eventsThrough: number;
  readonly state: unknown;
  readonly events: unknown;
}

/**
 * Why `reply` is not the publication of `session` from event `cursor`, or `null` when it is: the same revision and
 * events cursor in the reply and its view, the view's events from the cursor on, and its state without the calls.
 */
function publicationDifference(
  reply: TapeReply & { ok: true },
  session: PlayerRuntimeSession,
  cursor: number,
): string | null {
  // EVIDENCE: validation: a reply that published carries a publication view from the same build.
  const view = reply.view as View | null;
  if (view === null) return "the adapter changed the session but the bridge published nothing";
  const { calls: _calls, ...state } = session.state;
  if (view.revision !== session.revision || reply.revision !== session.revision)
    return "the publication's revision differs from the adapter's";
  if (view.from !== cursor)
    return "the publication's events start elsewhere than the oracle's cursor";
  if (view.eventsThrough !== session.events.length || reply.eventsThrough !== session.events.length)
    return "the publication's events cursor differs from the adapter's";
  if (json(view.events) !== json(session.events.slice(cursor)))
    return "the publication's events differ from the adapter's";
  if (json(view.state) !== json(state)) return "the publication's state differs from the adapter's";
  return null;
}

/** Whether `reply`, of a session-free request (`prepare`, the final capture), carries no session envelope or publication. */
const sessionFree = (reply: TapeReply & { ok: true }) =>
  reply.session === null &&
  reply.revision === null &&
  reply.eventsThrough === null &&
  reply.view === null;

/**
 * Judges `entries` (a tape of `project` started with `options`) against the adapter; `null` when all agree. With
 * `complete`, the tape must end in a final capture that agrees.
 */
export function judgeTape(
  project: PlayerProject,
  options: StartOptions,
  entries: readonly TapeEntry[],
  { complete = false }: { readonly complete?: boolean } = {},
): OracleDifference | null {
  const compiled = compilePlayerProject(project);
  let session: PlayerRuntimeSession | null = null;
  let cursor = 0;
  for (const [index, entry] of entries.entries()) {
    const differ = (what: string): OracleDifference => ({ index, op: entry.op, what });
    const reply = entry.reply;
    if (entry.op === "prepare") {
      if (!reply.ok) return differ("prepare was refused");
      if (!sessionFree(reply))
        return differ("prepare's reply carries a session envelope or publication");
      // EVIDENCE: validation: `prepare` replies from the same build with a `PrepareResult`.
      const result = reply.result as { kind: string; diagnostics?: unknown };
      if (result.kind !== (compiled.plan === null ? "notCompiled" : "prepared"))
        return differ("prepare's result differs from the oracle's compile");
      if (json(result.diagnostics) !== json(compiled.diagnostics))
        return differ("prepare's diagnostics differ from the oracle's compile");
      continue;
    }
    if (entry.op === "start") {
      if (compiled.plan === null || !reply.ok) return differ("a Start without a plan or a reply");
      session = createPlayerRuntimeSession(compiled.plan, options);
      const difference = publicationDifference(reply, session, 0);
      if (difference !== null) return differ(`Start: ${difference}`);
      cursor = session.events.length;
      continue;
    }
    if (session === null) return differ("a request before Start");
    if (entry.op === "captureCheckpoint") {
      // EVIDENCE: validation: the capture's result is a `CheckpointCapture` from the same build.
      const capture = reply.ok
        ? (reply.result as { revision: number; eventsThrough: number; checkpointJson: string })
        : null;
      if (capture === null || !reply.ok) return differ("the final capture was refused");
      if (!sessionFree(reply))
        return differ("the final capture's reply carries a session envelope or publication");
      if (capture.revision !== session.revision || capture.eventsThrough !== session.events.length)
        return differ("the final capture's revision or events cursor differs from the adapter's");
      if (capture.checkpointJson !== createPlayerRuntimeRestorePoint(session).checkpointJson)
        return differ("the final checkpoint differs from the adapter's");
      if (index !== entries.length - 1) return differ("a request after the final capture");
      continue;
    }
    const call = adapterCall(entry.op);
    if (call === undefined) return differ(`'${entry.op}' has no oracle path (ADAPTER_OPS)`);
    // EVIDENCE: validation: every op the tapes send takes an object of arguments.
    const args = entry.args as Record<string, unknown>;
    if (!reply.ok) {
      // A thrown op must throw the same on the adapter, on a copy the throw leaves unusable; a refused request changed nothing.
      if (reply.kind !== "engine") continue;
      const copy = restorePlayerRuntimeSessionAt(
        session.plan,
        JSON.stringify(playerRuntimeSnapshot(session)),
        [],
      );
      try {
        call(copy, args);
      } catch (error) {
        if (error instanceof Error && error.name === reply.name) continue;
      }
      return differ(`it threw ${reply.name} over the bridge but not on the adapter`);
    }
    const made = call(session, args);
    if (json(reply.result) !== json(made === null ? null : made.outcome))
      return differ("its result differs from the adapter's");
    if (made === null || made.session === session) {
      if (
        reply.view !== null ||
        reply.revision !== session.revision ||
        reply.eventsThrough !== null
      )
        return differ(
          "the adapter changed nothing but the bridge published, or at another revision",
        );
      continue;
    }
    const difference = publicationDifference(reply, made.session, cursor);
    if (difference !== null) return differ(difference);
    session = made.session;
    cursor = session.events.length;
  }
  if (complete && entries.at(-1)?.op !== "captureCheckpoint")
    return { index: entries.length, op: "", what: "a complete tape without its final capture" };
  return null;
}
