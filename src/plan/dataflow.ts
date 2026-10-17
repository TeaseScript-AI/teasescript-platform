/**
 * A forward dataflow analysis over a graph of numbered nodes. The state entering a node is the join of what each edge
 * into it carries, and `transfer` gives what leaves it along each edge. The solver is a worklist that runs until no
 * state changes, which it does when `join` only moves a state along a lattice of finite height.
 */
export interface ForwardAnalysis<State, Edge> {
  readonly nodeCount: number;
  successors(node: number): readonly { readonly node: number; readonly edge: Edge }[];
  join(left: State, right: State): State;
  equals(left: State, right: State): boolean;
  /**
   * The state that `state`, entering `node`, passes along `edge`; `null` when nothing does, because the edge is
   * impossible or the way ends at the node.
   */
  transfer(node: number, edge: Edge, state: State): State | null;
}

/** The state entering each node, or `null` where no way from an entry reaches it. */
export function solveForward<State, Edge>(
  analysis: ForwardAnalysis<State, Edge>,
  entries: Iterable<readonly [node: number, state: State]>,
): (State | null)[] {
  const states: (State | null)[] = new Array<State | null>(analysis.nodeCount).fill(null);
  const queue: number[] = [];
  const queued = new Uint8Array(analysis.nodeCount);
  const enter = (node: number, state: State): void => {
    const known = states[node];
    const joined = known === null || known === undefined ? state : analysis.join(known, state);
    if (known !== null && known !== undefined && analysis.equals(known, joined)) return;
    states[node] = joined;
    if (queued[node] === 0) {
      queued[node] = 1;
      queue.push(node);
    }
  };
  for (const [node, state] of entries) enter(node, state);
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head]!;
    queued[node] = 0;
    const state = states[node]!;
    for (const { node: next, edge } of analysis.successors(node)) {
      const out = analysis.transfer(node, edge, state);
      if (out !== null) enter(next, out);
    }
    // The queue only grows, so what it already handed out is dropped now and then.
    if (head >= 65_536 && head * 2 >= queue.length) {
      queue.splice(0, head + 1);
      head = -1;
    }
  }
  return states;
}

/**
 * A backward dataflow analysis over a graph of numbered nodes: the state at a node is what the ways on from it need.
 * `transfer` gives what a node needs for one of its ways, from what the node that way leads to needs, and the state at
 * the node is the join over its ways. The solver is a worklist that starts every node from needing nothing and runs
 * until no state changes, which it does when `transfer` keeps the order of states and `join` only moves a state along a
 * lattice of finite height.
 */
export interface BackwardAnalysis<State, Edge> {
  readonly nodeCount: number;
  /**
   * The ways on from `node`, with `node: null` for a way that leaves the graph. What a node needs itself counts only
   * through its ways, so a node whose ways all leave the graph still lists them.
   */
  successors(node: number): readonly { readonly node: number | null; readonly edge: Edge }[];
  join(left: State, right: State): State;
  equals(left: State, right: State): boolean;
  /**
   * What `node` needs for its way along `edge`, given `state`, what the node that way leads to needs: `null` where that
   * node needs nothing, so far, or the way leaves the graph. `null` where the node needs nothing for the way.
   */
  transfer(node: number, edge: Edge, state: State | null): State | null;
}

/**
 * The state at each node, or `null` where it needs nothing. `known` gives the states of nodes that are already solved:
 * the solver keeps them as they are and never asks for their ways.
 */
export function solveBackward<State, Edge>(
  analysis: BackwardAnalysis<State, Edge>,
  known: Iterable<readonly [node: number, state: State]> = [],
): (State | null)[] {
  const { nodeCount } = analysis;
  const states: (State | null)[] = new Array<State | null>(nodeCount).fill(null);
  const fixed = new Uint8Array(nodeCount);
  for (const [node, state] of known) {
    states[node] = state;
    fixed[node] = 1;
  }
  // Each node's ways, asked for once, and the nodes whose ways lead to each node, in one flat list.
  const ways = new Array<readonly { readonly node: number | null; readonly edge: Edge }[]>(
    nodeCount,
  );
  // Where each node's predecessors start in that list, and at `nodeCount` where the list ends.
  const firstPredecessor = new Int32Array(nodeCount + 1);
  for (let node = 0; node < nodeCount; node += 1) {
    const out = fixed[node] === 1 ? [] : analysis.successors(node);
    ways[node] = out;
    for (const { node: next } of out)
      if (next !== null) firstPredecessor[next + 1] = firstPredecessor[next + 1]! + 1;
  }
  for (let node = 0; node < nodeCount; node += 1)
    firstPredecessor[node + 1] = firstPredecessor[node + 1]! + firstPredecessor[node]!;
  const predecessors = new Int32Array(firstPredecessor[nodeCount]!);
  const filled = firstPredecessor.slice(0, nodeCount);
  for (let node = 0; node < nodeCount; node += 1)
    for (const { node: next } of ways[node]!) {
      if (next === null) continue;
      const slot = filled[next]!;
      predecessors[slot] = node;
      filled[next] = slot + 1;
    }

  // Every node is solved once, the last ones first, since most ways lead forward; then again whenever a way's node
  // needs more.
  const queue: number[] = [];
  const queued = new Uint8Array(nodeCount);
  for (let node = nodeCount - 1; node >= 0; node -= 1) {
    if (fixed[node] === 1) continue;
    queued[node] = 1;
    queue.push(node);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head]!;
    queued[node] = 0;
    let state: State | null = null;
    for (const { node: next, edge } of ways[node]!) {
      const need = analysis.transfer(node, edge, next === null ? null : (states[next] ?? null));
      if (need !== null) state = state === null ? need : analysis.join(state, need);
    }
    const before = states[node] ?? null;
    if (state !== null && (before === null || !analysis.equals(before, state))) {
      states[node] = state;
      for (let at = firstPredecessor[node]!; at < firstPredecessor[node + 1]!; at += 1) {
        const previous = predecessors[at]!;
        if (fixed[previous] === 0 && queued[previous] === 0) {
          queued[previous] = 1;
          queue.push(previous);
        }
      }
    }
    // The queue only grows, so what it already handed out is dropped now and then.
    if (head >= 65_536 && head * 2 >= queue.length) {
      queue.splice(0, head + 1);
      head = -1;
    }
  }
  return states;
}

/** The join of two sets, for an analysis whose states are sets: one of the two where it holds the other. */
export function setUnion<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): ReadonlySet<T> {
  if (left === right || right.size === 0) return left;
  if (left.size === 0) return right;
  const [larger, smaller] = left.size >= right.size ? [left, right] : [right, left];
  let union: Set<T> | null = null;
  for (const value of smaller) {
    if (larger.has(value)) continue;
    union ??= new Set(larger);
    union.add(value);
  }
  return union ?? larger;
}

export function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}
