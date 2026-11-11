import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/** A plan or diagnostics digest as the runner writes one (sha256's first 32 hex digits), here of `label`. */
const digest = (label: string) => createHash("sha256").update(label).digest("hex").slice(0, 32);

const tool = resolve("tests/families/plans.mjs");

test("the plans summary prints a recorded mode as recorded and says once what a number is (#2342)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const side = (units: number) => ({
    plan: digest("p"),
    diagnostics: digest("d"),
    checks: 0,
    error: null,
    trace: `1/${units}/00`,
    questions: "1/00",
    units,
  });
  const mode = (name: unknown) => ({ mode: name, base: side(3), head: side(2), same: false });
  const file = join(folder, "records.jsonl");
  writeFileSync(
    file,
    [
      { set: "s", name: "old", runs: 2, differing: 2, modes: [mode(2), mode(1)] },
      { set: "s", name: "new", runs: 1, differing: 1, modes: [mode("forward, unshared")] },
    ]
      .map((record) => `${JSON.stringify(record)}\n`)
      .join(""),
  );
  const ran = spawnSync(process.execPath, [tool, "summary", file], { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  const lines = ran.stdout.trim().split("\n").slice(1);
  assert.deepEqual(lines, [
    "mode <number>: a record from before #2342, the mode's index in HELD_MODES at the commit that wrote it",
    "s old mode 2: work 3 → 2",
    "s old mode 1: work 3 → 2",
    's new mode "forward, unshared": work 3 → 2',
  ]);
});

test("the plans summary names what differs in a demand row, gives it one class, and which tree's output the allowance stops (#2341)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const compile = (plan: string, diagnostics: string, more: Record<string, unknown> = {}) => ({
    plan: digest(plan),
    diagnostics: digest(diagnostics),
    checks: 1,
    error: null,
    trace: "1/5/00",
    questions: "1/00",
    units: 5,
    ...more,
  });
  // (in "reversed" the trees' unstopped compiles differ, so that a row read against the other tree's names the other
  // tree; in "forward, unshared" they agree, so that a row can differ in its questions or work alone)
  const apart = { base: compile("A", "d"), head: compile("B", "e") };
  const alike = { base: compile("P", "d"), head: compile("P", "d") };
  const modes = [
    {
      mode: "reversed",
      ...apart,
      same: false,
      demands: [
        // (the base's output at the allowance is the head's unstopped plan, not its own: the base's stop alone)
        {
          demand: 64,
          base: compile("B", "d", { questions: "2/00", trace: "1/4/00", units: 4 }),
          head: compile("B", "e", { questions: "3/00", trace: "1/6/00", units: 6 }),
        },
        {
          demand: 16,
          base: compile("X", "d", { trace: "1/4/00", units: 4 }),
          head: compile("Y", "e", { trace: "1/3/00", units: 3 }),
        },
      ],
    },
    {
      mode: "forward, unshared",
      ...alike,
      same: true,
      demands: [
        {
          demand: 32,
          base: compile("P", "d", { questions: "2/00" }),
          head: compile("P", "d", { questions: "3/00" }),
        },
        {
          demand: 8,
          base: compile("P", "d", { trace: "1/4/00", units: 4 }),
          head: compile("P", "d", { trace: "1/3/00", units: 3 }),
        },
      ],
    },
  ];
  const file = join(folder, "records.jsonl");
  writeFileSync(file, `${JSON.stringify({ set: "s", name: "n", runs: 6, differing: 5, modes })}\n`);
  const ran = spawnSync(process.execPath, [tool, "summary", file], { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  const [countsLine, ...lines] = ran.stdout.trim().split("\n");
  const counts = JSON.parse(countsLine!);
  assert.deepEqual(
    ["demand", "demandPublication", "demandQuestions", "demandWork"].map((key) => counts[key]),
    [4, 2, 1, 1],
  );
  assert.deepEqual(
    ["Base", "Head", "Both", "Neither"].map((who) => counts[`demandStops${who}`]),
    [1, 0, 1, 2],
  );
  const own = "(against its own unstopped compile, base:";
  const checks = "checks 1/1 → 1/1 (unstopped/at the allowance)";
  assert.deepEqual(lines.slice(1), [
    `s n mode "reversed": at demand allowance 64 apart (publication): diagnostics, questions, work; stops base ` +
      `${own} plan, questions, work, head: questions, work); ${checks}, units 4 → 6`,
    `s n mode "reversed": at demand allowance 16 apart (publication): plan, diagnostics, work; stops both ` +
      `${own} plan, work, head: plan, work); ${checks}, units 4 → 3`,
    `s n mode "forward, unshared": at demand allowance 32 apart (questions): questions; stops neither ` +
      `${own} questions, head: questions); ${checks}, units 5 → 5`,
    `s n mode "forward, unshared": at demand allowance 8 apart (work): work; stops neither ` +
      `${own} work, head: work); ${checks}, units 4 → 3`,
  ]);
});

