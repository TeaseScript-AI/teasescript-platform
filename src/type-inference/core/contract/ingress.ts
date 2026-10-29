import type { PlaceId } from "../../graph.js";
import type { Contract } from "../contract.js";
import { ingressLeaf } from "../definitions.js";
import { REASON, type IngressNode, type Item } from "../items.js";

// The ingress a value is, or the one its projections read (C9).

/** C9: external data that entered by a load, `fromJson` or a host read names its ingress. */
export function entered(
  contract: Contract,
  value: PlaceId,
  items: readonly Item[],
): readonly Item[] {
  const leaf = ingressLeafOf(contract, value);
  if (leaf === undefined) return items;
  const ingress = contract.pass.program.scope.ingress;
  return items.map((item) =>
    item.tag === "unknown" && (item.reasons & REASON.external) !== 0
      ? { ...item, ingress: ingress.union(item.ingress, leaf)! }
      : item,
  );
}

/**
 * The ingress a value is, or the one its projections read (`hostValue.n`, `hostValue[0].n`: its answer is that
 * ingress's data at their steps, so its leaf is the ingress's, #1210); `null` for none.
 */
export function ingressOf(contract: Contract, value: PlaceId): PlaceId | null {
  const { definitions, program } = contract.pass;
  let at = value;
  while (!definitions.ingress.has(at)) {
    const projection = program.projOf.get(at);
    if (projection === undefined || projection.step === "iteration") return null;
    at = projection.owner;
  }
  return at;
}

/**
 * The leaf naming an ingress value or a projection of one (`ingressOf`, S6-CARRIERS §3.1): every ingress's, where it
 * lands being admission's; else `undefined`, external data created where no ingress is, loose.
 */
export function ingressLeafOf(contract: Contract, value: PlaceId): IngressNode | undefined {
  const { program } = contract.pass;
  const ingress = contract.ingressOf(value);
  const site = ingress === null ? null : program.places[ingress]?.site;
  if (site === null || site === undefined) return undefined;
  return program.scope.ingress.leaf(ingressLeaf(program, site));
}
