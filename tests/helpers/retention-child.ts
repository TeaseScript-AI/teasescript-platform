import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { OwnedCell, OwnedMap } from "../../player/engine-bridge/delivery.js";

/*
 * The child side of the retention witness (`retention-witness.ts`), for a child run by `runRetentionChild`: markers,
 * the reach of a connection, and the heap snapshot the parent scans. A child keeps its connections, their ops
 * included, until the snapshot, and runs its cases in a function that has returned by then, so that only what the
 * code under test holds stays.
 */

/** A case's marker, from the seed its parent passed: never written in a source, so a hit is held data. */
export function markerOf(seed: string): string {
  return `zq${[...seed].reverse().join("")}`;
}

/** The cases a child was given: each case's name and seed. */
export function childCases(): readonly { readonly name: string; readonly seed: string }[] {
  // EVIDENCE: fixture: `runRetentionChild` passes its cases as this JSON.
  return JSON.parse(process.argv[2]!) as { name: string; seed: string }[];
}

/** Every object reachable from `root` through object values, `Map` keys and values, and `Set` values. */
export function reach(root: WeakKey): Set<WeakKey> {
  const found = new Set<WeakKey>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if ((typeof value !== "object" && typeof value !== "function") || value === null) continue;
    if (found.has(value)) continue;
    found.add(value);
    // A registry the connection's deliveries own keeps its map private: its entries are what it reaches.
    if (value instanceof Map || value instanceof OwnedMap)
      for (const [key, item] of value) pending.push(key, item);
    else if (value instanceof OwnedCell) pending.push(value.value);
    else if (value instanceof Set) pending.push(...value);
    else pending.push(...Object.values(value));
  }
  return found;
}

/**
 * What a connection reached before its teardown, as weak references: every object reachable from `context`. Read
 * with `stillHeld` after collection.
 */
export function heldBefore(context: WeakKey): readonly WeakRef<WeakKey>[] {
  return [...reach(context)].map((value) => new WeakRef(value));
}

/** How many of `before` are still alive and not reachable from `context`, after collection. */
export function stillHeld(before: readonly WeakRef<WeakKey>[], context: WeakKey): number {
  const kept = reach(context);
  return before.filter((ref) => {
    const value = ref.deref();
    return value !== undefined && !kept.has(value);
  }).length;
}

/** Collects garbage over two turns of the event loop; the child runs with `--expose-gc`. */
export async function collect(): Promise<void> {
  const gc = globalThis.gc;
  if (gc === undefined) throw new Error("Run with --expose-gc");
  for (let round = 0; round < 2; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    gc();
  }
}

/**
 * Writes the heap snapshot the parent scans, and returns its path. First a successful match on a constant: V8 keeps
 * the last RegExp subject (`regexp_last_match_info`), which would show the last text the code under test matched.
 */
export async function snapshotForRetention(): Promise<string> {
  /x/.exec("x");
  await collect();
  return writeHeapSnapshot(join(mkdtempSync(join(tmpdir(), "retention-")), "heap.heapsnapshot"));
}
