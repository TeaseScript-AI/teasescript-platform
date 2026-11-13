import {
  compileProject,
  compileSource,
  createFreshRuntimeSession,
  createRuntimeSession,
  createTaggedRuntimeSession,
  deserializeRuntimeSession,
  restoreRuntimeSession,
  RuntimeDebugContext,
  runtimeTimedWork,
  serializeCheckpoint,
} from "../../src/index.js";
import { compileProjectWithBackend, compileSourceWithBackend } from "../../src/compiler.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { buildAdapter, type PipelineAdapter } from "./runtime/runtime-differential-side.js";

/** This build, in this process: the differential driver's default side (docs/TESTING.md "Differential harness"). */
export function thisBuild(label: string): PipelineAdapter {
  return buildAdapter(label, {
    index: {
      compileProject,
      compileSource,
      createFreshRuntimeSession,
      createRuntimeSession,
      createTaggedRuntimeSession,
      restoreRuntimeSession,
      deserializeRuntimeSession,
      serializeCheckpoint,
      runtimeTimedWork,
      RuntimeDebugContext,
    },
    compiler: { compileProjectWithBackend, compileSourceWithBackend },
    backend: { CORE_BACKEND, CandidateOutsideSlice },
  });
}
