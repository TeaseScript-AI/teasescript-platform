import assert from "node:assert/strict";

import { CORE_RUNTIME_BUILTINS } from "../../src/compiler.js";
import { compileStableProject, type LoweringTrace } from "../../src/compiler/compile-program.js";
import { staticText } from "../../src/expression-children.js";
import { parse } from "../../src/parser.js";
import { PlanControlFlow } from "../../src/plan/control-flow.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import { compareProjectPaths } from "../../src/project-paths.js";
import { validateProjectSemantics } from "../../src/semantic.js";
import { dominators } from "../../src/type-inference/core/dominators.js";
import {
  buildFlowGraph,
  type FlowGraph,
  type FlowGraphFile,
  type FlowNode,
} from "../../src/type-inference/core/flow-graph.js";
import { checkTypes } from "../../src/type-inference/index.js";
import { DeadWays, placeKey, type WayFacts } from "../../src/way-facts.js";
import { HOST_GLOBALS, type FlowProgram } from "./type-core-flow-programs.js";

/*
 * The coarse core's flow graph against the lowering (the coarse-core table's proof of §3.1 rests on their agreement).
 * For each program of the corpus, the lowering's control flow is the plan's (`PlanControlFlow`) without the ways the
 * type check rules out (`DeadWays`), with its blocks entered where they are created and a computed target leading to
 * every file's entry; calls are summarized alike, a call entering its callee and its summary edge standing for the
 * return. Which calls can return the test decides on the plan by the rules the graph follows (see `planReturns`).
 *
 * Both are compared on the program's `say` markers (whether each runs, whether one reaches and dominates another, and
 * the loops around it), on every way through an `if`, a `switch`, a loop, a lazy operand and a lazy default that the
 * plan decides, and on the loops a `break` or `goto` may leave (F5a). A difference fails unless the program lists it
 * as a refinement that a literal fact only the graph uses explains.
 */

interface Lowered {
  readonly programs: readonly FlowGraphFile[];
  readonly plan: InstructionPlan;
  readonly flow: PlanControlFlow;
  readonly ways: DeadWays;
  readonly facts: WayFacts;
  readonly trace: LoweringTrace;
}

export function filesOf(
  program: FlowProgram,
): { readonly path: string; readonly source: string }[] {
  const files =
    typeof program.files === "string"
      ? [{ path: "main.tease", source: program.files }]
      : [...program.files];
  return files.sort((left, right) => compareProjectPaths(left.path, right.path));
}

/** Compiles a program as the compiler does, keeping what the plan's analyses read; it must have no errors. */
function lower(
  name: string,
  files: readonly { readonly path: string; readonly source: string }[],
): Lowered {
  const parsed = files.map((file) => {
    const result = parse(file.source);
    assert.deepEqual(result.diagnostics, [], `${name}: ${file.path} parses`);
    return { path: file.path, program: result.program };
  });
  const options = { builtins: CORE_RUNTIME_BUILTINS, globals: HOST_GLOBALS };
  const names = validateProjectSemantics(parsed, options);
  // The graph takes the name pass's picks of glob targets, as the lowering does.
  const programs = parsed.map((file, index) => ({ ...file, picks: names[index]!.picks }));
  const errors = (
    diagnostics: readonly {
      readonly severity: string;
      readonly code: string;
      readonly message: string;
    }[],
  ) =>
    diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((d) => `${d.code} ${d.message}`);
  assert.deepEqual(
    names.flatMap((result) => errors(result.diagnostics)),
    [],
    `${name}: names`,
  );
  const types = checkTypes(programs, {
    ...options,
    sharedWrites: new Map(names.flatMap((result) => [...result.sharedWrites])),
    written: {
      lets: new Set(names.flatMap((result) => [...result.writtenLets])),
      globals: new Set(names.flatMap((result) => [...result.writtenGlobals])),
    },
    speakers: new Map(names.flatMap((result) => [...result.speakers])),
  });
  assert.deepEqual(types.diagnostics.flatMap(errors), [], `${name}: types`);
  const trace: LoweringTrace = { origins: new Map(), statements: new Map() };
  const plan = compileStableProject(
    programs.map((file, index) => ({
      ...file,
      picks: names[index]!.picks,
      captures: names[index]!.captures,
    })),
    types.runtimeChecks,
    () => {},
    [],
    types.formShapes,
    types.storageTypes,
    trace,
  );
  const flow = new PlanControlFlow(plan);
  return {
    programs,
    plan,
    flow,
    ways: new DeadWays(flow, trace.origins, types.ways),
    facts: types.ways,
    trace,
  };
}

