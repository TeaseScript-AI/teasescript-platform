import type { Statement } from "./ast.js";
import type { ControlOrigin } from "./compiler/compile-program.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import { PlanControlFlow, type FlowEdge } from "./plan/control-flow.js";
import { solveForward, type ForwardAnalysis } from "./plan/dataflow.js";
import {
  conditionalExpressionPlanChildren,
  expressionPlanChildren,
} from "./plan/expression-children.js";
import { instructionExpressions } from "./plan/instruction-expressions.js";
import type {
  CompiledFunctionDefinition,
  ExpressionPlan,
  InstructionPlan,
  PlanSourceLocation,
} from "./plan/model.js";
import type { SourceSpan } from "./source.js";
import { PERSON_FIELDS, PLAYER } from "./speaker-terms.js";

/*
 * The flow check of speaker properties (V30 §37): a read of a property through a speaker's name, or as `speaker` where
 * `as` names it, is an error where a way to it misses the custom property, or where no way to it gave the built-in
 * field. It follows the compiled plan, which runs exactly as the session will, with the generic control flow of
 * `plan/control-flow.ts` and the solver of `plan/dataflow.ts`; what it takes from the type check is listed in
 * `SpeakerFlowInput`. Its own choices: what the compiler cannot follow counts as stored (a timer, media, or button
 * block, a called file, a computed target, a fallback), a call counts for what every way through the function assigns,
 * and a function's start is the meet of its calls.
 */

/** A read of a speaker's property through the speaker's name, or as `speaker` where `as` names it. */
export interface SpeakerFlowRead {
  readonly speaker: string;
  readonly name: string;
  /** Whether the property is a built-in field, term, or name list rather than a custom property. */
  readonly field: boolean;
  /** The properties of which the speaker needs one for the read to find a value, the property first. */
  readonly sources: readonly string[];
  /** Where a diagnostic of the read points: the property's name. */
  readonly span: SourceSpan;
}

/** A store `name.property = ...` through a speaker's name. */
export interface SpeakerFlowStore {
  readonly speaker: string;
  readonly name: string;
}

/**
 * What the flow check takes from the type check (see `TypeChecker.speakerFlowInput`), by the place of the source it
 * concerns (see {@link placeKey}), which the plan's expressions and instructions carry as their spans.
 */
export interface SpeakerFlowInput {
  /** The reads to follow, by the place of the property access: a declaration or a store somewhere gives the speaker a source of each. */
  readonly reads: ReadonlyMap<string, SpeakerFlowRead>;
  /** The stores through a speaker's name, by the place of the assignment's target. */
  readonly stores: ReadonlyMap<string, SpeakerFlowStore>;
  /**
   * Which ways through a branch or loop the type check found possible: for an `if` its `then` and its `else` (also
   * without one), for a `switch` each case and then no case, for a `while` its body and its end, and for a `repeat` or
   * `for` its body and no run of it.
   */
  readonly paths: ReadonlyMap<Statement, readonly boolean[]>;
  /** For `and`, `or`, and `otherwise`, by place: whether the right side may run, and whether it may be skipped. */
  readonly operands: ReadonlyMap<string, readonly boolean[]>;
}

/** The key of a place in the source: its file and the offsets of its span. */
export function placeKey(file: number, span: SourceSpan | PlanSourceLocation): string {
  return "so" in span
    ? `${file}:${span.so}:${span.eo}`
    : `${file}:${span.start.offset}:${span.end.offset}`;
}

/** The TSV043 diagnostics of each file, in plan order, for the reads that a way to them does not prepare. */
export function speakerFlowDiagnostics(
  plan: InstructionPlan,
  origins: ReadonlyMap<number, ControlOrigin>,
  input: SpeakerFlowInput,
): readonly Diagnostic[][] {
  const result = plan.files.map((): Diagnostic[] => []);
  if (input.reads.size > 0) new SpeakerFlow(plan, origins, input).report(result);
  return result;
}

type Mode = "must" | "may";

/** An edge of the check's graph: the plan's, or one through a hub of ways the plan cannot name. */
type Edge =
  | FlowEdge
  /** From the hub of computed destinations to every file entry and label. */
  | { readonly kind: "anywhere" }
  /** From the hub of `end`s without a caller to every fallback destination. */
  | { readonly kind: "fallback" };

interface Successor {
  readonly node: number;
  readonly edge: Edge;
}

/** A copy of a function's prologue for the calls that supply the same parameters, so that only their defaults run. */
interface Clone {
  readonly fn: CompiledFunctionDefinition;
  readonly mask: bigint;
  /** The node of the prologue's first instruction; the others follow in order. */
  readonly base: number;
}

/** A region with one entry whose effect calls or creations take over: a prologue, a function body, or a handler. */
interface Routine {
  readonly kind: "prologue" | "body" | "handler";
  readonly fn: CompiledFunctionDefinition;
  /** The nodes of the region: `start` up to `end`. */
  readonly start: number;
  readonly end: number;
  readonly clone: Clone | null;
  /** Whether some way through it reaches its exit: the body for a prologue, a `return` for the others. */
  returns: boolean;
  /** What every way to the exit assigns, and what some way to it may assign. */
  must: bigint;
  may: bigint;
  /** For a handler, whatever it may assign at any time, also in what it creates and calls. */
  any: bigint;
}

interface Summary {
  readonly returns: boolean;
  readonly must: bigint;
  readonly may: bigint;
}

/** A followed read in an instruction. */
interface Read {
  readonly info: SpeakerFlowRead;
  readonly key: string;
}

/** How a way enters a node, to name the way that misses a store. */
type Way =
  | {
      readonly kind: "then" | "noElse" | "else" | "case" | "default" | "noCase" | "goto" | "call";
      readonly line: number;
      readonly file: number;
    }
  | {
      readonly kind: "loop";
      readonly line: number;
      readonly file: number;
      readonly loop: SourceSpan;
    }
  | { readonly kind: "labelFall"; readonly label: string }
  | {
      readonly kind: "functionCall" | "partialCall";
      readonly name: string;
      readonly line: number;
      readonly file: number;
    }
  | {
      readonly kind: "operand";
      readonly operator: "and" | "or" | "otherwise" | "default";
      readonly line: number;
      readonly file: number;
    };

