import { isRecord } from "./ast.ts";

/**
 * Deterministic smoke run of generated TeaseScript in the real runtime: buttons are pressed, each visit of a choice
 * takes the next option in turn (so loops waiting for a particular answer end), text and number inputs cycle
 * through fixed answers, waits and timers advance simulated time, and media reports a short successful playback.
 * It proves that one path through the script executes without runtime errors; it does not explore every branch.
 */
export interface SmokeRunResult {
  status: "halted" | "failed" | "stepLimit" | "stuck";
  /** `line` is the one-based line of the generated TeaseScript source. */
  failure: { code: string; message: string; line: number | null } | null;
  steps: number;
}

/** Values exchanged with host functions: scalars, or runtime composites such as `{ kind: "list", items }`. */
export type RuntimeValue = string | number | boolean | null | { readonly kind: string };

export type HostFunction = (
  positional: readonly RuntimeValue[],
  named: Readonly<Record<string, RuntimeValue>>,
) => RuntimeValue;

/**
 * `visits` counts interaction visits per instruction; passing the same map for every run of one script continues
 * the answer rotation when the script is entered again.
 */
export type TeaseRunner = (
  source: string,
  builtins: Readonly<Record<string, HostFunction>>,
  maxSteps?: number,
  visits?: Map<unknown, number>,
) => SmokeRunResult;

/** State shared by the scripts of one package flow: storage, and the script a `run` transfers to. */
export interface FlowState {
  storage: Map<string, RuntimeValue>;
  transfer: string | null;
}

export interface FlowScript {
  source: string;
  builtins: (state: FlowState) => Record<string, HostFunction>;
}

export interface FlowRunResult {
  entry: string;
  /** A run started at a script that no entry flow reached, with empty storage instead of the package's state. */
  isolated: boolean;
  /** `blocked`: the flow transferred to a script that has no runnable conversion. */
  status: SmokeRunResult["status"] | "blocked";
  failure: (NonNullable<SmokeRunResult["failure"]> & { script: string }) | null;
  blockedTarget: string | null;
  /** Scripts entered, in first-visit order. */
  visited: string[];
  transfers: number;
  steps: number;
}

/** Normalized lookup key of a package-relative script path, as written in `run` targets. */
export function flowKey(scriptPath: string): string {
  return scriptPath
    .replaceAll("\\", "/")
    .replace(/^\.?\//u, "")
    .toLowerCase();
}

/**
 * Runs a package the way a player would: from an entry script, following `run` transfers to other scripts of the
 * package with shared storage, until the flow ends, fails, reaches an unconverted script, or uses up its steps.
 * `scripts` is keyed by `flowKey()`.
 */
export function smokeRunFlow(
  runner: TeaseRunner,
  entry: string,
  scripts: ReadonlyMap<string, FlowScript | null>,
  isolated = false,
  maxSteps = 5000,
): FlowRunResult {
  const state: FlowState = { storage: new Map(), transfer: null };
  const visits = new Map<string, Map<unknown, number>>();
  const visited: string[] = [];
  let steps = 0;
  let transfers = 0;
  const result = (
    status: FlowRunResult["status"],
    failure: FlowRunResult["failure"] = null,
    blockedTarget: string | null = null,
  ): FlowRunResult => ({
    entry,
    isolated,
    status,
    failure,
    blockedTarget,
    visited,
    transfers,
    steps,
  });
  for (let current = flowKey(entry); ;) {
    const script = scripts.get(current);
    if (script === undefined || script === null) return result("blocked", null, current);
    if (!visited.includes(current)) visited.push(current);
    if (steps >= maxSteps) return result("stepLimit");
    let scriptVisits = visits.get(current);
    if (scriptVisits === undefined) visits.set(current, (scriptVisits = new Map()));
    state.transfer = null;
    const run = runner(script.source, script.builtins(state), maxSteps - steps, scriptVisits);
    // A transfer counts as a step, so scripts that transfer immediately cannot loop forever.
    steps += run.steps + 1;
    if (run.status !== "halted") {
      return result(run.status, run.failure === null ? null : { ...run.failure, script: current });
    }
    if (state.transfer === null) return result("halted");
    current = flowKey(state.transfer);
    transfers += 1;
  }
}

const repositoryIndexUrl = new URL("../../dist/src/index.js", import.meta.url);

/** A runtime operation result read field by field; plans and snapshots inside it are passed back unchanged. */
type RuntimeData = Readonly<Record<string, unknown>>;

type RuntimeOperation = (...args: unknown[]) => RuntimeData;

export async function loadRepositoryRunner(): Promise<TeaseRunner> {
  const module: unknown = await import(repositoryIndexUrl.href);
  const names = [
    "compileSource",
    "createFreshRuntimeSnapshot",
    "run",
    "completeAction",
    "observeTime",
    "reportMediaLoad",
  ] as const;
  const api = new Map<string, RuntimeOperation>();
  for (const name of names) {
    const value = isRecord(module) ? module[name] : undefined;
    if (typeof value !== "function") throw new Error(`Repository build does not export ${name}().`);
    api.set(name, (...args) => runtimeData(name, value(...args)));
  }
  const call = (name: string, ...args: unknown[]): RuntimeData => {
    const operation = api.get(name);
    if (operation === undefined) throw new Error(`Unknown runtime operation ${name}.`);
    return operation(...args);
  };
  return (source, builtins, maxSteps = 2000, visits = new Map()) =>
    smokeRun(call, source, builtins, maxSteps, visits);
}

function runtimeData(name: string, value: unknown): RuntimeData {
  if (isRecord(value)) return value;
  throw new Error(`${name}() returned an unexpected result shape.`);
}

function isRuntimeValue(value: unknown): value is RuntimeValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (isRecord(value) && typeof value.kind === "string")
  );
}

