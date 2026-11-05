import type { PlanSourceLocation } from "../../plan/model.js";
import { isCameraView, isMediaHandle, isTimerHandle } from "../values/value-predicates.js";
import type { SerializableRuntimeValue } from "../values/serializable-values.js";
import { valueNotationPrefix } from "../values/value-text.js";
import { RUNTIME_DEBUG_TRACE_LIMITS } from "./debug-trace-limits.js";

// A value as the debug trace previews it, without the trace (`debug-trace.ts`), whose context retains the plan.

const PREVIEW_SPAN: PlanSourceLocation = Object.freeze({
  so: 0,
  sl: 0,
  sc: 0,
  eo: 0,
  el: 0,
  ec: 0,
});

/**
 * A value as the trace previews it: `say` notation cut at `RUNTIME_DEBUG_TRACE_LIMITS.maxPreviewCharacters` while it is
 * written, so a debugger can show a live value the same way as a recorded one.
 */
export function runtimeDebugPreview(value: SerializableRuntimeValue): {
  readonly text: string;
  readonly truncated: boolean;
} {
  return previewOf(value);
}

export function previewOf(value: SerializableRuntimeValue): { text: string; truncated: boolean } {
  return valueNotationPrefix(
    value,
    PREVIEW_SPAN,
    (handle) =>
      isTimerHandle(handle)
        ? "<timer>"
        : isMediaHandle(handle)
          ? "<media>"
          : isCameraView(handle)
            ? "<camera>"
            : "<permanent button>",
    RUNTIME_DEBUG_TRACE_LIMITS.maxPreviewCharacters,
  );
}