interface WayText {
  readonly phrase: string;
  readonly fix: string | null;
  readonly complete?: boolean;
}

interface NamedStore {
  readonly source: string | null;
  readonly index: number;
  readonly runs: boolean;
  /** The nodes from which some way leads to the store. */
  readonly reaching: ReadonlySet<number>;
}

const TRUE_IMPOSSIBLE = 1;
const FALSE_IMPOSSIBLE = 2;
const ITERATE_IMPOSSIBLE = 4;
const EXHAUSTED_IMPOSSIBLE = 8;
/** The loop runs at least once: it is left only after its body ran. */
const RUNS_ONCE = 16;

class SpeakerFlow {
  readonly #plan: InstructionPlan;
  readonly #flow: PlanControlFlow;
  readonly #origins: ReadonlyMap<number, ControlOrigin>;
  readonly #input: SpeakerFlowInput;
  readonly #bits = new Map<string, bigint>();
  #all = 0n;
  /** The store bits of each instruction that stores. */
  readonly #storeBits = new Map<number, bigint>();
  #allStores = 0n;
  /** The properties that speaker declarations give, which hold from the start of the session. */
  #declared = 0n;
  /** The instructions that store each `speaker.property`, and the copies of the account, in order. */
  readonly #storesOf = new Map<string, number[]>();
  readonly #copies: number[] = [];
  readonly #reads = new Map<number, Read[]>();
  /** The impossible ways of each `jumpIfFalse` and `loopStart`, from the type check. */
  readonly #impossible = new Map<number, number>();
  /** The parameters each call supplies, as a bit per parameter index. */
  readonly #masks = new Map<number, bigint>();
  readonly #clones = new Map<number, Map<bigint, Clone>>();
  readonly #cloneList: Clone[] = [];
  readonly #routines: Routine[] = [];
  readonly #prologues = new Map<string, Routine>();
  readonly #bodies = new Map<number, Routine>();
  readonly #handlers = new Map<number, Routine>();
  readonly #instructionCount: number;
  #nodeCount: number;
  readonly #anywhere: number;
  readonly #fallback: number;
  readonly #returnSink: number;
  readonly #anywhereTargets: number[] = [];
  readonly #fallbackTargets: number[] = [];
  #must: (bigint | null)[] = [];
  #may: (bigint | null)[] = [];
  #incoming: { from: number; edge: Edge }[][] | null = null;
  readonly #fileStoreCache = new Map<number, bigint>();
  readonly #ways = new Map<bigint, Map<number, Way | null>>();
  readonly #named = new Map<string, NamedStore | null>();
  #returnNodes: Map<number, number[]> | null = null;
  #creators: Map<number, number[]> | null = null;

  public constructor(
    plan: InstructionPlan,
    origins: ReadonlyMap<number, ControlOrigin>,
    input: SpeakerFlowInput,
  ) {
    this.#plan = plan;
    this.#flow = new PlanControlFlow(plan);
    this.#origins = origins;
    this.#input = input;
    this.#instructionCount = plan.instructions.length;
    for (const read of input.reads.values())
      for (const source of read.sources) this.#allocate(read.speaker, source);
    this.#collectEvents();
    this.#collectFacts();
    this.#nodeCount = this.#instructionCount;
    this.#allocateClones();
    this.#anywhere = this.#nodeCount;
    this.#fallback = this.#nodeCount + 1;
    this.#returnSink = this.#nodeCount + 2;
    this.#nodeCount += 3;
    this.#collectHubs();
    this.#allocateRoutines();
  }

  // Setup ------------------------------------------------------------------------------------------------------------

  #allocate(speaker: string, name: string): void {
    const key = `${speaker}.${name}`;
    if (this.#bits.has(key)) return;
    const bit = 1n << BigInt(this.#bits.size);
    this.#bits.set(key, bit);
    this.#all |= bit;
  }

  #bit(speaker: string, name: string): bigint {
    return this.#bits.get(`${speaker}.${name}`) ?? 0n;
  }

