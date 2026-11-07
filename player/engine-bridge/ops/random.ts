import type {
  RandomDrawResolutionOutcome,
  RandomOutcome,
} from "../../../src/runtime/random/random-control.js";
import { checkedOutcome } from "../../../src/runtime/random/random-kinds.js";
import { resumePlayerRuntimeRandomDraw } from "../../runtime-adapter.js";
import type { RandomTried } from "../../random-decisions.js";
import { exactly, isRecord } from "../argument-checks.js";
import {
  alignRandom,
  isRandomIntent,
  ownedRandom,
  type PlayerOpsContext,
  type RandomIntent,
} from "../player-ops.js";
import type { BridgeOps } from "../worker-host.js";
import { heldSession } from "./persistence.js";
import { HeldSession, publishing, sessionOp } from "./session.js";

/*
 * L5i.4's ops: Debug's random control as the connection's state (`randomControl`), a paused draw's resolution with the
 * history it records (`resolveDraw`), and what a site took (`randomTried`). Every access to the random state goes
 * through `ownedRandom`: a session of a Player that ended neither reads nor changes the next Player's.
 */

/** How a paused draw goes on: naturally, with an outcome, or with its site's least-tried outcome. */
export type DrawResolution = "natural" | "untried" | RandomOutcome;

/** What `resolveDraw` replies: the engine's outcome, or `notOwned` for a session whose Player no longer holds it. */
export interface ResolveDrawResult {
  readonly outcome: RandomDrawResolutionOutcome | { readonly kind: "notOwned" };
  /** The history's revision after it. */
  readonly revision: number;
}

/** What `randomTried` replies: what the site took and the history's revision, or `null` for another Player's session. */
export type RandomTriedView = (RandomTried & { readonly revision: number }) | null;

const isResolution = (value: unknown): value is DrawResolution =>
  value === "natural" || value === "untried" || (isRecord(value) && typeof value.kind === "string");

export function randomOps(context: PlayerOpsContext): BridgeOps {
  return {
    // The Player's random intent, on the Worker itself (`after` the session it names): the host aligns to it, and with
    // `session` it gives that session the intent's owner's control from its next op on, as Start and Continue do. With
    // `release` instead, the session gives up any Player's control from its next op on, as a Continue's restored
    // session does until its kept draw went on naturally.
    randomControl: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) &&
        (exactly(args, ["intent"], ["session"])
          ? isRandomIntent(args.intent) &&
            (args.session === undefined || typeof args.session === "string")
          : exactly(args, ["session", "release"]) &&
            typeof args.session === "string" &&
            args.release === true),
      run: (args, sessions) => {
        // EVIDENCE: validation: checkArguments accepted an intent with a session's ID, or a session's release.
        const { intent, session, release } = args as {
          readonly intent?: RandomIntent;
          readonly session?: string;
          readonly release?: true;
        };
        if (intent !== undefined) alignRandom(context, intent);
        const held = session === undefined ? undefined : sessions.get(session);
        if (held instanceof HeldSession) held.adopt(release === true ? null : intent!.owner);
        return { result: { revision: context.random.history.revision } };
      },
    },
    // Resolves the draw the session is paused at. With `record`, its outcome goes into the history first, so the draws
    // the session meets next decide from it, and comes out again exactly if the engine refuses it; a record asked for
    // before a reset since enters nothing. Least tried and records need the session's Player to hold the random state.
    resolveDraw: sessionOp(
      (args) =>
        isRecord(args) &&
        exactly(args, ["drawId", "outcome", "record"]) &&
        typeof args.drawId === "number" &&
        isResolution(args.outcome) &&
        (args.record === null ||
          (isRecord(args.record) &&
            exactly(args.record, ["resetAt"]) &&
            typeof args.record.resetAt === "number")),
      (held, args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments; the engine checks the outcome itself.
        const { drawId, outcome, record } = args as {
          readonly drawId: number;
          readonly outcome: DrawResolution;
          readonly record: { readonly resetAt: number } | null;
        };
        const owned = ownedRandom(context, held.owner);
        const revision = () => owned?.history.revision ?? context.random.history.revision;
        if ((record !== null || outcome === "untried") && owned === null)
          return { result: { outcome: { kind: "notOwned" }, revision: revision() }, view: null };
        const current = held.current;
        const draw = current.state.randomDraw;
        let resolved: "natural" | RandomOutcome = outcome === "untried" ? "natural" : outcome;
        if (outcome === "untried" && draw !== null && draw.drawId === drawId) {
          const least = owned!.history.leastTried(draw);
          resolved = least === null || least === draw.natural ? "natural" : least;
        }
        // Only an outcome the draw takes is recorded, as the engine's own check decides it; anything else goes to the
        // engine unrecorded, which refuses it. A record is whole or nothing (`RandomHistory.record`).
        const taken =
          draw === null || draw.drawId !== drawId
            ? null
            : resolved === "natural"
              ? draw.natural.kind === "failure"
                ? null
                : draw.natural
              : checkedOutcome(draw.support, resolved);
        const undo =
          record !== null &&
          owned !== null &&
          record.resetAt === owned.forgotAt &&
          draw !== null &&
          taken !== null &&
          typeof taken !== "string"
            ? owned.history.record(draw, taken)
            : null;
        let result;
        try {
          result = resumePlayerRuntimeRandomDraw(current, { drawId, outcome: resolved });
        } catch (error) {
          undo?.();
          throw error;
        }
        if (result.outcome.kind !== "resolved") undo?.();
        const reply: ResolveDrawResult = { outcome: result.outcome, revision: revision() };
        return publishing(held, result.session, reply);
      },
    ),
    // What `site` took, for the picker: a read (`PlayerBridge.read`) of the session's Player's history.
    randomTried: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) &&
        exactly(args, ["session", "site"]) &&
        typeof args.session === "string" &&
        typeof args.site === "string",
      run: (args, sessions) => {
        // EVIDENCE: validation: checkArguments accepted the session's ID and the site.
        const { session, site } = args as { readonly session: string; readonly site: string };
        const owned = ownedRandom(context, heldSession(sessions, session).owner);
        const result: RandomTriedView =
          owned === null
            ? null
            : { ...owned.history.tried(site), revision: owned.history.revision };
        return { result };
      },
    },
  };
}
