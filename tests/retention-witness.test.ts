import assert from "node:assert/strict";
import test from "node:test";

import { runRetentionChild } from "./helpers/retention-witness.js";

/*
 * The retention witness's positive controls (`helpers/retention-witness.ts`): it must find a piece of session data
 * kept after teardown in any kind of holder. The marker scan finds every holder of a marked piece; the object
 * observation finds a held marker-free piece the connection reached. A clean teardown is found by neither.
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
const AXES = {
  scan: {
    holder: [...OBJECT_HOLDERS, "propertyKey", "slice", "cons", "lineCopy", "splitCons"],
    piece: ["sidecarText", "sidecarFile", "renderedLines", "plan", "sourceElement"],
  },
  object: { holder: OBJECT_HOLDERS, piece: ["tokenArray", "enclosingSpans"] },
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
  for (const { name, extra, held } of reports) {
    const found = hits.get(name)!;
    // What a holder keeps outside the connection leaves the connection as a fresh one.
    assert.equal(extra, 0, name);
    if (name === "clean") {
      assert.deepEqual([found, held], [[], 0], "a clean teardown leaves nothing");
    } else if (name.startsWith("scan/")) {
      assert.ok(found.length > 0, `${name}: the scan finds the kept piece`);
      for (const { path } of found) assert.notEqual(path[0], "(no path from the root)", name);
    } else assert.ok(held > 0, `${name}: the object observation finds the kept piece`);
  }
});
