import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { markerOf } from "./retention-child.js";

/*
 * The retention witness: what a child (`retention-child.ts`) still holds after its connections' teardown, found
 * without naming the holder. Its guarantee: after teardown, no original object the connection reached survives, and no
 * string holding a case's marker survives. Each case gets a marker that its fixture writes on every line (in names,
 * texts, comments and a path). The child's heap snapshot must hold no string that is, or could be, a string with it:
 * one string reader gives every string node its content, whole or, for a slice, "some part of its parent", and a
 * concatenated string is read through its leaves; a node whose content could form the marker counts (it fails
 * closed). The child adds the connection's reach as objects. It runs without V8's background threads
 * (`--single-threaded`), so what it finds held is not a background compile job's (#1947); a retention check elsewhere
 * that fails only under load is first compared with background threads off, before any hunt for the holder.
 *
 * Its limits, by design:
 * - a copy of marker-free data (a cloned token array, numbers, spans): copies are not originals, and carry no marker;
 * - an object without a marker kept where the object walk cannot see (a private field, a closure's environment, a
 *   `WeakMap` entry, a promise's result); the marker scan still sees marked strings there;
 * - a copy held only as bytes (a `TextEncoder` result, an `ArrayBuffer`, a `Blob`) that the connection never held;
 * - a result returned unmarked (an outcome `true`), which carries no session's identity.
 * A route that keeps bytes brings its own evidence of their lifetime.
 */

/** A node of the snapshot that holds a marker, and the shortest path that keeps it alive. */
export interface RetentionHit {
  readonly type: string;
  /** Whether its content was read with some part of a slice's parent: a hit by failing closed. */
  readonly partial: boolean;
  /** Its structure as the snapshot shows it: `flat`, `slice`, or `cons(first,second)` of those. */
  readonly shape: string;
  /** A flat string's length; `null` for another shape. */
  readonly length: number | null;
  readonly path: readonly string[];
}

/** No limit: a snapshot keeps every string whole (V8 cuts names at 1024 characters by default). */
const STRING_LIMIT = 2 ** 32 - 1;

/**
 * Runs `script` with `cases`, each with a fresh seed, and returns its report and, per case, the snapshot's hits of
 * its marker. The child writes `{ report, snapshot }`: the path of the snapshot it wrote, which this removes.
 */
export function runRetentionChild(
  script: URL,
  names: readonly string[],
): { readonly report: unknown; readonly hits: ReadonlyMap<string, readonly RetentionHit[]> } {
  const cases = names.map((name) => ({ name, seed: randomBytes(6).toString("hex") }));
  const child = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      // Without V8's background threads: a background compile job holds the closure it optimizes, its environment
      // included, until the main thread installs the code, so under load it kept a connection's data past the child's
      // collection, data the code under test no longer held (#1947).
      "--single-threaded",
      `--heap-snapshot-string-limit=${STRING_LIMIT}`,
      fileURLToPath(script),
      JSON.stringify(cases),
    ],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 1 << 24 },
  );
  if (child.status !== 0) throw new Error(`The retention child failed: ${child.stderr}`);
  // EVIDENCE: fixture: the child writes this JSON as its last output.
  const { report, snapshot } = JSON.parse(child.stdout) as { report: unknown; snapshot: string };
  try {
    const markers = new Map(cases.map(({ name, seed }) => [markerOf(seed), name]));
    const found = retentionHits(snapshot, [...markers.keys()]);
    return {
      report,
      hits: new Map(cases.map(({ name, seed }) => [name, found.get(markerOf(seed)) ?? []])),
    };
  } finally {
    rmSync(dirname(snapshot), { recursive: true, force: true });
  }
}

/** A part of a string's content: a known text, or some part of `within`, a slice's parent (`null`: anything). */
type Segment = string | { readonly within: string | null };

/**
 * Whether content made of `read` holds, or could hold, `marker`: a known text must match exactly where the marker
 * crosses it, and a part of a parent may be any stretch of the parent. Matched prefixes of the marker are carried from
 * segment to segment.
 */
