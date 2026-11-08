import {
  loadInstructionPlan,
  type InstructionPlan,
  type PlanValidationError,
} from "../../src/playback.js";
import type { PlayerProject, PlayerScriptDiagnostic } from "../runtime-adapter.js";
import type { ScriptIdentity } from "../script-identity.js";
import { planMetadata, type PlanMetadata } from "./plan-facts.js";
import { DebugRecorder } from "../debug-recorder.js";
import { MAIN_FILE_PATH } from "../../src/project-paths.js";
import type { RuntimeDebugContext } from "../../src/runtime/debug/debug-trace.js";
import { RandomHistory } from "../random-decisions.js";
import { everyItem, exactly, isRecord, isStringArray } from "./argument-checks.js";
import { type Delivery, type DeliveryOwner, deliveryOwner, OwnedMap } from "./delivery.js";
import { SourceViewCaches, sourceViewOps } from "./ops/source-views.js";
import { historyOps } from "./ops/history.js";
import { inputOps } from "./ops/input.js";
import { mediaOps } from "./ops/media.js";
import { persistenceOps, type PlanTextSlot } from "./ops/persistence.js";
import { randomOps } from "./ops/random.js";
import { recordingOps, type HeldTicket } from "./ops/recording.js";
import { transferOps, type TransferTicket } from "./ops/transfer.js";
import { resourceOps } from "./ops/resources.js";
import { sessionOps } from "./ops/session.js";
import { traceOps } from "./ops/trace.js";
import { HistoryRegistry } from "./history/registry.js";
import type { DebugHistorySpill } from "./history/snapshots.js";
import { openDebugHistorySpill } from "../debug-history-indexeddb.js";
import type { BridgeOps, HostSessions } from "./worker-host.js";
import type { RandomState } from "./connection-state.js";

// These live in their leaves (`plan-facts.ts`, `connection-state.ts`); new imports, especially from `ops/`, take
// them from there, so that no op imports a value from this composition.
export type { PlanMetadata } from "./plan-facts.js";
export {
  alignRandom,
  alignTrace,
  type RandomIntent,
  type RandomState,
  type TracingIntent,
} from "./connection-state.js";

/**
 * What `prepare` gives: a plan the Worker now holds, under a token for this plan instance; a script that does not
 * compile, with its diagnostics; plan text whose plan is invalid, with the complete diagnostic array; or text that is
 * no JSON at all.
 */
export type PrepareResult =
  | {
      readonly kind: "prepared";
      readonly plan: string;
      readonly diagnostics: readonly PlayerScriptDiagnostic[];
      readonly identity: ScriptIdentity | null;
      readonly metadata: PlanMetadata;
    }
  | {
      readonly kind: "notCompiled";
      readonly diagnostics: readonly PlayerScriptDiagnostic[];
      readonly identity: ScriptIdentity;
    }
  | { readonly kind: "invalid"; readonly errors: readonly PlanValidationError[] }
  | { readonly kind: "unreadable"; readonly message: string };

/** A script to prepare: source the Worker compiles (a hosted package or the playground), or published plan text. */
export type PrepareSource =
  | { readonly kind: "source"; readonly script: string | PlayerProject }
  | { readonly kind: "plan"; readonly text: string };

function isProject(value: unknown): value is PlayerProject {
  if (!isRecord(value) || !exactly(value, ["files"], ["images", "unreadableFiles"])) return false;
  const files = value.files;
  const images = value.images;
  const unreadable = value.unreadableFiles;
  return (
    everyItem(
      files,
      (file) =>
        isRecord(file) &&
        exactly(file, ["path", "source"]) &&
        typeof file.path === "string" &&
        typeof file.source === "string",
    ) &&
    (images === undefined ||
      everyItem(
        images,
        (image) =>
          isRecord(image) &&
          exactly(image, ["path", "keywords"], ["tagsProblem"]) &&
          typeof image.path === "string" &&
          isStringArray(image.keywords) &&
          (image.tagsProblem === undefined || typeof image.tagsProblem === "string"),
      )) &&
    (unreadable === undefined ||
      everyItem(
        unreadable,
        (file) =>
          isRecord(file) &&
          exactly(file, ["path", "reason"], ["folder"]) &&
          typeof file.path === "string" &&
          typeof file.reason === "string" &&
          (file.folder === undefined || typeof file.folder === "boolean"),
      ))
  );
}

