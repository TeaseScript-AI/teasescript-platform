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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactly = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
/**
 * Whether `value` is an array whose every element passes `test`, read by index: a cloned array keeps own properties
 * such as an `every` of its own, and a hole is no element.
 */
function everyItem(value: unknown, test: (item: unknown) => boolean): boolean {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1)
    if (!Object.hasOwn(value, index) || !test(value[index])) return false;
  return true;
}
const isStringArray = (value: unknown) => everyItem(value, (item) => typeof item === "string");

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

function metadata(plan: InstructionPlan): PlanMetadata {
  return {
    files: plan.files.map((file) => file.path),
    stageImages: playerRuntimeStageImages(plan),
    randomSites: listRandomSites(plan),
    ...planLockNeeds(plan),
  };
}

/**
 * The Player's ops. The plans live here, under their tokens; nothing returns one. A source is compiled in the Worker:
 * the compiler loads only then, so a Worker that loads published plans never loads it.
 */
export function playerBridgeOps(): BridgeOps {
  const plans = new Map<string, InstructionPlan>();
  let nextPlan = 1;
  const hold = (plan: InstructionPlan): string => {
    const token = `p${nextPlan++}`;
    plans.set(token, plan);
    return token;
  };
  return {
    prepare: {
      session: "none",
      checkArguments: isPrepareArguments,
      run: async (args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { source } = args as { readonly source: PrepareSource };
        if (source.kind === "plan") {
          const loaded = loadInstructionPlan(source.text);
          const result: PrepareResult =
            loaded.kind === "valid"
              ? {
                  kind: "prepared",
                  plan: hold(loaded.plan),
                  diagnostics: [],
                  identity: null,
                  metadata: metadata(loaded.plan),
                }
              : loaded.kind === "invalid"
                ? { kind: "invalid", errors: loaded.validation.errors }
                : { kind: "unreadable", message: loaded.message };
          return { result };
        }
        const [{ compilePlayerProject }, { scriptIdentity }] = await Promise.all([
          import("../runtime-adapter.js"),
          import("../script-identity.js"),
        ]);
        const compilation = compilePlayerProject(source.script);
        const identity = scriptIdentity(source.script);
        const result: PrepareResult =
          compilation.plan === null
            ? { kind: "notCompiled", diagnostics: compilation.diagnostics, identity }
            : {
                kind: "prepared",
                plan: hold(compilation.plan),
                diagnostics: compilation.diagnostics,
                identity,
                metadata: metadata(compilation.plan),
              };
        return { result };
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
  };
}
