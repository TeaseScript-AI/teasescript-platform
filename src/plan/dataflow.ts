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
