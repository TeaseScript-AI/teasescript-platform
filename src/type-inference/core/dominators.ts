import type { FlowGraph, FlowNode } from "./flow-graph.js";

/*
 * The dominators of the coarse core's flow graph (§3.1): which node every run that reaches another passes first. The
 * exact path takes the nearest dominating definition of a read (X2), compares its boundaries (X4) and loops (X5), and
 * counts the events between two nodes in their intervals of the dominator tree (X6). Lengauer and Tarjan's algorithm
 * with path compression, written with explicit stacks, so deep code does not deepen the native stack.
 *
 * Dead code has dominators too: an edge counts unless it leads from dead code, or is dead, into live code. So a dead
 * edge never changes what dominates live code, and every node, dead or live, hangs in one tree below the program's
 * entry (the flow graph joins code that nothing reaches by dead edges).
 */

export interface Dominators {
  /** The nodes in depth-first preorder from the program's entry, over the edges that count. */
  readonly order: readonly FlowNode[];
  /** A node's immediate dominator: the program's entry for itself, `null` for a node the search did not reach. */
  idom(node: FlowNode): FlowNode | null;
  /** Whether every way from the program's entry to `b` passes `a`; a node dominates itself. */
  dominates(a: FlowNode, b: FlowNode): boolean;
  /**
   * Where a node's interval in a depth-first walk of the dominator tree starts, or -1 for a node the search did not
   * reach: `a` dominates `b` exactly when `a`'s interval encloses `b`'s.
   */
  dfsIn(node: FlowNode): number;
  /** Where a node's interval ends (see {@link dfsIn}). */
  dfsOut(node: FlowNode): number;
  /**
   * The nearest dominating boundary (X4): a function's entry, a file's entry that something other than the session's
   * start enters, or a label that some `goto` enters (a label that only the code before it reaches is none, L5).
   * `null` where no boundary dominates, as in the code of the file the session starts in.
   */
  edom(node: FlowNode): FlowNode | null;
  /** The nearest dominating entry of a timer, media, or button block, or `null` outside blocks. */
  hdom(node: FlowNode): FlowNode | null;
}

