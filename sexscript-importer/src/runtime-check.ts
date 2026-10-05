import path from "node:path";
import { isRecord } from "./ast.ts";

/**
 * Deterministic smoke run of generated TeaseScript in the real runtime: buttons are pressed, each visit of a choice
 * takes the next option in turn (so loops waiting for a particular answer end), text and number inputs cycle
 * through fixed answers, waits and timers advance simulated time, and media plays in simulated real time after a
 * successful load of one second per pass. The wall clock starts at 2026-10-02 12:00 UTC and follows simulated time.
 * It proves that one path through the script executes without runtime errors; it does not explore every branch.
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

/** The wall clock at simulated time 0: 2026-10-02 12:00 UTC, in epoch milliseconds. */
const SMOKE_EPOCH_MS = Date.UTC(2026, 9, 2, 12, 0, 0);

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

/** One file of a TeaseScript project (ADR 0022): its package path and source. */
export interface ProjectSource {
  path: string;
  source: string;
}

/** A smoke run of a whole project, which starts at `main.tease` and follows its transfers in the runtime itself. */
export interface ProjectRunResult {
  status: SmokeRunResult["status"];
  /** `path` names the project file of `line`. */
  failure: (NonNullable<SmokeRunResult["failure"]> & { path: string | null }) | null;
  steps: number;
}

/** `images` is the package's image catalog, which tag queries search. */
export type TeaseProjectRunner = (
  files: readonly ProjectSource[],
  builtins: Readonly<Record<string, HostFunction>>,
  options?: {
    maxSteps?: number;
    images?: ReadonlyArray<{ path: string; keywords: readonly string[] }>;
    /** The storage the run starts with and leaves its saved values in; empty by default. */
    storage?: Map<string, RuntimeValue>;
  },
) => ProjectRunResult;

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
  "compileProject",
  "createFreshRuntimeSnapshot",
  "run",
  "completeAction",
  "observeTime",
  "reportMediaLoad",
];

