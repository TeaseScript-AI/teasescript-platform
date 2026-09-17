// Presentation data only; runtime transcript/provenance remains owned by the runtime adapter.
export interface TranscriptEntry {
  id: string;
  author: "speaker" | "player";
  name: string;
  text: string;
}
