import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SerializableRuntimeValue } from "../../src/index.js";
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
} from "./runtime/runtime-differential-side.js";

/*
 * The side port across processes (docs/TESTING.md "Differential harness"): each side is a root's runner
 * (`tools/runtime-differential/run-root.mjs`), one process per root, called synchronously over a pair of named pipes
 * (`mkfifo`). The launcher writes a request line and blocks reading the reply line, so the lockstep driver's one
 * control flow runs unchanged. Every reply line passes through one total decoder (`decodeReply`) before the driver sees
 * it: strict UTF-8 of the complete line, JSON, exactly its request's sequence and one answer, and that answer's shape
 * for its operation, a record's parts included, with engine payloads left opaque; a failure or stop only of the asking
 * side's own. A runner that exits, closes its pipe, or writes anything else is that side's `harness-failure` where it
 * was lost, and stays lost. A runner that never answers blocks until the job's deadline; that case is a limit of the written bar,
 * with no timeout of its own.
 */

const runner = fileURLToPath(
  new URL("../../../tools/runtime-differential/run-root.mjs", import.meta.url),
);

/** The operations a runner answers. */
export type RunnerOp =
  | "begin"
  | "compile"
  | "planDigest"
  | "probe"
  | "start"
  | "opening"
  | "next"
  | "apply"
  | "capture"
  | "restore"
  | "pending"
  | "admit";