export function dominators(graph: FlowGraph): Dominators {
  const nodes = graph.nodes;
  const count = nodes.length;
  const counts = (from: FlowNode, to: FlowNode): boolean =>
    !(from.dead && !to.dead) && !(graph.isDeadEdge(from, to) && !to.dead);

  // The depth-first search: preorder numbers, the tree's parents, and the reverse postorder.
  const number = new Int32Array(count).fill(-1);
  const vertex: FlowNode[] = [];
  const parent: number[] = [];
  {
    const entry = graph.program.entry;
    const stack: FlowNode[] = [entry];
    const next: number[] = [0];
    number[entry.id] = 0;
    vertex.push(entry);
    parent.push(-1);
    while (stack.length > 0) {
      const top = stack.length - 1;
      const node = stack[top]!;
      const index = next[top]!;
      if (index === node.successors.length) {
        stack.pop();
        next.pop();
        continue;
      }
      next[top] = index + 1;
      const successor = node.successors[index]!;
      if (number[successor.id] !== -1 || !counts(node, successor)) continue;
      number[successor.id] = vertex.length;
      vertex.push(successor);
      parent.push(number[node.id]!);
      stack.push(successor);
      next.push(0);
    }
  }
  const reached = vertex.length;

  // Lengauer–Tarjan over preorder numbers: semidominators, then immediate dominators.
  const semi = new Int32Array(reached);
  const label = new Int32Array(reached);
  const ancestor = new Int32Array(reached).fill(-1);
  const idom = new Int32Array(reached).fill(-1);
  const bucketHead = new Int32Array(reached).fill(-1);
  const bucketNext = new Int32Array(reached).fill(-1);
  const path = new Int32Array(reached);
  for (let index = 0; index < reached; index += 1) {
    semi[index] = index;
    label[index] = index;
  }
  /** The vertex of least semidominator on the compressed path from `v` up to its forest root's child. */
  const evaluate = (v: number): number => {
    if (ancestor[v] === -1) return v;
    let length = 0;
    let x = v;
    while (ancestor[ancestor[x]!] !== -1) {
      path[length] = x;
      length += 1;
      x = ancestor[x]!;
    }
    for (let index = length - 1; index >= 0; index -= 1) {
      const y = path[index]!;
      const up = ancestor[y]!;
      if (semi[label[up]!]! < semi[label[y]!]!) label[y] = label[up]!;
      ancestor[y] = ancestor[up]!;
    }
    return label[v]!;
  };
  for (let w = reached - 1; w >= 1; w -= 1) {
    const node = vertex[w]!;
    for (const predecessor of node.predecessors) {
      const v = number[predecessor.id]!;
      if (v === -1 || !counts(predecessor, node)) continue;
      const u = evaluate(v);
      if (semi[u]! < semi[w]!) semi[w] = semi[u]!;
    }
    bucketNext[w] = bucketHead[semi[w]!]!;
    bucketHead[semi[w]!] = w;
    const p = parent[w]!;
    ancestor[w] = p;
    for (let v = bucketHead[p]!; v !== -1; v = bucketNext[v]!) {
      const u = evaluate(v);
      idom[v] = semi[u]! < semi[v]! ? u : p;
    }
    bucketHead[p] = -1;
  }
  for (let w = 1; w < reached; w += 1) if (idom[w] !== semi[w]) idom[w] = idom[idom[w]!]!;
  idom[0] = 0;

  // The dominator tree's children in flat arrays, then each node's interval in one walk of it.
  const firstChild = new Int32Array(reached + 1);
  for (let w = 1; w < reached; w += 1) firstChild[idom[w]! + 1]! += 1;
  for (let v = 0; v < reached; v += 1) firstChild[v + 1]! += firstChild[v]!;
  const children = new Int32Array(Math.max(reached - 1, 0));
  const filled = firstChild.slice(0, reached);
  for (let w = 1; w < reached; w += 1) {
    const d = idom[w]!;
    children[filled[d]!] = w;
    filled[d]! += 1;
  }
  const dfsIn = new Int32Array(count).fill(-1);
  const dfsOut = new Int32Array(count).fill(-1);
  if (reached > 0) {
    let time = 0;
    const stack: number[] = [0];
    const next: number[] = [firstChild[0]!];
    dfsIn[vertex[0]!.id] = time;
    time += 1;
    while (stack.length > 0) {
      const top = stack.length - 1;
      const v = stack[top]!;
      const index = next[top]!;
      if (index === firstChild[v + 1]) {
        dfsOut[vertex[v]!.id] = time;
        time += 1;
        stack.pop();
        next.pop();
        continue;
      }
      next[top] = index + 1;
      const child = children[index]!;
      dfsIn[vertex[child]!.id] = time;
      time += 1;
      stack.push(child);
      next.push(firstChild[child]!);
    }
  }

  // The nearest dominating boundary and block entry, in preorder, where a node's dominator comes first.
  const boundary = (node: FlowNode): boolean => {
    if (node.kind === "function-entry") return true;
    if (node.kind === "file-entry")
      return node.predecessors.some(
        (predecessor) => predecessor.kind !== "startup-exit" && counts(predecessor, node),
      );
    return (
      node.statement?.kind === "labelStatement" &&
      node.predecessors.some(
        (predecessor) => predecessor !== node.fallthrough && counts(predecessor, node),
      )
    );
  };
  const edom = new Int32Array(count).fill(-1);
  const hdom = new Int32Array(count).fill(-1);
  for (let w = 0; w < reached; w += 1) {
    const node = vertex[w]!;
    const above = w === 0 ? null : vertex[idom[w]!]!;
    edom[node.id] = boundary(node) ? node.id : above === null ? -1 : edom[above.id]!;
    hdom[node.id] = node.kind === "handler-entry" ? node.id : above === null ? -1 : hdom[above.id]!;
  }

  const byId = (id: number): FlowNode | null => (id === -1 ? null : nodes[id]!);
  return {
    order: vertex,
    idom: (node) => {
      const v = number[node.id]!;
      return v === -1 ? null : vertex[idom[v]!]!;
    },
    dominates: (a, b) => {
      const inA = dfsIn[a.id]!;
      const inB = dfsIn[b.id]!;
      return inA !== -1 && inB !== -1 && inA <= inB && dfsOut[b.id]! <= dfsOut[a.id]!;
    },
    dfsIn: (node) => dfsIn[node.id]!,
    dfsOut: (node) => dfsOut[node.id]!,
    edom: (node) => byId(edom[node.id]!),
    hdom: (node) => byId(hdom[node.id]!),
  };
}

/**
 * X5: whether every loop around `read` also encloses `definition`. The loops around a node are nested, outermost
 * first, so it is enough that `definition` lies in `read`'s innermost loop at the same depth; a `for` loop's binding
 * lies in its loop.
 */
export function insideLoopsOf(definition: FlowNode, read: FlowNode): boolean {
  const depth = read.loops.length;
  return depth === 0 || definition.loops[depth - 1] === read.loops[depth - 1];
}
