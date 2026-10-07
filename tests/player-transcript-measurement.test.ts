import assert from "node:assert/strict";
import test from "node:test";

import {
  ChangedContentMeasurement,
  type MeasuringVirtualizer,
} from "../player/transcript-measurement.js";

/** A virtualizer scrolled to 1,000 px in `direction`, having measured row `a` at 300 px high. */
function scrolled(direction: MeasuringVirtualizer["scrollDirection"]): MeasuringVirtualizer {
  return {
    scrollOffset: 1_000,
    scrollAdjustments: 0,
    scrollDirection: direction,
    itemSizeCache: new Map([["a", 300]]),
  };
}

test("a row's new size moves the reading position as TanStack does, unless its text changed out of view", () => {
  const above = { key: "a", start: 200 };
  const measurement = new ChangedContentMeasurement();
  measurement.measured("a", 1);
  // A first measurement above the view is compensated either way, and one spanning the view's top is not.
  assert.equal(measurement.compensates({ key: "new", start: 200 }, scrolled("backward")), true);
  assert.equal(measurement.compensates({ key: "a", start: 800 }, scrolled(null)), false);
  // A row measured again above the view is compensated, except while the reader scrolls up.
  measurement.measured("a", 1);
  assert.equal(measurement.compensates(above, scrolled(null)), true);
  assert.equal(measurement.compensates(above, scrolled("backward")), false);
  // A row whose text changed since its size was last taken is compensated while scrolling up too.
  measurement.measured("a", 2);
  assert.equal(measurement.compensates(above, scrolled("backward")), true);
});

test("a change measured at the same size leaves later measurements of the row to TanStack's rule", () => {
  const measurement = new ChangedContentMeasurement();
  measurement.measured("a", 1);
  // The changed text measured at its old size: the virtualizer asks nothing about it.
  measurement.measured("a", 7);
  // A later resize, such as a narrower view, while the reader scrolls up.
  measurement.measured("a", 7);
  assert.equal(measurement.compensates({ key: "a", start: 200 }, scrolled("backward")), false);
  // A new transcript forgets what was measured.
  measurement.measured("a", 8);
  measurement.clear();
  assert.equal(measurement.compensates({ key: "a", start: 200 }, scrolled("backward")), false);
});
