import assert from "node:assert/strict";
import test from "node:test";

import * as canonicalPlan from "../src/plan/model.js";
import * as legacyPlan from "../src/instructions.js";
import * as canonicalLibraries from "../src/library-tooling/public.js";
import * as legacyLibraries from "../src/libraries/public.js";
import * as canonicalWorkspace from "../playground/workspace/controller.js";
import * as legacyWorkspace from "../playground/workspace.js";

test("legacy plan and compiler facade preserves canonical exports", () => {
  assert.equal(legacyPlan.compileProgram, canonicalPlan.compileProgram);
  assert.equal(legacyPlan.validateInstructionPlan, canonicalPlan.validateInstructionPlan);
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