function couldHold(read: readonly Segment[], marker: string): boolean {
  // Known throughout: the content itself.
  if (read.every((segment) => typeof segment === "string")) return read.join("").includes(marker);
  let open = new Set<number>([0]);
  for (const segment of read) {
    const next = new Set<number>([0]);
    for (const matched of open) {
      const rest = marker.slice(matched);
      if (typeof segment === "string") {
        if (matched === 0) {
          if (segment.includes(marker)) return true;
          for (let end = 1; end < marker.length; end += 1)
            if (segment.endsWith(marker.slice(0, end))) next.add(end);
        } else if (segment.startsWith(rest)) return true;
        else if (rest.startsWith(segment)) next.add(matched + segment.length);
        continue;
      }
      const { within } = segment;
      if (within === null || within.includes(rest)) return true;
      // The part ends inside the marker: it holds the marker's next stretch, perhaps empty.
      for (let end = matched; end < marker.length; end += 1)
        if (within.includes(marker.slice(matched, end))) next.add(end);
    }
    open = next;
  }
  return false;
}

/** The heap snapshot's JSON, as V8 writes it. */
interface HeapSnapshot {
  readonly snapshot: {
    readonly meta: {
      readonly node_fields: readonly string[];
      readonly node_types: readonly [readonly string[], ...unknown[]];
      readonly edge_fields: readonly string[];
      readonly edge_types: readonly [readonly string[], ...unknown[]];
    };
  };
  readonly nodes: readonly number[];
  readonly edges: readonly number[];
  readonly strings: readonly string[];
}