// ------------------------------------------------------------------------------------------------- the plan's side

/**
 * Which functions and files of the plan can return, by the rules of the graph's `#decideReturns`, on instructions: a
 * function returns at a `return`; a file at an `end` of its top level, at an `end` in a function it calls, through a
 * file it starts with `goto` that returns, or at an `end` of a block that some instruction the session can reach
 * registers; a function may end the running file at an `end`, through a function that may, a `goto` of a file that
 * returns, or a `goto` of a label whose continuation in its file's top level reaches such an ending (r4.25). A call
 * goes on only once its callee is found to return. Iterated until nothing changes.
 */
function planReturns(lowered: Lowered): {
  readonly functions: Set<number>;
  readonly files: Set<number>;
} {
  const { plan, flow } = lowered;
  const functions = new Set<number>();
  const files = new Set<number>();
  const ending = new Set<number>();
  let blockEnds = false;
  const labelEnds = new Set<number>();
  const root = (file: number) => (at: number) =>
    at >= plan.files[file]!.entryInstruction && at < plan.files[file]!.rootEndInstruction;
  // The blocks that some instruction registers that the session reaches, every call returning.
  const registered = new Set<number>();
  {
    const seen = new Set([plan.files[0]!.startInstruction]);
    const work = [plan.files[0]!.startInstruction];
    while (work.length > 0) {
      const index = work.pop()!;
      for (const handler of flow.handlersOf(index)) registered.add(handler);
      const next = flow
        .successors(index)
        .filter(({ edge }) => lowered.ways.possible(index, edge.kind))
        .flatMap(({ edge, target }) =>
          edge.kind === "computed"
            ? plan.files.map((file) => file.entryInstruction)
            : target === null
              ? []
              : [target],
        );
      for (const handler of flow.handlersOf(index)) {
        const definition = flow.functionById(handler);
        if (definition !== undefined) next.push(definition.entryInstruction);
      }
      for (const target of next)
        if (!seen.has(target)) {
          seen.add(target);
          work.push(target);
        }
    }
  }
  const units: {
    readonly entry: number;
    readonly unit: (index: number) => boolean;
    readonly kind: "function" | "handler" | "file" | "label";
    readonly id: number;
  }[] = [
    ...plan.functions.map((definition) => ({
      entry: definition.entryInstruction,
      unit: (index: number) => flow.functionOf(index)?.id === definition.id,
      kind: definition.handler === null ? ("function" as const) : ("handler" as const),
      id: definition.id,
    })),
    ...plan.files.map((file, index) => ({
      entry: file.entryInstruction,
      unit: root(index),
      kind: "file" as const,
      id: index,
    })),
    // The continuation of each label that a function or block jumps to, in its file's top level.
    ...plan.instructions.flatMap((instruction, index) =>
      instruction.kind === "goto" && flow.functionOf(index) !== null
        ? [
            {
              entry: instruction.target,
              unit: root(flow.fileOf(instruction.target)),
              kind: "label" as const,
              id: instruction.target,
            },
          ]
        : [],
    ),
  ];
  const targetsOf = (index: number): number[] => {
    const instruction = plan.instructions[index]!;
    if (instruction.kind !== "transfer") return [];
    const destination = instruction.destination;
    return "value" in destination
      ? plan.files.map((_, file) => file)
      : ("pick" in destination ? destination.pick : [destination]).map((option) => option.file);
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of units) {
      let returns = false;
      let ends = false;
      const seen = new Set<number>([unit.entry]);
      const work = [unit.entry];
      while (work.length > 0) {
        const index = work.pop()!;
        const instruction = plan.instructions[index]!;
        if (
          (instruction.kind === "returnValue" || instruction.kind === "returnVoid") &&
          unit.kind === "function"
        )
          returns = true;
        if (instruction.kind === "end") ends = true;
        if (instruction.kind === "callFunction" && ending.has(instruction.functionId)) ends = true;
        if (
          instruction.kind === "goto" &&
          flow.functionOf(index) !== null &&
          labelEnds.has(instruction.target)
        )
          ends = true;
        if (
          instruction.kind === "transfer" &&
          instruction.mode === "goto" &&
          targetsOf(index).some((file) => files.has(file))
        )
          ends = true;
        for (const { edge, target } of flow.successors(index)) {
          if (target === null || !unit.unit(target) || !lowered.ways.possible(index, edge.kind))
            continue;
          if (
            edge.kind === "resume" &&
            instruction.kind === "callFunction" &&
            !functions.has(instruction.functionId)
          )
            continue;
          if (
            edge.kind === "resume" &&
            instruction.kind === "transfer" &&
            !targetsOf(index).some((file) => files.has(file))
          )
            continue;
          if (!seen.has(target)) {
            seen.add(target);
            work.push(target);
          }
        }
      }
      if (unit.kind === "function") {
        if (returns && !functions.has(unit.id)) {
          functions.add(unit.id);
          changed = true;
        }
        if (ends && !ending.has(unit.id)) {
          ending.add(unit.id);
          changed = true;
        }
      } else if (unit.kind === "file") {
        if ((ends || blockEnds) && !files.has(unit.id)) {
          files.add(unit.id);
          changed = true;
        }
      } else if (unit.kind === "label") {
        if (ends && !labelEnds.has(unit.id)) {
          labelEnds.add(unit.id);
          changed = true;
        }
      } else if (ends && !blockEnds && registered.has(unit.id)) {
        blockEnds = true;
        changed = true;
      }
    }
  }
  return { functions, files };
}

