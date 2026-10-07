/**
 * When the transcript's virtualizer compensates a row's new size by moving the scroll position (PLAYER-UI.md
 * "Message presentation and provenance"). TanStack compensates a remeasured row above the view, except while the reader
 * scrolls up. A message whose text changed since its size was last taken is measured anew as it comes back into view,
 * so that measurement is compensated in any direction; otherwise the text being read would move by the change. Every
 * other measurement keeps TanStack's own rule. Framework-independent; the transcript reports every measurement, before
 * the virtualizer asks whether to compensate it, and every rendered row once its rendering is complete.
 */
type Key = string | number | bigint;

export interface MeasuredRow {
  readonly key: Key;
  readonly start: number;
}

export interface MeasuringVirtualizer {
  readonly scrollOffset: number | null;
  readonly scrollAdjustments: number;
  readonly scrollDirection: "forward" | "backward" | null;
  readonly itemSizeCache: ReadonlyMap<Key, number>;
}

export class ChangedContentMeasurement {
  // The content each row's size was last taken with: a message's content event, or `undefined`.
  readonly #content = new Map<Key, string | undefined>();
  // The measurement taken last, which the virtualizer asks about next if its size changed.
  #current: { readonly key: Key; readonly changed: boolean } | null = null;

  /**
   * A measurement of row `key`, which shows `content`. Only the ResizeObserver's report measures what a row shows.
   * TanStack answers any other measurement from its cache, or, for a row it has no size for yet, from the DOM while Vue
   * may still be rendering the row's text.
   */
  measured(key: Key, content: string | undefined, observed: boolean): void {
    if (!observed) {
      this.#current = null;
      return;
    }
    this.#current = { key, changed: this.#content.has(key) && this.#content.get(key) !== content };
    this.#content.set(key, content);
  }

  /**
   * Row `key` rendered with `content`, once Vue has rendered it completely. New content of the size TanStack measured
   * last gets no ResizeObserver report, so its size counts as taken with that content.
   */
  rendered(
    key: Key,
    content: string | undefined,
    measured: number | undefined,
    size: () => number,
  ): void {
    if (this.#content.has(key) && this.#content.get(key) !== content && size() === measured)
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