  /** The followed reads and the stores of each instruction. */
  #collectEvents(): void {
    const { instructions } = this.#plan;
    for (let index = 0; index < instructions.length; index += 1) {
      const instruction = instructions[index]!;
      const file = this.#flow.fileOf(index);
      let stores = 0n;
      if (instruction.kind === "assign" && instruction.target.kind === "property") {
        const store = this.#input.stores.get(placeKey(file, instruction.target.span));
        if (store !== undefined) stores = this.#noteStore(store.speaker, store.name, index);
      } else if (instruction.kind === "declareSpeaker") {
        for (const property of instruction.properties)
          stores |= this.#bit(instruction.name, property.name);
        this.#declared |= stores;
      } else if (instruction.kind === "copyAccount") {
        this.#copies.push(index);
        for (const field of PERSON_FIELDS) stores |= this.#noteStore(PLAYER, field, index);
      }
      if (stores !== 0n) {
        this.#storeBits.set(index, stores);
        this.#allStores |= stores;
      }
      for (const expression of instructionExpressions(instruction))
        this.#collectReads(expression, file, index);
    }
  }

  #noteStore(speaker: string, name: string, index: number): bigint {
    const bit = this.#bit(speaker, name);
    if (bit === 0n) return 0n;
    const key = `${speaker}.${name}`;
    const known = this.#storesOf.get(key);
    if (known === undefined) this.#storesOf.set(key, [index]);
    else known.push(index);
    return bit;
  }

  /** The followed reads in an expression, leaving out a lazy operand that never runs. */
  #collectReads(root: ExpressionPlan, file: number, index: number): void {
    const work: { readonly expression: ExpressionPlan; readonly dead: boolean }[] = [
      { expression: root, dead: false },
    ];
    while (work.length > 0) {
      const { expression, dead } = work.pop()!;
      if (expression.kind === "property" && !dead) {
        const key = placeKey(file, expression.span);
        const info = this.#input.reads.get(key);
        if (info !== undefined) {
          const reads = this.#reads.get(index);
          const read = { info, key };
          if (reads === undefined) this.#reads.set(index, [read]);
          else reads.push(read);
        }
      }
      const conditional = conditionalExpressionPlanChildren(expression);
      const skipped =
        conditional.length > 0 && expression.kind === "binary"
          ? this.#input.operands.get(placeKey(file, expression.span))?.[0] === false
          : false;
      for (const child of expressionPlanChildren(expression))
        work.push({ expression: child, dead: dead || (skipped && conditional.includes(child)) });
    }
  }

  /** The ways through each branch and loop that the type check rules out, by the plan's jumps. */
  #collectFacts(): void {
    for (const [index, origin] of this.#origins) {
      let flags = 0;
      switch (origin.kind) {
        case "if": {
          const ways = this.#input.paths.get(origin.statement);
          if (ways?.[0] === false) flags |= TRUE_IMPOSSIBLE;
          if (ways?.[1] === false) flags |= FALSE_IMPOSSIBLE;
          break;
        }
        case "case": {
          const ways = this.#input.paths.get(origin.statement);
          if (ways?.[origin.index] === false) flags |= TRUE_IMPOSSIBLE;
          const last = origin.statement.cases.length - 1;
          if (origin.index === last && ways?.[last + 1] === false) flags |= FALSE_IMPOSSIBLE;
          break;
        }
        case "loop": {
          const ways = this.#input.paths.get(origin.statement);
          if (ways?.[0] === false) flags |= ITERATE_IMPOSSIBLE;
          if (ways?.[1] === false) {
            flags |= EXHAUSTED_IMPOSSIBLE;
            if (origin.statement.kind !== "whileStatement") flags |= RUNS_ONCE;
          }
          break;
        }
        case "operand": {
          const fact = this.#input.operands.get(
            placeKey(this.#flow.fileOf(index), origin.expression.span),
          );
          if (fact === undefined) break;
          // `and` and `otherwise` run their right side when the condition holds, `or` when it does not.
          const runs = origin.expression.operator === "or" ? FALSE_IMPOSSIBLE : TRUE_IMPOSSIBLE;
          const skip = origin.expression.operator === "or" ? TRUE_IMPOSSIBLE : FALSE_IMPOSSIBLE;
          if (!fact[0]) flags |= runs;
          if (!fact[1]) flags |= skip;
          break;
        }
        case "load":
          break;
      }
      if (flags !== 0) this.#impossible.set(index, flags);
    }
  }

  /** One prologue per function and set of supplied parameters, for the functions with a default. */
  #allocateClones(): void {
    const { instructions } = this.#plan;
    for (let index = 0; index < instructions.length; index += 1) {
      const instruction = instructions[index]!;
      if (instruction.kind !== "callFunction") continue;
      const fn = this.#flow.functionById(instruction.functionId);
      if (fn === undefined) continue;
      let mask = 0n;
      for (const argument of instruction.arguments) {
        const parameter = fn.parameters.find((item) => item.name === argument.parameterName);
        if (parameter !== undefined) mask |= 1n << BigInt(parameter.index);
      }
      this.#masks.set(index, mask);
      if (!fn.parameters.some((parameter) => parameter.hasDefault)) continue;
      let clones = this.#clones.get(fn.id);
      if (clones === undefined) {
        clones = new Map();
        this.#clones.set(fn.id, clones);
      }
      if (clones.has(mask)) continue;
      const clone: Clone = { fn, mask, base: this.#nodeCount };
      this.#nodeCount += fn.bodyEntryInstruction - fn.entryInstruction;
      clones.set(mask, clone);
      this.#cloneList.push(clone);
    }
  }

  #collectHubs(): void {
    this.#plan.files.forEach((file) => {
      this.#anywhereTargets.push(file.entryInstruction);
      for (const label of file.labels) this.#anywhereTargets.push(label.instruction);
    });
    let anyFallback = false;
    for (const instruction of this.#plan.instructions) {
      if (instruction.kind !== "setFallback" || instruction.destination === null) continue;
      const { destination } = instruction;
      if ("value" in destination) anyFallback = true;
      else
        for (const option of "pick" in destination ? destination.pick : [destination])
          this.#fallbackTargets.push(option.target);
    }
    if (anyFallback) this.#fallbackTargets.push(...this.#anywhereTargets);
  }

  #allocateRoutines(): void {
    const add = (routine: Routine): Routine => {
      this.#routines.push(routine);
      return routine;
    };
    for (const fn of this.#plan.functions) {
      const fresh = { returns: true, must: this.#all, may: 0n, any: 0n };
      if (fn.handler !== null) {
        this.#handlers.set(
          fn.id,
          add({
            kind: "handler",
            fn,
            start: fn.entryInstruction,
            end: fn.endInstruction,
            clone: null,
            ...fresh,
          }),
        );
        continue;
      }
      this.#bodies.set(
        fn.id,
        add({
          kind: "body",
          fn,
          start: fn.bodyEntryInstruction,
          end: fn.endInstruction,
          clone: null,
          ...fresh,
        }),
      );
      const clones = this.#clones.get(fn.id);
      if (clones === undefined) {
        this.#prologues.set(
          `${fn.id}`,
          add({
            kind: "prologue",
            fn,
            start: fn.entryInstruction,
            end: fn.bodyEntryInstruction,
            clone: null,
            ...fresh,
          }),
        );
        continue;
      }
      for (const clone of clones.values())
        this.#prologues.set(
          `${fn.id}:${clone.mask}`,
          add({
            kind: "prologue",
            fn,
            start: clone.base,
            end: clone.base + (fn.bodyEntryInstruction - fn.entryInstruction),
            clone,
            ...fresh,
          }),
        );
    }
  }

  // The graph --------------------------------------------------------------------------------------------------------

  /** The instruction of a node, and the prologue copy it stands in. */
  #decode(node: number): { readonly index: number; readonly clone: Clone | null } {
    if (node < this.#instructionCount) return { index: node, clone: null };
    const clones = this.#cloneList;
    let low = 0;
    let high = clones.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (clones[middle]!.base <= node) low = middle + 1;
      else high = middle;
    }
    const clone = clones[low - 1]!;
    return { index: clone.fn.entryInstruction + (node - clone.base), clone };
  }

  /** The node of `index` as seen from `clone`: in the copy when the instruction is part of its prologue. */
  #nodeOf(index: number, clone: Clone | null): number {
    if (
      clone !== null &&
      index >= clone.fn.entryInstruction &&
      index < clone.fn.bodyEntryInstruction
    )
      return clone.base + (index - clone.fn.entryInstruction);
    return index;
  }

  /** The prologue copy that a call enters, or `null` for the function's one prologue. */
  #calleeClone(callIndex: number, fn: CompiledFunctionDefinition): Clone | null {
    return this.#clones.get(fn.id)?.get(this.#masks.get(callIndex) ?? 0n) ?? null;
  }

  #successors(node: number): readonly Successor[] {
    if (node >= this.#anywhere) {
      if (node === this.#anywhere)
        return this.#anywhereTargets.map((target) => ({
          node: target,
          edge: { kind: "anywhere" },
        }));
      if (node === this.#fallback)
        return this.#fallbackTargets.map((target) => ({
          node: target,
          edge: { kind: "fallback" },
        }));
      return [];
    }
    const { index, clone } = this.#decode(node);
    const out: Successor[] = [];
    for (const { edge, target } of this.#flow.successors(index)) {
      switch (edge.kind) {
        case "call": {
          const fn = this.#flow.functionById(edge.functionId);
          if (fn === undefined) break;
          const callee = this.#calleeClone(index, fn);
          out.push({ node: callee === null ? fn.entryInstruction : callee.base, edge });
          break;
        }
        case "computed":
          out.push({ node: this.#anywhere, edge });
          break;
        case "end":
          out.push({ node: this.#fallback, edge });
          break;
        case "return":
          out.push({ node: this.#returnSink, edge });
          break;
        case "exit":
          break;
        case "goto":
        case "transfer":
          out.push({ node: target!, edge });
          break;
        default:
          if (target !== null) out.push({ node: this.#nodeOf(target, clone), edge });
      }
    }
    const instruction = this.#plan.instructions[index]!;
    if (instruction.kind === "loopControl" && instruction.action === "continue") {
      const start = this.#flow.loopStart(instruction.loopId);
      const loop = start === undefined ? undefined : this.#plan.instructions[start];
      if (
        start !== undefined &&
        loop?.kind === "loopStart" &&
        ((this.#impossible.get(start) ?? 0) & RUNS_ONCE) !== 0
      )
        out.push({ node: this.#nodeOf(loop.target, clone), edge: { kind: "exhausted" } });
    }
    return out;
  }

  /** The state after the instruction of `node` itself: what it stores, and what the blocks it creates may store. */
  #effect(index: number, state: bigint): bigint {
    let out = state | (this.#storeBits.get(index) ?? 0n);
    for (const handler of this.#flow.handlersOf(index))
      out |= this.#handlers.get(handler)?.any ?? 0n;
    return out;
  }

  #summaryOfCall(callIndex: number): Summary | null {
    const instruction = this.#plan.instructions[callIndex];
    if (instruction?.kind !== "callFunction") return null;
    const fn = this.#flow.functionById(instruction.functionId);
    if (fn === undefined) return null;
    const clone = this.#calleeClone(callIndex, fn);
    const prologue = this.#prologues.get(clone === null ? `${fn.id}` : `${fn.id}:${clone.mask}`);
    const body = this.#bodies.get(fn.id);
    if (prologue === undefined || body === undefined) return null;
    return {
      returns: prologue.returns && body.returns,
      must: prologue.must | body.must,
      may: prologue.may | body.may,
    };
  }

  /**
   * The state that `state`, entering `node`, passes along `edge`, or `null` when the way ends or the type check rules
   * the edge out. `must` follows only ways the compiler is sure of: it skips computed targets and fallbacks, takes from
   * a call what every way through the function assigns, and ends at a call that never returns. `may` follows every way.
   */
  #transfer(mode: Mode, node: number, edge: Edge, state: bigint): bigint | null {
    if (node >= this.#anywhere) return mode === "may" ? state : null;
    const { index, clone } = this.#decode(node);
    const out = this.#effect(index, state);
    const flags = this.#impossible.get(index) ?? 0;
    switch (edge.kind) {
      case "true":
        return (flags & TRUE_IMPOSSIBLE) === 0 ? out : null;
      case "false":
        return (flags & FALSE_IMPOSSIBLE) === 0 ? out : null;
      case "iterate":
        return (flags & ITERATE_IMPOSSIBLE) === 0 ? out : null;
      case "exhausted":
        return this.#plan.instructions[index]!.kind !== "loopStart" ||
          (flags & EXHAUSTED_IMPOSSIBLE) === 0
          ? out
          : null;
      case "supplied":
      case "omitted": {
        if (clone === null) return out;
        const instruction = this.#plan.instructions[index]!;
        const parameter =
          instruction.kind === "prepareParameterDefault" ? instruction.parameterIndex : 0;
        const supplied = (clone.mask & (1n << BigInt(parameter))) !== 0n;
        return supplied === (edge.kind === "supplied") ? out : null;
      }
      case "resume": {
        const instruction = this.#plan.instructions[index]!;
        if (instruction.kind === "callFunction") {
          const summary = this.#summaryOfCall(index);
          if (summary === null || !summary.returns) return null;
          return out | (mode === "must" ? summary.must : summary.may);
        }
        // A file `call` returns once that file, or one it went on to, ends: what any of them may assign counts.
        if (instruction.kind !== "transfer") return out;
        if ("value" in instruction.destination) return out | this.#allStores;
        const { destination } = instruction;
        let stores = out;
        for (const option of "pick" in destination ? destination.pick : [destination])
          stores |= this.#storesFrom(option.target);
        return stores;
      }
      case "computed":
      case "end":
        return mode === "may" ? out : null;
      case "return":
        return out;
      case "exit":
        return null;
      case "next":
      case "jump":
      case "continue":
      case "break":
      case "call":
      case "goto":
      case "transfer":
      case "anywhere":
      case "fallback":
        return out;
    }
  }

  /** Every store that code starting at the instruction `entry` may make, in the files and blocks it reaches. */
  #storesFrom(entry: number): bigint {
    const known = this.#fileStoreCache.get(entry);
    if (known !== undefined) return known;
    const seen = new Uint8Array(this.#nodeCount);
    const work = [entry];
    seen[entry] = 1;
    let stores = 0n;
    for (let node = work.pop(); node !== undefined; node = work.pop()) {
      if (node < this.#anywhere) {
        const { index } = this.#decode(node);
        stores |= this.#storeBits.get(index) ?? 0n;
        for (const handler of this.#flow.handlersOf(index)) {
          const routine = this.#handlers.get(handler);
          if (routine !== undefined && seen[routine.start] === 0) {
            seen[routine.start] = 1;
            work.push(routine.start);
          }
        }
      }
      for (const { node: next } of this.#successors(node))
        if (seen[next] === 0) {
          seen[next] = 1;
          work.push(next);
        }
    }
    this.#fileStoreCache.set(entry, stores);
    return stores;
  }

  // Solving ----------------------------------------------------------------------------------------------------------

  #analysis(mode: Mode): ForwardAnalysis<bigint, Edge> {
    return {
      nodeCount: this.#nodeCount,
      successors: (node) => this.#successors(node),
      join: mode === "must" ? (left, right) => left & right : (left, right) => left | right,
      equals: (left, right) => left === right,
      transfer: (node, edge, state) => this.#transfer(mode, node, edge, state),
    };
  }

  /**
   * The states of a routine on its own, from an empty state at its start: what reaches its exit, and for a handler
   * what it may assign anywhere. Calls into other routines use their summaries; ways that leave the routine for good
   * (a `goto`, a transfer, an `exit`, an `end`) count for nothing at the exit.
   */
  #solveRoutine(routine: Routine, mode: Mode): { exit: bigint | null; any: bigint } {
    const { start, end } = routine;
    const length = end - start;
    const exitNode = length;
    const isExit = (successor: Successor): boolean =>
      routine.kind === "prologue"
        ? successor.node === routine.fn.bodyEntryInstruction
        : successor.edge.kind === "return";
    const analysis: ForwardAnalysis<bigint, Edge> = {
      nodeCount: length + 1,
      successors: (local) => {
        if (local === exitNode) return [];
        const out: { node: number; edge: Edge }[] = [];
        for (const successor of this.#successors(start + local)) {
          if (successor.edge.kind === "call") continue;
          if (isExit(successor)) out.push({ node: exitNode, edge: successor.edge });
          else if (successor.node >= start && successor.node < end)
            out.push({ node: successor.node - start, edge: successor.edge });
        }
        return out;
      },
      join: mode === "must" ? (left, right) => left & right : (left, right) => left | right,
      equals: (left, right) => left === right,
      transfer: (local, edge, state) => this.#transfer(mode, start + local, edge, state),
    };
    const states = solveForward(analysis, [[0, 0n]]);
    let any = 0n;
    if (mode === "may")
      for (let local = 0; local < length; local += 1) {
        const state = states[local] ?? null;
        if (state !== null) any |= this.#effect(this.#decode(start + local).index, state);
      }
    return { exit: states[exitNode] ?? null, any };
  }

  /** The routines whose summaries each routine's own summary uses: the functions it calls and the blocks it creates. */
  #dependents(): Map<Routine, Set<Routine>> {
    const dependents = new Map<Routine, Set<Routine>>();
    const depend = (user: Routine, used: Routine | undefined): void => {
      if (used === undefined) return;
      const known = dependents.get(used);
      if (known === undefined) dependents.set(used, new Set([user]));
      else known.add(user);
    };
    for (const routine of this.#routines)
      for (let node = routine.start; node < routine.end; node += 1) {
        const { index } = this.#decode(node);
        const instruction = this.#plan.instructions[index]!;
        if (instruction.kind === "callFunction") {
          const fn = this.#flow.functionById(instruction.functionId);
          if (fn === undefined) continue;
          const clone = this.#calleeClone(index, fn);
          depend(
            routine,
            this.#prologues.get(clone === null ? `${fn.id}` : `${fn.id}:${clone.mask}`),
          );
          depend(routine, this.#bodies.get(fn.id));
        }
        for (const handler of this.#flow.handlersOf(index))
          depend(routine, this.#handlers.get(handler));
      }
    return dependents;
  }

  /** Settles every routine's summary, from the optimistic start that each returns and assigns everything. */
  #summarize(): void {
    const dependents = this.#dependents();
    const work = new Set(this.#routines);
    for (const routine of work) {
      work.delete(routine);
      const must = this.#solveRoutine(routine, "must");
      const may = this.#solveRoutine(routine, "may");
      const returns = must.exit !== null;
      const mustGains = must.exit ?? this.#all;
      const mayGains = may.exit ?? 0n;
      if (
        returns === routine.returns &&
        mustGains === routine.must &&
        mayGains === routine.may &&
        may.any === routine.any
      )
        continue;
      routine.returns = returns;
      routine.must = mustGains;
      routine.may = mayGains;
      routine.any = may.any;
      for (const dependent of dependents.get(routine) ?? []) work.add(dependent);
    }
  }

  #solve(mode: Mode): (bigint | null)[] {
    // The session sets up the speakers before the story runs; a declared property also serves the start values that
    // the declaration's own block and the declarations before it read.
    const entries: [number, bigint][] = [[this.#plan.files[0]!.startInstruction, this.#declared]];
    // A block runs at a time the code around it cannot tell: it starts with everything.
    for (const routine of this.#handlers.values()) entries.push([routine.start, this.#all]);
    return solveForward(this.#analysis(mode), entries);
  }

  // Reporting --------------------------------------------------------------------------------------------------------

  public report(result: Diagnostic[][]): void {
    this.#summarize();
    this.#must = this.#solve("must");
    this.#may = this.#solve("may");
    const reported = new Set<string>();
    for (const [index, reads] of this.#reads) {
      const file = this.#flow.fileOf(index);
      for (const node of this.#nodesOf(index)) {
        const must = this.#must[node] ?? null;
        const may = this.#may[node] ?? null;
        if (must === null || may === null) continue;
        for (const read of reads) {
          if (reported.has(read.key)) continue;
          const message = this.#message(read.info, node, must, may, file);
          if (message === null) continue;
          reported.add(read.key);
          result[file]!.push(
            createDiagnostic(DiagnosticSeverity.Error, "TSV043", message, read.info.span),
          );
        }
      }
    }
    for (const diagnostics of result)
      diagnostics.sort((left, right) => left.span.start.offset - right.span.start.offset);
  }

  /** The nodes of an instruction: its own, and one per prologue copy when it is part of a copied prologue. */
  #nodesOf(index: number): readonly number[] {
    const fn = this.#flow.functionOf(index);
    const clones = fn === null ? undefined : this.#clones.get(fn.id);
    if (clones === undefined || index >= fn!.bodyEntryInstruction) return [index];
    return [...clones.values()].map((clone) => clone.base + (index - fn!.entryInstruction));
  }

  /** The message for a read where the speaker cannot have the property yet, or `null`. */
  #message(
    read: SpeakerFlowRead,
    node: number,
    mustState: bigint,
    mayState: bigint,
    file: number,
  ): string | null {
    const { speaker, name, field, sources } = read;
    let some = 0n;
    for (const source of field ? sources : [name]) some |= this.#bit(speaker, source);
    if ((mayState & some) === 0n) return this.#tooEarly(read, node, file);
    const bit = this.#bit(speaker, name);
    if (field || (mustState & bit) !== 0n) return null;
    const way = this.#missingWay(node, bit);
    return someWaysMessage(speaker, name, way === null ? null : this.#describe(way, file, read));
  }

  /**
   * The message for a read that no way to it gives a source of the property first. It names one store: for the
   * player's field a copy of the account, else an assignment of a source, preferring one that runs, and says whether
   * it comes later, runs only on a way that does not reach the read, or never runs.
   */
  #tooEarly(read: SpeakerFlowRead, node: number, file: number): string {
    const { speaker, name, field, sources } = read;
    const copy = speaker === PLAYER && field && this.#copies.length > 0;
    const key = JSON.stringify([speaker, copy, sources]);
    let store = this.#named.get(key);
    if (store === undefined) {
      const candidates = copy
        ? this.#copies.map((index) => ({ source: null, index }))
        : sources.flatMap((source) =>
            (this.#storesOf.get(`${speaker}.${source}`) ?? []).map((index) => ({ source, index })),
          );
      const runs = (index: number): boolean => (this.#may[index] ?? null) !== null;
      candidates.sort(
        (left, right) =>
          Number(runs(right.index)) - Number(runs(left.index)) ||
          this.#flow.fileOf(left.index) - this.#flow.fileOf(right.index) ||
          this.#plan.instructions[left.index]!.span.so -
            this.#plan.instructions[right.index]!.span.so,
      );
      const first = candidates[0];
      store =
        first === undefined
          ? null
          : { ...first, runs: runs(first.index), reaching: this.#reaching(first.index) };
      this.#named.set(key, store);
    }
    let named = "";
    if (store !== null) {
      const when = !store.runs ? "never" : store.reaching.has(node) ? "later" : "elsewhere";
      const line = this.#line(store.index, file);
      named =
        store.source === null
          ? ` The copy on ${line} ${when === "never" ? "never runs" : when === "later" ? "comes only later" : "runs only on a way that does not reach this line"}.`
          : ` ${capitalize(line)} assigns ${sources.length === 1 ? "it" : `'${store.source}'`}, but ${when === "never" ? "that line never runs" : when === "later" ? "only later" : "only on a way that does not reach this line"}.`;
    }
    if (!field)
      return `Speaker '${speaker}' has no '${name}' yet here: nothing assigns it before this line runs.${named} ${
        speaker === PLAYER
          ? `Assign it before this line, as in 'player.${name} = ...'.`
          : `Give it a start value, as in 'speaker ${speaker} { ${name}: ... }', or assign it before this line.`
      }`;
    const quoted = alternatives(sources);
    if (speaker === PLAYER)
      return `Speaker 'player' has no '${name}' yet here: nothing copies the account or assigns ${quoted} before this line runs.${named} Copy the account before this line, as in 'player.copyFrom(account)' at the start of the script, or assign ${sources.includes("gender") ? `'player.gender' or 'player.${name}'` : `'player.${name}'`} first.`;
    return `Speaker '${speaker}' has no '${name}' yet here: nothing assigns ${quoted} before this line runs.${named} ${
      sources.includes("gender")
        ? `Give it a gender, as in 'speaker ${speaker} { gender: "female" }', or assign it before this line.`
        : `Give it a start value, as in 'speaker ${speaker} { ${name}: ... }', or assign it before this line.`
    }`;
  }

  /** `line N`, with the file when it is not `from`. */
  #line(index: number, from: number): string {
    return this.#lineAt(this.#plan.instructions[index]!.span.sl, this.#flow.fileOf(index), from);
  }

  #lineAt(line: number, file: number, from: number): string {
    const text = `line ${line + 1}`;
    return file === from ? text : `${text} of '${this.#plan.files[file]!.path}'`;
  }

  /** The edges into each node, in the order of their sources. */
  #incomingOf(node: number): readonly { from: number; edge: Edge }[] {
    if (this.#incoming === null) {
      const incoming = Array.from(
        { length: this.#nodeCount },
        (): { from: number; edge: Edge }[] => [],
      );
      for (let from = 0; from < this.#nodeCount; from += 1)
        for (const successor of this.#successors(from))
          incoming[successor.node]!.push({ from, edge: successor.edge });
      this.#incoming = incoming;
    }
    return this.#incoming[node]!;
  }

  /** The `must` state that a way into a node carries, or `null` when no way takes it. */
  #carried(from: number, edge: Edge): bigint | null {
    const state = this.#must[from] ?? null;
    return state === null ? null : this.#transfer("must", from, edge, state);
  }

  /**
   * A way to `start` that misses `bit`, searched back from it: a way into a node that misses the bit where another way
   * into it has it, or a call of a function that assigns it on only some of its ways. `null` when none is found. The
   * answer is kept for each node between the way found and `start`, or for every node searched when none is found, so
   * a later search stops at the first node it already knows.
   */
  #missingWay(start: number, bit: bigint): Way | null {
    let found = this.#ways.get(bit);
    if (found === undefined) {
      found = new Map();
      this.#ways.set(bit, found);
    }
    const lacks = (state: bigint | null): boolean => state !== null && (state & bit) === 0n;
    const parents = new Map<number, number | null>([[start, null]]);
    const work = [start];
    let way: Way | null = null;
    let at: number | null = null;
    for (let position = 0; position < work.length && at === null; position += 1) {
      const node = work[position]!;
      const kept = found.get(node);
      if (kept !== undefined) {
        // A node searched before: its way leads here too, or nothing behind it misses the bit where another way has it.
        if (kept === null) continue;
        way = kept;
        at = node;
        break;
      }
      const incoming = this.#incomingOf(node);
      const states = incoming.map(({ from, edge }) => this.#carried(from, edge));
      if (states.some((state) => state !== null && !lacks(state)))
        for (const [entry, { from, edge }] of incoming.entries()) {
          if (!lacks(states[entry]!)) continue;
          way = this.#wayOf(from, edge, node);
          if (way !== null) break;
        }
      for (const [entry, { from, edge }] of incoming.entries()) {
        if (way !== null) break;
        if (!lacks(states[entry]!)) continue;
        way = this.#partialCall(from, edge, bit);
        if (!parents.has(from)) {
          parents.set(from, node);
          work.push(from);
        }
      }
      if (way !== null) at = node;
    }
    if (at === null) for (const node of parents.keys()) found.set(node, null);
    else
      for (let node: number | null = at; node !== null; node = parents.get(node)!)
        found.set(node, way);
    return way;
  }

  /** The way after a call of a function that may assign `bit` but does not on every way, as a way that misses it. */
  #partialCall(from: number, edge: Edge, bit: bigint): Way | null {
    if (edge.kind !== "resume") return null;
    const { index } = this.#decode(from);
    const summary = this.#summaryOfCall(index);
    if (summary === null || (summary.may & bit) === 0n || (summary.must & bit) !== 0n) return null;
    const instruction = this.#plan.instructions[index]!;
    const name =
      instruction.kind === "callFunction"
        ? (this.#flow.functionById(instruction.functionId)?.name ?? "")
        : "";
    return { kind: "partialCall", name, line: instruction.span.sl, file: this.#flow.fileOf(index) };
  }

  /**
   * The way that the edge from `from` into `to` stands for, or `null` for an edge that only continues a way: the
   * search then follows a way with one source back to the first edge that stands for something.
   */
  #wayOf(from: number, edge: Edge, to: number): Way | null {
    const seen = new Set<number>();
    for (;;) {
      const way = this.#namedWay(from, edge, to);
      if (way !== null) return way;
      const incoming = this.#incomingOf(from);
      if (incoming.length !== 1 || seen.has(from)) return null;
      seen.add(from);
      to = from;
      from = incoming[0]!.from;
      edge = incoming[0]!.edge;
    }
  }

  #namedWay(from: number, edge: Edge, to: number): Way | null {
    if (from >= this.#anywhere) return null;
    const { index } = this.#decode(from);
    const file = this.#flow.fileOf(index);
    const instruction = this.#plan.instructions[index]!;
    const line = instruction.span.sl;
    switch (edge.kind) {
      case "true":
      case "false": {
        const origin = this.#origins.get(index);
        if (origin === undefined) return null;
        const held = edge.kind === "true";
        switch (origin.kind) {
          case "if": {
            const at = origin.statement.span.start.line;
            if (held) return { kind: "then", line: at, file };
            return {
              kind: origin.statement.elseBlock === null ? "noElse" : "else",
              line: at,
              file,
            };
          }
          case "case": {
            const { statement, index: position } = origin;
            if (held)
              return { kind: "case", line: statement.cases[position]!.span.start.line, file };
            if (position !== statement.cases.length - 1) return null;
            return statement.defaultBlock === null
              ? { kind: "noCase", line: statement.span.start.line, file }
              : { kind: "default", line: statement.defaultBlock.span.start.line, file };
          }
          case "operand": {
            const { operator } = origin.expression;
            const skipped = operator === "or" ? held : !held;
            if (!skipped) return null;
            return {
              kind: "operand",
              operator: operator === "and" || operator === "or" ? operator : "otherwise",
              line: origin.expression.span.start.line,
              file,
            };
          }
          case "load":
            return held
              ? null
              : {
                  kind: "operand",
                  operator: "default",
                  line: origin.expression.span.start.line,
                  file,
                };
          case "loop":
            return null;
        }
        break;
      }
      case "goto":
        return { kind: "goto", line, file };
      case "transfer":
        return { kind: edge.mode === "goto" ? "goto" : "call", line, file };
      case "call": {
        const name = this.#flow.functionById(edge.functionId)?.name ?? "";
        return { kind: "functionCall", name, line, file };
      }
      case "next":
      case "jump":
      case "iterate":
      case "exhausted": {
        // Into a loop's start, where the ways from before it and from its body meet, or into a label.
        const loop = this.#loopEnteredAt(to, from);
        if (loop !== null) return loop;
        const label = edge.kind === "next" ? this.#flow.labelAt(to) : null;
        return label === null ? null : { kind: "labelFall", label: label.name };
      }
      case "resume":
      case "supplied":
      case "omitted":
      case "continue":
      case "break":
      case "return":
      case "computed":
      case "end":
      case "exit":
      case "anywhere":
      case "fallback":
        return null;
    }
    return null;
  }

  /** The loop whose start the node `to` is, entered from before the loop by `from`, as the way into its first run. */
  #loopEnteredAt(to: number, from: number): Way | null {
    if (to >= this.#anywhere) return null;
    for (const { from: source, edge } of this.#incomingOf(to)) {
      if (edge.kind !== "continue" || source === from) continue;
      const { index } = this.#decode(source);
      const control = this.#plan.instructions[index]!;
      if (control.kind !== "loopControl") continue;
      const start = this.#flow.loopStart(control.loopId);
      const origin = start === undefined ? undefined : this.#origins.get(start);
      if (origin?.kind !== "loop") continue;
      const file = this.#flow.fileOf(start!);
      return {
        kind: "loop",
        line: origin.statement.span.start.line,
        file,
        loop: origin.statement.span,
      };
    }
    return null;
  }

  /**
   * The nodes from which some way leads to the instruction `target`: back through the edges, from a call's
   * continuation back to the returns of the function and from a file call's to every `end`, and from a block's start
   * to the code that creates it.
   */
  #reaching(target: number): ReadonlySet<number> {
    const reached = new Set<number>([target]);
    const work = [target];
    const visit = (node: number): void => {
      if (reached.has(node)) return;
      reached.add(node);
      work.push(node);
    };
    for (let node = work.pop(); node !== undefined; node = work.pop()) {
      for (const { from, edge } of this.#incomingOf(node)) {
        visit(from);
        if (edge.kind !== "resume" || from >= this.#anywhere) continue;
        const { index } = this.#decode(from);
        const call = this.#plan.instructions[index]!;
        if (call.kind === "callFunction")
          for (const back of this.#returnNodesOf(call.functionId)) visit(back);
        else if (call.kind === "transfer")
          for (const back of this.#returnNodesOf(null)) visit(back);
      }
      if (node < this.#anywhere) {
        const { index } = this.#decode(node);
        const fn = this.#flow.functionOf(index);
        if (fn !== null && fn.handler !== null && index === fn.entryInstruction)
          for (const creator of this.#creatorsOf(fn.id)) visit(creator);
      }
    }
    return reached;
  }

  /** The `return` instructions of a function's body, or every `end` for `null`. */
  #returnNodesOf(functionId: number | null): readonly number[] {
    if (this.#returnNodes === null) {
      const nodes = new Map<number, number[]>();
      const add = (key: number, index: number): void => {
        const known = nodes.get(key);
        if (known === undefined) nodes.set(key, [index]);
        else known.push(index);
      };
      this.#plan.instructions.forEach((instruction, index) => {
        if (instruction.kind === "end") add(-1, index);
        else if (instruction.kind === "returnValue" || instruction.kind === "returnVoid") {
          const fn = this.#flow.functionOf(index);
          if (fn !== null) add(fn.id, index);
        }
      });
      this.#returnNodes = nodes;
    }
    return this.#returnNodes.get(functionId ?? -1) ?? [];
  }

  /** The instructions that create a handler's block. */
  #creatorsOf(handlerId: number): readonly number[] {
    if (this.#creators === null) {
      const creators = new Map<number, number[]>();
      this.#plan.instructions.forEach((_, index) => {
        for (const handler of this.#flow.handlersOf(index)) {
          const known = creators.get(handler);
          if (known === undefined) creators.set(handler, [index]);
          else known.push(index);
        }
      });
      this.#creators = creators;
    }
    return this.#creators.get(handlerId) ?? [];
  }

  /** The way as a phrase that ends before ", nothing assigns it", and the fix that fits it. */
  #describe(way: Way, from: number, read: SpeakerFlowRead): WayText {
    switch (way.kind) {
      case "then":
        return {
          phrase: `when the 'if' on ${this.#lineAt(way.line, way.file, from)} is true`,
          fix: "on that way too",
        };
      case "noElse":
        return {
          phrase: `when the 'if' on ${this.#lineAt(way.line, way.file, from)} is false`,
          fix: "on that way too, as in an 'else'",
        };
      case "else":
        return {
          phrase: `through the 'else' of the 'if' on ${this.#lineAt(way.line, way.file, from)}`,
          fix: "on that way too",
        };
      case "case":
        return {
          phrase: `through the 'case' on ${this.#lineAt(way.line, way.file, from)}`,
          fix: "on that way too",
        };
      case "default":
        return {
          phrase: `through the 'default' on ${this.#lineAt(way.line, way.file, from)}`,
          fix: "on that way too",
        };
      case "noCase":
        return {
          phrase: `when no 'case' of the 'switch' on ${this.#lineAt(way.line, way.file, from)} matches`,
          fix: "on that way too, as in a 'default'",
        };
      case "loop": {
        const inside =
          way.file === from &&
          read.span.start.offset >= way.loop.start.offset &&
          read.span.end.offset <= way.loop.end.offset;
        const line = this.#lineAt(way.line, way.file, from);
        return {
          phrase: inside
            ? `on the first run of the loop on ${line}`
            : `when the loop on ${line} does not run`,
          fix: "before the loop",
        };
      }
      case "labelFall":
        return {
          phrase: `when the script runs into 'label ${way.label}' from the line before it`,
          fix: `before 'label ${way.label}'`,
        };
      case "goto":
        return {
          phrase: `after the 'goto' on ${this.#lineAt(way.line, way.file, from)}`,
          fix: "before that 'goto'",
        };
      case "call":
        return {
          phrase: `through the 'call' on ${this.#lineAt(way.line, way.file, from)}`,
          fix: "before that 'call'",
        };
      case "functionCall":
        return {
          phrase: `when ${this.#lineAt(way.line, way.file, from)} calls '${way.name}'`,
          fix: "before that call",
        };
      case "partialCall":
        return {
          phrase: `${this.#lineAt(way.line, way.file, from)} calls '${way.name}', which assigns it on only some of its ways`,
          fix: `on every way through '${way.name}'`,
          complete: true,
        };
      case "operand":
        return {
          phrase: `when ${
            way.operator === "otherwise"
              ? "the fallback after 'otherwise'"
              : way.operator === "default"
                ? "the 'default:' of the 'load'"
                : `the right side of the '${way.operator}'`
          } on ${this.#lineAt(way.line, way.file, from)} does not run`,
          fix: null,
        };
    }
  }
}

function someWaysMessage(speaker: string, name: string, way: WayText | null): string {
  const missing =
    way === null
      ? "not every way to this line assigns it"
      : way.complete === true
        ? way.phrase
        : `${way.phrase}, nothing assigns it before this line`;
  const fix = `Assign it ${way?.fix ?? "on every way to this line"}`;
  return `Speaker '${speaker}' may have no '${name}' here: ${missing}. ${
    speaker === PLAYER
      ? `${fix}.`
      : `${fix}, or give it a start value, as in 'speaker ${speaker} { ${name}: ... }'.`
  }`;
}

/** Names in quotes as alternatives, as in `'a' or 'b'` and `'a', 'b', or 'c'`. */
function alternatives(names: readonly string[]): string {
  const quoted = names.map((name) => `'${name}'`);
  return quoted.length <= 2
    ? quoted.join(" or ")
    : `${quoted.slice(0, -1).join(", ")}, or ${quoted.at(-1)}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
