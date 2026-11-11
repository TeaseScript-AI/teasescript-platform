/*
 * The route rule's candidates (`NarrowingRoutes`, routes.ts): a key's candidate definitions by callable body, each with
 * the reach of its writer side over the closed statements of its layers, and the nearest one whose writer side
 * reaches a read.
 */
import { joinParts, keepText, type WorkLedger } from "../budget.js";
import type { Definition, Key } from "../definitions.js";
import { each, mapped, passing, sorted, steps } from "../charged-iteration.js";
import { countIn, lowerBound, type TreeBlock, type TreeStatement } from "./statement-tree.js";
import { RouteTests, type Place } from "./route-tests.js";

/** A candidate D′ of a key: its definition, where it stands, and the end of the block its writer side reaches. */
export interface Candidate {
  readonly def: Definition;
  readonly chain: readonly Place[];
  readonly start: number;
  readonly reach: number;
}

/** A key's candidates in one callable's body, by where they start, with a tree of the maximum reach below each node. */
export interface Candidates {
  readonly list: readonly Candidate[];
  readonly starts: readonly number[];
  readonly reaches: readonly number[];
  readonly size: number;
}

/**
 * A sparse layer of closed statements (N3, §13.3) over a parent layer: a key's kill layer over its parent key's (the
 * key's own kills, and the compound statements they close beside the shared layer and every layer below), or a key's
 * test layer for one offending kind over its kill layer (the blocking tests of the needed form, and what they close).
 * A prefix's kills stay in the prefix's layer, never copied into a descendant's. Per block, the indexes it closes
 * (sorted) and their number; per compound statement, how many of its live arms it closes.
 */
export interface Layer {
  readonly parent: Layer | null;
  readonly statements: ReadonlySet<TreeStatement>;
  readonly closed: ReadonlyMap<number, readonly number[]>;
  readonly counts: ReadonlyMap<number, number>;
  readonly arms: ReadonlyMap<TreeStatement, number>;
  /** The arms it closes, each counted once among the layers (a feasibility layer closes arms with no statement). */
  readonly closedArms: ReadonlySet<TreeBlock>;
  /** The shared layer's applicability: calls close only for a key with an owner outside its activation (X6). */
  readonly calls: boolean;
}

/** The candidate side of the route query: candidates by callable body, their reach and the nearest one. */
export class RouteCandidates extends RouteTests {
  /** Per (key, offending kind) its certified own definitions, and per key (`*`) its whole stores, by callable body. */
  protected readonly candidates = new Map<string, ReadonlyMap<TreeBlock, Candidates>>();
  /** The program's ledger. */
  readonly #work: WorkLedger = this.pass.program.work;

  /**
   * Whether a segment of a block, statements `low` to `high` exclusive, holds a closed statement: in the shared layer
   * (its applicability) or in a layer of the chain, two binary searches each.
   */
  protected closed(
    block: TreeBlock,
    low: number,
    high: number,
    layer: Layer | null,
    calls: boolean,
  ): boolean {
    this.#work.charge("eventSteps");
    const work = this.#work;
    if (countIn(work, calls ? block.calls : block.leaves, low, high) > 0) return true;
    let at = layer;
    for (const _ of steps(work, "eventSteps", () => at !== null)) {
      const own = at!.closed.get(block.id);
      if (own !== undefined && countIn(work, own, low, high) > 0) return true;
      at = at!.parent;
    }
    return false;
  }

  /**
   * The end of the block a definition's open writer side reaches (N3 (a)): from its statement up, each block's
   * statements after the one left open; out of a loop's body only where its header leaves it, its header open. N3's "no
   * back edge between" is the read never before the candidate in a body they share: a round's end that reaches the code
   * after the loop is the route out of it (the set's `3b/loop/nested/changed` errs on a `null` stored in an inner loop's
   * body and read after it); a loop only a `break` leaves stops the writer side.
   */
  #reach(chain: readonly Place[], layer: Layer | null, calls: boolean): number {
    this.#work.charge("eventSteps");
    let level = chain.length;
    for (const _ of steps(this.#work, "eventSteps", () => level > 0)) {
      level -= 1;
      const { block, index } = chain[level]!;
      if (this.closed(block, index + 1, block.statements.length, layer, calls)) return block.end;
      const owner = block.owner;
      if (owner === null) return Infinity;
      if (!this.leaves(owner, calls)) return block.end;
    }
    return Infinity;
  }