/** The lowering's control flow, as the graph summarizes calls, from the start of the session. */
function planSuccessors(lowered: Lowered): (index: number) => number[] {
  const { plan, flow, ways } = lowered;
  const returns = planReturns(lowered);
  return (index) => {
    const instruction = plan.instructions[index];
    if (instruction === undefined) return [];
    const out: number[] = [];
    for (const { edge, target } of flow.successors(index)) {
      if (!ways.possible(index, edge.kind)) continue;
      if (edge.kind === "computed") {
        for (const file of plan.files) out.push(file.entryInstruction);
        continue;
      }
      if (target === null) continue;
      if (
        edge.kind === "resume" &&
        instruction.kind === "callFunction" &&
        !returns.functions.has(instruction.functionId)
      )
        continue;
      if (edge.kind === "resume" && instruction.kind === "transfer") {
        const destination = instruction.destination;
        const files =
          "value" in destination
            ? plan.files.map((_, file) => file)
            : ("pick" in destination ? destination.pick : [destination]).map(
                (option) => option.file,
              );
        if (!files.some((file) => returns.files.has(file))) continue;
      }
      out.push(target);
    }
    // `Reachability`'s rule: a `continue` of a loop that runs its body at least once may also end it.
    if (instruction.kind === "loopControl" && instruction.action === "continue") {
      const start = flow.loopStart(instruction.loopId);
      const loop = start === undefined ? undefined : plan.instructions[start];
      if (start !== undefined && loop?.kind === "loopStart" && ways.runsOnce(start))
        out.push(loop.target);
    }
    for (const handler of flow.handlersOf(index)) {
      const definition = flow.functionById(handler);
      if (definition !== undefined) out.push(definition.entryInstruction);
    }
    return out;
  };
}

function reachable(start: number, successors: (index: number) => readonly number[]): Set<number> {
  const seen = new Set([start]);
  const work = [start];
  while (work.length > 0)
    for (const next of successors(work.pop()!))
      if (!seen.has(next)) (seen.add(next), work.push(next));
  return seen;
}