function smokeRun(
  api: (name: string, ...args: unknown[]) => RuntimeData,
  source: string,
  builtins: Readonly<Record<string, HostFunction>>,
  maxSteps: number,
  visits: Map<unknown, number>,
): SmokeRunResult {
  const compiled = api("compileSource", source, { builtins: Object.keys(builtins) });
  if (!isRecord(compiled.plan)) {
    return {
      status: "failed",
      failure: { code: "COMPILE", message: "Source does not compile.", line: null },
      steps: 0,
    };
  }
  const plan = compiled.plan;
  const capabilities = {
    builtins: Object.fromEntries(
      Object.entries(builtins).map(([name, host]) => [
        name,
        (request: unknown): RuntimeValue => {
          const positional =
            isRecord(request) && Array.isArray(request.positional) ? request.positional : [];
          const named = isRecord(request) && isRecord(request.named) ? request.named : {};
          const namedValues = Object.entries(named);
          if (
            !positional.every(isRuntimeValue) ||
            !namedValues.every(([, value]) => isRuntimeValue(value))
          ) {
            throw new Error(`Unexpected argument shape for ${name}().`);
          }
          return host(
            positional,
            Object.fromEntries(
              namedValues.filter((entry): entry is [string, RuntimeValue] =>
                isRuntimeValue(entry[1]),
              ),
            ),
          );
        },
      ]),
    ),
  };
  let snapshot: RuntimeData = api("createFreshRuntimeSnapshot", plan, {
    seed: 12345,
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
  });
  let now = 0;
  // Operations return `{ snapshot, ... }`; the fresh snapshot is the snapshot itself.
  const advance = (result: RuntimeData): void => {
    const next = api("run", plan, result.snapshot, capabilities).snapshot;
    if (!isRecord(next)) throw new Error("run() returned no snapshot.");
    snapshot = next;
  };
  advance({ snapshot });
  for (let steps = 0; steps < maxSteps; steps += 1) {
    if (snapshot.status === "halted") return { status: "halted", failure: null, steps };
    if (snapshot.status === "failed") {
      const failure = isRecord(snapshot.failure) ? snapshot.failure : {};
      const start =
        isRecord(failure.span) && isRecord(failure.span.start) ? failure.span.start : {};
      return {
        status: "failed",
        failure: {
          code: typeof failure.code === "string" ? failure.code : "UNKNOWN",
          message: typeof failure.message === "string" ? failure.message : "",
          line: typeof start.line === "number" ? start.line + 1 : null,
        },
        steps,
      };
    }
    const action = isRecord(snapshot.foregroundAction) ? snapshot.foregroundAction : null;
    if (action === null) return { status: "stuck", failure: null, steps };
    if (action.kind === "interaction") {
      const visit = visits.get(action.owningInstruction) ?? 0;
      visits.set(action.owningInstruction, visit + 1);
      advance(
        api("completeAction", plan, snapshot, {
          actionId: action.actionId,
          actionKind: "interaction",
          interactionKind: action.interactionKind,
          payload: interactionAnswer(action, visit),
        }),
      );
      continue;
    }
    if (typeof action.deadlineMs === "number") {
      now = Math.max(now + 1, action.deadlineMs);
      advance(api("observeTime", plan, snapshot, now, []));
      continue;
    }
    if (action.kind === "mediaPlayback") {
      const media = mediaFor(snapshot, action.mediaId);
      if (media === null || media.loaded !== true) {
        advance(
          api("reportMediaLoad", plan, snapshot, action.mediaId, {
            kind: "loaded",
            durationMs: 1000,
          }),
        );
      } else {
        now += 1000;
        advance(
          api("observeTime", plan, snapshot, now, [
            { mediaId: media.mediaId, segment: media.segment, progressMs: 1000 },
          ]),
        );
      }
      continue;
    }
    now += 1000;
    advance(api("observeTime", plan, snapshot, now, []));
  }
  return { status: "stepLimit", failure: null, steps: maxSteps };
}

const TEXT_ANSWERS = ["answer", "yes", "no"];
const NUMBER_ANSWERS = ["1", "3", "10", "0"];

function interactionAnswer(action: RuntimeData, visit: number) {
  switch (action.interactionKind) {
    case "button":
      return { kind: "activate" };
    case "text":
      return { kind: "submittedText", submittedText: TEXT_ANSWERS[visit % TEXT_ANSWERS.length] };
    case "number":
      return {
        kind: "submittedText",
        submittedText: NUMBER_ANSWERS[visit % NUMBER_ANSWERS.length],
      };
    default: {
      const ui = isRecord(action.ui) ? action.ui : {};
      const options = Array.isArray(ui.options) ? ui.options.filter(isRecord) : [];
      const option = options[visit % Math.max(options.length, 1)] ?? {};
      return ui.labelType === "none"
        ? { kind: "selectedText", selectedText: option.text }
        : { kind: "selectedLabel", selectedLabel: option.label };
    }
  }
}

/** The playback record of a media wait, kept with the background media actions. */
function mediaFor(snapshot: RuntimeData, mediaId: unknown): RuntimeData | null {
  const actions = Array.isArray(snapshot.backgroundActions) ? snapshot.backgroundActions : [];
  for (const action of actions) {
    if (isRecord(action) && isRecord(action.media) && action.media.mediaId === mediaId) {
      return action.media;
    }
  }
  return null;
}
