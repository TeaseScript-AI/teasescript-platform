// A task's contributions to A2's held view, each once, at its path below the task's own.

import type { Admission } from "../../admission.js";
import { keep, keptParts, keptSteps, keptText } from "../../budget.js";
import { type Key } from "../../definitions.js";
import type { Expansion } from "../model.js";
import { contributionOf } from "../own.js";
import { partOf } from "../walk.js";

/** A task's contributions to A2's held view (`heldMeetings`), each once, by text, at its path below the task's own. */
export interface HeldInput {
  readonly points: ReadonlyMap<string, readonly string[]>;
  readonly reads: ReadonlyMap<string, { readonly at: readonly string[]; readonly source: Key }>;
}

const NOTHING: HeldInput = { points: new Map(), reads: new Map() };

/**
 * A2's held view of a task (`ownOf`'s, its place's copies list empty), once per task and lane (`deep`: below an
 * operation): its own stop's point (a literal, a written copy, a value of scalar kinds read whole) or read (a value's
 * source where it is no operand), and its parts', each where it stands; a copy that may inherit stands below and
 * decides nothing here. A literal is walked with the literals nested in it as cells, each one's own at its path; any
 * other part's input is its own, joined where it stands. A part's input is taken whole where the task adds nothing to
 * it, so a carrier around a carrier keeps one input, never a list per level.
 */
export function heldInput(admission: Admission, task: Expansion, deep: boolean): HeldInput {
  const memo = admission.heldInputs;
  const name = (at: Expansion, lane: boolean): string => (lane ? `d${at.id}` : `${at.id}`);
  const known = memo.get(name(task, deep));
  if (known !== undefined) return known;
  const work = admission.pass.program.work;
  interface Frame {
    readonly name: string;
    readonly own: HeldInput;
    readonly parts: readonly {
      readonly task: Expansion;
      readonly deep: boolean;
      readonly at: readonly string[];
    }[];
    next: number;
  }
  const open = (root: Expansion, lane: boolean): Frame => {
    const points = new Map<string, readonly string[]>();
    const reads = new Map<string, { readonly at: readonly string[]; readonly source: Key }>();
    const parts: Frame["parts"][number][] = [];
    const pending: (readonly [Expansion, boolean, readonly string[]])[] = [[root, lane, []]];
    while (pending.length > 0) {
      const [current, within, at] = pending.pop()!;
      work.charge("indexSteps");
      const stop = current.stop;
      if (stop !== null) {
        const contribution =
          stop.list === "values"
            ? contributionOf(admission, current.value, stop.strip, within)
            : "point";
        if (contribution === "point") points.set(keptText(admission.work, at), at);
        else if (typeof contribution === "object")
          reads.set(keptParts(admission.work, at, contribution.read), {
            at,
            source: contribution.read,
          });
      }
      for (const part of current.parts) {
        const child = partOf(admission, part);
        const childLane = part.deep ?? within;
        if (part.step === null) parts.push({ task: child, deep: childLane, at });
        else {
          const below = keptSteps(admission.work, at, [part.step]);
          if (child.stop?.list === "literals") pending.push([child, childLane, below]);
          else parts.push({ task: child, deep: childLane, at: below });
        }
      }
    }
    return { name: name(root, lane), own: { points, reads }, parts, next: 0 };
  };
  // (each task after its parts, on an explicit stack: a nest of any depth never deepens the native one)
  const stack: Frame[] = [open(task, deep)];
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    if (frame.next < frame.parts.length) {
      const part = frame.parts[frame.next++]!;
      if (!memo.has(name(part.task, part.deep))) stack.push(open(part.task, part.deep));
      continue;
    }
    stack.pop();
    const inputs: { readonly input: HeldInput; readonly at: readonly string[] }[] = [];
    if (frame.own.points.size + frame.own.reads.size > 0) inputs.push({ input: frame.own, at: [] });
    for (const part of frame.parts) {
      const input = memo.get(name(part.task, part.deep))!;
      if (input.points.size + input.reads.size > 0) inputs.push({ input, at: part.at });
    }
    memo.set(frame.name, united(admission, inputs));
  }
  return memo.get(name(task, deep))!;
}

/**
 * The union of held inputs, each below its path: the largest at the task's own path taken whole, the others' entries
 * it lacks added to a copy of it, each charged as kept before it is made.
 */
function united(
  admission: Admission,
  inputs: readonly { readonly input: HeldInput; readonly at: readonly string[] }[],
): HeldInput {
  const work = admission.pass.program.work;
  let base: HeldInput = NOTHING;
  let largest = -1;
  for (const [index, { input, at }] of inputs.entries())
    if (
      at.length === 0 &&
      (largest < 0 || input.points.size + input.reads.size > base.points.size + base.reads.size)
    ) {
      base = input;
      largest = index;
    }
  let points: Map<string, readonly string[]> | null = null;
  let reads: Map<string, { readonly at: readonly string[]; readonly source: Key }> | null = null;
  for (const [index, { input, at: below }] of inputs.entries()) {
    if (index === largest) continue;
    for (const [text, path] of input.points) {
      work.charge("checks");
      const at = below.length === 0 ? path : keptSteps(admission.work, below, path);
      const name = below.length === 0 ? text : keptText(admission.work, at);
      if ((points ?? base.points).has(name)) continue;
      points ??= new Map(base.points);
      keep(admission.work, 1);
      points.set(name, at);
    }
    for (const { at: where, source } of input.reads.values()) {
      work.charge("checks");
      const at = below.length === 0 ? where : keptSteps(admission.work, below, where);
      const name = keptParts(admission.work, at, source);
      if ((reads ?? base.reads).has(name)) continue;
      reads ??= new Map(base.reads);
      keep(admission.work, 1);
      reads.set(name, { at, source });
    }
  }
  if (points !== null) keep(admission.work, base.points.size);
  if (reads !== null) keep(admission.work, base.reads.size);
  return points === null && reads === null
    ? base
    : { points: points ?? base.points, reads: reads ?? base.reads };
}
