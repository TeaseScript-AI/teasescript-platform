import assert from "node:assert/strict";
import test from "node:test";
import { HELD_MODES } from "../helpers/type-core-held-host.js";
import { stopRuns } from "../helpers/type-core-stop-oracle.js";

// #2116's declared difference under #2080 (the owner's decision (B): the decision index lands before #2080's unsettled
// side, with this record). This file pins known escapes, not accepted behaviour: at these forced demand allowances on
// constructed sources, the index's charges move an unsettled stop where main keeps a store's check, and the oracle reads
// each stop's runs as it does today. #2080's unsettled side (bounded fresh-pass inference) flips each row to `closed`;
// update the rows then. The oracle is lane 1a's (`stopRuns`, #2080); its rows are lane 1a's to review.

/**
 * Codex round 7's reachable sources (PR #2116): a place holding `count` settled whole stores (or `count` copies of
 * them), reads under a host condition that is false when the script runs, which pay for the decision index, then a
 * store of the host value that main's plan checks.
 */
const settled = (count: number, last: string) =>
  [
    "let value:integer=1",
    "let u={f1:{n:value}}",
    'u={g:"s"}',
    "let root={f0:{n:value}}",
    ...Array.from({ length: count - 1 }, (_, i) => `root={f${i + 1}:{n:value}}`),
    "if hostOther is integer {",
    ...Array.from({ length: 2 * count }, (_, i) => `let r${i}=root.f${i % count}.n`),
    "}",
    last,
    'say "accepted"',
    "exit",
  ].join("\n");
const copied = (count: number) =>
  [
    "let value:integer=1",
    "let u={f1:{n:value}}",
    'u={g:"s"}',
    ...Array.from({ length: count }, (_, i) => `let root${i}={p:{n:value},q${i}:value}`),
    "let a=root0",
    ...Array.from({ length: count - 1 }, (_, i) => `a=root${i + 1}`),
    "if hostOther is integer {",
    ...Array.from({ length: 2 * count }, (_, i) => `let r${i}=a.p.m${i}`),
    "}",
    "a=hostValue",
    'say "accepted"',
    "exit",
  ].join("\n");

/**
 * Each declared setting (its source, `HELD_MODES` index and demand allowance) and the oracle's reading on this tree:
 * `open` with the natural plan's failure its witnessing run shows, or `unwitnessed`.
 */
const ROWS: readonly {
  readonly label: string;
  readonly source: string;
  readonly mode: number;
  readonly demand: number;
  readonly natural?: { readonly code: string; readonly start: number };
}[] = [
  ...(
    [
      [0, 80],
      [0, 96],
      [0, 112],
      [0, 128],
      [0, 160],
      [2, 80],
      [2, 96],
      [2, 112],
      [2, 224],
      [2, 256],
    ] as const
  ).map(([mode, demand]) => ({
    label: "direct-distinct-whole-8",
    source: settled(8, "root=hostValue"),
    mode,
    demand,
    natural: { code: "TSR058", start: 526 },
  })),
  ...(
    [
      [0, 384],
      [2, 320],
    ] as const
  ).map(([mode, demand]) => ({
    label: "copy-every-whole-4",
    source: copied(4),
    mode,
    demand,
    natural: { code: "TSR058", start: 361 },
  })),
  // (both plans fail here, the stopped one first, with TSR017 at 299, so the oracle shows no escape)
  ...([0, 2] as const).map((mode) => ({
    label: "direct-distinct-field-4",
    source: settled(4, "root.f1=hostValue"),
    mode,
    demand: 96,
  })),
];

test("#2116's declared difference under #2080: 14 settings whose unsettled stop drops a store's check main keeps, as the stop oracle reads them (PR #2116, the owner's decision (B))", () => {
  for (const { label, source, mode, demand, natural } of ROWS) {
    const name = `${label} ${HELD_MODES[mode]!.name} at ${demand}`;
    const found = stopRuns(
      [{ path: "main.tease", source }],
      ["hostValue", "hostOther"],
      (make) => HELD_MODES[mode]!.run(make),
      demand,
    );
    assert.equal(found.stopped.plan, true, name);
    if (natural === undefined) {
      assert.equal(found.kind, "unwitnessed", name);
      continue;
    }
    assert.equal(found.kind, "open", name);
    assert.ok(found.first !== null, name);
    assert.deepEqual(
      [
        found.first.natural?.failure?.code,
        found.first.natural?.failure?.start,
        found.first.stopped.failure,
      ],
      [natural.code, natural.start, null],
      name,
    );
  }
});
