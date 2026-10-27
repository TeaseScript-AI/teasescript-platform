import type { FlowNode } from "./model.js";

// The keys of source sites and of edges, which the builder, its walk and its passes share.

/** The key of a source site, as `placeKey` of `way-facts.ts` writes it. */
export function siteKey(file: number, start: number, end: number): string {
  return `${file}:${start}:${end}`;
}

/**
 * Edges are keyed by their ends' ids in one number, which stays exact while ids stay below this bound; a graph that
 * large holds far more nodes than memory allows, so the bound is never reached.
 */
export const NODE_ID_BOUND = 2 ** 26;

export function edgeKey(from: FlowNode, to: FlowNode): number {
  return from.id * NODE_ID_BOUND + to.id;
}
