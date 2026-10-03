import path from "node:path";
import { isRecord } from "./ast.ts";

/**
 * Deterministic smoke run of generated TeaseScript in the real runtime: buttons are pressed, each visit of a choice
 * takes the next option in turn (so loops waiting for a particular answer end), text and number inputs cycle
 * through fixed answers, waits and timers advance simulated time, and media plays in simulated real time after a
 * successful load of one second per pass. It proves that one path through the script executes without runtime
 * errors; it does not explore every branch.
 *
 * `failed` includes `TSR037`: the product's default instruction budget between two events, which the Player uses
 * as well. `stepLimit` is inconclusive.
 */
export interface SmokeRunResult {
  status: "halted" | "failed" | "stepLimit" | "stuck";
  /** `line` is the one-based line of the generated TeaseScript source; harness problems have code `HARNESS`. */
  failure: { code: string; message: string; line: number | null } | null;
  steps: number;
}

/** Values exchanged with host functions: scalars, or runtime composites such as `{ kind: "list", items }`. */
export type RuntimeValue = string | number | boolean | null | { readonly kind: string };

export type HostFunction = (
  positional: readonly RuntimeValue[],
  named: Readonly<Record<string, RuntimeValue>>,
) => RuntimeValue;

/** Simulated time shared with host stand-ins, in milliseconds since the start of the run or flow. */
export interface SmokeClock {
  nowMs: number;
}

export interface SmokeRunOptions {
  maxSteps?: number;
  /**
   * Interaction visits per instruction; passing the same map for every run of one script continues the answer
   * rotation when the script is entered again.
   */
  visits?: Map<unknown, number>;
  /** Advanced with simulated time; a flow passes one clock through all of its scripts. */
  clock?: SmokeClock;
  /** Script storage the run starts with and leaves its writes in; a flow passes one map through its scripts. */
  storage?: Map<string, RuntimeValue>;
}

export type TeaseRunner = (
  source: string,
  builtins: Readonly<Record<string, HostFunction>>,
  options?: SmokeRunOptions,
) => SmokeRunResult;

/**
 * State shared by the scripts of one package flow: storage, the script a `run` transfers to, simulated time, and
 * answer rotation of host stand-ins for pending inputs.
 */
export interface FlowState {
  storage: Map<string, RuntimeValue>;
  transfer: string | null;
  clock: SmokeClock;
  answers: Map<string, number>;
}

export function newFlowState(): FlowState {
  return { storage: new Map(), transfer: null, clock: { nowMs: 0 }, answers: new Map() };
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
  /** Scripts that ran, in first-visit order. */
  visited: string[];
  transfers: number;
  steps: number;
}

/**
 * Normalized lookup key of a package-relative script path as written in `run` targets: forward slashes, no `.` or
 * `..` segments or repeated separators, and lower case, since the legacy player ran on case-insensitive file systems.
 */
