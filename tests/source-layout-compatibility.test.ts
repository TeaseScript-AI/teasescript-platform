import assert from "node:assert/strict";
import test from "node:test";

import * as root from "../src/index.js";
import * as canonicalPlan from "../src/plan/model.js";
import * as canonicalCapture from "../src/plan/capture.js";
import * as canonicalValidation from "../src/plan/validation.js";
import * as canonicalCompiler from "../src/compiler/compile-program.js";
import * as canonicalCompilerErrors from "../src/compiler/errors.js";
import * as canonicalCompleteAction from "../src/runtime/operations/complete-action.js";
import * as canonicalObserveTime from "../src/runtime/operations/observe-time.js";
import * as canonicalActionModel from "../src/runtime/actions/model.js";
import * as canonicalValidationTesting from "../src/validation-testing.js";
import * as legacyEngine from "../src/runtime/engine.js";
import * as legacyState from "../src/runtime/state.js";
import * as legacyPlan from "../src/instructions.js";
import * as canonicalLibraries from "../src/library-tooling/public.js";
import * as legacyLibraries from "../src/libraries/public.js";
import * as legacyValidationTesting from "../src/runtime/validation-testing.js";
import * as canonicalWorkspace from "../playground/workspace/controller.js";
import * as legacyWorkspace from "../playground/workspace.js";
import type {
  RuntimeActionSettlementSnapshot as CanonicalActionSettlementSnapshot,
  RuntimeDelayActionSnapshot as CanonicalDelayActionSnapshot,
  RuntimeInteractionActionSnapshot as CanonicalInteractionActionSnapshot,
  RuntimePendingActionSnapshot as CanonicalPendingActionSnapshot,
} from "../src/runtime/actions/model.js";
import type {
  RuntimeActionSettlementSnapshot as StateActionSettlementSnapshot,
  RuntimeDelayActionSnapshot as StateDelayActionSnapshot,
  RuntimeInteractionActionSnapshot as StateInteractionActionSnapshot,
  RuntimePendingActionSnapshot as StatePendingActionSnapshot,
} from "../src/runtime/state.js";

type Assert<T extends true> = T;
type IsBidirectionallyAssignable<Left, Right> =
  [Left] extends [Right] ? [Right] extends [Left] ? true : false : false;

type ActionTypeCompatibility = [
  Assert<IsBidirectionallyAssignable<CanonicalPendingActionSnapshot, StatePendingActionSnapshot>>,
  Assert<IsBidirectionallyAssignable<CanonicalActionSettlementSnapshot, StateActionSettlementSnapshot>>,
  Assert<IsBidirectionallyAssignable<CanonicalInteractionActionSnapshot, StateInteractionActionSnapshot>>,
  Assert<IsBidirectionallyAssignable<CanonicalDelayActionSnapshot, StateDelayActionSnapshot>>,
];
const actionTypeCompatibility: ActionTypeCompatibility = [true, true, true, true];
void actionTypeCompatibility;

test("legacy instruction facade preserves the canonical plan and compiler exports", () => {
  assert.equal(legacyPlan.compileProgram, canonicalCompiler.compileProgram);
  assert.equal(legacyPlan.InstructionCompilationError, canonicalCompiler.InstructionCompilationError);
  assert.equal(canonicalCompiler.InstructionCompilationError, canonicalCompilerErrors.InstructionCompilationError);
  assert.equal(legacyPlan.captureInstructionPlan, canonicalCapture.captureInstructionPlan);
  assert.equal(legacyPlan.validateInstructionPlan, canonicalValidation.validateInstructionPlan);
  assert.equal(legacyPlan.INSTRUCTION_PLAN_VERSION, canonicalPlan.INSTRUCTION_PLAN_VERSION);
});

test("root exports preserve the supported canonical surface", () => {
  assert.equal(root.compileProgram, canonicalCompiler.compileProgram);
  assert.equal(root.validateInstructionPlan, canonicalValidation.validateInstructionPlan);
  assert.equal(root.completeAction, canonicalCompleteAction.completeAction);
  assert.equal(root.observeTime, canonicalObserveTime.observeTime);
  assert.equal("captureInstructionPlan" in root, false);
  assert.equal("validateCapturedInstructionPlan" in root, false);
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

test("validation-testing facade preserves canonical test instrumentation", () => {
  assert.equal(
    legacyValidationTesting.beginValidationTestStatistics,
    canonicalValidationTesting.beginValidationTestStatistics,
  );
  assert.equal(
    legacyValidationTesting.withValidationTestStatistics,
    canonicalValidationTesting.withValidationTestStatistics,
  );
  assert.equal(
    legacyValidationTesting.recordValidationTestWork,
    canonicalValidationTesting.recordValidationTestWork,
  );
  assert.equal(
    legacyValidationTesting.withDetailedValidationWorkLimitForTesting,
    canonicalValidationTesting.withDetailedValidationWorkLimitForTesting,
  );
  assert.equal(
    legacyValidationTesting.withInteractionControlFlowWorkLimitForTesting,
    canonicalValidationTesting.withInteractionControlFlowWorkLimitForTesting,
  );
});

test("action contracts remain runtime type-only at both canonical and state compatibility paths", () => {
  assert.deepEqual(Object.keys(canonicalActionModel), []);
  assert.equal("RuntimePendingActionSnapshot" in legacyState, false);
});
