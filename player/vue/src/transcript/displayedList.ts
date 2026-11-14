import type { PlayerTranscriptEntryPresentation } from "../../../presentation/model.js";

type Entry = PlayerTranscriptEntryPresentation;

/** The key of an entry's row: an answer keeps the key its predicted row had, so its element stays. */
export function rowKey(entry: Entry): string {
  return (entry.kind === "message" ? entry.renderKey : undefined) ?? entry.id;
}

/**
 * The rows the conversation shows: `entries`, then `pending` until an entry takes its row key. Its entry may come
 * anywhere in what is appended while it is pending, after a block's messages or before a long continuation, so every
 * entry is searched once: a pending row newly shown, or a replaced or shortened entries list, is searched whole, and
 * an append from where the last search ended. The list changes only with the entries, their length and the pending
 * row: typing in the composer leaves it as it is.
 */
export function displayedList(): (
  entries: readonly Entry[],
  pending: Entry | null,
) => readonly Entry[] {
  let listed: {
    readonly entries: readonly Entry[];
    readonly length: number;
    readonly pending: Entry | null;
    readonly arrived: boolean;
    readonly value: readonly Entry[];
  } | null = null;
  return (entries, pending) => {
    if (
      listed !== null &&
      listed.entries === entries &&
      listed.length === entries.length &&
      listed.pending === pending
    )
      return listed.value;
    const from =
      listed !== null &&
      listed.pending === pending &&
      listed.entries === entries &&
      listed.length <= entries.length
        ? listed
        : null;
    let arrived = from?.arrived ?? false;
    if (pending !== null && !arrived) {
      const key = rowKey(pending);
      for (let index = from?.length ?? 0; index < entries.length; index += 1)
        if (rowKey(entries[index]!) === key) {
          arrived = true;
          break;
        }
    }
    const value = pending === null || arrived ? entries : [...entries, pending];
    listed = { entries, length: entries.length, pending, arrived, value };
    return value;
  };
}
