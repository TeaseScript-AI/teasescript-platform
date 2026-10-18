/**
 * Bounds of one trace's retained history: the oldest records are dropped first once either the record count or the
 * accounted bytes would be exceeded. Previews and dependency lists are cut while they are captured. These are tuning
 * values of the debugger, not language limits.
 */
export const RUNTIME_DEBUG_TRACE_LIMITS = Object.freeze({
  maxRecords: 8192,
  maxAccountedBytes: 8 * 1024 * 1024,
  maxPreviewCharacters: 1024,
  maxDependencies: 32,
});
