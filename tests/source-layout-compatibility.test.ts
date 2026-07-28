import assert from "node:assert/strict";
import test from "node:test";

import * as canonicalPlan from "../src/plan/model.js";
import * as canonicalCapture from "../src/plan/capture.js";
import * as canonicalValidation from "../src/plan/validation.js";
import * as canonicalCompiler from "../src/compiler/compile-program.js";
import * as canonicalCompleteAction from "../src/runtime/operations/complete-action.js";
import * as canonicalObserveTime from "../src/runtime/operations/observe-time.js";
import * as canonicalActionModel from "../src/runtime/actions/model.js";
import * as legacyEngine from "../src/runtime/engine.js";
import * as legacyState from "../src/runtime/state.js";
import * as legacyPlan from "../src/instructions.js";
import * as canonicalLibraries from "../src/library-tooling/public.js";
import * as legacyLibraries from "../src/libraries/public.js";
import * as canonicalWorkspace from "../playground/workspace/controller.js";
import * as legacyWorkspace from "../playground/workspace.js";

test("legacy instruction facade preserves the canonical plan and compiler exports", () => {
  assert.equal(legacyPlan.compileProgram, canonicalCompiler.compileProgram);
  assert.equal(legacyPlan.captureInstructionPlan, canonicalCapture.captureInstructionPlan);
  assert.equal(legacyPlan.validateInstructionPlan, canonicalValidation.validateInstructionPlan);
  assert.equal(legacyPlan.INSTRUCTION_PLAN_VERSION, canonicalPlan.INSTRUCTION_PLAN_VERSION);
});

test("legacy library tooling facade preserves canonical exports", () => {
  assert.equal(legacyLibraries.LibraryCatalog, canonicalLibraries.LibraryCatalog);
  assert.equal(legacyLibraries.createPublicLibraryMetadata, canonicalLibraries.createPublicLibraryMetadata);
});

test("legacy workspace facade preserves the canonical controller", () => {
  assert.equal(legacyWorkspace.compileWorkspaceSource, canonicalWorkspace.compileWorkspaceSource);
  assert.equal(legacyWorkspace.executeWorkspaceSource, canonicalWorkspace.executeWorkspaceSource);
});

test("engine compatibility exports delegate to canonical operations", () => {
  assert.equal(legacyEngine.completeAction, canonicalCompleteAction.completeAction);
  assert.equal(legacyEngine.observeTime, canonicalObserveTime.observeTime);
});

test("action contracts remain type-only at both canonical and state compatibility paths", () => {
  assert.deepEqual(Object.keys(canonicalActionModel), []);
  assert.equal("RuntimePendingActionSnapshot" in legacyState, false);
});
