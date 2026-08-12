import {
  createSourcePosition,
  createSourceSpan,
  type SourceSpan,
} from "../source.js";
import type { PlanSourceLocation } from "./model.js";

/** Converts a rich compiler source span into compact serialized plan provenance. */
export function sourceSpanToPlanLocation(span: SourceSpan): PlanSourceLocation {
  return {
    so: span.start.offset,
    sl: span.start.line,
    sc: span.start.column,
    eo: span.end.offset,
    el: span.end.line,
    ec: span.end.column,
  };
}

/** Reconstructs the public/runtime rich source span from plan provenance. */
export function planLocationToSourceSpan(location: PlanSourceLocation): SourceSpan {
  return createSourceSpan(
    createSourcePosition(location.so, location.sl, location.sc),
    createSourcePosition(location.eo, location.el, location.ec),
  );
}
