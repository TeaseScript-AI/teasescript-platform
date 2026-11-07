import {
  listRandomSites,
  loadInstructionPlan,
  type InstructionPlan,
  type PlanValidationError,
  type RandomSite,
} from "../../src/playback.js";
import type { PlayerProject, PlayerScriptDiagnostic } from "../runtime-adapter.js";
import type { ScriptIdentity } from "../script-identity.js";
import { planLockNeeds, playerRuntimeStageImages } from "../plan-metadata.js";
import { DebugRecorder } from "../debug-recorder.js";
import { MAIN_FILE_PATH } from "../../src/project-paths.js";
import { RuntimeDebugContext } from "../../src/runtime/debug/debug-trace.js";
import type {
  RandomControlOptions,
  RandomDecision,
  RandomDrawView,
} from "../../src/runtime/random/random-control.js";
import { decideDraw, RandomHistory, type RandomNext } from "../random-decisions.js";
import { everyItem, exactly, isRecord, isStringArray } from "./argument-checks.js";
import { DebugCaches, debugOps } from "./ops/debug.js";
import { inputOps } from "./ops/input.js";
import { mediaOps } from "./ops/media.js";
import { persistenceOps, type PlanTextSlot } from "./ops/persistence.js";
import { randomOps } from "./ops/random.js";
import { resourceOps } from "./ops/resources.js";
import { sessionOps } from "./ops/session.js";
import { traceOps } from "./ops/trace.js";
import type { BridgeOps } from "./worker-host.js";

/** What the Player reads from a plan the Worker holds, sent with the plan's token instead of the plan. */
export interface PlanMetadata {
  /** The plan's script files, in plan order. */
  readonly files: readonly string[];
  readonly stageImages: readonly string[];
  readonly randomSites: readonly RandomSite[];
  /** Whether the script locks or opens anything, and whether it encrypts. */
  readonly locks: boolean;
  readonly encrypts: boolean;
}

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

/** What the Player reads from a plan, sent with its token. */
export function planMetadata(plan: InstructionPlan): PlanMetadata {
  return {
    files: plan.files.map((file) => file.path),
    stageImages: playerRuntimeStageImages(plan),
    randomSites: listRandomSites(plan),
    ...planLockNeeds(plan),
  };
}

/**
 * What the Player's ops share on one connection: its plans under their tokens, their sources, Debug's caches, and its debug
 * recorder.
 */
export interface PlayerOpsContext {
  readonly plans: Map<string, InstructionPlan>;
  /** Keeps `plan` under a new token, which it returns. */
  hold(plan: InstructionPlan): string;
  /** Records the connection's sessions for a debug export; see `DebugRecorder`. */
  readonly recorder: DebugRecorder;
  /** The source files of each plan this Worker compiled, by the plan's token: what Debug's source views show. */
  readonly sources: Map<string, readonly { readonly path: string; readonly source: string }[]>;
  /** Debug's source caches; `teardown` clears them with the plans. */
  readonly debug: DebugCaches;
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
  readonly planTexts: Map<string, PlanTextSlot>;
  /** Debug's random control on this connection (`alignRandom`); every session its owner holds runs with it. */
  readonly random: RandomState;
}

/**
 * Debug's random control as the newest random intent set it: its Player (`owner`), which draws it decides, and the
 * history of what each site took, which belongs to that Player and lasts until it asks for a reset.
 */
export interface RandomState {
  /** The serial of the newest random intent the host applied; `0` before any. */
  intent: number;
  /** The Player that sent it (`PlayerBridge.claim`); `0` before any. */
  owner: number;
  /** The control the owner's sessions run with, or `null` while Choose outcomes is off. */
  control: RandomControlOptions | null;
  settings: ReadonlyMap<string, RandomNext>;
  readonly history: RandomHistory;
  /** The serial of the newest reset applied (`RandomIntent.resetAt`). */
  forgotAt: number;
}

/**
 * One random change a live Player sent: its control (the sites set to go on by themselves), or none; the serial of the
 * newest reset of its history it asked for; and its own serial, which the connection counts up across the Players that
 * use it (`PlayerBridge.nextRandomIntent`). Every op that sets the connection's control carries one.
 */
export interface RandomIntent {
  readonly owner: number;
  readonly control: { readonly sites: readonly (readonly [string, RandomNext])[] } | null;
  readonly resetAt: number;
  readonly intent: number;
}

