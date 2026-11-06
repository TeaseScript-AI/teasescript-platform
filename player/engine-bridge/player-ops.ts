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
import { everyItem, exactly, isRecord, isStringArray } from "./argument-checks.js";
import { inputOps } from "./ops/input.js";
import { mediaOps } from "./ops/media.js";
import { resourceOps } from "./ops/resources.js";
import { sessionOps } from "./ops/session.js";
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

/** What the Player's ops share on one connection: its plans under their tokens, and its debug recorder. */
export interface PlayerOpsContext {
  readonly plans: Map<string, InstructionPlan>;
  /** Keeps `plan` under a new token, which it returns. */
  hold(plan: InstructionPlan): string;
  /** Records the connection's sessions for a debug export; see `DebugRecorder`. */
  readonly recorder: DebugRecorder;
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
    return compilation.plan === null
      ? { kind: "notCompiled", diagnostics: compilation.diagnostics, identity }
      : {
          kind: "prepared",
          plan: hold(compilation.plan),
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
        sessions.clear();
        return { result: null };
      },
    },
    ...sessionOps(context),
    ...inputOps(context),
    ...mediaOps(context),
    ...resourceOps(context),
  };
}
