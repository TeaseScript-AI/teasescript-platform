import type { FlowGraphBuilder } from "../flow-graph.js";
import { edgeKey } from "./keys.js";
import type { Callable, CallSite, FlowNode } from "./model.js";

// The callables in a cycle of calls and file transfers, and the callables a block may run.

/**
 * The callables in a cycle of calls and file transfers, which may run in several activations at once: the strongly
 * connected components of the graph from each callable to those it may run in (Tarjan, iteratively). A file that a
 * `goto` starts runs in place of the file it leaves, inside whatever called that one.
 */
export function recursion(
  builder: FlowGraphBuilder,
  callables: readonly Callable[],
): ReadonlySet<Callable> {
  const recursive = new Set<Callable>();
  const startedBy = new Map<Callable, Callable[]>();
  for (const jump of builder.jumps) {
    const from = builder.callableOf[jump.node.region];
    if (jump.kind !== "file" || from === null || from === undefined) continue;
    for (const file of jump.files) {
      const list = startedBy.get(file);
      if (list === undefined) startedBy.set(file, [from]);
      else list.push(from);
    }
  }
  const callers = (callable: Callable): Callable[] => [
    ...callable.sites.flatMap((site) => {
      const caller = builder.callableOf[site.caller];
      return caller === null || caller === undefined ? [] : [caller];
    }),
    ...(startedBy.get(callable) ?? []),
  ];
  const index = new Map<Callable, number>();
  const low = new Map<Callable, number>();
  const onStack = new Set<Callable>();
  const stack: Callable[] = [];
  let counter = 0;
  const enter = (
    callable: Callable,
    frames: { callable: Callable; next: number; edges: Callable[] }[],
  ): void => {
    index.set(callable, counter);
    low.set(callable, counter);
    counter += 1;
    stack.push(callable);
    onStack.add(callable);
    frames.push({ callable, next: 0, edges: callers(callable) });
  };
  for (const root of callables) {
    if (index.has(root)) continue;
    const frames: { callable: Callable; next: number; edges: Callable[] }[] = [];
    enter(root, frames);
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      if (frame.next < frame.edges.length) {
        const other = frame.edges[frame.next]!;
        frame.next += 1;
        if (other === frame.callable) recursive.add(other);
        if (!index.has(other)) enter(other, frames);
        else if (onStack.has(other))
          low.set(frame.callable, Math.min(low.get(frame.callable)!, index.get(other)!));
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent !== undefined)
        low.set(parent.callable, Math.min(low.get(parent.callable)!, low.get(frame.callable)!));
      if (low.get(frame.callable) === index.get(frame.callable)) {
        const members: Callable[] = [];
        let member: Callable;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          members.push(member);
        } while (member !== frame.callable);
        if (members.length > 1) for (const m of members) recursive.add(m);
      }
    }
  }
  return recursive;
}

/**
 * The callables a block may run: those it calls or starts, and all that they call and start, by a worklist over the
 * call and transfer edges, each once. A `goto` out of a block reaches the code after its label, not the code before
 * it (L6): those nodes are marked, and the callables they call or start are block code whole.
 */
export function blockReach(builder: FlowGraphBuilder): {
  readonly blockCalled: ReadonlySet<Callable>;
  readonly blockReached: ReadonlySet<FlowNode>;
} {
  const blockCalled = new Set<Callable>();
  const blockReached = new Set<FlowNode>();
  const inBlock = (node: FlowNode): boolean => builder.regions[node.region]!.kind === "handler";
  const onward = new Map<Callable, Callable[]>();
  const queue: Callable[] = [];
  const mark = (callable: Callable): void => {
    if (blockCalled.has(callable)) return;
    blockCalled.add(callable);
    queue.push(callable);
  };
  const edge = (node: FlowNode, callee: Callable): void => {
    if (inBlock(node)) return mark(callee);
    const caller = builder.callableOf[node.region];
    if (caller === null || caller === undefined) return;
    const list = onward.get(caller);
    if (list === undefined) onward.set(caller, [callee]);
    else list.push(callee);
  };
  const sitesAt = new Map<FlowNode, CallSite>();
  for (const site of builder.sites) {
    sitesAt.set(site.callIn, site);
    for (const callee of site.callees) edge(site.callIn, callee);
  }
  const reach = (from: readonly FlowNode[]): void => {
    const work = [...from];
    while (work.length > 0) {
      const node = work.pop()!;
      if (blockReached.has(node)) continue;
      blockReached.add(node);
      for (const callee of sitesAt.get(node)?.callees ?? []) mark(callee);
      for (const next of node.successors)
        if (!builder.deadEdges.has(edgeKey(node, next))) work.push(next);
    }
  };
  for (const jump of builder.jumps)
    if (inBlock(jump.node)) reach(jump.targets);
    else for (const file of jump.files) edge(jump.node, file);
  while (queue.length > 0) for (const callee of onward.get(queue.pop()!) ?? []) mark(callee);
  return { blockCalled, blockReached };
}
