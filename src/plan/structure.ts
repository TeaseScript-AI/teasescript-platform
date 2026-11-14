import type { Instruction } from "./model.js";

/**
 * A region's ifs, loops, parameter defaults and blocks, read back from its jumps. Each construct covers instructions
 * `from` up to `to`; a sequence of constructs covers its range without gaps, in order.
 * - `run`: instructions that start no construct, never next to another run. Exits stand here: `goto`,
 *   `transfer`, `loopControl`, returns, `exit`, `end`, whose targets other checks hold.
 * - `if`: the `jumpIfFalse` at `at`, its true way `whenTrue`, and its false way `whenFalse` when
 *   the true way ends in the `jump` at `elseJump` past it; without one, the false way goes on after `to`.
 * - `loop`: the `loopStart` at `at`; `head`, the instructions before it that each round runs again (a `while`'s
 *   condition, from its `continueTarget`), and `body`, up to its target.
 * - `default`: the `prepareParameterDefault` at `at` and the default's instructions, which run when the argument is
 *   left out.
 * - `scope`: the `enterScope` at `from`, its `body`, and the `leaveScope` at `to - 1`.
 */
export type Construct =
  | { readonly kind: "run"; readonly from: number; readonly to: number }
  | {
      readonly kind: "if";
      readonly from: number;
      readonly to: number;
      readonly at: number;
      readonly whenTrue: readonly Construct[];
      readonly elseJump: number | null;
      readonly whenFalse: readonly Construct[] | null;
    }
  | {
      readonly kind: "loop";
      readonly from: number;
      readonly to: number;
      readonly at: number;
      readonly head: readonly Construct[];
      readonly body: readonly Construct[];
    }
  | {
      readonly kind: "default";
      readonly from: number;
      readonly to: number;
      readonly at: number;
      readonly body: readonly Construct[];
    }
  | {
      readonly kind: "scope";
      readonly from: number;
      readonly to: number;
      readonly body: readonly Construct[];
    };

/** Why a region's jumps do not nest: the instruction that breaks the rule, and how. */
export interface StructureRefusal {
  readonly instruction: number;
  readonly message: string;
}

/**
 * The constructs of the region of `instructions` from `start` up to `end`. The plan is valid, so its jumps nest (plan
 * validation runs {@link structureRefusal}); a region that does not throws.
 */
export function planStructure(
  instructions: readonly Instruction[],
  region: { readonly start: number; readonly end: number },
): readonly Construct[] {
  const read = readStructure(instructions, region.start, region.end);
  if ("message" in read)
    throw new Error(
      `Instruction ${read.instruction}: ${read.message} (planStructure on an unvalidated plan)`,
    );
  return read.constructs;
}

/** Why the region's jumps do not nest, or `null` when they do. */
export function structureRefusal(
  instructions: readonly Instruction[],
  region: { readonly start: number; readonly end: number },
): StructureRefusal | null {
  const read = readStructure(instructions, region.start, region.end);
  return "message" in read ? read : null;
}

/** What a sequence being read belongs to, which decides what it becomes when it ends. */
type Owner =
  | { readonly kind: "region" }
  | { readonly kind: "then"; readonly at: number }
  | {
      readonly kind: "else";
      readonly at: number;
      readonly whenTrue: readonly Construct[];
      readonly elseJump: number;
    }
  | { readonly kind: "loop"; readonly at: number; readonly head: readonly Construct[] }
  | { readonly kind: "default"; readonly at: number }
  | { readonly kind: "scope"; readonly at: number };

/**
 * A sequence being read: from `from` up to `to`, or, for a scope, up to its `leaveScope`, which must come before `to`.
 * `elseJump` is set when an if's true way ends in the `jump` past its false way.
 */
interface Sequence {
  readonly owner: Owner;
  readonly from: number;
  readonly to: number;
  pc: number;
  readonly constructs: Construct[];
  elseJump: number | null;
}

/**
 * Reads the region with a list of open sequences, not by recursion: valid source may nest deeper than the call stack
 * reaches. Every target is checked against the sequence around it, so what starts inside a construct ends inside it.
 * The instructions that start a construct are named in the switch; every other instruction is part of a run.
 */
