import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  planLocationToSourceSpan,
  sourceSpanToPlanLocation,
} from "../src/plan/source-location.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { createSourcePosition, createSourceSpan } from "../src/source.js";

test("converts rich spans to the exact compact plan location and back", () => {
  const span = createSourceSpan(
    createSourcePosition(2, 0, 2),
    createSourcePosition(9, 1, 3),
  );
  const location = sourceSpanToPlanLocation(span);

  assert.deepEqual(location, { so: 2, sl: 0, sc: 2, eo: 9, el: 1, ec: 3 });
  assert.deepEqual(planLocationToSourceSpan(location), span);
});

test("compiler stores compact locations and validator requires their exact shape", () => {
  const compiled = compileSource("say \"😀\"\r\nexit");
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  const plan = compiled.plan!;
  assert.equal(plan.version, 19);
  assert.deepEqual(plan.sourceSpan, { so: 0, sl: 0, sc: 0, eo: 14, el: 1, ec: 4 });

  for (const location of [
    { sl: 0, sc: 0, eo: 1, el: 0, ec: 1 },
    { so: 0, sl: 0, sc: 0, eo: 1, el: 0, ec: 1, extra: true },
    { so: -1, sl: 0, sc: 0, eo: 1, el: 0, ec: 1 },
    { so: 0, sl: 0, sc: 0, eo: Number.MAX_SAFE_INTEGER + 1, el: 0, ec: 1 },
    { so: 2, sl: 0, sc: 0, eo: 1, el: 0, ec: 1 },
    { start: { offset: 0, line: 0, column: 0 }, end: { offset: 1, line: 0, column: 1 } },
  ]) {
    const validation = validateInstructionPlan({ ...plan, sourceSpan: location });
    assert.equal(validation.valid, false, JSON.stringify(location));
    assert.equal(validation.errors[0]?.path, "$.sourceSpan");
  }
});
