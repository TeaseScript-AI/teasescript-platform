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
 * control flow runs unchanged. A runner that exits, closes its pipe, or writes a malformed line is that side's
 * `harness-failure` at the call. A runner that never answers blocks until the job's deadline; that case is a limit of
 * the written bar, with no timeout of its own.
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
  #buffer = "";
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

  /** Sends one request and blocks for its reply; a runner lost at it, or before, raises its first loss. */
  public call(op: string, stage: string, args: unknown): Reply {
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
    let reply: { readonly seq?: unknown } & Partial<Reply>;
    try {
      // EVIDENCE: validation: checked below for its sequence and for exactly one of its three answers.
      reply = JSON.parse(line) as typeof reply;
    } catch {
      throw lose(`wrote a malformed line: ${line.slice(0, 80)}`);
    }
    if (reply.seq !== seq || !("value" in reply || "failure" in reply || "stop" in reply))
      throw lose(`answered out of order: ${line.slice(0, 80)}`);
    // EVIDENCE: validation: the reply has its request's sequence and one of the three answers.
    return reply as Reply;
  }

  private readLine(): string | null {
    const chunk = Buffer.alloc(1 << 16);
    for (;;) {
      const at = this.#buffer.indexOf("\n");
      if (at >= 0) {
        const line = this.#buffer.slice(0, at);
        this.#buffer = this.#buffer.slice(at + 1);
        return line;
      }
      let read;
      try {
        read = fs.readSync(this.#read, chunk, 0, chunk.length, null);
      } catch {
        return null;
      }
      if (read === 0) return null;
      this.#buffer += chunk.toString("utf8", 0, read);
    }
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

  /** One operation on the runner's port: its answer, or the stop or side failure it raised there, raised here. */
  private call<T>(op: string, args: unknown = null): T {
    let reply: Reply;
    try {
      reply = this.runner.call(op, this.attribution.cursor.stage, args);
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
    // A record comes as the two texts `canonicalText` wrote of its parts.
    // EVIDENCE: validation: the runner answers `op` with what its `LocalPort` returned, whose type the caller names.
    return reply.value as T;
  }

  /** A record the runner wrote: its texts, read back into the record they write. */
  private record(texts: Texts): PortRecord {
    // EVIDENCE: validation: the text is `canonicalText` of a record's state, which `JSON.parse` reads back.
    const state = JSON.parse(texts.state) as SideRecord["state"];
    // EVIDENCE: validation: the text is `canonicalText` of a record's traces, which `JSON.parse` reads back.
    const traces = JSON.parse(texts.traces) as SideRecord["traces"];
    return { record: { state, traces }, texts };
  }

  public compile(): CompiledFacts {
    return this.call<CompiledFacts>("compile");
  }

  public planDigest(): string {
    return this.call<string>("planDigest");
  }

  public probe(): ProbeFacts {
    return this.call<ProbeFacts>("probe");
  }

  public start(): void {
    this.call<null>("start");
  }

  public opening(run: number): PortRecord {
    return this.record(this.call<Texts>("opening", { run }));
  }

  public next(run: number): NextFacts {
    return this.call<NextFacts>("next", { run });
  }

  public apply(run: number): PortRecord {
    return this.record(this.call<Texts>("apply", { run }));
  }

  public capture(state: number): void {
    this.call<null>("capture", { state });
  }

  public restore(tail: RestoreTail, cut: number): { readonly run: number; readonly live: boolean } {
    return this.call<{ readonly run: number; readonly live: boolean }>("restore", { tail, cut });
  }

  /** The runner's latched failure; a runner lost when asked is that failure itself, so the verdict still leaves. */
  public pending(): ClassifiedSideFailure | null {
    try {
      return this.call<ClassifiedSideFailure | null>("pending");
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
  const reply = runner.call("admit", "admit", { recipe, route });
  if (!("value" in reply))
    throw new Error(`The ${runner.label} runner could not admit: ${canonicalText(reply)}`);
  // EVIDENCE: validation: the runner answers an admission as `{ accepted, digest }` or `{ accepted, error }`.
  return reply.value as Admission;
}
