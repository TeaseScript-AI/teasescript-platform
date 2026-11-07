import assert from "node:assert/strict";
import test from "node:test";

import { runRetentionChild } from "./helpers/retention-witness.js";

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
/** Each holder's own edge, which the path of what it keeps passes. */
const EDGES: Record<string, string> = {
  module: "-moduleHeld->",
  closure: "-kept->",
  global: "-retention scan/global/",
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
/** The snapshot node a representation must show as, and whether it is read by failing closed. */
const SHOWN: Record<string, { readonly type: string; readonly partial: boolean }> = {
  flat: { type: "string", partial: false },
  cons: { type: "concatenated string", partial: false },
  nestedCons: { type: "concatenated string", partial: false },
  slice: { type: "sliced string", partial: true },
  sliceInConsLeft: { type: "concatenated string", partial: true },
  sliceInConsRight: { type: "concatenated string", partial: true },
  long: { type: "string", partial: false },
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
    holder: Object.keys(SHOWN),
    piece: Array.from({ length: MARKER_LENGTH + 1 }, (_, cut) => String(cut)),
  },
} as const;
const CASES = [
  ...Object.entries(AXES).flatMap(([observation, { holder, piece }]) =>
    holder.flatMap((each) => piece.map((kind) => `${observation}/${each}/${kind}`)),
  ),
  "clean",
];

test("the retention witness finds a piece kept in any holder after teardown, and nothing after a clean one", () => {
  const { report, hits } = runRetentionChild(
    new URL("./helpers/retention-controls.js", import.meta.url),
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
    const [observation, holder] = name.split("/");
    // What a holder keeps outside the connection leaves the connection as a fresh one.
    assert.equal(extra, 0, name);
    if (observation === "clean") {
      assert.deepEqual([found, held], [[], 0], "a clean teardown leaves nothing");
    } else if (observation === "scan") {
      const paths = found.map(({ path }) => path.join(" "));
      assert.ok(
        paths.some((path) => path.includes(EDGES[holder!]!)),
        `${name}: the scan finds the piece through its holder: ${paths.join(" || ")}`,
      );
    } else if (observation === "object") {
      assert.ok(held > 0, `${name}: the object observation finds the kept piece`);
      assert.equal(released, 0, `${name}: its holder alone kept it`);
    } else {
      const { type, partial } = SHOWN[holder!]!;
      assert.ok(
        found.some(
          (hit) =>
            hit.type === type &&
            hit.partial === partial &&
            hit.path.join(" ").includes("-representations->"),
        ),
        `${name}: the scan reads it as a ${type}: ${JSON.stringify(found.map(({ type: t, partial: p }) => [t, p]))}`,
      );
    }
  }
});
