import type { PlaceId } from "../graph.js";
import type { FlowNode } from "./flow-graph.js";
import { writerKey, type ItemScope, type Writer } from "./items.js";
import type { Proof } from "./solver.js";

/*
 * G3 3a (TABLE r4.164, r4.178, r4.187): the positioned frontier. A read of a path through wrappers, local literals that
 * each hold the next one's read at a property (`a2 = {q: a1}`, `a3.q.q`), is answered from the read one step up, its
 * position, advanced one step: never from its root and the whole path below it, which asks every wrapper again at every
 * suffix of the path. A position is where the answer stands: an original read occurrence (its read node on the value
 * side) at a path below it, and the writer the wrappers crossed above it give its items (`Contract.wrapperHop`). Each is
 * a proof of its read's demand, so the solver holds it as it holds the items (2a).
 */

let positioned = true;

/** Whether reads are answered from their positions (false only inside `withoutPositions`). */
export function positions(): boolean {
  return positioned;
}

/** For the tests and the evidence: every read answered from its root and its whole path, as before G3 3a. */
export function withoutPositions<T>(callback: () => T): T {
  const before = positioned;
  positioned = false;
  try {
    return callback();
  } finally {
    positioned = before;
  }
}

/**
 * A read's position: what its answer stands at (an original read occurrence, a binding whose key is read, or a literal),
 * the path below it (a path id, `Contract.pathStep`), the read node on the value side, whether a wrapper was crossed
 * (`hopped`) and the writer of the outermost one crossed (`null` before the first), and whether every receiver on the way
 * holds no reference (`noRef`, `Contract.#receiver`'s walk, step by step) and a structure too (`clean`, the contract
 * side's).
 */
export class Position implements Proof {
  public constructor(
    readonly read: PlaceId,
    readonly rest: number,
    readonly node: FlowNode | null,
    readonly hopped: boolean,
    readonly writer: Writer | null,
    readonly noRef: boolean,
    readonly clean: boolean,
    /**
     * On the value side, the key whose receivers the read's own receivers are (`noRef`), once a read stands above it, by
     * its cursor (`Contract.keyId`).
     */
    readonly outer: string | null = null,
  ) {}

  public signature(scope: ItemScope): string {
    scope.work.charge("sigItems");
    return [
      this.read,
      this.rest,
      this.node?.id ?? "-",
      this.hopped ? 1 : 0,
      this.writer === null ? "" : writerKey(this.writer),
      this.noRef ? 1 : 0,
      this.clean ? 1 : 0,
      this.outer ?? "-",
    ].join("|");
  }
}

/** A read answered from its root and its whole path, as before (a read no position stands for). */
export const UNPOSITIONED: Proof = Object.freeze({ signature: () => "-" });
