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
  /** The worklist's selections: every push and every pop of the heap (each O(log nodes)). */
  readonly selections: number;
  /** The heap's comparisons while sifting, the work behind the selections, at most selections × log2(nodes) + selections. */
  readonly siftSteps: number;
}

/**
 * Evaluates the components in schedule order. Inside a component every node is evaluated once, then the nodes that
 * read a changed cell are re-evaluated until no cell changes; a node outside the component that reads a changed cell
 * is not enqueued, because its component comes later and starts from the final state. Deterministic: the worklist is
 * ordered by node index, so two runs of the same input evaluate the same nodes in the same order (the result does not
 * depend on it, but the counts in the report do).
 */
export function run(input: RunInput, seeds?: readonly NodeId[]): RunReport {
  const plan = schedule(input);
  const readers = new Map<CellId, NodeId[]>();
  for (let node = 0; node < input.nodes; node += 1)
    for (const cell of input.reads(node)) {
      const list = readers.get(cell);
      if (list === undefined) readers.set(cell, [node]);
      else list.push(node);
    }
  // One worklist over every node, the earliest component's lowest node first: the components give the order of a
  // first pass, and a changed cell re-queues every reader of it, in an earlier component too. The static reads do
  // not see a part shared between cells (a copy shares its source's parts), so a store path through one owner
  // changes what an earlier component's node read; the worklist re-runs that node. Deterministic, and the work is
  // the nodes plus one re-run per change of a cell per reader, each selection O(log nodes) through a binary heap
  // (a scan of the pending set was quadratic in the nodes: the closing check's CC-B2). With `seeds`, the worklist
  // starts from those nodes alone (a later phase of the solve).
  const rank = (node: NodeId): number => plan.componentOf[node]! * input.nodes + node;
  const heap: NodeId[] = [];
  const queued = new Array<boolean>(input.nodes).fill(false);
  let selections = 0;
  let siftSteps = 0;
  const push = (node: NodeId): void => {
    if (queued[node]) return;
    queued[node] = true;
    selections += 1;
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      siftSteps += 1;
      if (rank(heap[parent]!) <= rank(heap[i]!)) break;
      [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
      i = parent;
    }
  };
  const pop = (): NodeId => {
    selections += 1;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let least = i;
        siftSteps += 1;
        if (left < heap.length && rank(heap[left]!) < rank(heap[least]!)) least = left;
        if (right < heap.length && rank(heap[right]!) < rank(heap[least]!)) least = right;
        if (least === i) break;
        [heap[least], heap[i]] = [heap[i]!, heap[least]!];
        i = least;
      }
    }
    queued[top] = false;
    return top;
  };
  if (seeds === undefined) for (let node = 0; node < input.nodes; node += 1) push(node);
  else for (const node of seeds) push(node);
  const taken = new Array<number>(plan.components.length).fill(0);
  let evaluations = 0;
  while (heap.length > 0) {
    const node = pop();
    evaluations += 1;
    const component = plan.componentOf[node]!;
    taken[component] = (taken[component] ?? 0) + 1;
    for (const cell of input.evaluate(node))
      for (const reader of readers.get(cell) ?? []) push(reader);
  }
  return {
    components: plan.components.length,
    evaluations,
    longestComponent: taken.reduce((a, b) => Math.max(a, b), 0),
    selections,
    siftSteps,
  };
}
