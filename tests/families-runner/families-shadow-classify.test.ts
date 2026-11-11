import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const tool = resolve("tests/families/shadow-classify.mjs");
/**
 * The S11 readiness research's records (main `dfc7fed44`, `~/work/evidence/o4-sol-s11-readiness/`): the smallest three
 * witnesses of each class its replay retains under 30 kB, and #1703's inventory rows at depth 32 with one, two and four
 * copies, each cut to the fields the classifier reads, messages and each check list replaced by a sha256 prefix (it
 * compares them only for equality); and the three #1704 configurations that exhaust the legacy route's heap, recorded by
 * `shadow.mjs` at main `e972f4d84`, cut the same way. `witnessOf` names the classes each witnesses.
 */
interface Witness {
  key: string;
  set?: string;
  name?: string;
  origins: Array<{ name: string }>;
  witnessOf: string[];
  rows: Array<{ core: { diagnostics: unknown[]; checks: unknown; planHash: string } }>;
}
const witnesses: Witness[] = readFileSync(
  resolve("tests/fixtures/shadow-classify/witnesses.jsonl"),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line): Witness => JSON.parse(line));
const nameOf = (r: Witness) => r.name ?? r.origins[0]?.name ?? "";
/** The research's smallest unavailable sources: in its manifest, without a record. */
const UNAVAILABLE = [
  "40e7ee95c5f67e0279d4fc97538397bb6f58176e3f52cb7b9fb312f37e9498e0",
  "61fcfaadc2fc0bb61532221aa93c05fabab0a448af4c57895f5efad2b7a16915",
  "652fb4fd2fb1d094bd77fe53bad8bc85e85912d0e044740804efb8b2aea3d4c7",
];
const load = async () => import(pathToFileURL(tool).href);
const entries = (records: unknown[]) =>
  records.map((record, i) => ({ record, bytes: JSON.stringify(record).length, where: `#${i}` }));

const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
const SAME = { diagnosticIdentity: false, diagnosticText: false, checks: false, plan: false };
const diagnostic = (code: string, at: number, message = "m") => ({
  code,
  severity: "warning",
  path: "main.tease",
  message,
  span: { start: { offset: at }, end: { offset: at + 1 } },
});
const planned = (diagnostics: unknown[] = [], planHash = "p", checks = "c") => ({
  outcome: "plan",
  diagnostics,
  checks: { runtimeChecks: checks },
  planHash,
  decisionCounts: { ordinary: [1], completion: [1] },
});
/** `shadow.mjs --demands`'s rows: the core alone at a demand allowance, each run reaching a completion or not. */
const control = (demand: number, completion = [1]) => ({
  demand,
  rows: MODES.map((mode) => ({
    mode,
    core: { outcome: "plan", decisionCounts: { ordinary: [1], completion } },
  })),
});
/** A record of four rows, `row(mode index)` giving each one's legacy, core and delta. */
const record = (key: string, row: (i: number) => Record<string, unknown>) => ({
  key,
  origins: [{ set: "synthetic", name: key }],
  rows: MODES.map((mode, i) => ({
    mode,
    legacy: planned(),
    core: planned(),
    delta: SAME,
    ...row(i),
  })),
  demands: [control(16)],
});

test("every recorded witness falls in its class, each pair in exactly one", async () => {
  const C = await load();
  // (the research's campaign and shadow.mjs's run of #1704's configurations, classified apart: the research's records
  // of those keys are aborted ones, so together the two campaigns conflict)
  const research = witnesses.filter((r) => r.set === undefined);
  const rerun = witnesses.filter((r) => r.set === "copies");
  // (#1744's presence sources, recorded by shadow.mjs at main 575c699b9; and Sol's traversal control past a function
  // declaration, `return-controlled.json` of the classifier-group preparation, the return statement's witness)
  // (and v5's: gate run 5's record of a natural decline by the lost-check gate, #1781, at main 830497aaf)
  const holes = witnesses.filter(
    (r) => r.set === "holes" || r.set === "return-control" || r.set === "declined",
  );
  const result = C.classifyRecords(
    entries(research),
    new Set([...research.map((r) => r.key), ...UNAVAILABLE]),
  );
  assert.deepEqual(result.problems, []);
  const fresh = C.classifyRecords(entries(rerun));
  assert.deepEqual(fresh.problems, []);
  assert.deepEqual(
    fresh.perPair.map((p: { class: string }) => p.class),
    rerun.flatMap(() => [0, 1, 2, 3].map(() => "failed/legacy-heap")),
  );
  assert.deepEqual(
    C.classifyRecords(entries(witnesses)).problems.map((p: { problem: string }) => p.problem),
    rerun.map(() => "conflicting duplicate"),
  );
  // (each class's named witness is the fixture's, where it names one)
  for (const [table, classes] of [
    ["pairs", C.PAIR_CLASSES],
    ["sharing", C.SHARING_CLASSES],
  ])
    for (const c of classes) {
      if (/^synthetic|the research's manifest|over the fixture's size/.test(c.witness)) continue;
      const [key, ...name] = c.witness.split(" ");
      assert.ok(
        witnesses.some(
          (r) =>
            r.key.startsWith(key) &&
            nameOf(r).replace(/\n/g, " ") === name.join(" ") &&
            r.witnessOf.includes(`${table}:${c.id}`),
        ),
        `${c.id}: ${c.witness}`,
      );
    }
  // (each presence source in its exclusion class, the classifier's own reading of the run)
  const fromHoles = C.classifyRecords(entries(holes));
  assert.deepEqual(fromHoles.problems, []);
  for (const r of holes)
    assert.ok(
      fromHoles.perPair.some(
        (p: { key: string; class: string }) =>
          p.key === r.key && `pairs:${p.class}` === r.witnessOf[0],
      ),
      `${nameOf(r)} witnesses ${r.witnessOf[0]}`,
    );
  for (const r of research)
    for (const tag of r.witnessOf) {
      if (tag === "#1703 inventory") continue;
      const [table, id] = [tag.slice(0, tag.indexOf(":")), tag.slice(tag.indexOf(":") + 1)];
      const list = table === "pairs" ? result.perPair : result.perOrder;
      assert.ok(
        list.some((p: { key: string; class: string }) => p.key === r.key && p.class === id),
        `${nameOf(r)} witnesses ${tag}`,
      );
    }
  // (every class the research's records reach has its witnesses here; the rest are the synthetic test's below)
  const reached = (table: Array<{ id: string; pairs: number }>) =>
    table.filter((r) => r.pairs > 0).map((r) => r.id);
  assert.deepEqual(
    C.PAIR_CLASSES.map((c: { id: string }) => c.id).filter(
      (id: string) => !reached(result.pairs).includes(id),
    ),
    [
      "differs/plan",
      // (v5's: the research's records predate #1781; gate run 5's own record is checked with the presence sources)
      "declined/lost check",
      // (v2's: the presence sources' and the traversal control's own records reach them, checked below)
      "excluded/this return statement",
      "excluded/this show camera statement",
      "excluded/this show camera expression",
      "excluded/this hide camera statement",
      "excluded/this tag query expression",
      // (v4's: #1775's decline, which no gate source has reached yet)
      "excluded/a typed parse's or load's default that a stop left open",
      "failed/legacy-heap",
      "failed/other",
      "exception",
    ],
  );
  assert.deepEqual(
    C.SHARING_CLASSES.map((c: { id: string }) => c.id).filter(
      (id: string) => !reached(result.sharing).includes(id),
    ),
    ["both-stop-differ"],
  );
  assert.equal(result.verdict, "open");
});

