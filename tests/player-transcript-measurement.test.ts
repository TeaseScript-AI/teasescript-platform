import assert from "node:assert/strict";
import test from "node:test";

import {
  ChangedContentMeasurement,
  type MeasuringVirtualizer,
} from "../player/transcript-measurement.js";

/** A virtualizer scrolled to 1,000 px in `direction`, having measured rows `a` and `b` at 300 px high. */
function scrolled(direction: MeasuringVirtualizer["scrollDirection"]): MeasuringVirtualizer {
  return {
    scrollOffset: 1_000,
    scrollAdjustments: 0,
    scrollDirection: direction,
    itemSizeCache: new Map([
      ["a", 300],
      ["b", 300],
    ]),
  };
}

const above = { key: "a", start: 200 };

test("a row's new size moves the reading position as TanStack does, unless its text changed out of view", () => {
  const measurement = new ChangedContentMeasurement();
  measurement.measured("a", "1", true);
  // A first measurement above the view is compensated either way, and one spanning the view's top is not.
  assert.equal(measurement.compensates({ key: "new", start: 200 }, scrolled("backward")), true);
  assert.equal(measurement.compensates({ key: "a", start: 800 }, scrolled(null)), false);
  // A row measured again above the view is compensated, except while the reader scrolls up.
  measurement.measured("a", "1", true);
  assert.equal(measurement.compensates(above, scrolled(null)), true);
  assert.equal(measurement.compensates(above, scrolled("backward")), false);
  // A row whose text changed since its size was last taken is compensated while scrolling up too.
  measurement.measured("a", "2", true);
  assert.equal(measurement.compensates(above, scrolled("backward")), true);
});

test("only the observer's report takes a row's size with new content", () => {
  const measurement = new ChangedContentMeasurement();
  measurement.measured("a", "1", true);
  // TanStack answers from its cache while Vue renders the new text, whatever the row shows then.
  measurement.measured("a", "1", false);
  measurement.measured("a", "2", false);
  // The observer then reports the size of the new text, while the reader scrolls up.
  measurement.measured("a", "2", true);
  assert.equal(measurement.compensates(above, scrolled("backward")), true);
  // Its next report is of the same text.
  measurement.measured("a", "2", true);
  assert.equal(measurement.compensates(above, scrolled("backward")), false);
});

test("new text of the size measured last counts as measured once rendered", () => {
  const measurement = new ChangedContentMeasurement();
  measurement.measured("a", "1", true);
  // Text that changes the row's size waits for the observer; the size is not read again once taken.
  let reads = 0;
  const size = (height: number) => () => (reads++, height);
  measurement.rendered("a", "2", 300, size(708));
  measurement.rendered("a", "1", 300, size(300));
  assert.equal(reads, 1);
  // Text of the same size gets no report, and a later resize while scrolling up keeps TanStack's rule.
  measurement.rendered("a", "7", 300, size(300));
  measurement.measured("a", "7", true);
  assert.equal(measurement.compensates(above, scrolled("backward")), false);
  // A row never measured, and a new transcript, have no size taken with any content.
  measurement.rendered("b", "1", undefined, size(300));
  measurement.measured("b", "2", true);
  assert.equal(measurement.compensates({ key: "b", start: 200 }, scrolled("backward")), false);
  measurement.measured("a", "8", true);
  measurement.clear();
  assert.equal(measurement.compensates(above, scrolled("backward")), false);
});
