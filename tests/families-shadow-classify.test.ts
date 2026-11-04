import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});

test("every recorded witness falls in its class, each pair in exactly one", async () => {
  const C = await load();
  // (the research's campaign and shadow.mjs's run of #1704's configurations, classified apart: the research's records
  // of those keys are aborted ones, so together the two campaigns conflict)
  const research = witnesses.filter((r) => r.set === undefined);
  const rerun = witnesses.filter((r) => r.set !== undefined);
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
    ["differs/plan", "failed/legacy-heap", "failed/other", "exception"],
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
  ])
    facts.push([{ kind: "outside", outside: text }, "excluded/"]);
  facts.push([{ kind: "outside", outside: "the name x" }, null]);
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
  assert.equal(checked, 8 + 128 * 8 + 4 + 6);
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
    /^# Shadow gate \(taxonomy v1\): green/,
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