const isSerial = (value: unknown, least: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= least;
const isRandomNext = (value: unknown): value is RandomNext =>
  value === "random" || value === "untried";

/** Whether `value` is a `RandomIntent`. */
export const isRandomIntent = (value: unknown): value is RandomIntent =>
  isRecord(value) &&
  exactly(value, ["owner", "control", "resetAt", "intent"]) &&
  isSerial(value.owner, 1) &&
  isSerial(value.resetAt, 0) &&
  isSerial(value.intent, 1) &&
  value.resetAt <= value.intent &&
  (value.control === null ||
    (isRecord(value.control) &&
      exactly(value.control, ["sites"]) &&
      everyItem(
        value.control.sites,
        (site) =>
          Array.isArray(site) &&
          site.length === 2 &&
          typeof site[0] === "string" &&
          isRandomNext(site[1]),
      )));

/**
 * Makes the connection's random control follow the newest random intent; one older than the newest applied does
 * nothing. Another owner's intent, or a reset newer than the last applied, forgets the history first, before its
 * control can decide a draw: a reset an intent overtook still applies, as every later intent carries it.
 */
export function alignRandom(context: PlayerOpsContext, intent: RandomIntent): void {
  const random = context.random;
  if (intent.intent <= random.intent) return;
  random.intent = intent.intent;
  if (intent.owner !== random.owner || intent.resetAt > random.forgotAt) random.history.clear();
  random.forgotAt = intent.resetAt;
  random.settings = new Map(intent.control?.sites ?? []);
  if (intent.control === null) random.control = null;
  else if (random.owner !== intent.owner || random.control === null)
    random.control = ownerControl(context, intent.owner);
  random.owner = intent.owner;
}

/**
 * The control of `owner`'s sessions: it decides by the connection's settings and records into its history while
 * `owner` still holds them and Choose outcomes is on; otherwise every draw goes on naturally and nothing is recorded,
 * as for a session of a Player that ended.
 */
function ownerControl(context: PlayerOpsContext, owner: number): RandomControlOptions {
  const natural: RandomDecision = { kind: "natural" };
  return Object.freeze({
    decide: (draw: RandomDrawView): RandomDecision => {
      // Through the one gate to the random state, as every other access is.
      const owned = ownedRandom(context, owner);
      return owned !== null && owned.control !== null
        ? decideDraw(owned.settings, owned.history, draw)
        : natural;
    },
  });
}

/** The random state `owner`'s sessions may use: the connection's while `owner` holds it, else none. */
export function ownedRandom(context: PlayerOpsContext, owner: number | null): RandomState | null {
  return owner !== null && owner === context.random.owner ? context.random : null;
}

/**
 * One tracing change a live Player sent: on or off, with its serial, which the connection counts up across the Players
 * that use it (`PlayerBridge.nextTracingIntent`). Every op that sets the connection's trace carries one, through
 * whichever channel it arrives.
 */
export interface TracingIntent {
  readonly on: boolean;
  readonly intent: number;
}

/** Whether `value` is a `TracingIntent`. */
export const isTracingIntent = (value: unknown): value is TracingIntent =>
  isRecord(value) &&
  exactly(value, ["on", "intent"]) &&
  typeof value.on === "boolean" &&
  typeof value.intent === "number" &&
  Number.isSafeInteger(value.intent) &&
  value.intent >= 1;

/**
 * Makes the connection's value trace follow the Player's newest tracing intent: a new trace with no history, or none.
 * The intent arrives through the connection's queue (`debugTracing`) or with the work that begins an epoch (a Start in
 * the host, Continue's `restartTrace`), in any order; one older than the newest applied does nothing, so a change still
 * queued never undoes a newer one. Returns the trace's ID now, or `null`.
 */
export function alignTrace(
  context: PlayerOpsContext,
  { on, intent }: TracingIntent,
): number | null {
  if (intent > context.traceIntent) {
    context.traceIntent = intent;
    if (on !== (context.trace !== null)) {
      context.trace = on ? new RuntimeDebugContext() : null;
      if (on) context.traceId += 1;
    }
  }
  return context.trace === null ? null : context.traceId;
}

export function playerOpsContext(): PlayerOpsContext {
  const plans = new Map<string, InstructionPlan>();
  let nextPlan = 1;
  return {
    plans,
    hold: (plan) => {
      const token = `p${nextPlan++}`;
      plans.set(token, plan);
      return token;
    },
    recorder: new DebugRecorder(),
    sources: new Map(),
    debug: new DebugCaches(),
    trace: null,
    traceId: 0,
    traceIntent: 0,
    planTexts: new Map(),
    random: {
      intent: 0,
      owner: 0,
      control: null,
      settings: new Map(),
      history: new RandomHistory(),
      forgotAt: 0,
    },
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
  /** A source's result, after the compiler loads: the only op the host awaits. */
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
    context.sources.set(
      plan,
      typeof script === "string" ? [{ path: MAIN_FILE_PATH, source: script }] : script.files,
    );
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
    teardown: {
      session: "none",
      checkArguments: (args) => args === null,
      run: (_args, sessions) => {
        plans.clear();
        context.sources.clear();
        context.debug.clear();
        for (const slot of context.planTexts.values())
          if (slot.timer !== null) clearTimeout(slot.timer);
        context.planTexts.clear();
        sessions.clear();
        return { result: null };
      },
    },
    ...sessionOps(context),
    ...debugOps(context),
    ...inputOps(context),
    ...mediaOps(context),
    ...resourceOps(context),
    ...persistenceOps(context),
    ...traceOps(context),
    ...randomOps(context),
  };
}
