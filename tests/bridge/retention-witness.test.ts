import assert from "node:assert/strict";
import test from "node:test";

import { runRetentionChild } from "../helpers/retention-witness.js";
import { markedProject } from "../helpers/bridge/source-ops-project.js";

/*
 * The retention witness's positive controls (`helpers/retention-witness.ts`): it must find a piece of session data
 * kept after teardown in any kind of holder, and a marker in any representation of a string. The marker scan finds
 * every holder of a marked piece, on a path through that holder; the object observation finds a held marker-free piece
 * the connection reached, and loses it once its holder lets it go. A clean teardown is found by neither.
 */
const OBJECT_HOLDERS = [
  "module",
  "closure",
  "global",
  "mapByToken",
  "weakMapValue",
  "set",
  "promiseReaction",
  "timer",
  "staticField",
  "arrayElement",
] as const;
/** Each holder kind's own edge, which the path of what it keeps passes. */
const EDGE_OF: Record<string, string> = {
  module: "-moduleHeld->",
  closure: "-kept->",
  mapByToken: "-byToken->",
  weakMapValue: "part of key",
  set: "-inSet->",
  promiseReaction: "-reactions_or_result->",
  timer: "-_onTimeout->",
  staticField: "Held -values->",
  arrayElement: "-nested->",
  propertyKey: "-keys->",
  slice: "-slices->",
  cons: "-conses->",
  lineCopy: "-lineCopies->",
  splitCons: "-splitConses->",
};
/** Each representation's structure, as the snapshot shows it. */
const SHAPE_OF: Record<string, string> = {
  flat: "flat",
  cons: "cons(flat,flat)",
  nestedCons: "cons(cons(flat,flat),flat)",
  slice: "slice",
  sliceInConsLeft: "cons(slice,flat)",
  sliceInConsRight: "cons(flat,slice)",
  long: "flat",
};
const MARKER_LENGTH = 14;
const AXES = {
  scan: {
    holder: [...OBJECT_HOLDERS, "propertyKey", "slice", "cons", "lineCopy", "splitCons"],
    piece: ["sidecarText", "sidecarFile", "renderedLines", "plan", "sourceElement"],
  },
  object: { holder: OBJECT_HOLDERS, piece: ["tokenArray", "enclosingSpans"] },
  // Every cut of the marker, from before its first character to after its last.
  string: {
    holder: Object.keys(SHAPE_OF),
    piece: Array.from({ length: MARKER_LENGTH + 1 }, (_, cut) => String(cut)),
  },
} as const;
/** The marked path a string control holds, as long as it is with a marker. */
const PATH_LENGTH = markedProject("m".repeat(MARKER_LENGTH)).files[0]!.path.length;

/**
 * What the snapshot must show for a case, from its axis values alone: the edge of the holder its piece is kept by,
 * and for a string control the structure and length of the string it holds.
 */
function expectedOf(name: string): {
  readonly edge: string;
  readonly shape: string | null;
  readonly length: number | null;
} {
  const [observation, holder] = name.split("/");
  if (observation === "string")
    return {
      edge: "-representations->",
      shape: SHAPE_OF[holder!]!,
      length: holder === "long" ? 70_000 + PATH_LENGTH : null,
    };
  return {
    edge: holder === "global" ? `-retention ${name}->` : EDGE_OF[holder!]!,
    shape: null,
    length: null,
  };
}

const CASES = [
  ...Object.entries(AXES).flatMap(([observation, { holder, piece }]) =>
    holder.flatMap((each) => piece.map((kind) => `${observation}/${each}/${kind}`)),
  ),
  "clean",
];

test("the retention witness finds a piece kept in any holder after teardown, and nothing after a clean one", () => {
  const { report, hits } = runRetentionChild(
    new URL("../helpers/retention-controls.js", import.meta.url),
    CASES,
  );
  // EVIDENCE: fixture: the child reports one entry per case it was given.
  const reports = report as readonly {
    readonly name: string;
    readonly extra: number;
    readonly held: number;
    readonly released: number;
  }[];
  // Coverage, from the names the child reports: every holder and piece of each observation, and every pair.
  const names = reports.map(({ name }) => name.split("/"));
  for (const [observation, { holder, piece }] of Object.entries(AXES))
    for (const each of holder)
      for (const kind of piece)
        assert.ok(
          names.some(([o, h, p]) => o === observation && h === each && p === kind),
          `${observation}/${each}/${kind}`,
        );
  for (const { name, extra, held, released } of reports) {
    const found = hits.get(name)!;
    // What a holder keeps outside the connection leaves the connection as a fresh one.
    assert.equal(extra, 0, name);
    if (name === "clean") {
      assert.deepEqual([found, held], [[], 0], "a clean teardown leaves nothing");
      continue;
    }
    // The observed holder and structure, against what the case's axis values imply.
    const { edge, shape, length } = expectedOf(name);
    const through = found
      .filter(({ path }) => path.join(" ").includes(edge))
      .sort((left, right) => left.path.length - right.path.length);
    const observed = (hit: (typeof found)[number] | undefined) =>
      hit === undefined ? "none" : `${hit.shape}:${hit.length} via ${hit.path.join(" ")}`;
    assert.ok(
      through.length > 0,
      `${name}: kept through ${edge}: ${found.map(observed).join(" || ")}`,
    );
    // The string it holds directly: the hit nearest its holder.
    if (shape !== null) assert.equal(through[0]!.shape, shape, `${name}: ${observed(through[0])}`);
    if (length !== null)
      assert.equal(through[0]!.length, length, `${name}: ${observed(through[0])}`);
    if (name.startsWith("object/")) {
      assert.ok(held > 0, `${name}: the object observation finds the kept piece`);
      assert.equal(released, 0, `${name}: released, it is collected`);
    }
  }
});