test("the sharing column on #1703's inventory rows: forward, sharing changes warnings with equal plans; reversed, one copy count stops in one mode only (#1711)", async () => {
  const C = await load();
  const rows = witnesses
    .filter((r) => r.witnessOf.includes("#1703 inventory"))
    .sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : 1));
  const result = C.classifyRecords(entries(rows));
  assert.deepEqual(result.problems, []);
  const column = Object.fromEntries(
    result.perOrder.map((p: { name: string; reversed: boolean; class: string }) => [
      `${p.name} ${p.reversed ? "reversed" : "forward"}`,
      p.class,
    ]),
  );
  assert.deepEqual(column, {
    "sharing-warning/depth32/copies1 forward": "neither-stops-differ",
    "sharing-warning/depth32/copies1 reversed": "equal",
    "sharing-warning/depth32/copies2 forward": "neither-stops-differ",
    "sharing-warning/depth32/copies2 reversed": "equal",
    "sharing-warning/depth32/copies4 forward": "neither-stops-differ",
    "sharing-warning/depth32/copies4 reversed": "one-mode-stop",
  });
  // (the #1703 report: forward, both sharing modes plan the same with the same checks, warnings 37/130, 38/162, 40/226)
  for (const r of rows) {
    const [shared, unshared] = r.rows.slice(0, 2).map((row) => row.core);
    assert.ok(shared !== undefined && unshared !== undefined);
    assert.deepEqual([shared.planHash, shared.checks], [unshared.planHash, unshared.checks]);
  }
  assert.deepEqual(
    rows.map((r) => r.rows.slice(0, 2).map((row) => row.core.diagnostics.length)),
    [
      [37, 130],
      [38, 162],
      [40, 226],
    ],
  );
});