test("the plans summary refuses, naming file, line and fault, any line that is not a record the runner writes (#2341)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const compile = (more: Record<string, unknown> = {}) => ({
    plan: digest("p"),
    diagnostics: digest("d"),
    checks: 0,
    error: null,
    trace: "1/5/811c9dc5c2b2ae3d",
    questions: "1/a0",
    units: 5,
    ...more,
  });
  const valid = () => ({
    set: "s",
    name: "n",
    key: "c".repeat(64),
    runs: 2,
    differing: 1,
    modes: [
      {
        mode: "reversed",
        base: compile(),
        head: compile(),
        same: true,
        demands: [{ demand: 16, base: compile(), head: compile({ trace: "1/4/a0", units: 4 }) }],
      },
    ],
  });
  const stopList = (stops: [string, number][]) =>
    stops.map(([phase, allowance]) => ({ allowance, phase }));
  const apartStops = {
    count: 2,
    sameSet: false,
    differ: [],
    base: stopList([
      ["walk", 1],
      ["walk", 2],
    ]),
    head: stopList([
      ["walk", 2],
      ["walk", 3],
    ]),
  };
  const withStops = (r: ReturnType<typeof valid>, stops: Record<string, unknown>) => ({
    ...r,
    modes: [{ ...r.modes[0], stops }],
  });
  // (each row one fault, which only its own clause refuses; a row whose fault is null passes: the valid records first,
  // one with apart stops)
  const rows: (readonly [
    string,
    (r: ReturnType<typeof valid>) => object | string,
    RegExp | null,
  ])[] = [
    ["a valid record", (r) => r, null],
    ["a valid record with apart stops", (r) => withStops(r, apartStops), null],
    ["not JSON", () => "{not json", /no JSON/],
    ["a key that is no hash", (r) => ({ ...r, key: "k" }), /no sha256/],
    ["an unknown field", (r) => ({ ...r, extra: 1 }), /no source record/],
    ["runs as text", (r) => ({ ...r, runs: "2" }), /runs or differing/],
    ["no modes", (r) => ({ ...r, modes: [] }), /no modes/],
    ["a mode twice", (r) => ({ ...r, modes: [r.modes[0], r.modes[0]] }), /a mode twice/],
    [
      "a mode index past 3",
      (r) => ({ ...r, modes: [{ ...r.modes[0], mode: 4 }] }),
      /neither by a name/,
    ],
    [
      "questions false",
      (r) => ({ ...r, modes: [{ ...r.modes[0], base: compile({ questions: false }) }] }),
      /questions not n\/hash/,
    ],
    [
      "trace null",
      (r) => ({ ...r, modes: [{ ...r.modes[0], head: compile({ trace: null }) }] }),
      /trace not n\/units\/hash/,
    ],
    [
      "a part missing",
      (r) => ({ ...r, modes: [{ ...r.modes[0], head: { ...compile(), questions: undefined } }] }),
      /exactly its seven parts/,
    ],
    [
      "a plan neither a digest nor null",
      (r) => ({ ...r, modes: [{ ...r.modes[0], base: compile({ plan: 1 }) }] }),
      /neither a digest nor null/,
    ],
    // (each value format the runner writes, one malformed value a row: round 2's B1)
    ...(
      [
        ["a plan of no digest", { plan: "not-a-hash" }, /neither a digest nor null/],
        ["diagnostics of 33 digits", { diagnostics: "b".repeat(33) }, /neither a digest nor null/],
        ["a digest in capitals", { plan: "A".repeat(32) }, /neither a digest nor null/],
        ["an error that is no text", { error: 1 }, /error neither text nor null/],
        ["a trace hash of one word", { trace: "1/5/a" }, /trace not/],
        ["a trace hash of 17 digits", { trace: `1/5/${"a".repeat(17)}` }, /trace not/],
        ["a trace word with a leading zero", { trace: "1/5/00a" }, /trace not/],
        ["a trace count with a leading zero", { trace: "01/5/a0" }, /trace not/],
        ["a questions hash of one word", { questions: "1/a" }, /questions not/],
        ["a questions hash of 17 digits", { questions: `1/${"a".repeat(17)}` }, /questions not/],
        ["units apart from the trace's", { units: 6 }, /units not its trace's/],
      ] as const
    ).map(
      ([label, part, fault]) =>
        [
          label,
          (r: ReturnType<typeof valid>) => ({
            ...r,
            modes: [
              { ...r.modes[0], demands: [{ demand: 16, base: compile(), head: compile(part) }] },
            ],
          }),
          fault,
        ] as const,
    ),
    [
      "checks below zero",
      (r) => ({ ...r, modes: [{ ...r.modes[0], base: compile({ checks: -1 }) }] }),
      /checks or units/,
    ],
    [
      "same against the parts",
      (r) => ({ ...r, modes: [{ ...r.modes[0], same: false }] }),
      /same that is not/,
    ],
    [
      "a demand side null",
      (r) => ({
        ...r,
        modes: [{ ...r.modes[0], demands: [{ demand: 16, base: null, head: compile() }] }],
      }),
      /exactly its seven parts/,
    ],
    [
      "a demand kept though equal",
      (r) => ({
        ...r,
        modes: [{ ...r.modes[0], demands: [{ demand: 16, base: compile(), head: compile() }] }],
      }),
      /do not differ/,
    ],
    [
      "a demand as text",
      (r) => ({
        ...r,
        modes: [{ ...r.modes[0], demands: [{ ...r.modes[0]!.demands[0]!, demand: "16" }] }],
      }),
      /demand not one/,
    ],
    ["a stall with runs", (r) => ({ ...r, stalled: "units", run: null }), /also holds runs/],
    [
      "a stall's run of no tree",
      () => ({
        set: "s",
        name: "n",
        stalled: "units",
        run: { tree: "both", mode: "forward", at: "natural" },
      }),
      /run not one the runner names/,
    ],
    ...(
      [
        // (the runs a stall names, as every runner on main words them: null fault, the record passes)
        [{ at: "natural" }, null],
        [{ at: "demand 16" }, null],
        [{ at: "allowance 1027" }, null],
        [{ at: "analysis" }, null],
        [{ at: "stop search", analysis: 0 }, null],
        [{ at: "stop search, between", analysis: 3 }, null],
        [{ at: "somewhere" }, /run not one the runner names/],
        [{ at: "demand 016" }, /run not one the runner names/],
        [{ at: "natural", analysis: 1 }, /run not one the runner names/],
        [{ at: "stop search" }, /run not one the runner names/],
      ] as const
    ).map(
      ([run, fault]) =>
        [
          `a stall at ${JSON.stringify(run)}`,
          () => ({
            set: "s",
            name: "n",
            stalled: "units",
            run: { tree: "head", mode: "forward", ...run },
            work: 9,
            allowance: 2,
          }),
          fault,
        ] as const,
    ),
    [
      "a safety net reached",
      () => ({ set: "s", name: "n", uncharged: "safety net 1800 s", run: null }),
      null,
    ],
    [
      "a safety net worded otherwise",
      () => ({ set: "s", name: "n", uncharged: "timeout", run: null }),
      /does not word so/,
    ],
    // (#2340: the stops a held mode records, and the lists of both trees where its sets differ)
    [
      "stops unavailable without a reason",
      (r) => withStops(r, { unavailable: 1 }),
      /without its reason/,
    ],
    [
      "stops with an unknown field",
      (r) => withStops(r, { ...apartStops, extra: 1 }),
      /stops not one/,
    ],
    [
      "one tree's list alone",
      (r) => withStops(r, { ...apartStops, head: undefined }),
      /without the other's/,
    ],
    [
      "lists where the sets are the same",
      (r) => withStops(r, { ...apartStops, sameSet: true }),
      /the same on both trees/,
    ],
    [
      "a count not the base's",
      (r) => withStops(r, { ...apartStops, count: 9 }),
      /not the base's stops/,
    ],
    [
      "lists equal where the sets differ",
      (r) => withStops(r, { ...apartStops, head: apartStops.base }),
      /lists equal/,
    ],
    [
      "a stop with an extra field",
      (r) => withStops(r, { ...apartStops, head: [{ allowance: 1, phase: "walk", at: 0 }] }),
      /no \{allowance, phase\}/,
    ],
    [
      "an allowance as text",
      (r) => withStops(r, { ...apartStops, head: [{ allowance: "1", phase: "walk" }] }),
      /no \{allowance, phase\}/,
    ],
    [
      "a phase that is no text",
      (r) => withStops(r, { ...apartStops, head: [{ allowance: 1, phase: 2 }] }),
      /no \{allowance, phase\}/,
    ],
    ["a stop list that is no list", (r) => withStops(r, { ...apartStops, head: {} }), /no list/],
    [
      // (R19, R21: a tree's allowances and their order are its own, so any it may give passes)
      "stops at any allowance, in any order",
      (r) =>
        withStops(r, {
          ...apartStops,
          head: [
            { allowance: 0, phase: "walk" },
            { allowance: -1, phase: "walk" },
            { allowance: 0.5, phase: "read" },
            { allowance: null, phase: "walk" },
            { allowance: 0, phase: "walk" },
          ],
        }),
      null,
    ],
  ];
  for (const [at, [label, change, fault]] of rows.entries()) {
    const changed = change(valid());
    const file = join(folder, `row-${at}.jsonl`);
    writeFileSync(file, `${typeof changed === "string" ? changed : JSON.stringify(changed)}\n`);
    const ran = spawnSync(process.execPath, [tool, "summary", file], { encoding: "utf8" });
    if (fault === null) assert.equal(ran.status, 0, `${label}: ${ran.stderr}`);
    else {
      assert.equal(ran.status, 2, `${label}: ${ran.stdout}`);
      assert.match(ran.stderr, new RegExp(`row-${at}\\.jsonl:1: `), label);
      assert.match(ran.stderr, fault, label);
      assert.equal(ran.stdout, "", label);
    }
  }
});