function isPrepareArguments(args: unknown): args is { readonly source: PrepareSource } {
  if (!isRecord(args) || !exactly(args, ["source"]) || !isRecord(args.source)) return false;
  const source = args.source;
  if (source.kind === "plan")
    return exactly(source, ["kind", "text"]) && typeof source.text === "string";
  return (
    source.kind === "source" &&
    exactly(source, ["kind", "script"]) &&
    (typeof source.script === "string" || isProject(source.script))
  );
}

/**
 * What the Player's ops share on one connection: its plans under their tokens, their sources, Debug's caches, and its debug
 * recorder.
 */
export interface PlayerOpsContext {
  /**
   * The connection's deliveries (`delivery.ts`): its host runs every op in one, and every allocation of these registries
   * registers its undo with the open one first. Its host must be started with it (`startBridgeHost`).
   */
  readonly delivery: DeliveryOwner;
  readonly plans: OwnedMap<string, InstructionPlan>;
  /** Keeps `plan` under a new token, which it returns, owned by `delivery` (the innermost open one by default). */
  hold(plan: InstructionPlan, delivery?: Delivery): string;
  /** Records the connection's sessions for a debug export; see `DebugRecorder`. */
  readonly recorder: DebugRecorder;
  /** The source files of each plan this Worker compiled, by the plan's token: what Debug's source views show. */
  readonly sources: OwnedMap<string, readonly { readonly path: string; readonly source: string }[]>;
  /** The source-view ops' caches; `teardown` clears them with the plans. */
  readonly sourceViews: SourceViewCaches;
  /**
   * Debug's value trace on this connection while Debug runs, else `null` (`debugTracing`): every session the host holds
   * runs with it, from its next operation on.
   */
  trace: RuntimeDebugContext | null;
  /** Counts the traces this connection made, so that a reply names the one it read. */
  traceId: number;
  /** The serial of the newest tracing intent the host applied (`alignTrace`); `0` before any. */
  traceIntent: number;
  /** The held plans' canonical JSON, per token, which `preparePlanText` alone keeps (`ops/persistence.ts`). */
  readonly planTexts: OwnedMap<string, PlanTextSlot>;
  /** The sessions read for an import, by ticket, until released (`ops/transfer.ts`). */
  readonly transfers: OwnedMap<string, TransferTicket>;
  /** Counts the tickets this connection gave out. */
  transferCount: number;
  /** Captured recordings and debug exports, by ticket, until released (`ops/recording.ts`). */
  readonly recordings: OwnedMap<string, HeldTicket>;
  /** A new ticket of `recordings`; the connection never gives one out twice. */
  nextTicket(): string;
  /** Debug's random control on this connection (`alignRandom`); every session its owner holds runs with it. */
  readonly random: RandomState;
  /** Debug's rewind histories on this connection (`ops/history.ts`); `teardown` closes them. */
  readonly history: HistoryRegistry;
}

/** Opens a spill store for a rewind history where the host's realm has IndexedDB, else none. */
const hostSpill = (): Promise<DebugHistorySpill | null> => openDebugHistorySpill();

export function playerOpsContext(
  options: {
    /** A rewind history's spill store, as tests give one; IndexedDB where the realm has it by default. */
    readonly historySpill?: () => Promise<DebugHistorySpill | null>;
    /** UTF-16 code units of snapshot JSON a history admits; `DEBUG_HISTORY_ADMITTED_SNAPSHOT_CHARS` by default. */
    readonly historyBudget?: number;
  } = {},
): PlayerOpsContext {
  const delivery = deliveryOwner();
  const plans = new OwnedMap<string, InstructionPlan>(delivery);
  let nextPlan = 1;
  let nextTicket = 1;
  return {
    delivery,
    plans,
    hold: (plan, by) => {
      const token = `p${nextPlan++}`;
      plans.set(token, plan, by);
      return token;
    },
    recorder: new DebugRecorder(),
    sources: new OwnedMap(delivery),
    sourceViews: new SourceViewCaches(delivery),
    trace: null,
    traceId: 0,
    traceIntent: 0,
    // A slot leaving, however it leaves, stops its waiting task (`ops/persistence.ts`).
    planTexts: new OwnedMap(delivery, (slot) => {
      if (slot.timer !== null) clearTimeout(slot.timer);
    }),
    transfers: new OwnedMap(delivery),
    transferCount: 0,
    recordings: new OwnedMap(delivery),
    nextTicket: () => `r${nextTicket++}`,
    random: {
      intent: 0,
      owner: 0,
      control: null,
      settings: new Map(),
      history: new RandomHistory(),
      forgotAt: 0,
    },
    history: new HistoryRegistry(
      delivery,
      options.historySpill ?? hostSpill,
      options.historyBudget,
    ),
  };
}

