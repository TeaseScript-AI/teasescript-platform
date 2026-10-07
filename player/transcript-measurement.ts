/**
 * When the transcript's virtualizer compensates a row's new size by moving the scroll position (PLAYER-UI.md
 * "Message presentation and provenance"). TanStack compensates a remeasured row above the view, except while the reader
 * scrolls up. A message whose text changed since its size was last taken is measured anew as it comes back into view,
 * so that measurement is compensated in any direction; otherwise the text being read would move by the change. Every
 * other measurement keeps TanStack's own rule. Framework-independent; the transcript reports each measurement it takes,
 * equal sizes included, before the virtualizer asks whether to compensate it.
 */
export interface MeasuredRow {
  readonly key: string | number | bigint;
  readonly start: number;
}

export interface MeasuringVirtualizer {
  readonly scrollOffset: number | null;
  readonly scrollAdjustments: number;
  readonly scrollDirection: "forward" | "backward" | null;
  readonly itemSizeCache: ReadonlyMap<string | number | bigint, number>;
}

export class ChangedContentMeasurement {
  // The content each row's size was last taken with: a message's content event, or `undefined`.
  readonly #content = new Map<string | number | bigint, number | undefined>();
  // The measurement taken last, which the virtualizer asks about next if its size changed.
  #current: { readonly key: string | number | bigint; readonly changed: boolean } | null = null;

  /** A measurement of row `key` showing `content`. */
  measured(key: string | number | bigint, content: number | undefined): void {
    this.#current = { key, changed: this.#content.has(key) && this.#content.get(key) !== content };
    this.#content.set(key, content);
  }

  /** Forgets every row, as for a new transcript. */
  clear(): void {
    this.#content.clear();
    this.#current = null;
  }

  /** Whether the scroll position follows the new size of `row`, which the last measurement took. */
  compensates(row: MeasuredRow, instance: MeasuringVirtualizer): boolean {
    const offset = (instance.scrollOffset ?? 0) + instance.scrollAdjustments;
    const measured = instance.itemSizeCache.get(row.key);
    if (measured === undefined) return row.start < offset;
    if (row.start + measured > offset) return false;
    const changed = this.#current?.key === row.key && this.#current.changed;
    return instance.scrollDirection !== "backward" || changed;
  }
}