export function flowKey(scriptPath: string): string {
  return path.posix
    .normalize(scriptPath.replaceAll("\\", "/"))
    .replace(/^(?:\.\/|\/)+/u, "")
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
  const state = newFlowState();
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
    if (steps >= maxSteps) return result("stepLimit");
    if (!visited.includes(current)) visited.push(current);
    let scriptVisits = visits.get(current);
    if (scriptVisits === undefined) visits.set(current, (scriptVisits = new Map()));
    state.transfer = null;
    const run = runner(script.source, script.builtins(state), {
      maxSteps: maxSteps - steps,
      visits: scriptVisits,
      clock: state.clock,
      storage: state.storage,
    });
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

interface RuntimeApi {
  call: (name: string, ...args: unknown[]) => RuntimeData;
  /** Playback records of the active media, from mediaPlaybackProjection(). */
  media: (snapshot: RuntimeData) => RuntimeData[];
}

const RUNTIME_OPERATIONS = [
  "compileSource",
  "createFreshRuntimeSnapshot",
  "run",
  "completeAction",
  "observeTime",
  "reportMediaLoad",
];

export async function loadRepositoryRunner(): Promise<TeaseRunner> {
  const module: unknown = await import(repositoryIndexUrl.href);
  const exported = (name: string) => {
    const value = isRecord(module) ? module[name] : undefined;
    if (typeof value !== "function") throw new Error(`Repository build does not export ${name}().`);
    return value;
  };
  const operations = new Map(RUNTIME_OPERATIONS.map((name) => [name, exported(name)]));
  const projection = exported("mediaPlaybackProjection");
  const api: RuntimeApi = {
    call: (name, ...args) => {
      const operation = operations.get(name);
      if (operation === undefined) throw new Error(`Unknown runtime operation ${name}.`);
      const value: unknown = operation(...args);
      if (!isRecord(value)) throw new Error(`${name}() returned an unexpected result shape.`);
      return value;
    },
    media: (snapshot) => {
      const value: unknown = projection(snapshot);
      return Array.isArray(value) ? value.filter(isRecord) : [];
    },
  };
  return (source, builtins, options = {}) =>
    smokeRun(
      api,
      source,
      builtins,
      options.maxSteps ?? 2000,
      options.visits ?? new Map(),
      options.clock ?? { nowMs: 0 },
      options.storage ?? new Map(),
    );
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

/** Duration of one pass of every simulated media file. */
const MEDIA_PASS_MS = 1000;

function smokeRun(
  api: RuntimeApi,
  source: string,
  builtins: Readonly<Record<string, HostFunction>>,
  maxSteps: number,
  visits: Map<unknown, number>,
  clock: SmokeClock,
  storage: Map<string, RuntimeValue>,
): SmokeRunResult {
  const compiled = api.call("compileSource", source, { builtins: Object.keys(builtins) });
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
  // Session-local storage, sorted by key as the runtime keeps it; stored values are never null.
  const scriptStorage = [...storage]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => ({ key, value }));
  let snapshot: RuntimeData = api.call("createFreshRuntimeSnapshot", plan, {
    seed: 12345,
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
    scriptStorage,
  });
  const clockStart = clock.nowMs;
  let now = 0;
  // When each playback segment was last reported, keyed by media ID and segment.
  const reportedAt = new Map<string, number>();
  const harness = (message: string, steps: number): SmokeRunResult => ({
    status: "stuck",
    failure: { code: "HARNESS", message, line: null },
    steps,
  });
  // Operations return `{ snapshot, outcome, ... }`; the fresh snapshot is the snapshot itself.
  const advance = (result: RuntimeData): void => {
    const next = api.call("run", plan, result.snapshot, capabilities).snapshot;
    if (!isRecord(next)) throw new Error("run() returned no snapshot.");
    snapshot = next;
  };
  // Advances simulated time; all running media, foreground or background, plays on in real time.
  const observe = (until: number): RuntimeData => {
    const reports = api
      .media(snapshot)
      .filter((media) => media.state === "running" && media.loaded === true)
      .map((media) => {
        const key = `${String(media.mediaId)}:${String(media.segment)}`;
        const since = reportedAt.get(key) ?? now;
        reportedAt.set(key, until);
        const reported =
          typeof media.reportedProgressMs === "number" ? media.reportedProgressMs : 0;
        return {
          mediaId: media.mediaId,
          segment: media.segment,
          progressMs: reported + until - since,
        };
      });
    now = until;
    clock.nowMs = clockStart + now;
    return api.call("observeTime", plan, snapshot, now, reports);
  };
  const terminal = (steps: number): SmokeRunResult | null => {
    if (snapshot.status === "halted") return { status: "halted", failure: null, steps };
    if (snapshot.status !== "failed") return null;
    const failure = isRecord(snapshot.failure) ? snapshot.failure : {};
    const start = isRecord(failure.span) && isRecord(failure.span.start) ? failure.span.start : {};
    return {
      status: "failed",
      failure: {
        code: typeof failure.code === "string" ? failure.code : "UNKNOWN",
        message: typeof failure.message === "string" ? failure.message : "",
        line: typeof start.line === "number" ? start.line + 1 : null,
      },
      steps,
    };
  };
  // Leaves the run's storage writes in the shared map however the run ends.
  const keepStorage = (): void => {
    storage.clear();
    const entries = Array.isArray(snapshot.scriptStorage) ? snapshot.scriptStorage : [];
    for (const entry of entries.filter(isRecord)) {
      if (typeof entry.key === "string" && isRuntimeValue(entry.value)) {
        storage.set(entry.key, entry.value);
      }
    }
  };
  const runActions = (): SmokeRunResult => {
    advance({ snapshot });
    for (let steps = 0; steps < maxSteps; steps += 1) {
      const done = terminal(steps);
      if (done !== null) return done;
      const action = isRecord(snapshot.foregroundAction) ? snapshot.foregroundAction : null;
      if (action === null) return { status: "stuck", failure: null, steps };
      if (action.kind === "interaction") {
        const visit = visits.get(action.owningInstruction) ?? 0;
        const completion = api.call("completeAction", plan, snapshot, {
          actionId: action.actionId,
          actionKind: "interaction",
          interactionKind: action.interactionKind,
          payload: interactionAnswer(action, visit),
        });
        const outcome = isRecord(completion.outcome) ? completion.outcome : {};
        if (outcome.kind === "completed") {
          visits.set(action.owningInstruction, visit + 1);
        } else if (outcome.kind !== "executionPending") {
          return harness(`Interaction answer rejected: ${JSON.stringify(outcome)}`, steps);
        }
        advance(completion);
        continue;
      }
      if (typeof action.deadlineMs === "number") {
        advance(observe(Math.max(now + 1, action.deadlineMs)));
        continue;
      }
      if (action.kind === "mediaPlayback") {
        const media = api.media(snapshot).find((entry) => entry.mediaId === action.mediaId);
        if (media !== undefined && media.loaded !== true) {
          const loaded = api.call("reportMediaLoad", plan, snapshot, action.mediaId, {
            kind: "loaded",
            durationMs: MEDIA_PASS_MS,
          });
          const outcome = isRecord(loaded.outcome) ? loaded.outcome : {};
          if (outcome.kind === "invalidReport") {
            return harness(`Media load report rejected: ${JSON.stringify(outcome)}`, steps);
          }
          advance(loaded);
          continue;
        }
      }
      advance(observe(now + MEDIA_PASS_MS));
    }
    return terminal(maxSteps) ?? { status: "stepLimit", failure: null, steps: maxSteps };
  };
  try {
    return runActions();
  } finally {
    keepStorage();
  }
}

const TEXT_ANSWERS = ["answer", "yes", "no"];
const NUMBER_ANSWERS = [1, 3, 10, 0];

function interactionAnswer(action: RuntimeData, visit: number) {
  switch (action.interactionKind) {
    case "button":
      return { kind: "activate" };
    case "text":
      return { kind: "submittedText", submittedText: TEXT_ANSWERS[visit % TEXT_ANSWERS.length] };
    case "number":
      return {
        kind: "submittedText",
        submittedText: String(NUMBER_ANSWERS[visit % NUMBER_ANSWERS.length]),
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