  /** Whether a round of a loop's body reaches the code after it: its header leaves it, and calls in it are open. */
  protected leaves(owner: TreeStatement, calls: boolean): boolean {
    this.#work.charge("eventSteps");
    return owner.loop === null || (owner.exits && !(calls && owner.called));
  }

  /** A prefix's whole stores, by callable body, their reach by the shared layer alone (checked whole when examined). */
  protected wholeStores(prefix: Key): ReadonlyMap<TreeBlock, Candidates> {
    this.#work.charge("indexSteps");
    const memo = joinParts(prefix, "*");
    const known = this.candidates.get(memo);
    if (known !== undefined) return known;
    const made = this.candidateLists(
      passing(
        this.#work,
        "indexSteps",
        this.pass.definitions.byKey.get(prefix) ?? [],
        (d) => d.kind === "whole" && !d.weak && d.value !== undefined,
      ),
      null,
      false,
    );
    keepText(this.#work, memo.length);
    this.candidates.set(memo, made);
    return made;
  }

  /** Candidates by callable body, sorted by where they start, with a tree of their reaches' maxima. */
  protected candidateLists(
    definitions: readonly Definition[],
    layer: Layer | null,
    calls: boolean,
  ): ReadonlyMap<TreeBlock, Candidates> {
    this.#work.charge("indexSteps");
    const { program, lists } = this.pass;
    const work = program.work;
    const byBody = new Map<TreeBlock, Candidate[]>();
    for (const d of each(work, "indexSteps", definitions)) {
      if (!lists.live(d) || !program.live(d.node) || program.inBlockCode(d.node)) continue;
      const chain = this.chainOf(d.node);
      if (chain === null) continue;
      const last = chain.at(-1)!;
      const statement = last.index < 0 ? undefined : last.block.statements[last.index];
      const candidate: Candidate = {
        def: d,
        chain,
        start: statement?.start ?? -1,
        reach: this.#reach(chain, layer, calls),
      };
      const list = byBody.get(chain[0]!.block);
      if (list === undefined) byBody.set(chain[0]!.block, [candidate]);
      else list.push(candidate);
    }
    const made = new Map<TreeBlock, Candidates>();
    for (const [body, list] of each(work, "indexSteps", byBody)) {
      sorted(
        work,
        "indexSteps",
        list,
        (a, b) => a.start - b.start || a.def.site.start - b.def.site.start,
      );
      let size = 1;
      for (const _ of steps(work, "indexSteps", () => size < list.length)) size *= 2;
      // a tree of maxima over the reaches, its leaves from `size` on
      const reaches: number[] = [];
      for (const _ of steps(work, "indexSteps", () => reaches.length < 2 * size)) {
        const leaf = reaches.length - size;
        reaches.push(leaf >= 0 && leaf < list.length ? list[leaf]!.reach : -Infinity);
      }
      let index = size;
      for (const _ of steps(work, "indexSteps", () => index > 1)) {
        index -= 1;
        reaches[index] = Math.max(reaches[2 * index]!, reaches[2 * index + 1]!);
      }
      made.set(body, {
        list,
        starts: mapped(work, "indexSteps", list, (candidate) => candidate.start),
        reaches,
        size,
      });
    }
    return made;
  }

  /** The last candidate starting before `at` whose writer side reaches `at`: a binary search and a descent. */
  protected last(candidates: Candidates, at: number): Candidate | null {
    this.#work.charge("eventSteps");
    const work = this.#work;
    const before = lowerBound(work, candidates.starts, at);
    const { reaches, size } = candidates;
    // the rightmost leaf below `before` whose reach is at least `at`
    const search = (node: number, low: number, high: number): number => {
      work.charge("eventSteps");
      if (low >= before || reaches[node]! < at) return -1;
      if (high - low === 1) return low;
      const middle = (low + high) >> 1;
      const right = search(2 * node + 1, middle, high);
      return right >= 0 ? right : search(2 * node, low, middle);
    };
    const found = search(1, 0, size);
    return found < 0 ? null : candidates.list[found]!;
  }
}
