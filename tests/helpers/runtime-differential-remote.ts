import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { differentialRunOn } from "./runtime-differential.js";
import { canonicalText } from "./runtime-state-comparison.js";
import {
  Attribution,
  DEFAULT_MAX_CUTS,
  DEFAULT_MAX_STEPS,
  PortFailure,
  Stop,
  type ClassifiedSideFailure,
  type CompiledFacts,
  type DifferentialInput,
  type DifferentialOptions,
  type DifferentialReport,
  type NextFacts,
  type PairVerdict,
  type PortContext,
  type PortRecord,
  type ProbeFacts,
  type RestoreTail,
  type SideName,
  type SideOutcome,
  type SidePort,
  type Stage,
  type SideRecord,
} from "./runtime-differential-side.js";

/*
 * The side port across processes (docs/TESTING.md "Differential harness"): each side is a root's runner
 * (`tools/runtime-differential/run-root.mjs`), one process per root, called synchronously over a pair of named pipes
 * (`mkfifo`). The launcher writes a request line and blocks reading the reply line, so the lockstep driver's one
 * control flow runs unchanged. Lines are decoded as UTF-8 only once complete. A reply is checked whole: its sequence,
 * exactly one answer, and that answer's shape for its operation, a failure or stop only of the asking side's own. A
 * runner that exits, closes its pipe, or writes anything else is that side's `harness-failure` where it was lost, and
 * stays lost. A runner that never answers blocks until the job's deadline; that case is a limit of the written bar,
 * with no timeout of its own.
 */

const runner = fileURLToPath(
  new URL("../../../tools/runtime-differential/run-root.mjs", import.meta.url),
);

/** How a runner answered one request. */
type Reply =
  | { readonly value: unknown }
  | { readonly failure: ClassifiedSideFailure }
  | {
      readonly stop: {
        readonly verdict: PairVerdict;
        readonly outcome: { readonly side: SideName; readonly outcome: SideOutcome } | null;
      };
    };

/** A runner the launcher cannot hear from: the side's harness failure at the call it was making. */
class RunnerLost extends Error {
  public constructor(
    message: string,
    readonly op: string,
    readonly stage: string,
  ) {
    super(message);
  }
}

/** One root's runner process and its pipes. */
export class Runner {
  readonly #child: ChildProcess;
  readonly #write: number;
  readonly #read: number;
  readonly #stderr: string;
  #buffer: Buffer = Buffer.alloc(0);
  #seq = 0;
  /** The first loss, raised again by every later call: a lost runner's stream is never read again. */
  #lost: RunnerLost | null = null;

  /**
   * Starts a runner for `root`, admitting `files` (relative to it), with test-only `replace` (`REL=FILE`). The runner
   * opens both pipes as its first statement, in this order, so these opens return as soon as it has started.
   */
  public constructor(
    readonly label: string,
    root: string,
    files: readonly string[],
    scratch: string,
    replace: readonly string[] = [],
  ) {
    const directory = fs.mkdtempSync(path.join(scratch, `runner-${label}-`));
    const requests = path.join(directory, "requests");
    const replies = path.join(directory, "replies");
    const list = path.join(directory, "files.json");
    this.#stderr = path.join(directory, "stderr.txt");
    fs.writeFileSync(list, JSON.stringify(files));
    // The runner's standard error goes to a file, which a synchronous caller can read when the runner is lost.
    const stderr = fs.openSync(this.#stderr, "w");
    execFileSync("mkfifo", [requests, replies]);
    this.#child = spawn(
      process.execPath,
      [
        runner,
        requests,
        replies,
        "--root",
        root,
        "--files",
        list,
        ...replace.flatMap((item) => ["--replace", item]),
      ],
      { stdio: ["ignore", "ignore", stderr] },
    );
    fs.closeSync(stderr);
    this.#write = fs.openSync(requests, "w");
    this.#read = fs.openSync(replies, "r");
  }

