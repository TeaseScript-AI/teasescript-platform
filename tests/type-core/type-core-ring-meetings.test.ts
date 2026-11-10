import assert from "node:assert/strict";
import test from "node:test";

import { RING_MEETING_FAMILIES } from "../helpers/type-core/families/ring-meetings.js";
import { steepCounters } from "../helpers/type-core/type-core-work.js";

/**
 * #1338: a containment over a node holding a whole-copy ring owes every meeting below the ring, and below the rest only
 * where the two nodes differ, so a ring beside a merge place's k dormant meetings does not owe them again for each of
 * k copies (main measured 3.37 to 3.61 per doubling on the list and place forms, the ring-free sibling 2.05). Each
 * family's total and each of its counters grow with the program in either order, with the sharing on and off. The
 * series, the four modes and the ring's own meetings (`HOT_CANDIDATE_WITNESSES`) are the step's evidence.
 */
test("a ring beside dormant meetings owes them only where a copy differs, in either order (#1338)", () => {
  assert.deepEqual(
    [...steepCounters(RING_MEETING_FAMILIES), ...steepCounters(RING_MEETING_FAMILIES, true)],
    [],
  );
});
