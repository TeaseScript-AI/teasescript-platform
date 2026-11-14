import type { WorkLedger } from "../../budget.js";

/** A route into a receiver from a producer, with the element levels the producer's value gains there. */
export interface Edge<N> {
  readonly producer: N;
  readonly weight: number;
}

/** The depth of a position that holds no kind at all: a literal's cell nothing is stored in, an element of a scalar. */
export const NOTHING = -1;

/** The depth a producer's value reaches in its receiver along a route of `weight`: none where it holds nothing there. */
export function reach(depth: number, weight: number): number {
  return depth === NOTHING ? NOTHING : Math.max(NOTHING, depth + weight);
}

/**
 * The strongly connected components of a graph, producers first: each one after every component its members read
 * (Tarjan's order along receiver-to-producer edges), iteratively, each edge charged as it is followed.
 */
export function components<N>(work: WorkLedger, into: ReadonlyMap<N, readonly Edge<N>[]>): N[][] {
  const index = new Map<N, number>();
  const low = new Map<N, number>();
  const onStack = new Set<N>();
  const stack: N[] = [];
  const out: N[][] = [];
  let counter = 0;
  for (const root of into.keys()) {
    if (index.has(root)) continue;
    const frames: { readonly node: N; next: number }[] = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const edges = into.get(frame.node) ?? [];
      if (frame.next < edges.length) {
        work.charge("indexSteps");
        const producer = edges[frame.next++]!.producer;
        if (!index.has(producer)) {
          index.set(producer, counter);
          low.set(producer, counter++);
          stack.push(producer);
          onStack.add(producer);
          frames.push({ node: producer, next: 0 });
        } else if (onStack.has(producer))
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(producer)!));
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent !== undefined)
        low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      const component: N[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === frame.node) break;
      }
      out.push(component);
    }
  }
  return out;
}

/** Whether a component closes on itself: more than one member, or one that reads itself. */
export function closed<N>(
  component: readonly N[],
  into: ReadonlyMap<N, readonly Edge<N>[]>,
): boolean {
  return (
    component.length > 1 ||
    (into.get(component[0]!) ?? []).some((edge) => edge.producer === component[0])
  );
}

/**
 * The deepest element level each member of a closed component reaches from its entries, along the component's own
 * edges (`NOTHING` where it holds no kind); `null` where some member passes `bound`, which only a cycle of positive
 * weight can make happen when `bound` is the deepest entry plus every gain on the component's edges: a simple path
 * gains at most their sum. Each member rises at most `bound + 1` times, each rise's edges charged.
 */
export function longestWithin<N>(
  work: WorkLedger,
  into: ReadonlyMap<N, readonly Edge<N>[]>,
  members: ReadonlySet<N>,
  entry: ReadonlyMap<N, number>,
  bound: number,
): Map<N, number> | null {
  const readers = new Map<N, { readonly receiver: N; readonly weight: number }[]>();
  for (const receiver of members)
    for (const edge of into.get(receiver) ?? []) {
      if (!members.has(edge.producer)) continue;
      work.charge("indexSteps");
      const list = readers.get(edge.producer);
      if (list === undefined) readers.set(edge.producer, [{ receiver, weight: edge.weight }]);
      else list.push({ receiver, weight: edge.weight });
    }
  const level = new Map(entry);
  const pending = [...members];
  const queued = new Set(pending);
  while (pending.length > 0) {
    const producer = pending.pop()!;
    queued.delete(producer);
    const from = level.get(producer)!;
    for (const { receiver, weight } of readers.get(producer) ?? []) {
      work.charge("indexSteps");
      const reached = reach(from, weight);
      if (reached <= level.get(receiver)!) continue;
      if (reached > bound) return null;
      level.set(receiver, reached);
      if (!queued.has(receiver)) {
        queued.add(receiver);
        pending.push(receiver);
      }
    }
  }
  return level;
}
