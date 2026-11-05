/**
 * A segment tree: the minimum or maximum of any range of values in logarithmic time, in linear space. The leaves are at
 * `size + i`; each node `k` below `size` combines nodes `2k` and `2k + 1`. That holds for any size because the
 * combination is associative, commutative and idempotent.
 */
export interface RangeTree {
  readonly nodes: Float64Array;
  readonly size: number;
  readonly combine: (left: number, right: number) => number;
  /** The combination's neutral value, which every leaf starts with. */
  readonly identity: number;
}

/** A tree of `size` leaves, all `identity`; write them at `nodes[size + i]`, then call `buildRangeTree`. */
export function rangeTree(
  size: number,
  combine: (left: number, right: number) => number,
  identity: number,
): RangeTree {
  return { nodes: new Float64Array(2 * size).fill(identity), size, combine, identity };
}

/** Combines the inner nodes from the leaves. */
export function buildRangeTree(tree: RangeTree): void {
  const { nodes, combine } = tree;
  for (let node = tree.size - 1; node > 0; node -= 1)
    nodes[node] = combine(nodes[2 * node]!, nodes[2 * node + 1]!);
}

/** The combination of the leaves from `first` to `last`, both included. */
export function rangeQuery(tree: RangeTree, first: number, last: number): number {
  const { nodes, combine } = tree;
  let result = tree.identity;
  let low = first + tree.size;
  let high = last + 1 + tree.size;
  // Arithmetic, not bitwise operators: those work on 32 bits and would wrap above 2^31 nodes.
  while (low < high) {
    if (low % 2 === 1) result = combine(result, nodes[low++]!);
    if (high % 2 === 1) result = combine(result, nodes[--high]!);
    low = Math.floor(low / 2);
    high = Math.floor(high / 2);
  }
  return result;
}