/**
 * The Player's ops. The plans live here, under their tokens; nothing returns one. A source is compiled in the Worker:
 * the compiler loads only then, so a Worker that loads published plans never loads it. Each family of the L5 series
 * adds its ops in a module of its own under `ops/`.
 */
export function playerBridgeOps(context: PlayerOpsContext = playerOpsContext()): BridgeOps {
  const { plans, hold } = context;
  /** A published plan's result, or why it is none; read at once, so the requests after it wait for nothing. */
  const loadPlan = (text: string): PrepareResult => {
    const loaded = loadInstructionPlan(text);
    return loaded.kind === "valid"
      ? {
          kind: "prepared",
          plan: hold(loaded.plan),
          diagnostics: [],
          identity: null,
          metadata: planMetadata(loaded.plan),
        }
      : loaded.kind === "invalid"
        ? { kind: "invalid", errors: loaded.validation.errors }
        : { kind: "unreadable", message: loaded.message };
  };
  /** A source's result, after the compiler loads. */
  const compile = async (script: string | PlayerProject): Promise<PrepareResult> => {
    const [{ compilePlayerProject }, { scriptIdentity }] = await Promise.all([
      import("../compile-project.js"),
      import("../script-identity.js"),
    ]);
    const compilation = compilePlayerProject(script);
    const identity = scriptIdentity(script);
    if (compilation.plan === null)
      return { kind: "notCompiled", diagnostics: compilation.diagnostics, identity };
    const plan = hold(compilation.plan);
    const files =
      typeof script === "string" ? [{ path: MAIN_FILE_PATH, source: script }] : script.files;
    context.sources.set(plan, files);
    return {
      kind: "prepared",
      plan,
      diagnostics: compilation.diagnostics,
      identity,
      metadata: planMetadata(compilation.plan),
    };
  };
  return {
    prepare: {
      session: "none",
      checkArguments: isPrepareArguments,
      run: (args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { source } = args as { readonly source: PrepareSource };
        return source.kind === "plan"
          ? { result: loadPlan(source.text) }
          : compile(source.script).then((result) => ({ result }));
      },
    },
    // What the Player reads of a plan the host holds, by its token, as `prepare` gave it; `null` for a token it does not
    // hold. For sessions that reach the Player in any way: started, continued, restored or transferred.
    planMetadata: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) && exactly(args, ["plan"]) && typeof args.plan === "string",
      run: (args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const plan = plans.get((args as { readonly plan: string }).plan);
        return { result: plan === undefined ? null : planMetadata(plan) };
      },
    },
    // Lets go of what the connection holds (`releaseConnection`); the connection stays open for more work.
    teardown: {
      session: "none",
      checkArguments: (args) => args === null,
      run: (_args, sessions) => {
        releaseConnection(context, sessions);
        return { result: null };
      },
    },
    ...sessionOps(context),
    ...sourceViewOps(context),
    ...inputOps(context),
    ...mediaOps(context),
    ...resourceOps(context),
    ...persistenceOps(context),
    ...transferOps(context),
    ...recordingOps(context),
    ...historyOps(context),
    ...traceOps(context),
    ...randomOps(context),
  };
}

/**
 * Lets go of the connection's sessions and of everything held for its plans: the plans, their sources and Debug's caches
 * of them, their JSON, the sessions read for an import, and the recording and export tickets. The debug recorder keeps
 * its log, the last diagnostics of the connection, but no longer binds to an engine; the value trace stays as it is.
 * This is no reset of the whole context. The `teardown` op runs it on a connection
 * that stays open; `closeConnection` runs it as the connection ends.
 */
function releaseConnection(context: PlayerOpsContext, sessions: HostSessions): void {
  context.plans.clear();
  context.sources.clear();
  context.sourceViews.clear();
  context.planTexts.clear();
  context.transfers.clear();
  context.recordings.clear();
  context.recorder.detach();
  // Its histories close as the Player's disposal: their parked sessions and candidates go with the sessions below.
  context.history.closeAll("disposal");
  sessions.clear();
}

/**
 * Ends the connection for good, as its transport ends: its deliveries are closed first, so work still running can
 * allocate nothing more, then what it holds is let go of (`releaseConnection`). Called directly by the backend whose
 * host outlives its client, never through that client. It never throws: an undo that fails is reported by the owner
 * (`delivery.ts`), and the release runs in any case.
 */
export function closeConnection(context: PlayerOpsContext, sessions: HostSessions): void {
  context.delivery.close();
  releaseConnection(context, sessions);
}