function readStructure(
  instructions: readonly Instruction[],
  start: number,
  end: number,
): { readonly constructs: readonly Construct[] } | StructureRefusal {
  const open: Sequence[] = [sequence({ kind: "region" }, start, end)];
  for (;;) {
    const current = open.at(-1)!;
    const pc = current.pc;
    if (pc >= current.to || current.elseJump !== null) {
      const owner = current.owner;
      if (owner.kind === "region") return { constructs: current.constructs };
      if (owner.kind === "scope")
        return refusal(owner.at, "this enterScope's block ends outside the construct around it");
      open.pop();
      const parent = open.at(-1)!;
      if (owner.kind === "then" && current.elseJump !== null) {
        // The true way ends in a jump past the false way, which must end inside the construct around the if.
        const jump = instructions[current.elseJump]!;
        const join = jump.kind === "jump" ? jump.target : -1;
        if (!(join >= current.to && join <= parent.to))
          return refusal(
            current.elseJump,
            "this jump past an if's false way lands outside the construct around it",
          );
        parent.pc = join;
        open.push(
          sequence(
            {
              kind: "else",
              at: owner.at,
              whenTrue: current.constructs,
              elseJump: current.elseJump,
            },
            current.to,
            join,
          ),
        );
        continue;
      }
      parent.constructs.push(ended(owner, current));
      continue;
    }
    const instruction = instructions[pc]!;
    switch (instruction.kind) {
      case "jumpIfFalse": {
        const target = instruction.target;
        if (!(target > pc && target <= current.to))
          return refusal(pc, "this jumpIfFalse's target lies outside the construct around it");
        current.pc = target;
        open.push(sequence({ kind: "then", at: pc }, pc + 1, target));
        continue;
      }
      case "jump":
        // A jump stands only as the last instruction of an if's true way.
        if (current.owner.kind === "then" && pc === current.to - 1) {
          current.elseJump = pc;
          continue;
        }
        return refusal(pc, "this jump does not end an if's true way");
      case "loopStart": {
        const target = instruction.target;
        if (!(target > pc && target <= current.to))
          return refusal(pc, "this loopStart's target lies outside the construct around it");
        const head = takeFrom(current, instruction.continueTarget);
        if (head === null)
          return refusal(
            pc,
            "this loop's rounds start outside its sequence or inside another construct",
          );
        current.pc = target;
        open.push(sequence({ kind: "loop", at: pc, head }, pc + 1, target));
        continue;
      }
      case "prepareParameterDefault": {
        const target = instruction.target;
        if (!(target > pc && target <= current.to))
          return refusal(
            pc,
            "this parameter default's target lies outside the construct around it",
          );
        current.pc = target;
        open.push(sequence({ kind: "default", at: pc }, pc + 1, target));
        continue;
      }
      case "enterScope":
        // The parent goes on after the scope's leaveScope.
        open.push(sequence({ kind: "scope", at: pc }, pc + 1, current.to));
        continue;
      case "leaveScope": {
        if (current.owner.kind !== "scope")
          return refusal(pc, "this leaveScope closes no enterScope inside the construct around it");
        open.pop();
        const parent = open.at(-1)!;
        parent.constructs.push({
          kind: "scope",
          from: current.owner.at,
          to: pc + 1,
          body: current.constructs,
        });
        parent.pc = pc + 1;
        continue;
      }
      default:
        addToRun(current.constructs, pc);
        current.pc = pc + 1;
    }
  }
}

/** The construct a sequence that ended at its `to` makes, for its owner. */
function ended(owner: Exclude<Owner, { kind: "region" | "scope" }>, done: Sequence): Construct {
  switch (owner.kind) {
    case "then":
      return {
        kind: "if",
        from: owner.at,
        to: done.to,
        at: owner.at,
        whenTrue: done.constructs,
        elseJump: null,
        whenFalse: null,
      };
    case "else":
      return {
        kind: "if",
        from: owner.at,
        to: done.to,
        at: owner.at,
        whenTrue: owner.whenTrue,
        elseJump: owner.elseJump,
        whenFalse: done.constructs,
      };
    case "loop":
      return {
        kind: "loop",
        from: owner.head[0]?.from ?? owner.at,
        to: done.to,
        at: owner.at,
        head: owner.head,
        body: done.constructs,
      };
    case "default":
      return { kind: "default", from: owner.at, to: done.to, at: owner.at, body: done.constructs };
  }
}

function sequence(owner: Owner, from: number, to: number): Sequence {
  return { owner, from, to, pc: from, constructs: [], elseJump: null };
}

function refusal(instruction: number, message: string): StructureRefusal {
  return { instruction, message };
}

function addToRun(constructs: Construct[], index: number): void {
  const last = constructs.at(-1);
  if (last !== undefined && last.kind === "run" && last.to === index)
    constructs[constructs.length - 1] = { kind: "run", from: last.from, to: index + 1 };
  else constructs.push({ kind: "run", from: index, to: index + 1 });
}

/**
 * Takes the constructs of `current` from instruction `from` on, a loop's head, splitting a run there; `null` when
 * `from` lies before the sequence, after where it stands, or inside one of its other constructs.
 */
function takeFrom(current: Sequence, from: number): Construct[] | null {
  if (from === current.pc) return [];
  // Before the sequence, the search below finds no construct that starts at or before `from`.
  if (from > current.pc) return null;
  const constructs = current.constructs;
  for (let index = constructs.length - 1; index >= 0; index -= 1) {
    const construct = constructs[index]!;
    if (construct.from === from) return constructs.splice(index);
    if (construct.from < from) {
      if (construct.kind !== "run") return null;
      const taken: Construct[] = [{ kind: "run", from, to: construct.to }];
      for (const after of constructs.splice(index + 1)) taken.push(after);
      constructs[index] = { kind: "run", from: construct.from, to: from };
      return taken;
    }
  }
  return null;
}
