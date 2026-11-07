import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { markerOf } from "./retention-child.js";

/*
 * The retention witness: what a child (`retention-child.ts`) still holds after its connections' teardown, found
 * without naming the holder. Each case gets a marker that its fixture writes on every line (in names, texts, comments
 * and a path), and the child's heap snapshot must hold no string with it: neither a flat string, nor a concatenated
 * one read whole through its leaves, nor a slice's parent. The child adds what a connection reached as objects.
 *
 * Its limits, by design: a copy held only as bytes (a `TextEncoder` result, an `ArrayBuffer`, a `Blob`) that the
 * connection never held has no string to find, and a result returned unmarked (an outcome `true`) carries no session's
 * identity. A route that keeps bytes brings its own evidence of their lifetime.
 */

/** A node of the snapshot that holds a marker, and the shortest path that keeps it alive. */
export interface RetentionHit {
  readonly type: string;
  readonly path: readonly string[];
}

/** A long enough limit that a snapshot keeps a fixture's strings whole. */
const STRING_LIMIT = 1 << 16;

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

  // A concatenated string's text, read through its `first` and `second` leaves, so that a marker split across
  // them shows; a sliced string's text is its parent's, which is a node of its own.
  const texts = new Map<number, string>();
  const textOf = (node: number): string => {
    const type = typeOf(node);
    if (type !== "concatenated string") return type === "string" ? nameOf(node) : "";
    let text = texts.get(node);
    if (text === undefined) {
      texts.set(node, "");
      const parts: Record<string, number> = {};
      for (const { name, to } of edgesOf(node)) parts[name] = to;
      text =
        (parts.first === undefined ? "" : textOf(parts.first)) +
        (parts.second === undefined ? "" : textOf(parts.second));
      texts.set(node, text);
    }
    return text;
  };

  const found = new Map<string, number[]>();
  for (let node = 0; node < count; node += 1) {
    const text = typeOf(node) === "concatenated string" ? textOf(node) : nameOf(node);
    for (const marker of markers)
      if (text.includes(marker)) found.set(marker, [...(found.get(marker) ?? []), node]);
  }
  if (found.size === 0) return new Map();

  // The retainers of each node, over strong edges, for the path of each hit.
  const retainers: [number, string][][] = Array.from({ length: count }, () => []);
  for (let node = 0; node < count; node += 1)
    for (const { type, name, to } of edgesOf(node))
      if (type !== "weak") retainers[to]!.push([node, name]);
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
      nodes.map((node) => ({ type: typeOf(node), path: pathOf(node) })),
    ]),
  );
}