/** Whether `a` dominates `b` on the plan's side: the iterative algorithm of Cooper, Harvey and Kennedy. */
function planDominance(
  root: number,
  live: ReadonlySet<number>,
  successors: (index: number) => readonly number[],
) {
  const order: number[] = [];
  {
    const seen = new Set([root]);
    const stack: [number, number][] = [[root, 0]];
    while (stack.length > 0) {
      const top = stack.at(-1)!;
      const next = successors(top[0]);
      if (top[1] < next.length) {
        const target = next[top[1]]!;
        top[1] += 1;
        if (!seen.has(target)) (seen.add(target), stack.push([target, 0]));
      } else (order.push(top[0]), stack.pop());
    }
  }
  order.reverse();
  const rank = new Map(order.map((node, index) => [node, index]));
  const predecessors = new Map<number, number[]>();
  for (const node of live)
    for (const next of successors(node))
      predecessors.set(next, [...(predecessors.get(next) ?? []), node]);
  const idom = new Map([[root, root]]);
  const intersect = (a: number, b: number): number => {
    while (a !== b) {
      while (rank.get(a)! > rank.get(b)!) a = idom.get(a)!;
      while (rank.get(b)! > rank.get(a)!) b = idom.get(b)!;
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of order) {
      if (node === root) continue;
      let candidate: number | null = null;
      for (const predecessor of predecessors.get(node) ?? [])
        if (idom.has(predecessor))
          candidate = candidate === null ? predecessor : intersect(predecessor, candidate);
      if (candidate !== null && idom.get(node) !== candidate)
        (idom.set(node, candidate), (changed = true));
    }
  }
  return (a: number, b: number): boolean => {
    if (!idom.has(a) || !idom.has(b)) return false;
    let node = b;
    while (node !== a && node !== root) node = idom.get(node)!;
    return node === a;
  };
}

// ------------------------------------------------------------------------------------------------ the comparison

interface Marker {
  readonly text: string;
  readonly node: FlowNode;
  readonly instruction: number;
}

function markersOf(name: string, graph: FlowGraph, lowered: Lowered): Marker[] {
  const sayAt = new Map<string, number>();
  lowered.plan.instructions.forEach((instruction, index) => {
    if (instruction.kind === "say")
      sayAt.set(`${lowered.flow.fileOf(index)}:${instruction.span.so}`, index);
  });
  const markers: Marker[] = [];
  for (const node of graph.nodes) {
    if (node.statement?.kind !== "sayStatement") continue;
    // A marker says a literal text; another `say` is part of the program.
    const text = staticText(node.statement.value);
    if (text === undefined) continue;
    const instruction = sayAt.get(`${node.file}:${node.statement.span.start.offset}`);
    assert.notEqual(instruction, undefined, `${name}: marker ${text} has its say instruction`);
    markers.push({ text, node, instruction: instruction! });
  }
  assert.equal(
    new Set(markers.map((marker) => marker.text)).size,
    markers.length,
    `${name}: markers are unique`,
  );
  return markers;
}

/** Where a construct starts, as `path:line`. */
function at(
  lowered: Lowered,
  file: number,
  node: { readonly span: { readonly start: { readonly line: number } } },
): string {
  return `${lowered.programs[file]!.path}:${node.span.start.line + 1}`;
}

/** Whether every edge into `node` is dead: the way into it is never taken. */
function wayDead(graph: FlowGraph, node: FlowNode): boolean {
  return node.predecessors.every((predecessor) => graph.isDeadEdge(predecessor, node));
}

/** Whether a way over live edges leads from `from` to `to` without passing `avoid`. */
function leads(graph: FlowGraph, from: FlowNode, to: FlowNode, avoid: FlowNode): boolean {
  const seen = new Set<FlowNode>([from]);
  const work = [from];
  while (work.length > 0) {
    const node = work.pop()!;
    if (node === to) return true;
    for (const next of node.successors)
      if (next !== avoid && !seen.has(next) && !graph.isDeadEdge(node, next))
        (seen.add(next), work.push(next));
  }
  return false;
}