test("the classes without a recorded witness, and what no class takes or two would", async () => {
  const C = await load();
  const at = (i: number, value: Record<string, unknown>) => (j: number) => (i === j ? value : {});
  const heap = (phase: string) => ({
    outcome: "failed",
    failure: "heap",
    phase,
    runsBeforeFailure: 0,
  });
  const cases: Array<[ReturnType<typeof record>, string]> = [
    [
      record("legacy-heap", at(2, { legacy: heap("analysis"), delta: undefined })),
      "failed/legacy-heap",
    ],
    [
      record("legacy-lowering", at(2, { legacy: heap("lowering"), delta: undefined })),
      "failed/other",
    ],
    [
      record(
        "core-units",
        at(1, { core: { outcome: "failed", failure: "units", phase: "analysis" } }),
      ),
      "failed/other",
    ],
    [
      record("thrown", at(0, { core: { outcome: "exception", name: "Error" }, delta: undefined })),
      "exception",
    ],
    [
      record(
        "legacy-thrown",
        at(1, {
          legacy: { outcome: "exception", name: "Error", message: "broken" },
          delta: undefined,
        }),
      ),
      "exception",
    ],
    [
      record("plan-only", at(3, { core: planned([], "q"), delta: { ...SAME, plan: true } })),
      "differs/plan",
    ],
  ];
  const result = C.classifyRecords(entries(cases.map(([r]) => r)));
  assert.deepEqual(result.problems, []);
  for (const [r, id] of cases) {
    const classes = result.perPair
      .filter((p: { key: string }) => p.key === r.key)
      .map((p: { class: string }) => p.class);
    assert.deepEqual(
      classes.filter((c: string) => c !== "agree"),
      [id],
      r.key,
    );
  }
  // (a legacy heap failure counts as legacy behaviour only with the core finished: the core's failure in the same
  // mode leaves it open)
  const both = record(
    "both-failed",
    at(2, { legacy: heap("analysis"), core: heap("analysis"), delta: undefined }),
  );
  assert.equal(C.classifyRecords(entries([both])).perPair[2].class, "failed/other");

  // (both sharing modes stop, the stop's text differs: the reversed depth-128 rows' TSV076 139/138)
  const stop = (message: string) => planned([diagnostic("TSV076", 0, message)], "s");
  const stopping = record("both-stop", (i) =>
    i === 2 ? { core: stop("139") } : i === 3 ? { core: stop("138") } : {},
  );
  assert.deepEqual(
    C.classifyRecords(entries([stopping])).perOrder.map((p: { class: string }) => p.class),
    ["equal", "both-stop-differ"],
  );

  // (faked: a changed code no rule names, a changed order without a changed identity, an exclusion text no version
  // lists; each fails the run as unclassified)
  const faked = [
    record(
      "unknown-code",
      at(0, {
        core: planned([diagnostic("TSV999", 4)]),
        delta: { ...SAME, diagnosticIdentity: true, diagnosticText: true },
      }),
    ),
    record(
      "order-only",
      at(0, {
        legacy: planned([diagnostic("TSV041", 1), diagnostic("TSV041", 2)]),
        core: planned([diagnostic("TSV041", 2), diagnostic("TSV041", 1)]),
        delta: { ...SAME, diagnosticIdentity: true, diagnosticText: true },
      }),
    ),
    record(
      "new-exclusion",
      at(0, { core: { outcome: "outside", outside: "this construct" }, delta: undefined }),
    ),
  ];
  const failed = C.classifyRecords(entries(faked));
  assert.deepEqual(
    failed.problems.map((p: { problem: string; key: string }) => [p.problem, p.key]),
    [
      ["unclassified", "unknown-code"],
      ["unclassified", "order-only"],
      ["unclassified", "new-exclusion"],
    ],
  );
  assert.equal(failed.verdict, "failed");
  // (two classes taking one pair would be ambiguous)
  assert.deepEqual(
    C.classify(
      [
        { id: "a", match: () => true },
        { id: "b", match: () => true },
      ],
      {},
    ),
    { error: "ambiguous", ids: ["a", "b"] },
  );

  // (input the classifier refuses: a record without its four modes, a key twice with different results, a record
  // outside the manifest)
  const fine = record("fine", () => ({}));
  const other = record("fine", at(0, { core: planned([], "q"), delta: { ...SAME, plan: true } }));
  const refused = C.classifyRecords(
    entries([{ key: "short", rows: fine.rows.slice(1) }, fine, other, record("stray", () => ({}))]),
    new Set(["fine", "short"]),
  );
  assert.deepEqual(
    refused.problems.map((p: { problem: string }) => p.problem),
    ["invalid", "conflicting duplicate", "outside the manifest"],
  );
  // (the same reading twice, whatever its timings, its rows' order or its members' order: counted once)
  const shuffled = {
    ...fine,
    index: 7,
    rows: [...fine.rows]
      .reverse()
      .map(({ mode, ...rest }) => ({
        ...rest,
        mode: { unshared: mode.unshared, reversed: mode.reversed },
      })),
  };
  const twice = C.classifyRecords(entries([fine, shuffled]));
  assert.deepEqual([twice.problems, twice.totals.duplicates, twice.perPair.length], [[], 1, 4]);
  // (two records of one key whose decision coverage differs conflict, in either order)
  const uncovered = record("fine", () => ({
    core: { ...planned(), decisionCounts: { ordinary: [], completion: [] } },
  }));
  for (const pair of [
    [fine, uncovered],
    [uncovered, fine],
  ])
    assert.deepEqual(
      C.classifyRecords(entries(pair)).problems.map((p: { problem: string }) => p.problem),
      ["conflicting duplicate"],
    );
  // (a compared row missing a delta component is refused, never read as equal)
  const partial = record("partial", at(0, { delta: { checks: false, plan: false } }));
  assert.deepEqual(
    C.classifyRecords(entries([partial])).problems.map((p: { why: string }) => p.why),
    ["a compared row without its four delta components"],
  );
  // (a completed run without its diagnostics or plan hash beside a failed one, and a plan delta without its paths,
  // are refused: every field a class, a signature or the duplicate check reads is checked first)
  const bare = { outcome: "plan", decisionCounts: { ordinary: [1], completion: [1] } };
  const unfinished = record("unfinished", () => ({
    legacy: { outcome: "failed", failure: "heap", phase: "analysis" },
    core: bare,
    delta: undefined,
  }));
  const pathless = record(
    "pathless",
    at(0, { delta: { ...SAME, plan: true }, planDelta: { diffs: [{ path: 3 }] } }),
  );
  assert.deepEqual(
    C.classifyRecords(entries([unfinished, pathless])).problems.map((p: { why: string }) => p.why),
    ["a completed core run without its diagnostics or plan hash", "a plan delta without its paths"],
  );
  // (two records of one reading, a check value's members and the plan paths in another order: one result, the same
  // signatures in either order)
  const checked = (value: unknown) => ({ ...planned(), checks: { runtimeChecks: [value] } });
  const variant = (members: Record<string, number>, paths: string[]) =>
    record(
      "variant",
      at(0, {
        core: checked(members),
        delta: { ...SAME, checks: true, plan: true },
        planDelta: { diffs: paths.map((path) => ({ path })) },
      }),
    );
  const first = variant({ a: 1, b: 2 }, ["/a", "/b"]);
  const second = variant({ b: 2, a: 1 }, ["/b", "/a"]);
  const inventory = (pair: unknown[]) => {
    const r = C.classifyRecords(entries(pair));
    return [
      r.problems,
      r.signatures.map((x: { signature: string; pairs: number }) => [x.signature, x.pairs]),
    ];
  };
  assert.deepEqual(inventory([first, second]), [
    [],
    [
      ["CHECKS runtimeChecks", 1],
      ["PLAN /a,/b", 1],
    ],
  ]);
  assert.deepEqual(inventory([second, first]), inventory([first, second]));
  // (the sharing column: one sharing mode outside its slice, the other planning)
  const mixed = record(
    "mixed",
    at(1, { core: { outcome: "outside", outside: "this assignment" }, delta: undefined }),
  );
  assert.deepEqual(
    C.classifyRecords(entries([mixed])).perOrder.map((p: { class: string }) => p.class),
    ["outside", "equal"],
  );
});