  /** The error line the runner wrote on its standard error (its first naming an error, else its last), if any. */
  public diagnostic(): string {
    let lines: string[];
    try {
      lines = fs
        .readFileSync(this.#stderr, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "");
    } catch {
      return "";
    }
    return (lines.find((line) => /^\w*Error\b/u.test(line)) ?? lines.at(-1) ?? "").slice(0, 400);
  }

  /**
   * Sends one request and blocks for its reply; a runner lost at it, or before, raises its first loss. The reply must
   * be an object of exactly its request's `seq` and one answer, which `valid` accepts; anything else loses the runner.
   */
  public call(op: string, stage: string, args: unknown, valid: (reply: Reply) => boolean): Reply {
    if (this.#lost !== null) throw this.#lost;
    const lose = (what: string) => {
      const detail = this.diagnostic();
      this.#lost = new RunnerLost(
        `the ${this.label} runner ${what}${detail === "" ? "" : `: ${detail}`}`,
        op,
        stage,
      );
      return this.#lost;
    };
    const seq = (this.#seq += 1);
    try {
      fs.writeSync(this.#write, `${canonicalText({ seq, op, stage, args })}\n`);
    } catch (error) {
      throw lose(`cannot be written to: ${String(error)}`);
    }
    const line = this.readLine();
    if (line === null) throw lose("closed its pipe");
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw lose(`wrote a malformed line: ${line.slice(0, 80)}`);
    }
    if (!isObject(parsed) || parsed["seq"] !== seq)
      throw lose(`answered out of order: ${line.slice(0, 80)}`);
    const keys = Object.keys(parsed);
    const tag = keys.find((key) => key !== "seq");
    if (keys.length !== 2 || (tag !== "value" && tag !== "failure" && tag !== "stop"))
      throw lose(`wrote a malformed reply: ${line.slice(0, 80)}`);
    // EVIDENCE: validation: the reply is an object of its request's sequence and exactly one of the three answer tags.
    const reply = { [tag]: parsed[tag] } as Reply;
    if (!valid(reply)) throw lose(`wrote a malformed reply to ${op}: ${line.slice(0, 80)}`);
    return reply;
  }

  /** The next line, its bytes decoded only once it is complete, so a character split between reads stays whole. */
  private readLine(): string | null {
    const chunk = Buffer.alloc(1 << 16);
    const parts: Buffer[] = [this.#buffer];
    let length = this.#buffer.length;
    let at = this.#buffer.indexOf(0x0a);
    while (at < 0) {
      let read;
      try {
        read = fs.readSync(this.#read, chunk, 0, chunk.length, null);
      } catch {
        return null;
      }
      if (read === 0) return null;
      const found = chunk.subarray(0, read).indexOf(0x0a);
      if (found >= 0) at = length + found;
      parts.push(Buffer.from(chunk.subarray(0, read)));
      length += read;
    }
    const bytes = Buffer.concat(parts, length);
    this.#buffer = bytes.subarray(at + 1);
    return bytes.toString("utf8", 0, at);
  }

  /** Ends the runner: closing its requests ends its loop. */
  public close(): void {
    for (const fd of [this.#write, this.#read])
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    this.#child.kill();
  }
}

/** A record as a runner writes it: `canonicalText` of its state and of its traces. */
interface Texts {
  readonly state: string;
  readonly traces: string;
}

/*
 * What a runner may answer, checked before the driver sees it: each guard accepts exactly what a `LocalPort` returns
 * for its operation, and a failure or a stop only of the asking side's own kinds.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object with exactly `keys`. */
function hasExactly(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const isText = (value: unknown): value is string => typeof value === "string";
const STAGES: readonly string[] = [
  "compile",
  "probe",
  "setup",
  "opening",
  "step",
  "capture",
  "restore",
];

function isOutcome(value: unknown): value is SideOutcome {
  if (!isObject(value)) return false;
  switch (value["kind"]) {
    case "completed":
    case "waiting":
      return hasExactly(value, ["kind"]);
    case "structured-fault":
      return (
        hasExactly(value, ["kind", "code", "path", "span", "pc"]) &&
        isText(value["code"]) &&
        isText(value["path"]) &&
        isCount(value["pc"])
      );
    case "compile-rejected":
      return hasExactly(value, ["kind", "diagnostics"]);
    case "unsupported-route":
    case "censored":
      return hasExactly(value, ["kind", "reason"]) && isText(value["reason"]);
    case "admission-rejected":
      return hasExactly(value, ["kind", "error"]) && isText(value["error"]);
    case "serializer-failure":
    case "harness-failure":
      return (
        hasExactly(value, ["kind", "stage", "member", "error"]) &&
        STAGES.includes(String(value["stage"])) &&
        isText(value["member"]) &&
        isText(value["error"])
      );
    default:
      return false;
  }
}

/** A classified failure of `side` itself, as a port reports one: a harness or serializer failure. */
function isOwnFailure(value: unknown, side: SideName): value is ClassifiedSideFailure {
  if (!hasExactly(value, ["side", "outcome"]) || value["side"] !== side) return false;
  const outcome = value["outcome"];
  return (
    isOutcome(outcome) &&
    (outcome.kind === "harness-failure" || outcome.kind === "serializer-failure")
  );
}

/** The one stop a port raises: its own fresh session refusing the input. */
function isOwnStop(value: unknown, side: SideName): boolean {
  if (!hasExactly(value, ["verdict", "outcome"])) return false;
  const { verdict, outcome } = value;
  return (
    hasExactly(verdict, ["kind", "side", "because"]) &&
    verdict["kind"] === "not-compared" &&
    verdict["side"] === side &&
    verdict["because"] === "admission-rejected" &&
    hasExactly(outcome, ["side", "outcome"]) &&
    outcome["side"] === side &&
    isOutcome(outcome["outcome"]) &&
    outcome["outcome"].kind === "admission-rejected"
  );
}

const isNull = (value: unknown): value is null => value === null;
const isDigest = (value: unknown): value is string =>
  isText(value) && /^[0-9a-f]{64}$/u.test(value);

function isCompiled(value: unknown): value is CompiledFacts {
  if (!isObject(value)) return false;
  if (value["kind"] === "plan" || value["kind"] === "rejected")
    return hasExactly(value, ["kind", "diagnostics"]);
  return (
    value["kind"] === "unsupported" &&
    hasExactly(value, ["kind", "reason"]) &&
    isText(value["reason"])
  );
}

function isProbe(value: unknown): value is ProbeFacts {
  return (
    hasExactly(value, ["steps", "waits", "emitting", "faulted"]) &&
    isCount(value["steps"]) &&
    Array.isArray(value["waits"]) &&
    value["waits"].every(isCount) &&
    Array.isArray(value["emitting"]) &&
    value["emitting"].every(isCount) &&
    typeof value["faulted"] === "boolean"
  );
}

function isNext(value: unknown): value is NextFacts {
  if (!isObject(value)) return false;
  if (value["kind"] === "go") return hasExactly(value, ["kind"]);
  return (
    value["kind"] === "end" && hasExactly(value, ["kind", "outcome"]) && isOutcome(value["outcome"])
  );
}

function isRestored(value: unknown): value is { readonly run: number; readonly live: boolean } {
  return (
    hasExactly(value, ["run", "live"]) &&
    isCount(value["run"]) &&
    typeof value["live"] === "boolean"
  );
}

function isTexts(value: unknown): value is Texts {
  return (
    hasExactly(value, ["state", "traces"]) && isText(value["state"]) && isText(value["traces"])
  );
}

function isAdmission(value: unknown): value is Admission {
  if (!isObject(value)) return false;
  if (value["accepted"] === true)
    return hasExactly(value, ["accepted", "digest"]) && isDigest(value["digest"]);
  const error = value["error"];
  return (
    value["accepted"] === false &&
    hasExactly(value, ["accepted", "error"]) &&
    hasExactly(error, ["name", "code", "path", "info", "message"]) &&
    isText(error["name"]) &&
    isText(error["message"])
  );
}

/** One side of a pair, in a root's runner. */
class RemotePort implements SidePort {
  public constructor(
    private readonly runner: Runner,
    private readonly attribution: Attribution,
    private readonly side: SideName,
  ) {}

  /** Starts the pair on this side's runner. */
  public begin(context: PortContext): void {
    this.call("begin", isNull, {
      side: this.side,
      input: context.input,
      route: context.route,
      maxSteps: context.maxSteps,
      maxCuts: context.maxCuts,
    });
  }

  /**
   * One operation on the runner's port: its answer, which `valid` accepts, or the stop or side failure it raised there,
   * raised here. A failure or a stop must be this side's own, as only a side's own port raises them.
   */
  private call<T>(op: string, valid: (value: unknown) => value is T, args: unknown = null): T {
    let reply: Reply;
    const side = this.side;
    try {
      reply = this.runner.call(op, this.attribution.cursor.stage, args, (answer) =>
        "value" in answer
          ? valid(answer.value)
          : "failure" in answer
            ? isOwnFailure(answer.failure, side)
            : isOwnStop(answer.stop, side),
      );
    } catch (error) {
      if (!(error instanceof RunnerLost)) throw error;
      // The side's failure is where the runner was lost, also when a later call raises it again.
      throw new PortFailure({
        side: this.side,
        outcome: {
          kind: "harness-failure",
          // EVIDENCE: validation: the stage is the cursor's, which this port sent with the call it was lost at.
          stage: error.stage as Stage,
          member: `runner.${error.op}`,
          error: error.message,
        },
      });
    }
    if ("failure" in reply) throw new PortFailure(reply.failure);
    if ("stop" in reply) throw new Stop(reply.stop.verdict, reply.stop.outcome);
    // EVIDENCE: validation: `valid` accepted the value, a type guard for `T`.
    return reply.value as T;
  }

  /** A record the runner wrote, as its texts and the record they read back into; texts that do not read lose it. */
  private record(op: "opening" | "apply", run: number): PortRecord {
    const read: { record?: SideRecord } = {};
    const texts = this.call(
      op,
      (value): value is Texts => {
        if (!isTexts(value)) return false;
        try {
          // EVIDENCE: validation: the texts are `canonicalText` of a record's parts, which `JSON.parse` reads back.
          read.record = {
            state: JSON.parse(value.state),
            traces: JSON.parse(value.traces),
          } as SideRecord;
          return true;
        } catch {
          return false;
        }
      },
      { run },
    );
    if (read.record === undefined) throw new Error("A validated record has been read.");
    return { record: read.record, texts };
  }

  public compile(): CompiledFacts {
    return this.call("compile", isCompiled);
  }

  public planDigest(): string {
    return this.call("planDigest", isDigest);
  }

  public probe(): ProbeFacts {
    return this.call("probe", isProbe);
  }

  public start(): void {
    this.call("start", isNull);
  }

  public opening(run: number): PortRecord {
    return this.record("opening", run);
  }

  public next(run: number): NextFacts {
    return this.call("next", isNext, { run });
  }

  public apply(run: number): PortRecord {
    return this.record("apply", run);
  }

  public capture(state: number): void {
    this.call("capture", isNull, { state });
  }

  public restore(tail: RestoreTail, cut: number): { readonly run: number; readonly live: boolean } {
    return this.call("restore", isRestored, { tail, cut });
  }

  /** The runner's latched failure; a runner lost when asked is that failure itself, so the verdict still leaves. */
  public pending(): ClassifiedSideFailure | null {
    const side = this.side;
    try {
      return this.call(
        "pending",
        (value): value is ClassifiedSideFailure | null =>
          value === null || isOwnFailure(value, side),
      );
    } catch (error) {
      if (error instanceof PortFailure) return error.failure;
      throw error;
    }
  }
}

/**
 * `input` through two roots' runners: `runners.left` is the oracle, whose uninterrupted run gives the cuts, and
 * `runners.right` the candidate. Only the default host runs across processes; a host driver and the records' injection
 * stay in-process.
 */
export function remoteDifferentialRun(
  runners: { readonly left: Runner; readonly right: Runner },
  input: DifferentialInput,
  options: Omit<DifferentialOptions, "left" | "right" | "host" | "inject"> = {},
): DifferentialReport {
  const attribution = new Attribution();
  return differentialRunOn(
    attribution,
    (route) => {
      const context: PortContext = {
        input,
        route,
        maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
        maxCuts: options.maxCuts ?? DEFAULT_MAX_CUTS,
        host: undefined,
      };
      const left = new RemotePort(runners.left, attribution, "left");
      const right = new RemotePort(runners.right, attribution, "right");
      left.begin(context);
      right.begin(context);
      return { left, right };
    },
    input,
    options,
  );
}

/** The closed list of value builders an external admission's recipe names. */
export type RecipeBuilder =
  | "deepList"
  | "deepSetChain"
  | "wideSet"
  | "mixedNest"
  | "accessorAt"
  | "cycleAt"
  | "holeAt"
  | "prototypeAt"
  | "nonFiniteAt";

/** A value to admit, built inside the root from these parameters, never sent as a value. */
export interface Recipe {
  readonly builder: RecipeBuilder;
  /** Levels of nesting (`deepList`, `deepSetChain`, `mixedNest`, and the depth of the `…At` builders' defect). */
  readonly depth?: number;
  /** Members of `wideSet`. */
  readonly width?: number;
  /** `wideSet`'s duplicated position. */
  readonly duplicateAt?: number;
}

/** The public route an external value enters by. */
export type AdmissionRoute = "global" | "storage" | "checkpoint";

/** What a root's admission did with a recipe's value. */
export type Admission =
  | { readonly accepted: true; readonly digest: string }
  | {
      readonly accepted: false;
      readonly error: {
        readonly name: string;
        readonly code: unknown;
        readonly path: unknown;
        readonly info: unknown;
        readonly message: string;
      };
    };

/**
 * `recipe`'s value built inside `runner`'s root and admitted through its public `route`: the frozen boundary's
 * admission when the runner is the oracle root's (2f Part B).
 */
export function admitExternal(runner: Runner, recipe: Recipe, route: AdmissionRoute): Admission {
  const reply = runner.call(
    "admit",
    "admit",
    { recipe, route },
    (answer) => "value" in answer && isAdmission(answer.value),
  );
  // EVIDENCE: validation: `Runner.call` accepted only a value that `isAdmission` accepts.
  return (reply as { readonly value: Admission }).value;
}
