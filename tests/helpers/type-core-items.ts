import {
  createXorShift32State,
  nextXorShift32,
  type XorShift32State,
} from "../../src/runtime/random/random.js";
import { WorkLedger } from "../../src/type-inference/core/budget.js";
import {
  CONTEXT_WORDS,
  IngressGraph,
  makeItem,
  REASON,
  type IngressNode,
  type Item,
  type ItemFields,
  type ItemScope,
  type ItemTag,
  type Writer,
} from "../../src/type-inference/core/items.js";

/** A fresh scope for item operations, with an allowance no test reaches unless it passes one. */
export function itemScope(allowance = Number.MAX_SAFE_INTEGER): ItemScope {
  return { work: new WorkLedger(allowance), ingress: new IngressGraph() };
}

const TAGS: readonly ItemTag[] = [
  "integer",
  "number",
  "string",
  "null",
  "unknown",
  "list",
  "object",
];

const WRITER_KINDS = ["initializer", "assignment", "element", "literal", "argument"];

/**
 * Random items from a fixed seed, as the reference model's algebra check draws them (`algebra14.mjs`): a few kinds, both
 * certainties, every reason set of an unknown, a context word or none, external data with or without ingress stores,
 * the guard mark, a null's ingress word, and the rows of one unknown operand.
 */
export class ItemSource {
  readonly #random: XorShift32State;
  readonly #writers: readonly (Writer | null)[];

  public constructor(
    seed: number,
    private readonly scope: ItemScope,
  ) {
    this.#random = createXorShift32State(seed);
    this.#writers = [
      null,
      ...Array.from({ length: 14 }, (_, index) => {
        const start = index * 7;
        return { kind: this.pick(WRITER_KINDS), file: 0, start, end: start + 3 };
      }),
    ];
  }

  public chance(probability: number): boolean {
    return nextXorShift32(this.#random) < probability;
  }

  public below(limit: number): number {
    return Math.floor(nextXorShift32(this.#random) * limit);
  }

  public pick<T>(values: readonly T[]): T {
    return values[this.below(values.length)]!;
  }

  public shuffled<T>(values: readonly T[]): T[] {
    const copy = [...values];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const other = this.below(index + 1);
      [copy[index], copy[other]] = [copy[other]!, copy[index]!];
    }
    return copy;
  }

  public writer(): Writer | null {
    return this.pick(this.#writers);
  }

  public item(): Item {
    const tag = this.pick(TAGS);
    const reasons = tag === "unknown" ? this.below(32) : 0;
    const cert = this.chance(0.5) ? "def" : "pos";
    const context = this.chance(0.3) ? null : this.pick(CONTEXT_WORDS);
    let ingress: IngressNode | undefined;
    if (tag === "unknown" && (reasons & REASON.external) !== 0 && this.chance(0.5))
      for (const store of [this.writer(), this.writer()])
        if (store !== null)
          ingress = this.scope.ingress.union(ingress, this.scope.ingress.leaf(store));
    const word = tag === "null" && this.chance(0.2);
    const fan = this.chance(0.1) ? this.pick(["fan@0:7", "fan@0:14"]) : undefined;
    // a guarded item is never definite (§3.2)
    const guarded = this.chance(0.2);
    const fields: ItemFields = {
      cert: guarded ? "pos" : cert,
      reasons,
      context,
      ...(ingress === undefined ? {} : { ingress }),
      ...(word ? { word: "unknown" } : {}),
      ...(fan === undefined ? {} : { fan }),
      ...(guarded ? { guarded: true } : {}),
    };
    return makeItem(tag, this.writer(), fields);
  }

  public items(count: number): Item[] {
    return Array.from({ length: count }, () => this.item());
  }
}
