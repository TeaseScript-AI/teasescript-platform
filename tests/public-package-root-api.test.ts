import assert from "node:assert/strict";
import test from "node:test";

import * as root from "../src/index.js";
import * as validationTesting from "../src/validation-testing.js";

test("the package root excludes internal compiler and test seams", () => {
  for (const internal of [
    "InstructionCompilationError",
    "captureInstructionPlan",
    "validateCapturedInstructionPlan",
  ])
    assert.equal(internal in root, false, `${internal} is internal`);

  for (const runtimeExport of Object.keys(validationTesting)) {
    assert.equal(runtimeExport in root, false, `${runtimeExport} is test-only`);
  }
});