/** A reply as `decodeReply` accepted it: a value of its operation's shape (a record read back), a failure, or a stop. */
export type Decoded =
  | { readonly value: unknown; readonly record?: SideRecord }
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
   * Sends one request and blocks for its reply, as `decodeReply` accepts it for `side`; anything else loses the runner.
   * A runner lost at this call, or before, raises its first loss.
   */
  public call(op: RunnerOp, stage: string, args: unknown, side: SideName | null): Decoded {
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
    const decoded = decodeReply(line, seq, op, side);
    if (typeof decoded === "string") throw lose(decoded);
    return decoded;
  }

  /** The next line's bytes, without its newline; `null` when the pipe has closed. */
  private readLine(): Buffer | null {
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
    return bytes.subarray(0, at);
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
        isText(value["stage"]) &&
        STAGES.includes(value["stage"]) &&
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

/** A record's parts as a `LocalPort` writes them: the harness's own shells, around the engine's opaque payloads. */
function isRecord(state: unknown, traces: unknown): boolean {
  return (
    hasExactly(state, ["operation", "host", "result", "decisions", "snapshot"]) &&
    isText(state["operation"]) &&
    Array.isArray(state["decisions"]) &&
    hasExactly(traces, ["observer", "instructionTrace", "debug"]) &&
    Array.isArray(traces["observer"])
  );
}

/** Each operation's answer, as its `LocalPort` returns it; `pending`'s and a failure's or stop's depend on the side. */
const ANSWERS: Readonly<Record<Exclude<RunnerOp, "pending">, (value: unknown) => boolean>> = {
  begin: isNull,
  compile: isCompiled,
  planDigest: isDigest,
  probe: isProbe,
  start: isNull,
  opening: isTexts,
  next: isNext,
  apply: isTexts,
  capture: isNull,
  restore: isRestored,
  admit: isAdmission,
};

/**
 * The one way from a reply line's bytes to what the driver sees, for the request `seq` of `op` that `side` made (`null`
 * for an admission, which only answers a value): strict UTF-8, JSON, an object of exactly that `seq` and one answer, and
 * the answer's shape (`ANSWERS`, a record's texts read back into its shells, or a failure or stop of `side`'s own). It
 * is total: the reason a reply is refused, never an exception, also when a check itself throws.
 */
export function decodeReply(
  bytes: Uint8Array,
  seq: number,
  op: RunnerOp,
  side: SideName | null,
): Decoded | string {
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return "wrote a line that is not UTF-8";
  }
  const shown = text.slice(0, 80);
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return `wrote a malformed line: ${shown}`;
    }
    if (!isObject(parsed) || parsed["seq"] !== seq) return `answered out of order: ${shown}`;
    const keys = Object.keys(parsed);
    const tag = keys.find((key) => key !== "seq");
    if (keys.length !== 2 || (tag !== "value" && tag !== "failure" && tag !== "stop"))
      return `wrote a malformed reply: ${shown}`;
    const answer = parsed[tag];
    const refused = `wrote a malformed reply to ${op}: ${shown}`;
    if (tag === "failure")
      return side !== null && isOwnFailure(answer, side) ? { failure: answer } : refused;
    if (tag === "stop") {
      if (side === null || !isOwnStop(answer, side)) return refused;
      // EVIDENCE: validation: `isOwnStop` accepted the stop: `side`'s own admission-rejected verdict and outcome.
      const stop = answer as Extract<Decoded, { readonly stop: unknown }>["stop"];
      return { stop };
    }
    if (op === "pending")
      return side !== null && (answer === null || isOwnFailure(answer, side))
        ? { value: answer }
        : refused;
    if (!ANSWERS[op](answer)) return refused;
    if (op !== "opening" && op !== "apply") return { value: answer };
    // EVIDENCE: validation: `isTexts` accepted the answer for a record's operation.
    const texts = answer as Texts;
    let state: unknown;
    let traces: unknown;
    try {
      state = JSON.parse(texts.state);
      traces = JSON.parse(texts.traces);
    } catch {
      return refused;
    }
    if (!isRecord(state, traces)) return refused;
    // EVIDENCE: validation: `isRecord` accepted both parts' shells; their payloads stay opaque, as `SideRecord`'s are.
    const record = { state, traces } as SideRecord;
    return { value: texts, record };
  } catch (error) {
    return `wrote a reply whose check threw: ${error instanceof Error ? error.message : "a non-error"}: ${shown}`;
  }
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
    this.call("begin", {
      side: this.side,
      input: context.input,
      route: context.route,
      maxSteps: context.maxSteps,
      maxCuts: context.maxCuts,
    });
  }

  /** One operation on the runner's port, decoded: its answer, or the stop or side failure it raised there. */
  private decoded(op: RunnerOp, args: unknown): Extract<Decoded, { readonly value: unknown }> {
    let reply: Decoded;
    try {
      reply = this.runner.call(op, this.attribution.cursor.stage, args, this.side);
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
    return reply;
  }

  /** `op`'s answer, of the type its `ANSWERS` guard accepted. */
  private call<T>(op: RunnerOp, args: unknown = null): T {
    // EVIDENCE: validation: `decodeReply` accepted the value by `op`'s guard, which accepts exactly a `T`.
    return this.decoded(op, args).value as T;
  }

  /** A record the runner wrote: its texts, and the record `decodeReply` read back from them. */
  private record(op: "opening" | "apply", run: number): PortRecord {
    const reply = this.decoded(op, { run });
    if (reply.record === undefined) throw new Error("A decoded record's reply carries its record.");
    // EVIDENCE: validation: `decodeReply` accepted the value as a record's texts (`isTexts`).
    const texts = reply.value as Texts;
    return { record: reply.record, texts };
  }

  public compile(): CompiledFacts {
    return this.call("compile");
  }

  public planDigest(): string {
    return this.call("planDigest");
  }

  public probe(): ProbeFacts {
    return this.call("probe");
  }

  public start(): void {
    this.call("start");
  }

  public opening(run: number): PortRecord {
    return this.record("opening", run);
  }

  public next(run: number): NextFacts {
    return this.call("next", { run });
  }

  public apply(run: number): PortRecord {
    return this.record("apply", run);
  }

  public capture(state: number): void {
    this.call("capture", { state });
  }

  public restore(tail: RestoreTail, cut: number): { readonly run: number; readonly live: boolean } {
    return this.call("restore", { tail, cut });
  }

  /** The runner's latched failure; a runner lost when asked is that failure itself, so the verdict still leaves. */
  public pending(): ClassifiedSideFailure | null {
    try {
      return this.call("pending");
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
  | "nonFiniteAt"
  | "plain";

/** A value to admit, built inside the root from these parameters, never sent as a value. */
export interface Recipe {
  readonly builder: RecipeBuilder;
  /** Levels of nesting (`deepList`, `deepSetChain`, `mixedNest`, and the depth of the `…At` builders' defect). */
  readonly depth?: number;
  /** Members of `wideSet`. */
  readonly width?: number;
  /** `wideSet`'s duplicated position. */
  readonly duplicateAt?: number;
  /** `plain`'s value as `canonicalText`: JSON data only, which the root parses. */
  readonly text?: string;
}

/** A recipe of a value JSON carries exactly (`canonicalText` keeps `-0`). */
export function plainRecipe(value: SerializableRuntimeValue): Recipe {
  return { builder: "plain", text: canonicalText(value) };
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
  const reply = runner.call("admit", "admit", { recipe, route }, null);
  // EVIDENCE: validation: without a side, `decodeReply` accepts only a value, which `isAdmission` accepted.
  return (reply as { readonly value: Admission }).value;
}