test("every pair of a generated grid over the pair rule's axes takes exactly one class or none, as the rules say", async () => {
  const C = await load();
  const known = ["TSV076", "TSV062", "TSV052", "TSV011", "TSV041", "TSV044", "TSV999"];
  const facts: Array<[Record<string, unknown>, string | null]> = [];
  for (let bits = 0; bits < 16; bits += 1) {
    const delta = {
      diagnosticIdentity: (bits & 1) > 0,
      diagnosticText: (bits & 2) > 0,
      checks: (bits & 4) > 0,
      plan: (bits & 8) > 0,
    };
    const sets = delta.diagnosticIdentity
      ? Array.from({ length: 1 << known.length }, (_, m) => known.filter((_, k) => (m >> k) & 1))
      : [[]];
    for (const codes of sets) {
      const changed = new Set(codes);
      // (the rule in words, independently of the tool's predicates)
      const expected = !Object.values(delta).some(Boolean)
        ? "agree"
        : !delta.diagnosticIdentity
          ? delta.checks
            ? "differs/checks"
            : delta.plan
              ? "differs/plan"
              : "differs/wording"
          : changed.has("TSV076")
            ? "differs/stop"
            : codes.some((c) => c === "TSV062" || c === "TSV052")
              ? "differs/surviving"
              : changed.has("TSV011")
                ? "differs/integer"
                : codes.length > 0 && codes.every((c) => c === "TSV041" || c === "TSV044")
                  ? "differs/rule"
                  : null;
      facts.push([
        {
          kind: "compared",
          delta,
          differs: Object.values(delta).some(Boolean),
          diag: delta.diagnosticIdentity,
          changed,
        },
        expected,
      ]);
    }
  }
  for (const text of [
    "this assignment",
    "the name 'x'",
    "the variable 'v', whose lists nest deeper than the slice follows",
    "this return statement",
    "a typed parse's or load's default that a stop left open",
  ])
    facts.push([{ kind: "outside", outside: text }, "excluded/"]);
  facts.push([{ kind: "outside", outside: "the name x" }, null]);
  facts.push([{ kind: "outside", outside: "this return statements" }, null]);
  for (const [f, id] of [
    [{ kind: "failed", legacyHeap: true }, "failed/legacy-heap"],
    [{ kind: "failed", legacyHeap: false }, "failed/other"],
    [{ kind: "exception" }, "exception"],
    [{ kind: "aborted" }, "aborted-record"],
    [{ kind: "unavailable" }, "unavailable"],
    [{ kind: "unknown" }, null],
  ] as const)
    facts.push([f, id]);
  let checked = 0;
  for (const [f, expected] of facts) {
    const got = C.classify(C.PAIR_CLASSES, f);
    assert.notEqual(
      got.error,
      "ambiguous",
      JSON.stringify(f, (_, value) => (value instanceof Set ? [...value] : value)),
    );
    if (expected === null) assert.equal(got.error, "unclassified");
    else if (expected === "excluded/")
      assert.ok(got.id?.startsWith("excluded/"), String(f.outside));
    else assert.equal(got.id, expected);
    checked += 1;
  }
  assert.equal(checked, 8 + 128 * 8 + 7 + 6);
});