/** The differences between the graph and the lowering, each written as `relation subject: lowering=… graph=…`. */
export function flowDifferences(program: FlowProgram): string[] {
  const files = filesOf(program);
  const lowered = lower(program.name, files);
  const graph = buildFlowGraph(lowered.programs);
  const dom = dominators(graph);
  const found: string[] = [];
  const note = (subject: string, lowering: unknown, graphValue: unknown): void => {
    const show = (value: unknown) =>
      Array.isArray(value) ? `[${value.join(",")}]` : String(value);
    if (show(lowering) !== show(graphValue))
      found.push(`${subject}: lowering=${show(lowering)} graph=${show(graphValue)}`);
  };

  // Every node hangs in the dominator tree, dead code included.
  for (const node of graph.nodes)
    assert.notEqual(
      dom.dfsIn(node),
      -1,
      `${program.name}: node ${node.id} (${node.kind}) has a dominator`,
    );

  const successors = planSuccessors(lowered);
  const root = lowered.plan.files[0]!.startInstruction;
  const live = reachable(root, successors);
  const planDominates = planDominance(root, live, successors);
  const markers = markersOf(program.name, graph, lowered);
  const planReach = new Map<number, Set<number>>();
  const graphReach = (from: FlowNode): Set<FlowNode> => {
    const seen = new Set<FlowNode>([from]);
    const work = [from];
    while (work.length > 0) {
      const node = work.pop()!;
      for (const next of node.successors)
        if (!seen.has(next) && !graph.isDeadEdge(node, next)) (seen.add(next), work.push(next));
    }
    return seen;
  };

  // The loops around each marker: on the plan, the `loopStart`s whose range holds its instruction.
  const loopStarts = lowered.plan.instructions.flatMap((instruction, index) =>
    instruction.kind === "loopStart" ? [{ index, instruction }] : [],
  );
  for (const marker of markers) {
    const planLoops = loopStarts
      .filter(
        ({ index, instruction }) =>
          index < marker.instruction && marker.instruction < instruction.target,
      )
      .map(({ instruction }) => instruction.span.so);
    note(
      `loops ${marker.text}`,
      planLoops,
      marker.node.loops.map((head) => head.span!.start.offset),
    );
  }
  for (const a of markers) {
    const liveA = live.has(a.instruction);
    note(`live ${a.text}`, liveA, !a.node.dead);
    if (!liveA || a.node.dead) continue;
    const fromA = planReach.get(a.instruction) ?? reachable(a.instruction, successors);
    planReach.set(a.instruction, fromA);
    const graphFromA = graphReach(a.node);
    for (const b of markers) {
      if (a === b) continue;
      note(`reach ${a.text}->${b.text}`, fromA.has(b.instruction), graphFromA.has(b.node));
      if (live.has(b.instruction) && !b.node.dead)
        note(
          `dom ${a.text}->${b.text}`,
          planDominates(a.instruction, b.instruction),
          dom.dominates(a.node, b.node),
        );
    }
  }

  // The loops a `break` or `goto` may leave.
  for (const { index, instruction } of loopStarts) {
    let left = false;
    for (let inner = index + 1; inner < instruction.target; inner += 1) {
      const other = lowered.plan.instructions[inner]!;
      if (
        other.kind === "loopControl" &&
        other.action === "break" &&
        other.loopId === instruction.loopId
      )
        left = true;
      if (other.kind === "goto" || (other.kind === "transfer" && other.mode === "goto"))
        left = true;
    }
    const head = graph.nodes.find(
      (node) =>
        node.kind === "loop-head" &&
        node.span?.start.offset === instruction.span.so &&
        node.file === lowered.flow.fileOf(index),
    );
    assert.notEqual(
      head,
      undefined,
      `${program.name}: the loop at ${instruction.span.so} has its head`,
    );
    note(
      `left ${lowered.programs[head!.file]!.path}:${instruction.span.sl + 1}`,
      left,
      graph.leftBy.has(head!),
    );
  }

  // Every way the plan decides by a `jumpIfFalse` or `loopStart`, and every lazy operand's.
  const conditionAt = new Map(
    graph.conditionUses.map((use) => [`${use.file}:${use.span.start.offset}`, use]),
  );
  const switchAt = new Map(
    graph.switchUses.map((use) => [`${use.file}:${use.span.start.offset}`, use]),
  );
  for (const [index, origin] of lowered.trace.origins) {
    const file = lowered.flow.fileOf(index);
    const possible = (edge: "true" | "false" | "iterate" | "exhausted") =>
      lowered.ways.possible(index, edge);
    switch (origin.kind) {
      case "if": {
        const use = conditionAt.get(`${file}:${origin.statement.condition.span.start.offset}`)!;
        note(
          `way ${at(lowered, file, origin.statement)} if then`,
          possible("true"),
          !wayDead(graph, use.branches[0]!),
        );
        note(
          `way ${at(lowered, file, origin.statement)} if else`,
          possible("false"),
          !wayDead(graph, use.branches[1]!),
        );
        break;
      }
      case "case": {
        const use = switchAt.get(`${file}:${origin.statement.subject.span.start.offset}`)!;
        const where = `way ${at(lowered, file, origin.statement)} case ${origin.index}`;
        note(`${where} taken`, possible("true"), !wayDead(graph, use.branches[origin.index]!));
        if (origin.index === origin.statement.cases.length - 1)
          note(`${where} none`, possible("false"), !wayDead(graph, use.branches.at(-1)!));
        break;
      }
      case "loop": {
        const loop = graph.loops.find((candidate) => candidate.statement === origin.statement)!;
        // The loop's entry: a `while` loop's head, or the value of a `repeat` count or a `for` iterable.
        const counted =
          origin.statement.kind === "whileStatement"
            ? null
            : origin.statement.kind === "repeatStatement"
              ? origin.statement.count
              : origin.statement.iterable;
        const entry =
          counted === null
            ? loop.head
            : graph.expressionAt({
                file,
                start: counted.span.start.offset,
                end: counted.span.end.offset,
              })!;
        const where = `way ${at(lowered, file, origin.statement)} loop`;
        note(`${where} body`, possible("iterate"), leads(graph, entry, loop.body, loop.exit));
        note(`${where} no-run`, possible("exhausted"), leads(graph, entry, loop.exit, loop.body));
        break;
      }
      case "default": {
        const value = graph.expressionAt({
          file,
          start: origin.expression.span.start.offset,
          end: origin.expression.span.end.offset,
        })!;
        // The node the default may run after: a lazy call's own value, or a `load`'s read of its key.
        const before =
          origin.expression.kind === "callExpression"
            ? graph.nodes.find(
                (node) => node.kind === "expression" && node.expression === origin.expression,
              )
            : value.predecessors.find((node) => node.kind === "default-probe");
        const where = `way ${at(lowered, file, origin.expression)} default`;
        note(
          `${where} runs`,
          possible("true"),
          before !== undefined &&
            before.successors.some((next) => next !== value && !graph.isDeadEdge(before, next)),
        );
        note(
          `${where} skipped`,
          possible("false"),
          before !== undefined &&
            before.successors.includes(value) &&
            !graph.isDeadEdge(before, value),
        );
        break;
      }
      case "operand":
        break;
    }
  }
  for (const node of graph.nodes) {
    const expression = node.expression;
    if (
      expression?.kind !== "binaryExpression" ||
      !["and", "or", "otherwise"].includes(expression.operator)
    )
      continue;
    const fact = lowered.facts.operands.get(placeKey(node.file, expression.span));
    const left = graph.expressionAt({
      file: node.file,
      start: expression.left.span.start.offset,
      end: expression.left.span.end.offset,
    })!;
    const where = `way ${at(lowered, node.file, expression)} ${expression.operator}`;
    note(
      `${where} right`,
      fact?.[0] ?? true,
      left.successors.some((next) => next !== node && !graph.isDeadEdge(left, next)),
    );
    note(
      `${where} skip`,
      fact?.[1] ?? true,
      left.successors.includes(node) && !graph.isDeadEdge(left, node),
    );
  }
  return found;
}

/** Whether the graph finds each marker of a program live, by its text. */
export function markerLiveness(program: FlowProgram): ReadonlyMap<string, boolean> {
  const parsed = filesOf(program).map((file) => ({
    path: file.path,
    program: parse(file.source).program,
  }));
  const names = validateProjectSemantics(parsed, {
    builtins: CORE_RUNTIME_BUILTINS,
    globals: HOST_GLOBALS,
  });
  const graph = buildFlowGraph(
    parsed.map((file, index) => ({ ...file, picks: names[index]!.picks })),
  );
  const live = new Map<string, boolean>();
  for (const node of graph.nodes) {
    if (node.statement?.kind !== "sayStatement") continue;
    const text = staticText(node.statement.value);
    if (text !== undefined) live.set(text, !node.dead);
  }
  return live;
}
