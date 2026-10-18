/**
 * The solver's schedule (O4 stage 3a, work note §3.3): the constraints of a graph read cells and write cells, so the
 * dependencies between them are known before solving. Their strongly connected components form a DAG, evaluated in
 * topological order, so that every input of a component is final before the component starts; inside a component a
 * worklist re-evaluates a node only when one of the cells it reads changed. The schedule knows nothing of what a node
 * computes: the solver gives it the nodes, what each reads and writes, and an `evaluate` that reports the cells it
 * changed. Iterative throughout, so a long chain of nodes does not deepen the native stack.
 */

export type NodeId = number;
export type CellId = number;

export interface ScheduleInput {
  /** The number of nodes; a node is its index. */
  readonly nodes: number;
  reads(node: NodeId): readonly CellId[];
  writes(node: NodeId): readonly CellId[];
}

/** The components of the dependency graph in evaluation order: every component's inputs come from earlier ones. */
export interface Schedule {
  readonly components: readonly (readonly NodeId[])[];
  /** The component index of each node. */
  readonly componentOf: readonly number[];
}

/** Writers of each cell, so that a node depends on the nodes that write what it reads. */
function writersByCell(input: ScheduleInput): Map<CellId, NodeId[]> {
  const writers = new Map<CellId, NodeId[]>();
  for (let node = 0; node < input.nodes; node += 1)
    for (const cell of input.writes(node)) {
      const list = writers.get(cell);
      if (list === undefined) writers.set(cell, [node]);
      else list.push(node);
    }
  return writers;
}

/** The nodes a node depends on: the writers of the cells it reads. */
function dependencies(input: ScheduleInput, writers: ReadonlyMap<CellId, NodeId[]>): NodeId[][] {
  const out: NodeId[][] = [];
  for (let node = 0; node < input.nodes; node += 1) {
    const seen = new Set<NodeId>();
    for (const cell of input.reads(node))
      for (const writer of writers.get(cell) ?? []) seen.add(writer);
    out.push([...seen]);
  }
  return out;
}

/**
 * Tarjan's strongly connected components, iterative, over the dependency edges (a node depends on the writers of what
 * it reads). Tarjan emits a component only after every component it depends on, so the emission order is a
 * topological order of the component DAG: the order the solver evaluates them in.
 */
export function schedule(input: ScheduleInput): Schedule {
  const deps = dependencies(input, writersByCell(input));
  const index = new Array<number>(input.nodes).fill(-1);
  const low = new Array<number>(input.nodes).fill(0);
  const onStack = new Array<boolean>(input.nodes).fill(false);
  const stack: NodeId[] = [];
  const components: NodeId[][] = [];
  const componentOf = new Array<number>(input.nodes).fill(-1);
  let counter = 0;
  for (let root = 0; root < input.nodes; root += 1) {
    if (index[root] !== -1) continue;
    // An explicit frame stack replaces recursion: each frame remembers which dependency it visits next.
    const frames: { node: NodeId; next: number }[] = [];
    const enter = (node: NodeId): void => {
      index[node] = counter;
      low[node] = counter;
      counter += 1;
      stack.push(node);
      onStack[node] = true;
      frames.push({ node, next: 0 });
    };
    enter(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const edges = deps[frame.node]!;
      if (frame.next < edges.length) {
        const target = edges[frame.next]!;
        frame.next += 1;
        if (index[target] === -1) enter(target);
        else if (onStack[target]) low[frame.node] = Math.min(low[frame.node]!, index[target]!);
        continue;
      }
      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1]!.node;
        low[parent] = Math.min(low[parent]!, low[frame.node]!);
      }
      if (low[frame.node] === index[frame.node]) {
        const component: NodeId[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack[member] = false;
          componentOf[member] = components.length;
          component.push(member);
          if (member === frame.node) break;
        }
        component.sort((left, right) => left - right);
        components.push(component);
      }
    }
  }
  return { components, componentOf };
}

export interface RunInput extends ScheduleInput {
  /** Evaluates a node and returns the cells whose sets grew (or whose positions lowered); empty when nothing changed. */
  evaluate(node: NodeId): readonly CellId[];
}

export interface RunReport {
  readonly components: number;
  /** The number of node evaluations, over every component. */
  readonly evaluations: number;
  /** The largest number of evaluations one component took, a measure of its iteration. */
  readonly longestComponent: number;
}

/**
 * Evaluates the components in schedule order. Inside a component every node is evaluated once, then the nodes that
 * read a changed cell are re-evaluated until no cell changes; a node outside the component that reads a changed cell
 * is not enqueued, because its component comes later and starts from the final state. Deterministic: the worklist is
 * ordered by node index, so two runs of the same input evaluate the same nodes in the same order (the result does not
 * depend on it, but the counts in the report do).
 */
export function run(input: RunInput): RunReport {
  const plan = schedule(input);
  const readers = new Map<CellId, NodeId[]>();
  for (let node = 0; node < input.nodes; node += 1)
    for (const cell of input.reads(node)) {
      const list = readers.get(cell);
      if (list === undefined) readers.set(cell, [node]);
      else list.push(node);
    }
  let evaluations = 0;
  let longest = 0;
  for (const [componentIndex, component] of plan.components.entries()) {
    const inComponent = new Set(component);
    const pending = new Set<NodeId>(component);
    let taken = 0;
    while (pending.size > 0) {
      // The lowest pending node first: deterministic, and the order of a straight-line program.
      let node: NodeId | undefined;
      for (const candidate of pending) if (node === undefined || candidate < node) node = candidate;
      // EVIDENCE: invariant: the set is not empty, so a lowest node was found.
      pending.delete(node!);
      taken += 1;
      for (const cell of input.evaluate(node!))
        for (const reader of readers.get(cell) ?? [])
          if (inComponent.has(reader) && plan.componentOf[reader] === componentIndex)
            pending.add(reader);
    }
    evaluations += taken;
    longest = Math.max(longest, taken);
  }
  return { components: plan.components.length, evaluations, longestComponent: longest };
}