test("the command: the verdict line, the gate's exit, the files it writes", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "shadow-classify-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const write = (name: string, lines: unknown[]) => {
    writeFileSync(join(folder, name), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    return join(folder, name);
  };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
  const fine = write("fine.jsonl", [record("fine", () => ({}))]);
  const manifest = write("expect.jsonl", [{ key: "fine" }]);
  const green = run(fine, "--expect", manifest, "--gate", "--out", join(folder, "out"));
  assert.equal(green.status, 0, green.stderr);
  assert.match(green.stdout, /^gate: green$/m);
  assert.match(
    readFileSync(join(folder, "out", "gate.md"), "utf8"),
    /^# Shadow gate \(taxonomy v5\): green/,
  );
  // (a source the manifest owes without a record: open; the gate's run exits 1, the plain run 0)
  const owed = write("owed.jsonl", [{ key: "fine" }, { key: "missing" }]);
  assert.equal(run(fine, "--expect", owed).status, 0);
  const open = run(fine, "--expect", owed, "--gate");
  assert.equal(open.status, 1);
  assert.match(open.stdout, /^gate: open \(open: unavailable, sharing uncompared\)$/m);
  assert.equal(run(fine, "--gate").status, 2);
  const unclassified = write("new.jsonl", [
    record("new", () => ({
      core: { outcome: "outside", outside: "this construct" },
      delta: undefined,
    })),
  ]);
  const failed = run(unclassified);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^gate: failed/m);
  assert.match(failed.stderr, /"problem":"unclassified"/);
  writeFileSync(join(folder, "broken.jsonl"), "{\n");
  assert.equal(run(join(folder, "broken.jsonl")).status, 1);
  // (a manifest line without its key, and a record without its delta's identity and text, fail the plain run too)
  const keyless = write("keyless.jsonl", [{ key: "fine" }, {}]);
  const noKey = run(fine, "--expect", keyless);
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /a manifest line without its key/);
  const half = write("half.jsonl", [
    record("half", () => ({
      core: planned([diagnostic("TSV999", 4)]),
      delta: { checks: false, plan: false },
    })),
  ]);
  const refused = run(half);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /^gate: failed/m);
  // (a name that is no text is refused before any report is written)
  const named = write("named.jsonl", [
    { ...record("named", () => ({})), name: { toString: "bad" } },
  ]);
  const badName = run(named, "--out", join(folder, "named"));
  assert.equal(badName.status, 1, badName.stderr);
  assert.match(badName.stdout, /^gate: failed/m);
  assert.match(badName.stderr, /a name that is no text/);
});

