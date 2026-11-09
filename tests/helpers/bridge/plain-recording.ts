import type { DebugRecording } from "../../../player/debug/debug-recorder.js";

/** A recording without its plan graph, which never crosses the bridge; everything else is plain data. */
export function plainRecording(recording: DebugRecording | null) {
  if (recording === null) return null;
  const { plan: _plan, ...plain } = recording;
  return plain;
}