test("the plans summary says which tree added, removed or moved each stop, by its phase, and an unrecorded list is unavailable (#2340)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const side = {
    plan: digest("p"),
    diagnostics: digest("d"),
    checks: 0,
    error: null,
    trace: "1/1/a0",
    questions: "1/b0",
    units: 1,
  };
  /** A stop list as `heldStops` gives it: each phase's allowances ascending, the phases from the highest down. */
  const stopsOf = (phases: [string, number, number][]) =>
    phases.flatMap(([phase, low, high]) =>
      Array.from({ length: high - low + 1 }, (_, i) => ({ allowance: low + i, phase })),
    );
  // (phase names in neither alphabetical nor allowance order; a phase the base alone has, one the head alone has, one
  // shifted by 43, as #2064's analysis units moved, a record from before #2340 without lists, and phase blocks in
  // another order alone; a malformed list is refused, in the summary's table of faults)
  const walk: [string, number, number] = ["walk", 5, 7];
  const publication: [string, number, number] = ["publication", 1121, 1125];
  const extraction: [string, number, number] = ["extraction", 300, 301];
  const entries: [string, Record<string, unknown>][] = [
    ["removed", { base: stopsOf([publication, walk]), head: stopsOf([publication]) }],
    ["added", { base: stopsOf([publication]), head: stopsOf([publication, extraction]) }],
    [
      "moved",
      { base: stopsOf([publication, walk]), head: stopsOf([["publication", 1164, 1168], walk]) },
    ],
    ["unrecorded", {}],
    ["reordered", { base: stopsOf([publication, walk]), head: stopsOf([walk, publication]) }],
    // (R19, R21: a phase's allowances in another order are no move; any allowance a tree gives is printed as it is)
    ["within a phase", { base: stopsOf([walk]), head: stopsOf([walk]).reverse() }],
    [
      "edges",
      {
        base: [0, null, 0.5].map((allowance) => ({ allowance, phase: "walk" })),
        head: [0, -1].map((allowance) => ({ allowance, phase: "walk" })),
      },
    ],
  ];
  const modes = entries.map(([mode, lists]) => ({
    mode,
    base: side,
    head: side,
    same: true,
    stops: {
      count: Array.isArray(lists.base) ? lists.base.length : 1,
      sameSet: false,
      differ: [],
      ...lists,
    },
  }));
  const failing = {
    mode: "failing",
    base: side,
    head: side,
    same: true,
    stops: { unavailable: "the base's unstopped compile failed: Error: no" },
  };
  const file = join(folder, "records.jsonl");
  const record = { set: "held", name: "c", runs: 6, differing: 5, modes: [...modes, failing] };
  writeFileSync(file, `${JSON.stringify(record)}\n`);
  const ran = spawnSync(process.execPath, [tool, "summary", file, "--list", "100"], {
    encoding: "utf8",
  });
  assert.equal(ran.status, 0, ran.stderr);
  const [countsLine, ...lines] = ran.stdout.trim().split("\n");
  const counts = JSON.parse(countsLine!);
  assert.deepEqual(
    ["stopSet", "stopsAdded", "stopsRemoved", "stopsMoved", "stopsUnavailable"].map(
      (key) => counts[key],
    ),
    [7, 1, 1, 2, 4],
  );
  const apart = (mode: string, count: number) =>
    `held c mode "${mode}": STOP SET apart (main ${count} stops)`;
  assert.deepEqual(lines, [
    apart("removed", 8),
    'held c mode "removed": stop phase "walk" removed: base 5..7 (3), head none (0)',
    apart("added", 5),
    'held c mode "added": stop phase "extraction" added: base none (0), head 300..301 (2)',
    apart("moved", 8),
    'held c mode "moved": stop phase "publication" moved: base 1121..1125 (5), head 1164..1168 (5)',
    apart("unrecorded", 1),
    'held c mode "unrecorded": which stops moved is unavailable (no stop lists recorded, a record from before #2340)',
    apart("reordered", 8),
    'held c mode "reordered": which stops moved is unavailable (the lists differ, no phase does)',
    apart("within a phase", 3),
    'held c mode "within a phase": which stops moved is unavailable (the lists differ, no phase does)',
    apart("edges", 3),
    'held c mode "edges": stop phase "walk" moved: base 0, 0.5, null (3), head -1..0 (2)',
    'held c mode "failing": stop set unavailable (the base\'s unstopped compile failed: Error: no)',
  ]);
});
