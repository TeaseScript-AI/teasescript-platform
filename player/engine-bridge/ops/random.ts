import type {
  RandomDrawResolutionOutcome,
  RandomOutcome,
} from "../../../src/runtime/random/random-control.js";
import { checkedOutcome } from "../../../src/runtime/random/random-kinds.js";
import { resumePlayerRuntimeRandomDraw } from "../../runtime/runtime-adapter.js";
import type { RandomTried } from "../../debug/random-decisions.js";
import { everyItem, exactly, isRecord } from "../argument-checks.js";
import { type PlayerOpsContext } from "../player-ops.js";
import {
  alignRandom,
  isRandomIntent,
  ownedRandom,
  type RandomIntent,
} from "../connection-state.js";
import type { BridgeOp, BridgeOps, OpOutcome } from "../worker-host.js";
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

/**
 * Whether `value` has a random outcome's shape: its kind and that kind's fields, exactly. Whether the draw takes it is
 * the engine's check (`checkedOutcome`), which follows.
 */
function isOutcomeShape(value: unknown): value is RandomOutcome {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "number":
      return exactly(value, ["kind", "value"]) && typeof value.value === "number";
    case "boolean":
      return exactly(value, ["kind", "value"]) && typeof value.value === "boolean";
    case "index":
      return exactly(value, ["kind", "index"]) && Number.isSafeInteger(value.index);
    case "order":
      return (
        exactly(value, ["kind", "order"]) &&
        everyItem(value.order, (index) => Number.isSafeInteger(index))
      );
    default:
      return false;
  }
}

const isResolution = (value: unknown): value is DrawResolution =>
  value === "natural" || value === "untried" || isOutcomeShape(value);

export function randomOps(context: PlayerOpsContext) {
  return {
    // The Player's random intent, on the Worker itself, sent `after` the shown session so it applies before that
    // session's next op: the host aligns to it. It gives no session to anyone (`adoptRandom` does).
    randomControl: {
      session: "none",
      checkArguments: (args): args is { readonly intent: RandomIntent } =>
        isRecord(args) && exactly(args, ["intent"]) && isRandomIntent(args.intent),
      run: (args) => {
        alignRandom(context, args.intent);
        return { result: { revision: context.random.history.revision } };
      },
    } satisfies BridgeOp<{ readonly intent: RandomIntent }, { readonly revision: number }, "none">,
    // Gives `session` the intent's owner's random control from its next op on, at one of the points that adopt a
    // session (a Start, input adopting an inspected state, Continue after its kept draw went on); the intent it carries
    // aligns first, so the session runs with the control it was adopted under.
    adoptRandom: {
      session: "none",
      checkArguments: (args): args is { readonly session: string; readonly intent: RandomIntent } =>
        isRecord(args) &&
        exactly(args, ["session", "intent"]) &&
        typeof args.session === "string" &&
        isRandomIntent(args.intent),
      run: (args, sessions) => {
        const { session, intent } = args;
        alignRandom(context, intent);
        const held = sessions.get(session);
        if (held instanceof HeldSession) held.adopt(intent.owner);
        return { result: { revision: context.random.history.revision } };
      },
    } satisfies BridgeOp<
      { readonly session: string; readonly intent: RandomIntent },
      { readonly revision: number },
      "none"
    >,
    // Takes any Player's random control from `session` from its next op on, as a Continue's restored session gives it
    // up until its kept draw went on naturally.
    releaseRandom: {
      session: "none",
      checkArguments: (args): args is { readonly session: string } =>
        isRecord(args) && exactly(args, ["session"]) && typeof args.session === "string",
      run: (args, sessions) => {
        const held = sessions.get(args.session);
        if (held instanceof HeldSession) held.adopt(null);
        return { result: null };
      },
    } satisfies BridgeOp<{ readonly session: string }, null, "none">,
    // Resolves the draw the session is paused at. With `record`, its outcome goes into the history first, so the draws
    // the session meets next decide from it, and comes out again exactly if the engine refuses it; a record asked for
    // before a reset since enters nothing. Least tried and records need the session's Player to hold the random state.
    resolveDraw: sessionOp(
      (
        args,
      ): args is {
        readonly drawId: number;
        readonly outcome: DrawResolution;
        readonly record: { readonly resetAt: number } | null;
      } =>
        isRecord(args) &&
        exactly(args, ["drawId", "outcome", "record"]) &&
        typeof args.drawId === "number" &&
        isResolution(args.outcome) &&
        (args.record === null ||
          (isRecord(args.record) &&
            exactly(args.record, ["resetAt"]) &&
            typeof args.record.resetAt === "number")),
      (held, args): OpOutcome<ResolveDrawResult> => {
        const { drawId, outcome, record } = args;
        const owned = ownedRandom(context, held.owner);
        const revision = () => owned?.history.revision ?? context.random.history.revision;
        if ((record !== null || outcome === "untried") && owned === null)
          return { result: { outcome: { kind: "notOwned" }, revision: revision() }, view: null };
        const current = held.sessionForOperation();
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
      checkArguments: (args): args is { readonly session: string; readonly site: string } =>
        isRecord(args) &&
        exactly(args, ["session", "site"]) &&
        typeof args.session === "string" &&
        typeof args.site === "string",
      run: (args, sessions) => {
        const { session, site } = args;
        const owned = ownedRandom(context, heldSession(sessions, session).owner);
        const result: RandomTriedView =
          owned === null
            ? null
            : { ...owned.history.tried(site), revision: owned.history.revision };
        return { result };
      },
    } satisfies BridgeOp<
      { readonly session: string; readonly site: string },
      RandomTriedView,
      "none"
    >,
  } satisfies BridgeOps;
}
