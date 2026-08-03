import assert from "node:assert/strict";
import test from "node:test";

import * as root from "../src/index.js";

test("the package root exposes supported runtime and checkpoint capabilities", () => {
  for (const capability of [
    "compileSource",
    "run",
    "stepToEvent",
    "createCheckpoint",
    "serializeCheckpoint",
    "deserializeCheckpoint",
    "restoreCheckpoint",
    "completeAction",
    "observeTime",
  ]) assert.equal(capability in root, true, `${capability} is public`);
});

test("the package root excludes internal compiler and test seams", () => {
  for (const internal of [
    "compileProgram",
    "InstructionCompilationError",
    "Interpreter",
    "execute",
    "captureInstructionPlan",
    "validateCapturedInstructionPlan",
    "beginValidationTestStatistics",
  ]) assert.equal(internal in root, false, `${internal} is internal`);
});