/** Every node of the snapshot at `path` that holds one of `markers`, by marker. */
function retentionHits(
  path: string,
  markers: readonly string[],
): ReadonlyMap<string, readonly RetentionHit[]> {
  // EVIDENCE: fixture: V8's heap snapshot format, written by `writeHeapSnapshot`.
  const heap = JSON.parse(readFileSync(path, "utf8")) as HeapSnapshot;
  const { meta } = heap.snapshot;
  const [nodeWidth, edgeWidth] = [meta.node_fields.length, meta.edge_fields.length];
  const field = (name: string) => meta.node_fields.indexOf(name);
  const [typeField, nameField, edgeCountField] = [
    field("type"),
    field("name"),
    field("edge_count"),
  ];
  const edgeField = (name: string) => meta.edge_fields.indexOf(name);
  const [edgeTypeField, edgeNameField, toField] = [
    edgeField("type"),
    edgeField("name_or_index"),
    edgeField("to_node"),
  ];
  const count = heap.nodes.length / nodeWidth;
  const typeOf = (node: number) => meta.node_types[0][heap.nodes[node * nodeWidth + typeField]!]!;
  const nameOf = (node: number) => heap.strings[heap.nodes[node * nodeWidth + nameField]!]!;
  const firstEdge = new Uint32Array(count + 1);
  for (let node = 0; node < count; node += 1)
    firstEdge[node + 1] =
      firstEdge[node]! + heap.nodes[node * nodeWidth + edgeCountField]! * edgeWidth;
  const edgesOf = function* (node: number) {
    for (let edge = firstEdge[node]!; edge < firstEdge[node + 1]!; edge += edgeWidth) {
      const type = meta.edge_types[0][heap.edges[edge + edgeTypeField]!]!;
      const label = heap.edges[edge + edgeNameField]!;
      yield {
        type,
        name: type === "element" || type === "hidden" ? `[${label}]` : heap.strings[label]!,
        to: heap.edges[edge + toField]! / nodeWidth,
      };
    }
  };

  // The string reader: a string node's content as segments, each a known text or some part of a slice's parent
  // (`null`: a parent not read, so anything). A concatenated string is its leaves', in order.
  const segments = new Map<number, readonly Segment[]>();
  const segmentsOf = (node: number): readonly Segment[] => {
    const type = typeOf(node);
    if (type === "string") {
      const text = nameOf(node);
      if (text.length >= STRING_LIMIT)
        throw new Error("A snapshot string reached the string limit");
      return [text];
    }
    let read = segments.get(node);
    if (read !== undefined) return read;
    segments.set(node, [{ within: null }]);
    const parts: Record<string, number> = {};
    for (const { name, to } of edgesOf(node)) parts[name] = to;
    if (type === "concatenated string")
      read = [parts.first, parts.second].flatMap((part) =>
        part === undefined ? [] : segmentsOf(part),
      );
    else {
      // A slice: its parent is a flat string, so its text is some part of the parent's.
      const parent = parts.parent === undefined ? null : segmentsOf(parts.parent);
      read = [{ within: parent?.length === 1 && typeof parent[0] === "string" ? parent[0] : null }];
    }
    segments.set(node, read);
    return read;
  };
  const strings = new Set(["string", "concatenated string", "sliced string"]);

  // Every marker starts with the same letters, so a known text without them holds none.
  const lead = markers[0]?.slice(0, 2) ?? "";
  const known = (read: readonly Segment[]) => read.every((segment) => typeof segment === "string");
  const found = new Map<string, number[]>();
  for (let node = 0; node < count; node += 1) {
    const read = strings.has(typeOf(node)) ? segmentsOf(node) : [nameOf(node)];
    if (known(read) && !read.join("").includes(lead)) continue;
    for (const marker of markers)
      if (couldHold(read, marker)) found.set(marker, [...(found.get(marker) ?? []), node]);
  }
  if (found.size === 0) return new Map();

  // The retainers of each node, over strong edges, for the path of each hit.
  const retainers: [number, string][][] = Array.from({ length: count }, () => []);
  for (let node = 0; node < count; node += 1) {
    // The string table holds its strings weakly; a string it alone holds is collected.
    if (typeOf(node) === "synthetic" && nameOf(node) === "(Internalized strings)") continue;
    for (const { type, name, to } of edgesOf(node))
      if (type !== "weak") retainers[to]!.push([node, name]);
  }
  const shapeOf = (node: number, depth: number): string => {
    const type = typeOf(node);
    if (type === "string") return "flat";
    if (type === "sliced string") return "slice";
    if (type !== "concatenated string") return type;
    if (depth === 0) return "cons(...)";
    const parts: Record<string, number> = {};
    for (const { name, to } of edgesOf(node)) parts[name] = to;
    const part = (at: number | undefined) => (at === undefined ? "none" : shapeOf(at, depth - 1));
    return `cons(${part(parts.first)},${part(parts.second)})`;
  };
  const label = (node: number) => `${typeOf(node)} ${nameOf(node).slice(0, 60)}`;
  const pathOf = (node: number): readonly string[] => {
    // Breadth first from the hit to the snapshot's root, node 0.
    const via = new Map<number, [number, string] | null>([[node, null]]);
    const queue = [node];
    for (let next = 0; next < queue.length; next += 1) {
      const current = queue[next]!;
      if (current === 0) break;
      for (const [retainer, name] of retainers[current]!)
        if (!via.has(retainer)) {
          via.set(retainer, [current, name]);
          queue.push(retainer);
        }
    }
    if (!via.has(0)) return ["(no path from the root)"];
    const path: string[] = [];
    for (let current = 0; current !== node;) {
      const [child, name] = via.get(current)!;
      path.push(`${label(current)} -${name}->`);
      current = child;
    }
    return [...path, label(node)];
  };
  return new Map(
    [...found].map(([marker, nodes]) => [
      marker,
      nodes.map((node) => ({
        type: typeOf(node),
        partial: strings.has(typeOf(node)) && !known(segmentsOf(node)),
        shape: shapeOf(node, 3),
        length: typeOf(node) === "string" ? nameOf(node).length : null,
        path: pathOf(node),
      })),
    ]),
  );
}
