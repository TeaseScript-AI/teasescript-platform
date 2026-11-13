import { BridgeRequestError } from "../../player/engine-bridge/client.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { StartOptions } from "../../player/engine-bridge/ops/session.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import { candidatesFor, type Candidate } from "./candidates.js";
import { OUTCOMES, UnfamiliarResult } from "./outcomes.js";
import { recordClient, type TapeEntry } from "./tape.js";
import { untypedBridge, untypedClient } from "../helpers/bridge/untyped.js";

/*
 * The K/F tape driver (the L5 gate's tape plan): prepares a project, starts it as a hosted Player starts, then
 * sweeps the session-wide candidates (`candidates.ts`) one request at a time, recording every request and reply on the
 * client. A decline moves to the next candidate not yet tried in this decision, read from the latest publication; an
 * acceptance starts a fresh decision. The tape ends halted, failed, cut, unsupported, refused or stalled.
 */

/** Accepted inputs after which a tape is cut. */
const TAPE_CUT = 250;

export type TapeOutcome =
  | { readonly kind: "halted" | "failed" | "cut" }
  | { readonly kind: "notPrepared"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "stalled"; readonly reason: string }
  | { readonly kind: "thrown"; readonly reason: string }
  | { readonly kind: "captureFailed"; readonly reason: string }
  | { readonly kind: "harnessError"; readonly reason: string };

/** Halted, failed and cut tapes are complete prefixes for this policy and cut; the others are not. */
export const isComplete = (outcome: TapeOutcome): boolean =>
  outcome.kind === "halted" || outcome.kind === "failed" || outcome.kind === "cut";

export interface TapeRun {
  readonly entries: readonly TapeEntry[];
  readonly outcome: TapeOutcome;
  /** The plan token the tape's `start` used. */
  readonly plan: string | null;
  readonly census: {
    readonly accepted: Readonly<Record<string, number>>;
    readonly declined: Readonly<Record<string, number>>;
    readonly rows: Readonly<Record<string, number>>;
    readonly status: string | null;
    readonly observedMs: number | null;
  };
}

const count = (counts: Record<string, number>, key: string) =>
  (counts[key] = (counts[key] ?? 0) + 1);

/**
 * Records one tape on `bridge`, a fresh host: `source` as `prepare` takes it, then a Start with `options`. Its census
 * counts accepted inputs by op, declines by op and reason, and the rows that proposed accepted inputs. `candidates` and
 * `outcomes` replace the table and its readings, for fixture hosts and the tests' negative probes and mutants.
 */
export async function driveTape(
  bridge: PlayerBridge,
  source: unknown,
  options: StartOptions,
  {
    cut = TAPE_CUT,
    candidates = candidatesFor,
    outcomes = OUTCOMES,
  }: {
    readonly cut?: number;
    readonly candidates?: typeof candidatesFor;
    readonly outcomes?: typeof OUTCOMES;
  } = {},
): Promise<TapeRun> {
  const recorder = recordClient(bridge.client);
  const accepted: Record<string, number> = {};
  const declined: Record<string, number> = {};
  const rows: Record<string, number> = {};
  let plan: string | null = null;
  let session: PlayerSession | null = null;
  const finish = (outcome: TapeOutcome): TapeRun => {
    recorder.stop();
    const shown = session === null ? null : (bridge.latest(session) ?? session);
    return {
      entries: recorder.entries,
      outcome,
      plan,
      census: {
        accepted,
        declined,
        rows,
        status: shown?.state.status ?? null,
        observedMs: shown?.state.observedSessionTimeMs ?? null,
      },
    };
  };
  try {
    // EVIDENCE: validation: `prepare` replies from the same build with a `PrepareResult`.
    const prepared = (await untypedClient(bridge.client).request("prepare", { source })).result as {
      kind: string;
      plan?: string;
    };
    if (prepared.kind !== "prepared" || prepared.plan === undefined)
      return finish({ kind: "notPrepared", reason: prepared.kind });
    plan = prepared.plan;
    session = await bridge.start(plan, options, true);
    let total = 0;
    for (;;) {
      const shown = bridge.latest(session) ?? session;
      if (shown.state.status === "halted")
        return await captured(bridge, shown, finish({ kind: "halted" }));
      if (shown.state.status === "failed")
        return await captured(bridge, shown, finish({ kind: "failed" }));
      if (total >= cut) return await captured(bridge, shown, finish({ kind: "cut" }));
      const tried = new Set<string>();
      let lastDeclined: { candidate: Candidate; reason: string } | null = null;
      let progressed = false;
      for (;;) {
        const latest = bridge.latest(session) ?? session;
        const next = candidates(latest, total).find((candidate) => !tried.has(key(candidate)));
        if (next === undefined) break;
        tried.add(key(next));
        let result: unknown;
        try {
          // The candidate's op, picked at run time.
          result = await untypedBridge(bridge).request(latest, next.op, next.args);
        } catch (error) {
          if (!(error instanceof BridgeRequestError)) throw error;
          // A refused request (a basis, an argument, a thrown op) is recorded and declined; a session it ended ends the tape.
          count(declined, `${next.op}:${error.name}`);
          // A thrown request that ended the session is no engine failure the script reached: the tape is incomplete.
          if (error.ended) return finish({ kind: "thrown", reason: `${next.op}: ${error.name}` });
          lastDeclined = { candidate: next, reason: error.name };
          continue;
        }
        const reading = outcomes[next.op](result);
        if (reading.accepted) {
          count(accepted, next.op);
          count(rows, next.row);
          total += 1;
          progressed = true;
          break;
        }
        count(declined, `${next.op}:${reading.reason}`);
        lastDeclined = { candidate: next, reason: reading.reason };
      }
      if (progressed) continue;
      const latest = bridge.latest(session) ?? session;
      if (lastDeclined?.candidate.op === "stepTime")
        return await captured(
          bridge,
          latest,
          finish({
            kind: "refused",
            reason: `the deadline at ${String(lastDeclined.candidate.args["targetMs"])} ms: ${lastDeclined.reason}`,
          }),
        );
      if (tried.size === 0 && latest.state.foregroundAction?.kind === "interaction")
        return await captured(
          bridge,
          latest,
          finish({
            kind: "unsupported",
            reason: `no candidate for the shown ${latest.state.foregroundAction.ui.kind}`,
          }),
        );
      return await captured(
        bridge,
        latest,
        finish({ kind: "stalled", reason: `tried ${[...tried].join(", ") || "nothing"}` }),
      );
    }
  } catch (error) {
    if (error instanceof UnfamiliarResult)
      return finish({ kind: "harnessError", reason: error.message });
    recorder.stop();
    throw error;
  }
}

const key = (candidate: Candidate) => `${candidate.op} ${JSON.stringify(candidate.args)}`;

/**
 * The tape's final capture, recorded as an entry: the session's checkpoint, read session-free after its requests. A
 * capture that fails leaves the tape incomplete (`captureFailed`), whatever outcome it had.
 */
async function captured(
  bridge: PlayerBridge,
  session: PlayerSession,
  run: TapeRun,
): Promise<TapeRun> {
  const recorder = recordClient(bridge.client);
  let failure: string | null = null;
  try {
    await bridge.read(session, "captureCheckpoint");
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    recorder.stop();
  }
  return {
    ...run,
    entries: [...run.entries, ...recorder.entries],
    ...(failure === null ? {} : { outcome: { kind: "captureFailed", reason: failure } }),
  };
}