test("the control's runs that left the slice are counted by exclusion rule, from the table itself, zeros included", async () => {
  const C = await load();
  // (one run at an exact text, one at a template's, one at a text no rule names; the fourth mode plans)
  const texts = ["this function declaration", "the name 'f'", "a text no rule names", null];
  const outside = {
    demand: 16,
    rows: control(16).rows.map((row, i) =>
      texts[i] === null
        ? row
        : {
            mode: row.mode,
            core: {
              outcome: "outside",
              outside: texts[i],
              decisionCounts: { ordinary: [], completion: [] },
            },
          },
    ),
  };
  const result = C.classifyRecords(
    entries([{ ...record("left", () => ({})), demands: [outside, control(64)] }]),
  );
  const table: { rule: string; text?: string; runs: number; witnesses: { key: string }[] }[] =
    result.coverage.controlOutside;
  // (every class that names a text, declined/lost check and the exclusions, has its row, in their order, zeros included)
  const classes: { id: string }[] = C.PAIR_CLASSES;
  const rules = classes
    .map((c) => c.id)
    .filter((id) => id.startsWith("excluded/") || id === "declined/lost check");
  assert.deepEqual(
    table.filter((r) => r.rule !== "unlisted").map((r) => r.rule),
    rules,
  );
  const runs = (rule: string) => table.find((r) => r.rule === rule)?.runs;
  assert.equal(runs("excluded/this function declaration"), 1);
  // (a template's text: its one row, `excluded/<words>`)
  assert.deepEqual(
    table.filter((r) => r.rule !== "unlisted" && r.runs > 0).map((r) => [r.rule, r.runs]),
    [
      ["excluded/this function declaration", 1],
      ["excluded/the name '<a name the slice does not declare>'", 1],
    ],
  );
  assert.equal(rules.filter((rule) => runs(rule) === 0).length, rules.length - 2);
  // (a text no rule names: its own row, counted and witnessed; information only, the gate's state does not move)
  assert.deepEqual(
    table.filter((r) => r.rule === "unlisted").map((r) => [r.text, r.runs, r.witnesses[0]?.key]),
    [["a text no rule names", 1, "left"]],
  );
  const plain = C.classifyRecords(
    entries([{ ...record("left", () => ({})), demands: [control(16), control(64)] }]),
  );
  assert.deepEqual(
    [result.coverage.state, result.verdict, result.open],
    [plain.coverage.state, plain.verdict, plain.open],
  );
  const quiet: { runs: number }[] = plain.coverage.controlOutside;
  assert.ok(quiet.every((r) => r.runs === 0));
  // (published: gate.json's coverage holds the table, gate.md the unlisted line under the coverage line and a row a rule)
  const folder = mkdtempSync(join(tmpdir(), "shadow-control-"));
  try {
    const left = { ...record("left", () => ({})), demands: [outside, control(64)] };
    writeFileSync(join(folder, "left.jsonl"), `${JSON.stringify(left)}\n`);
    const ran = spawnSync(
      process.execPath,
      [tool, join(folder, "left.jsonl"), "--groups", "none", "--out", join(folder, "out")],
      { encoding: "utf8" },
    );
    assert.equal(ran.status, 0, ran.stderr);
    const json = JSON.parse(readFileSync(join(folder, "out", "gate.json"), "utf8"));
    assert.equal(json.coverage.controlOutside.length, rules.length + 1);
    const md = readFileSync(join(folder, "out", "gate.md"), "utf8").split("\n");
    const at = md.findIndex((l) => l.startsWith("Coverage ("));
    assert.equal(md[at + 1], "Unlisted control texts: 1.");
    for (const row of [
      "| excluded/this function declaration | 1 | left left (source order, sharing on) |",
      "| unlisted: a text no rule names | 1 | left left (reversed, sharing on) |",
    ])
      assert.ok(md.includes(row), `${row}\n${md.filter((l) => l.includes("| 1 |")).join("\n")}`);
    // (the control's table only: the pair table above it lists accepted classes at 0 pairs too)
    const controlTable = md.slice(
      md.findIndex((l) => l.startsWith("| Left the slice at the demand control")),
    );
    assert.equal(
      controlTable.filter((l) => /^\| (excluded\/|declined\/)/.test(l) && l.endsWith(" | 0 |  |"))
        .length,
      rules.length - 2,
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("coverage: the natural runs' ordinary decisions and a receiving completion at the demand control (16)", async () => {
  const C = await load();
  const coverage = (demands: unknown[]) =>
    C.classifyRecords(entries([{ ...record("covered", () => ({})), demands }])).coverage;
  assert.deepEqual(
    [coverage([control(16)]).state, coverage([control(16)]).controlCompletionRuns],
    ["pass", 4],
  );
  // (without the control, at another allowance, or with no completion there: open, whatever the natural runs hold)
  for (const demands of [[], [control(64)], [control(16, [])]])
    assert.equal(coverage(demands).state, "open", JSON.stringify(demands));
  // (a failed control run is counted)
  const failed = {
    demand: 16,
    rows: control(16).rows.map((row, i) =>
      i === 1 ? { mode: row.mode, core: { outcome: "failed", failure: "heap" } } : row,
    ),
  };
  assert.deepEqual([coverage([failed]).state, coverage([failed]).controlFailedRuns], ["pass", 1]);
  // (a negative count is no decision count, natural or at the control)
  const negative = (counts: number[]) => ({
    ...planned(),
    decisionCounts: { ordinary: counts, completion: counts },
  });
  assert.deepEqual(
    C.classifyRecords(
      entries([
        record("negative-natural", () => ({ core: negative([-1]) })),
        { ...record("negative-control", () => ({})), demands: [control(16, [-1])] },
      ]),
    ).problems.map((p: { why: string }) => p.why),
    [
      "core decision counts that are no list of counts",
      "demand decision counts that are no list of counts",
    ],
  );
  // (a control row the classifier cannot read is refused)
  const short = { demand: 16, rows: control(16).rows.slice(1) };
  assert.deepEqual(
    C.classifyRecords(entries([{ ...record("short", () => ({})), demands: [short] }])).problems.map(
      (p: { why: string }) => p.why,
    ),
    ["a demand run not in four modes"],
  );
});

test("taxonomy v2's return-statement rule takes its text and no other (#1744)", async () => {
  const C = await load();
  const exclusion = (key: string, text: string) =>
    record(key, (i) =>
      i === 0 ? { core: { outcome: "outside", outside: text }, delta: undefined } : {},
    );
  const result = C.classifyRecords(
    entries([
      exclusion("return", "this return statement"),
      exclusion("near", "this return statements"),
    ]),
  );
  assert.deepEqual(
    result.perPair
      .filter((p: { mode: string }) => p.mode === "source order, sharing on")
      .map((p: { class: string }) => p.class),
    ["excluded/this return statement"],
  );
  assert.deepEqual(
    result.problems.map((p: { problem: string; key: string }) => [p.problem, p.key]),
    [["unclassified", "near"]],
  );
});

test("the group table: its bindings decide a grouped pair's state, by key, mode and guard, never by its signature (v3)", async () => {
  const C = await load();
  // (the tree's table: Sol's preparation of gate run 2, 94 leaf groups, 50,548 bindings; every open group names what
  // closes it)
  const tree = C.loadGroups(resolve("tests/families/shadow-groups"));
  const states = [...tree.groups.values()].map((g: { state: string }) => g.state);
  assert.deepEqual(
    ["conforms", "defect", "pending"].map((s) => states.filter((x: string) => x === s).length),
    [81, 10, 3],
  );
  assert.equal(tree.bindings.size, 50548);
  for (const g of tree.groups.values())
    if (g.state !== "conforms") assert.ok(typeof g.closes === "string" && g.closes !== "", g.id);
  // (a crafted table: two pairs of one signature bound to two groups, a defect and a pending group)
  // (a pair differing in every mode by one TSV041 identity: one signature)
  const differing = (key: string) =>
    record(key, () => ({
      core: planned([diagnostic("TSV041", 7)]),
      delta: { ...SAME, diagnosticIdentity: true, diagnosticText: true },
    }));
  const a = differing("a");
  const b = differing("b");
  const d = differing("d");
  const p = differing("p");
  const changed = differing("changed");
  const unbound = differing("unbound");
  const guard = (r: ReturnType<typeof record>) =>
    C.pairGuard(C.readRecord(r).reading.rows[0]).slice(0, 16);
  const folder = mkdtempSync(join(tmpdir(), "shadow-groups-"));
  const table = (bindings: string[]) => {
    writeFileSync(
      join(folder, "groups.json"),
      JSON.stringify({
        groups: [
          { id: "G1", state: "conforms", title: "one" },
          { id: "G2", state: "conforms", title: "two" },
          { id: "D", state: "defect", title: "a defect", closes: "#1" },
          { id: "P", state: "pending", title: "a construction", closes: "#2" },
        ],
      }),
    );
    writeFileSync(join(folder, "bindings.jsonl.gz"), gzipSync(`${bindings.join("\n")}\n`));
    return C.loadGroups(folder);
  };
  const line = (r: ReturnType<typeof record>, group: string, g = guard(r), cls = "differs/rule") =>
    `${r.key.slice(0, 16)} 0 ${group} ${g} ${cls}`;
  try {
    const groups = table([
      line(a, "G1"),
      line(b, "G2"),
      line(d, "D"),
      line(p, "P"),
      line(changed, "G1", "0000000000000000"),
    ]);
    const result = C.classifyRecords(entries([a, b, d, p, changed, unbound]), null, groups);
    assert.deepEqual(result.problems, []);
    const first = (key: string) =>
      result.perPair.find(
        (x: { key: string; mode: string }) =>
          x.key === key && x.mode === "source order, sharing on",
      );
    assert.deepEqual(
      [a, b, d, p, changed, unbound].map((r) => [first(r.key).group, first(r.key).groupState]),
      [
        ["G1", "conforms"],
        ["G2", "conforms"],
        ["D", "defect"],
        ["P", "pending"],
        ["G1", "changed"],
        [null, "unbound"],
      ],
    );
    // (a binding is its mode's: the same source in another mode is unbound)
    assert.equal(
      result.perPair.find(
        (x: { key: string; mode: string }) =>
          x.key === "a" && x.mode === "source order, sharing off",
      ).groupState,
      "unbound",
    );
    // (one signature, two groups: each pair its own binding's)
    assert.equal(
      new Set(
        result.signatures
          .filter((x: { pairs: number }) => x.pairs >= 2)
          .map((x: { signature: string }) => x.signature),
      ).size,
      1,
    );
    // (the open groups, each with what closes it; the conforming ones attributed)
    assert.deepEqual(
      result.open.filter((o: string) => o.startsWith("group ")),
      [
        "group D (defect: #1)",
        "group P (pending: #2)",
        "group changed (changed: re-adjudication: a new table version)",
        "group unbound (unbound: re-adjudication: a new table version)",
      ],
    );
    // (a binding of another class than the pair's is changed too)
    const recast = C.classifyRecords(
      entries([a]),
      null,
      table([line(a, "G1", guard(a), "differs/checks")]),
    );
    assert.equal(recast.perPair[0].groupState, "changed");
    // (an open group must name what closes it)
    writeFileSync(
      join(folder, "groups.json"),
      JSON.stringify({ groups: [{ id: "C", state: "defect", title: "no issue" }] }),
    );
    assert.throws(() => C.loadGroups(folder), /names nothing that closes it/);
    // (a malformed table is refused: a pair bound twice, a binding to no group)
    assert.throws(() => table([line(a, "G1"), line(a, "G2")]), /bound twice/);
    assert.throws(() => table([line(a, "G9")]), /bound to no group/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("importing shadow-bind.mjs does nothing, and shadow-groups/ holds no module, as the runner's areas are folders with one", async () => {
  // (#1771's writer in shadow-groups/ made it an area, whose import read its absent arguments: the baseline seed failed)
  const groups = resolve("tests/families/shadow-groups");
  const before = readdirSync(groups).sort();
  const bind: object = await import(pathToFileURL(resolve("tests/families/shadow-bind.mjs")).href);
  assert.deepEqual(Object.keys(bind), []);
  // (imported by a script that is no file: Node's stdin entry, `-`)
  const piped = spawnSync(process.execPath, ["--input-type=module", "-"], {
    input: `await import(${JSON.stringify(pathToFileURL(resolve("tests/families/shadow-bind.mjs")).href)});`,
    encoding: "utf8",
  });
  assert.deepEqual([piped.status, piped.stdout, piped.stderr], [0, "", ""]);
  assert.deepEqual(readdirSync(groups).sort(), before);
  assert.deepEqual(
    before.filter((name) => name.endsWith(".mjs")),
    [],
  );
});

test("shadow-bind.mjs joins an adjudication with its run, refusing a pair adjudicated twice or recorded twice with other readings, in either order", () => {
  const folder = mkdtempSync(join(tmpdir(), "shadow-bind-"));
  try {
    const differing = (message: string) =>
      record("k1", () => ({
        core: planned([diagnostic("TSV041", 7, message)]),
        delta: { ...SAME, diagnosticIdentity: true, diagnosticText: true },
      }));
    const canon = (x: unknown): string =>
      JSON.stringify(x, (_, v) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
          : v,
      );
    const rawGuard = (r: ReturnType<typeof record>, i: number) =>
      createHash("sha256")
        .update(
          canon(
            Object.fromEntries(
              (["legacy", "core"] as const).map((x) => [
                x,
                Object.fromEntries(
                  (["outcome", "diagnostics", "checks", "planHash"] as const).map((f) => [
                    f,
                    r.rows[i]![x][f] ?? null,
                  ]),
                ),
              ]),
            ),
          ),
        )
        .digest("hex");
    const MODE_NAMES = [
      "source order, sharing on",
      "source order, sharing off",
      "reversed, sharing on",
      "reversed, sharing off",
    ];
    const write = (name: string, text: string) => {
      writeFileSync(join(folder, name), text);
      return join(folder, name);
    };
    const tableJson = write(
      "table.json",
      JSON.stringify({
        schema: "test",
        rows: [
          { id: "G", parent: null, leaf: true, verdict: "conforms", title: "one", witness: null },
          {
            id: "D",
            parent: null,
            leaf: true,
            verdict: "defect",
            title: "a defect",
            witness: null,
          },
        ],
      }),
    );
    const tableMd = write(
      "table.md",
      "| G one | 4 / 1 | attributed / conforms |\n| D a defect | 4 / 1 | open / defect / #1 |\n",
    );
    const good = differing("one text");
    const other = differing("another text");
    const adjudication = (r: ReturnType<typeof record>, groups: string[]) =>
      groups
        .map((group, n) =>
          JSON.stringify({
            key: r.key,
            mode: MODE_NAMES[n % 4],
            group,
            class: "differs/rule",
            publicationSHA256: rawGuard(r, n % 4),
          }),
        )
        .join("\n");
    const run = (bindings: string, records: unknown[]) => {
      const list = write(
        "records.txt",
        write("records.jsonl", records.map((r) => JSON.stringify(r)).join("\n")),
      );
      const out = mkdtempSync(join(folder, "out-"));
      return spawnSync(
        process.execPath,
        [
          resolve("tests/families/shadow-bind.mjs"),
          tableJson,
          tableMd,
          write("pairs.jsonl", bindings),
          list,
          out,
        ],
        { encoding: "utf8" },
      );
    };
    const four = adjudication(good, ["G", "G", "G", "G"]);
    assert.equal(run(four, [good]).status, 0, run(four, [good]).stderr);
    // (the same pair recorded again with another reading: refused, in either order)
    for (const records of [
      [good, other],
      [other, good],
    ])
      assert.notEqual(run(four, records).status, 0);
    // (a pair adjudicated twice, to two groups: refused)
    const twice = `${four}\n${adjudication(good, ["D"])}`;
    const refused = run(twice, [good]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /adjudicated twice/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("gate.md keeps a witness's | and line breaks inside their cell", async () => {
  const C = await load();
  const named = {
    ...record("odd", () => ({ core: planned([], "q"), delta: { ...SAME, plan: true } })),
    origins: [{ set: "x", name: "a | b\nc" }],
  };
  const folder = mkdtempSync(join(tmpdir(), "shadow-md-"));
  try {
    writeFileSync(join(folder, "odd.jsonl"), `${JSON.stringify(named)}\n`);
    const ran = spawnSync(
      process.execPath,
      [tool, join(folder, "odd.jsonl"), "--groups", "none", "--out", join(folder, "out")],
      { encoding: "utf8" },
    );
    assert.equal(ran.status, 0, ran.stderr);
    const row = readFileSync(join(folder, "out", "gate.md"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("| differs/plan "))!;
    assert.equal(row.split(/(?<!\\)\|/).length, 7, row);
    assert.ok(row.includes("a \\| b c"), row);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  void C;
});

test("taxonomy v5's declined/lost check: a decline by the lost-check gate is its class at the natural allowance and at the control, any other decline text a problem (#1781)", async () => {
  const C = await load();
  assert.equal(C.VERSION, 5);
  const texts = [
    "a store whose check was lost at the budget",
    "a store whose required checks could not be established at the budget",
  ];
  const at = (text: string | null) => ({
    outcome: "outside",
    outside: text,
    decisionCounts: { ordinary: [], completion: [] },
  });
  // (natural: the source-order modes declined, one text each, the reversed ones planned; the control declines them all)
  const declined = (key: string, natural: (string | null)[]) => ({
    ...record(key, (i) => (natural[i] ? { core: at(natural[i]), delta: undefined } : {})),
    demands: [
      { demand: 16, rows: MODES.map((mode, i) => ({ mode, core: at(texts[i % 2]!) })) },
      control(64),
    ],
  });
  const lost = declined("lost", [texts[0]!, texts[1]!, null, null]);
  const other = declined("other", [
    "a store whose check was dropped at the budget",
    null,
    null,
    null,
  ]);
  const result = C.classifyRecords(entries([lost, other]));
  assert.deepEqual(
    result.perPair
      .filter((p: { key: string }) => p.key === "lost")
      .map((p: { class: string }) => p.class),
    ["declined/lost check", "declined/lost check", "agree", "agree"],
  );
  assert.deepEqual(
    result.problems.map((p: { problem: string; key: string }) => [p.problem, p.key]),
    [["unclassified", "other"]],
  );
  // (its state is accepted: it never opens the gate)
  const row = result.pairs.find((r: { id: string }) => r.id === "declined/lost check");
  assert.deepEqual(
    [row.state, row.pairs, row.sources],
    ["accepted (condition 1; condition 2 list)", 2, 1],
  );
  assert.ok(!result.open.includes("declined/lost check"));
  // (the control: its row of the table, both records' runs, and no unlisted text)
  const table: { rule: string; runs: number }[] = result.coverage.controlOutside;
  assert.deepEqual(
    table.filter((r) => r.runs > 0).map((r) => [r.rule, r.runs]),
    [["declined/lost check", 8]],
  );
  // (published: gate.md states the version's change, the class's row and no unlisted text)
  const folder = mkdtempSync(join(tmpdir(), "shadow-declined-"));
  try {
    writeFileSync(join(folder, "lost.jsonl"), `${JSON.stringify(lost)}\n`);
    const ran = spawnSync(
      process.execPath,
      [tool, join(folder, "lost.jsonl"), "--groups", "none", "--out", join(folder, "out")],
      { encoding: "utf8" },
    );
    assert.equal(ran.status, 0, ran.stderr);
    const md = readFileSync(join(folder, "out", "gate.md"), "utf8").split("\n");
    assert.ok(md[0]!.startsWith("# Shadow gate (taxonomy v5): "), md[0]);
    assert.equal(md[2], `Taxonomy ${C.VERSION_CHANGE}.`);
    assert.ok(
      md.some((l) =>
        l.startsWith("| declined/lost check | accepted (condition 1; condition 2 list) | 2 | 1 | "),
      ),
    );
    assert.equal(
      md[md.findIndex((l) => l.startsWith("Coverage (")) + 1],
      "Unlisted control texts: 0.",
    );
    assert.ok(md.some((l) => l.startsWith("| declined/lost check | 4 | ")));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
