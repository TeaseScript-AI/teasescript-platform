import assert from "node:assert/strict";
import test from "node:test";

import {
  combineSourceSpans,
  createSourcePosition,
  createSourceSpan,
  type SourceSpan,
} from "../src/source.js";

test("creates immutable zero-based source positions and half-open spans", () => {
  const start = createSourcePosition(0, 0, 0);
  const end = createSourcePosition(7, 0, 7);
  const span = createSourceSpan(start, end);

  assert.deepEqual(span, { start, end });
  assert.equal(Object.isFrozen(span), true);
  assert.equal(Object.isFrozen(span.start), true);
  assert.equal(Object.isFrozen(span.end), true);
});

test("allows a zero-length span at a boundary", () => {
  const position = createSourcePosition(0, 0, 0);

  assert.deepEqual(createSourceSpan(position, position), {
    start: position,
    end: position,
  });
});

test("combines source spans regardless of their supplied order", () => {
  const later = createSourceSpan(
    createSourcePosition(8, 1, 2),
    createSourcePosition(12, 1, 6),
  );
  const earlier = createSourceSpan(
    createSourcePosition(1, 0, 1),
    createSourcePosition(4, 0, 4),
  );

  assert.deepEqual(combineSourceSpans(later, earlier), {
    start: earlier.start,
    end: later.end,
  });
});

test("rejects invalid positions and reversed spans", () => {
  assert.throws(() => createSourcePosition(-1, 0, 0), RangeError);
  assert.throws(() => createSourcePosition(0, 0.5, 0), RangeError);
  assert.throws(
    () =>
      createSourceSpan(
        createSourcePosition(2, 0, 2),
        createSourcePosition(1, 0, 1),
      ),
    RangeError,
  );
});

test("rejects a malformed span supplied to the combining helper", () => {
  const outer = createSourceSpan(
    createSourcePosition(0, 0, 0),
    createSourcePosition(10, 0, 10),
  );
  const malformed = {
    start: createSourcePosition(8, 0, 8),
    end: createSourcePosition(2, 0, 2),
  } as unknown as SourceSpan;

  assert.throws(() => combineSourceSpans(outer, malformed), RangeError);
});