async function loadRuntimeApi(): Promise<RuntimeApi> {
  const module: unknown = await import(repositoryIndexUrl.href);
  const exported = (name: string) => {
    const value = isRecord(module) ? module[name] : undefined;
    if (typeof value !== "function") throw new Error(`Repository build does not export ${name}().`);
    return value;
  };
  const operations = new Map(RUNTIME_OPERATIONS.map((name) => [name, exported(name)]));
  const projection = exported("mediaPlaybackProjection");
  return {
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
}

const NOT_COMPILED = {
  status: "failed",
  failure: { code: "COMPILE", message: "Source does not compile.", line: null, path: null },
  steps: 0,
} as const satisfies ProjectRunResult;

/** Runs one source as the `main.tease` of a single-file project. */
export async function loadRepositoryRunner(): Promise<TeaseRunner> {
  const api = await loadRuntimeApi();
  return (source, builtins, options = {}) => {
    const compiled = api.call("compileSource", source, { builtins: Object.keys(builtins) });
    const { status, failure, steps } = !isRecord(compiled.plan)
      ? NOT_COMPILED
      : smokeRun(
          api,
          compiled.plan,
          builtins,
          options.maxSteps ?? 2000,
          options.visits ?? new Map(),
          options.clock ?? { nowMs: 0 },
          options.storage ?? new Map(),
        );
    return {
      status,
      failure:
        failure === null
          ? null
          : { code: failure.code, message: failure.message, line: failure.line },
      steps,
    };
  };
}

/** Compiles the files of a project into one plan and runs it from `main.tease`, transfers included. */
export async function loadRepositoryProjectRunner(): Promise<TeaseProjectRunner> {
  const api = await loadRuntimeApi();
  // Runs of the same files with the same host functions reuse the last plan; only the plan is kept, not the
  // compilation's parser trees, which a run does not need.
  let last: {
    files: readonly ProjectSource[];
    builtins: string;
    images: unknown;
    plan: RuntimeData | null;
  } | null = null;
  return (files, builtins, options = {}) => {
    const names = Object.keys(builtins).sort().join("\n");
    const reused =
      last !== null &&
      last.files === files &&
      last.builtins === names &&
      last.images === options.images;
    let plan = reused ? last!.plan : null;
    if (!reused) {
      const compiled = api.call("compileProject", files, {
        builtins: Object.keys(builtins),
        ...(options.images === undefined ? {} : { images: options.images }),
      });
      plan = isRecord(compiled.plan) ? compiled.plan : null;
    }
    last = { files, builtins: names, images: options.images, plan };
    return plan === null
      ? NOT_COMPILED
      : smokeRun(
          api,
          plan,
          builtins,
          options.maxSteps ?? 2000,
          new Map(),
          { nowMs: 0 },
          options.storage ?? new Map(),
        );
  };
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
  plan: RuntimeData,
  builtins: Readonly<Record<string, HostFunction>>,
  maxSteps: number,
  visits: Map<unknown, number>,
  clock: SmokeClock,
  storage: Map<string, RuntimeValue>,
): ProjectRunResult {
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
    wallClockMs: SMOKE_EPOCH_MS + clock.nowMs,
  });
  const clockStart = clock.nowMs;
  let now = 0;
  // When each playback segment was last reported, keyed by media ID and segment.
  const reportedAt = new Map<string, number>();
  const done = (
    status: ProjectRunResult["status"],
    failure: ProjectRunResult["failure"],
    steps: number,
  ): ProjectRunResult => ({ status, failure, steps });
  const harness = (message: string, steps: number): ProjectRunResult =>
    done("stuck", { code: "HARNESS", message, line: null, path: null }, steps);
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
  const terminal = (steps: number): ProjectRunResult | null => {
    if (snapshot.status === "halted") return done("halted", null, steps);
    if (snapshot.status !== "failed") return null;
    const failure = isRecord(snapshot.failure) ? snapshot.failure : {};
    const start = isRecord(failure.span) && isRecord(failure.span.start) ? failure.span.start : {};
    return done(
      "failed",
      {
        code: typeof failure.code === "string" ? failure.code : "UNKNOWN",
        message: typeof failure.message === "string" ? failure.message : "",
        line: typeof start.line === "number" ? start.line + 1 : null,
        path: typeof failure.path === "string" ? failure.path : null,
      },
      steps,
    );
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
  const runActions = (): ProjectRunResult => {
    advance({ snapshot });
    for (let steps = 0; steps < maxSteps; steps += 1) {
      const ended = terminal(steps);
      if (ended !== null) return ended;
      const action = isRecord(snapshot.foregroundAction) ? snapshot.foregroundAction : null;
      if (action === null) return done("stuck", null, steps);
      if (action.kind === "capture") {
        // No camera is configured, so takePhoto() returns null, as it does in a Player without one.
        const completion = api.call("completeAction", plan, snapshot, {
          actionId: action.actionId,
          actionKind: "capture",
          payload: { kind: "unavailable", reason: "unconfigured" },
        });
        const outcome = isRecord(completion.outcome) ? completion.outcome : {};
        if (outcome.kind !== "completed" && outcome.kind !== "executionPending") {
          return harness(`Camera answer rejected: ${JSON.stringify(outcome)}`, steps);
        }
        advance(completion);
        continue;
      }
      if (action.kind === "interaction") {
        const visit = visits.get(action.owningInstruction) ?? 0;
        // An image request (askImage) is answered with one stored image that the harness vouches for.
        const completion = api.call(
          "completeAction",
          plan,
          snapshot,
          {
            actionId: action.actionId,
            actionKind: "interaction",
            interactionKind: action.interactionKind,
            payload: interactionAnswer(action, visit),
          },
          { capturedMedia: { holds: (reference: string) => reference === SMOKE_IMAGE } },
        );
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
    return terminal(maxSteps) ?? done("stepLimit", null, maxSteps);
  };
  try {
    return runActions();
  } finally {
    keepStorage();
  }
}

const TEXT_ANSWERS = ["answer", "yes", "no"];
const NUMBER_ANSWERS = [1, 3, 10, 0];

/** The stored image a smoke run answers image requests with. */
const SMOKE_IMAGE = "smoke-image";

function interactionAnswer(action: RuntimeData, visit: number) {
  if (isRecord(action.ui) && action.ui.kind === "image")
    return { kind: "image", reference: SMOKE_IMAGE };
  switch (action.interactionKind) {
    case "button":
      return { kind: "activate" };
    case "text":
      return { kind: "submittedText", submittedText: TEXT_ANSWERS[visit % TEXT_ANSWERS.length] };
    case "number":
    case "integer":
      return {
        kind: "submittedText",
        submittedText: String(NUMBER_ANSWERS[visit % NUMBER_ANSWERS.length]),
      };
    default: {
      // A choice is completed by the position of a rendered option (#515).
      const ui = isRecord(action.ui) ? action.ui : {};
      const options = Array.isArray(ui.options) ? ui.options : [];
      return { kind: "selectedOption", optionIndex: visit % Math.max(options.length, 1) };
    }
  }
}
