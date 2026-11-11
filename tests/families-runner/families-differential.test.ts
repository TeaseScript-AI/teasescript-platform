import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { compileProject } from "../../src/compiler.js";
import { HELD_MODES } from "../helpers/type-core-held-host.js";
import { planCheckList, planChecks } from "../helpers/plan-checks.js";

const tool = resolve("tests/families/differential.mjs");

// A built tree's modules as the differential record loads them. Each answer names the mode it ran in (`MODE`, set by
// the stand-in modes' `run`) and is chosen by a word in the source: MODAL (the core's code is the mode's), OUTSIDE (the
// route refuses in mode 2), ERROR (the checker's error, no plan), THROW (the checker throws), UNPARSED (no core request).
const PLAN = `({ files: [{ path: "main.tease", startInstruction: 0, endInstruction: 1 }],
  instructions: [{ kind: "declareBinding", span: { so: 0, sl: 0, eo: 5 },
    typeCheck: { type: { kind: "integer" }, place: "'n'" } }] })`;
const diagnostic = (code: string, severity: string) =>
  `{ path: "main.tease", severity: "${severity}", code: ${code}, message: "says " + ${code},
  span: { start: { offset: 0, line: 0, column: 0 }, end: { offset: 3, line: 0, column: 3 } } }`;
const MODULES: Record<string, string> = {
  "src/compiler.js": `export const compileProject = (files) => {
  const source = files[0].source;
  if (source.includes("THROW")) throw new TypeError("the stand-in throws");
  const error = source.includes("ERROR");
  return { plan: error ? null : ${PLAN},
    diagnostics: error ? [${diagnostic('"TSV001"', "error")}] : [${diagnostic('"TSV052"', "warning")}] };
};
`,
  "src/type-inference/core/answers.js": `export const analyseCore = (request) => ({ request, mode: globalThis.MODE });\n`,
  "src/type-inference/core/check-result/check-result.js": `export const checkedResult = (answers) => ({
  outcome: "warning",
  diagnostics: [{ class: "warning", kind: "integer-use", site: { file: 0, start: 4, end: 5 },
    code: answers.request.files[0].source.includes("MODAL") ? "TSV00" + answers.mode : "TSV044" }],
  checks: [],
});
`,
  "src/type-inference/core/result.js": `export const coreRecord = (result, paths) => ({ runtimeChecks: [
  { kind: "kinds", target: "n", against: ["integer"], site: { file: paths[0], offset: 0, end: 3 } }] });
`,
  "src/type-inference/core/messages.js": `export const messageSource = (sources) => sources;
export const coreMessage = (d, sources) => d.code + " in " + sources.length;
`,
  "tests/helpers/type-core-analysis.js": `export const coreRequest = (files) => {
  if (files[0].source.includes("REQUEST")) throw new Error("request");
  return files[0].source.includes("UNPARSED") ? null : { files: files.map((f) => ({ path: f.path, source: f.source })) };
};
`,
  "tests/helpers/type-core-held-host.js": `export const HELD_MODES = ["first", "second", "third", "fourth"].map((name, index) => ({
  name,
  run: (make) => { globalThis.MODE = index; try { return make(); } finally { globalThis.MODE = undefined; } },
}));
`,
  "tests/helpers/type-core-oracles.js": `export const jsonText = (value) => JSON.stringify(value);
export const publishedRoute = (files) => {
  if (files[0].source.includes("OUTSIDE") && globalThis.MODE === 2)
    return { plan: "outside", text: JSON.stringify({ outside: "a construct" }) };
  const plan = ${PLAN};
  return { plan, text: JSON.stringify({ plan, diagnostics: [${diagnostic('"TSV0" + globalThis.MODE', "warning")}] }) };
};
`,
  "tests/helpers/type-core-route.js": `export const runGlobals = (plan, globals) =>
  globals.hostValue === 2.5
    ? { status: "failed", failure: "TSR058@0:5", said: [] }
    : { status: "halted", failure: null, said: [{ text: String(globals.hostValue), at: 6 }] };
`,
};

/** The JSON lines of `text`. */
function lines<T>(text: string): T[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        // EVIDENCE: invariant: `differential.mjs` writes one record of `Row`'s form a line, or a pair of them (`join`).
        JSON.parse(line) as T,
    );
}

function standIn(folder: string): string {
  const tree = join(folder, "tree");
  for (const [file, text] of Object.entries(MODULES)) {
    mkdirSync(join(tree, "dist", file, ".."), { recursive: true });
    writeFileSync(join(tree, "dist", file), text);
  }
  writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
  mkdirSync(join(tree, "tests", "families", "area"), { recursive: true });
  cpSync(resolve("tests/families/sources.mjs"), join(tree, "tests/families/sources.mjs"));
  writeFileSync(
    join(tree, "tests/families/area/cases.mjs"),
    `export const globals = ["g"];\nexport const cases = [["one", "from a set"]];\n`,
  );
  return tree;
}

/** A record as `differential.mjs` writes it (tests/families/README.md, "Differential records"), as far as read here. */
interface Entry {
  readonly mode: string;
  readonly diagnostics: readonly { readonly severity?: string; readonly code: string }[];
  readonly plan: { readonly hash: string; readonly checks: readonly unknown[] } | null;
  readonly runs?: readonly {
    readonly globals: unknown;
    readonly storage?: unknown;
    readonly status: string;
    readonly failure?: string | null;
    readonly said?: readonly { readonly text: string }[];
  }[];
  readonly outside?: string;
  readonly threw?: string;
}
interface Row {
  readonly name: string;
  readonly case: {
    readonly files: readonly { readonly source: string }[];
    readonly globals: readonly string[];
    readonly key?: string;
    readonly storage?: unknown;
  };
  readonly checker: Omit<Entry, "mode">;
  readonly core: {
    readonly unparsed?: true;
    readonly agree: boolean;
    readonly modes: readonly Entry[];
  };
  readonly candidate: { readonly agree: boolean; readonly modes: readonly Entry[] };
}

test("the differential record keeps every case's columns, its four modes, refusals and errors apart (#2298)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-differential-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const tree = standIn(folder);
  const run = (name: string, caseLines: string[], tree_ = tree) => {
    const cases = join(folder, `${name}.jsonl`);
    writeFileSync(cases, caseLines.map((line) => `${line}\n`).join(""));
    const out = join(folder, `${name}.records.jsonl`);
    const ran = spawnSync(process.execPath, [tool, tree_, cases, "--out", out], {
      encoding: "utf8",
    });
    const text = existsSync(out) ? readFileSync(out, "utf8") : null;
    const rows: Row[] = text === null ? [] : lines<Row>(text);
    return { ran, text, rows, cases, out };
  };
  const cases = [
    { name: "modal", source: "MODAL", runs: [{ hostValue: 2 }, { hostValue: 2.5 }] },
    { name: "outside", source: "OUTSIDE" },
    { name: "error", source: "ERROR", runs: [{ hostValue: 2 }] },
    { name: "unparsed", source: "UNPARSED" },
    { name: "request", source: "REQUEST" },
    { name: "set", set: "area", unit: "cases.mjs/one" },
    { name: "throws", source: "THROW" },
  ].map((c) => JSON.stringify(c));
  const all = run("all", cases);
  // (a case that throws is a record holding `threw`, never a dropped one, and fails the run)
  assert.equal(all.ran.status, 1, all.ran.stderr);
  assert.deepEqual(
    all.rows.map((r) => r.name),
    ["modal", "outside", "error", "unparsed", "request", "set", "throws"],
  );
  const named = (name: string): Row =>
    all.rows.find((r) => r.name === name) ?? assert.fail(`no record of ${name}`);
  const [modal, outside, error, unparsed, set, throws] = [
    named("modal"),
    named("outside"),
    named("error"),
    named("unparsed"),
    named("set"),
    named("throws"),
  ];

  // (every mode once, in order, by its name; their answers differ, so they disagree)
  assert.deepEqual(
    modal.core.modes.map((m) => [m.mode, m.diagnostics[0]?.code]),
    [
      ["first", "TSV000"],
      ["second", "TSV001"],
      ["third", "TSV002"],
      ["fourth", "TSV003"],
    ],
  );
  assert.equal(modal.core.agree, false);
  assert.deepEqual(modal.core.modes[0]!.diagnostics[0], {
    class: "warning",
    kind: "integer-use",
    code: "TSV000",
    path: "main.tease",
    line: 1,
    offset: 4,
    end: 5,
    text: "L",
    message: "TSV000 in 1",
  });
  assert.equal(outside.core.agree, true);
  assert.deepEqual(
    modal.candidate.modes.map((m) => m.diagnostics[0]?.code),
    ["TSV00", "TSV01", "TSV02", "TSV03"],
  );
  // (the plan's checks and hash, and each named run's end on each plan)
  assert.deepEqual(modal.checker.plan!.checks, [
    {
      field: "typeCheck",
      path: "main.tease",
      line: 1,
      offset: 0,
      end: 5,
      type: "integer",
      place: "'n'",
    },
  ]);
  assert.match(modal.checker.plan!.hash, /^[0-9a-f]{32}$/);
  assert.deepEqual(modal.checker.runs, [
    { globals: { hostValue: 2 }, status: "halted", failure: null, said: [{ text: "2", at: 6 }] },
    { globals: { hostValue: 2.5 }, status: "failed", failure: "TSR058@0:5", said: [] },
  ]);
  assert.deepEqual(modal.candidate.modes[3]!.runs, modal.checker.runs);

  // (a refusal is its text alone, never an empty list of diagnostics; the modes beside it keep theirs)
  assert.deepEqual(outside.candidate.modes[2], { mode: "third", outside: "a construct" });
  assert.equal(outside.candidate.agree, false);
  assert.equal(outside.candidate.modes[1]!.diagnostics.length, 1);

  // (the checker's error: no plan, the error kept, no run made)
  assert.equal(error.checker.plan, null);
  assert.deepEqual(
    error.checker.diagnostics.map((d) => [d.severity, d.code]),
    [["error", "TSV001"]],
  );
  assert.equal("runs" in error.checker, false);

  assert.deepEqual(unparsed.core, { unparsed: true });
  // (the core's request throwing is that case's core, and the cases after it are recorded)
  assert.deepEqual(named("request").core, { threw: "Error: request" });
  assert.deepEqual(set.case.globals, ["g"]);
  assert.equal(set.case.files[0]?.source, "from a set");
  assert.match(set.case.key ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(throws.checker, { threw: "TypeError: the stand-in throws" });

  // (the same tree and cases give the same bytes)
  assert.equal(run("again", cases).text, all.text);

  // (a refused cases file or tree writes no record)
  const refused = (name: string, caseLines: string[], why: RegExp, tree_ = tree) => {
    const r = run(name, caseLines, tree_);
    assert.equal(r.ran.status, 2, `${name}: ${r.ran.stderr}`);
    assert.match(r.ran.stderr, why);
    assert.equal(r.text, null, name);
  };
  refused("twice", [cases[0]!, cases[0]!], /twice\.jsonl:2: the name "modal" twice/);
  refused("malformed", [cases[0]!, "{"], /malformed\.jsonl:2: no JSON/);
  refused(
    "unknown",
    [JSON.stringify({ name: "x", source: "", global: [] })],
    /unknown keys global/,
  );
  refused("neither", [JSON.stringify({ name: "x" })], /exactly one of source, files and set/);
  refused(
    "storage alone",
    [JSON.stringify({ name: "x", source: "", storage: { k: 1 } })],
    /storage alone\.jsonl:1: storage is for runs/,
  );
  refused(
    "storage listed",
    [JSON.stringify({ name: "x", source: "", runs: [{}], storage: [{ key: "k", value: 1 }] })],
    /storage is an object of the stored values by key/,
  );
  refused(
    "no set",
    [JSON.stringify({ name: "x", set: "absent", unit: "u" })],
    /no set\.jsonl:1: cannot read the set absent/,
  );
  refused(
    "no unit",
    [JSON.stringify({ name: "x", set: "area", unit: "cases.mjs/none" })],
    /has no unit/,
  );
  refused("no tree", [cases[0]!], /has no src\/compiler\.js/, join(folder, "nowhere"));
  const missing = spawnSync(
    process.execPath,
    [tool, tree, join(folder, "none.jsonl"), "--out", join(folder, "x")],
    { encoding: "utf8" },
  );
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read the cases file/);

  // (join: every case once on each side, in the cases' order; else nothing written)
  const joinRun = (name: string, args: string[]) => {
    const out = join(folder, `${name}.joined.jsonl`);
    const ran = spawnSync(
      process.execPath,
      [tool, "join", "--cases", all.cases, ...args, "--out", out],
      { encoding: "utf8" },
    );
    return { ran, text: existsSync(out) ? readFileSync(out, "utf8") : null };
  };
  const reversed = join(folder, "reversed.jsonl");
  writeFileSync(reversed, `${all.text!.trim().split("\n").reverse().join("\n")}\n`);
  const one = joinRun("one", ["--base", reversed]);
  assert.equal(one.text, all.text);
  const short = join(folder, "short.jsonl");
  writeFileSync(short, all.text!.split("\n").slice(1).join("\n"));
  const dropped = joinRun("dropped", ["--base", all.out, "--head", short]);
  assert.equal(dropped.ran.status, 1);
  assert.match(dropped.ran.stderr, /head: "modal" missing/);
  assert.equal(dropped.text, null);
  const repeated = joinRun("repeated", ["--base", all.out, all.out]);
  assert.equal(repeated.ran.status, 1);
  assert.match(repeated.ran.stderr, /base: "modal" recorded twice/);
  // (a side given with no files has every case missing)
  const noHead = joinRun("no head", ["--base", all.out, "--head"]);
  assert.equal(noHead.ran.status, 1);
  assert.match(noHead.ran.stderr, /head: "modal" missing/);
  assert.equal(noHead.text, null);
  // (a line cut short, as by a run that ended while writing it, is no record)
  const cut = join(folder, "cut.jsonl");
  writeFileSync(cut, all.text!.slice(0, -2));
  const truncated = joinRun("truncated", ["--base", cut]);
  assert.equal(truncated.ran.status, 2);
  assert.match(truncated.ran.stderr, /cut\.jsonl:7: no whole record of differential\.mjs/);
  assert.equal(truncated.text, null);
});

/** A join of hand-written records (`join` reads each line's name and copies its bytes): its run and its output. */
function joinOf(
  folder: string,
  sides: Record<string, string[]>,
  out = join(folder, "joined.jsonl"),
  extra: string[] = [],
  names = ["a", "b", "c"],
) {
  const cases = join(folder, "cases.jsonl");
  writeFileSync(cases, names.map((name) => `${JSON.stringify({ name, source: "" })}\n`).join(""));
  const files = Object.entries(sides).flatMap(([side, rows]) => {
    const file = join(folder, `${side}.jsonl`);
    if (!existsSync(file)) writeFileSync(file, rows.map((row) => `${row}\n`).join(""));
    return [`--${side}`, file];
  });
  const ran = spawnSync(
    process.execPath,
    [tool, "join", "--cases", cases, ...files, "--out", out, ...extra],
    { encoding: "utf8" },
  );
  return { ran, text: existsSync(out) ? readFileSync(out, "utf8") : null };
}

test("join pairs each case with its own base and head records, whatever their order in each side (#2298)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-differential-pairs-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const row = (name: string, side: string) =>
    JSON.stringify({ name, side, payload: `${side} of ${name}` });
  // (each side's own content, in an order of its own and unlike the cases' a, b, c)
  const ran = joinOf(folder, {
    base: ["c", "a", "b"].map((name) => row(name, "base")),
    head: ["b", "c", "a"].map((name) => row(name, "head")),
  });
  assert.equal(ran.ran.status, 0, ran.ran.stderr);
  assert.deepEqual(
    lines<{ name: string; base: unknown; head: unknown }>(ran.text!),
    ["a", "b", "c"].map((name) => ({
      name,
      base: { name, side: "base", payload: `base of ${name}` },
      head: { name, side: "head", payload: `head of ${name}` },
    })),
  );
});

test("join refuses an output that is one of its inputs, by path or link, and leaves that input whole (#2298)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-differential-alias-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const rows = ["a", "b", "c"].map((name) => JSON.stringify({ name, payload: name }));
  const base = join(folder, "base.jsonl");
  const before = `${rows.join("\n")}\n`;
  writeFileSync(base, before);
  linkSync(base, join(folder, "hard.jsonl"));
  symlinkSync(base, join(folder, "soft.jsonl"));
  for (const alias of ["base.jsonl", "hard.jsonl", "soft.jsonl", "cases.jsonl"]) {
    const ran = joinOf(folder, { base: rows }, join(folder, alias));
    assert.equal(ran.ran.status, 2, `${alias}: ${ran.ran.stderr}`);
    assert.match(ran.ran.stderr, /the output .* is the input /);
    assert.equal(readFileSync(base, "utf8"), before, alias);
  }
  // (and a distinct output is written whole, nothing left beside it)
  const ran = joinOf(folder, { base: rows }, join(folder, "out.jsonl"));
  assert.equal(ran.ran.status, 0, ran.ran.stderr);
  assert.equal(ran.text, before);
  assert.deepEqual(
    readdirSync(folder).filter((file) => file.includes(".partial-")),
    [],
  );
});

test("join --ignore names the cases whose base and head differ with those fields removed at any depth (#2316)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-differential-ignore-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const record = (name: string, message: string, code = "TSV001", messageKind = "plain") =>
    JSON.stringify({
      name,
      message,
      core: { modes: [{ diagnostics: [{ code, message, messageKind }] }] },
    });
  // a: only `message` differs, at the top and nested, the keys after its name in another order; b: only
  // `messageKind`, a field whose name holds the ignored one; c: a nested `code` beside a differing `message`
  const base = [record("a", "old"), record("b", "same"), record("c", "old")];
  const head = [
    JSON.stringify({
      name: "a",
      core: {
        modes: [{ diagnostics: [{ messageKind: "plain", message: "new", code: "TSV001" }] }],
      },
      message: "new",
    }),
    record("b", "same", "TSV001", "framed"),
    record("c", "new", "TSV002"),
  ];
  const plain = joinOf(folder, { base, head }, join(folder, "plain.jsonl"));
  assert.equal(plain.ran.status, 0, plain.ran.stderr);
  assert.deepEqual(JSON.parse(plain.ran.stdout), { cases: 3, sides: 2 });
  const once = joinOf(folder, { base, head }, join(folder, "once.jsonl"), ["--ignore", "message"]);
  assert.deepEqual(JSON.parse(once.ran.stdout), {
    cases: 3,
    sides: 2,
    ignore: ["message"],
    differ: 2,
    differing: ["b", "c"],
    unread: [],
  });
  assert.equal(once.ran.status, 1, once.ran.stderr);
  // (the joined records are written as without --ignore)
  assert.equal(once.text, plain.text);
  const twice = joinOf(folder, { base, head }, join(folder, "twice.jsonl"), [
    "--ignore",
    "message",
    "--ignore",
    "messageKind",
  ]);
  assert.deepEqual(JSON.parse(twice.ran.stdout), {
    cases: 3,
    sides: 2,
    ignore: ["message", "messageKind"],
    differ: 1,
    differing: ["c"],
    unread: [],
  });
  assert.equal(twice.ran.status, 1, twice.ran.stderr);
  const all = joinOf(folder, { base, head }, join(folder, "all.jsonl"), [
    "--ignore",
    "message",
    "messageKind",
    "code",
  ]);
  assert.deepEqual(JSON.parse(all.ran.stdout), {
    cases: 3,
    sides: 2,
    ignore: ["message", "messageKind", "code"],
    differ: 0,
    differing: [],
    unread: [],
  });
  assert.equal(all.ran.status, 0, all.ran.stderr);
});

test("join --ignore reports a case one tree lacks, a record it cannot read, and an empty join (#2316)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-differential-ignore-edges-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const ignore = ["--ignore", "message"];
  const rows = ["a", "b", "c"].map((name) => JSON.stringify({ name, message: name }));
  // (a case in one tree only is reported, never skipped, and nothing is written)
  mkdirSync(join(folder, "one"));
  const one = joinOf(
    join(folder, "one"),
    { base: rows, head: rows.slice(0, 2) },
    undefined,
    ignore,
  );
  assert.equal(one.ran.status, 1, one.ran.stderr);
  assert.equal(one.ran.stderr, 'head: "c" missing\n');
  assert.equal(one.text, null);
  // (a record whose line names its case but is no JSON is named, never taken as equal)
  mkdirSync(join(folder, "unread"));
  const broken = joinOf(
    join(folder, "unread"),
    { base: rows, head: [rows[0]!, '{"name":"b",nope}', rows[2]!] },
    undefined,
    ignore,
  );
  assert.deepEqual(JSON.parse(broken.ran.stdout), {
    cases: 3,
    sides: 2,
    ignore: ["message"],
    differ: 0,
    differing: [],
    unread: ["b"],
  });
  assert.equal(broken.ran.status, 1, broken.ran.stderr);
  // (an empty join compares nothing and says so by its count)
  mkdirSync(join(folder, "empty"));
  const empty = joinOf(join(folder, "empty"), { base: [], head: [] }, undefined, ignore, []);
  assert.deepEqual(JSON.parse(empty.ran.stdout), {
    cases: 0,
    sides: 2,
    ignore: ["message"],
    differ: 0,
    differing: [],
    unread: [],
  });
  assert.equal(empty.ran.status, 0, empty.ran.stderr);
  assert.equal(empty.text, "");
  // (--ignore needs a field and a head)
  mkdirSync(join(folder, "refused"));
  const refusals: [Record<string, string[]>, string[]][] = [
    [{ base: rows, head: rows }, ["--ignore"]],
    [{ base: rows }, ignore],
  ];
  for (const [sides, extra] of refusals) {
    const ran = joinOf(join(folder, "refused"), sides, undefined, extra);
    assert.equal(ran.ran.status, 2, ran.ran.stderr);
    assert.equal(ran.text, null);
  }
});

test("the plan's check list lists each check planChecks counts, with its site and type (#2298)", () => {
  const span = (so: number, sl: number) => ({ so, sl, sc: 0, eo: so + 2, el: sl, ec: 2 });
  const type = { kind: "integer" };
  const plan = {
    files: [
      { path: "main.tease", startInstruction: 0, endInstruction: 2 },
      { path: "b.tease", startInstruction: 2, endInstruction: 3 },
    ],
    instructions: [
      {
        kind: "assign",
        span: span(10, 1),
        typeCheck: { type, place: "'a'" },
        requireExisting: true,
        partChecks: [
          { path: [{ property: "p" }, { element: true }], type, place: "'a.p'" },
          { path: [], type, place: "'a'" },
        ],
      },
      {
        kind: "expression",
        span: span(20, 2),
        value: {
          kind: "call",
          span: span(22, 2),
          indexCheck: true,
          expected: { kind: "list", element: null },
          repair: true,
        },
      },
      {
        kind: "storeTemporary",
        span: span(0, 0),
        fallbackCheck: { type, place: "'b'" },
        repair: type,
      },
    ],
    // (a value nested deeper than a recursive walk follows, holding one check)
    deep: Array.from({ length: 20_000 }).reduce<unknown>((inner) => [inner], {
      typeCheck: { type, place: "deep" },
    }),
  };
  // EVIDENCE: invariant: a stand-in of the plan's check fields; the list reads only those and the spans.
  const list = planCheckList(plan as never);
  assert.equal(list.length, planChecks(plan));
  assert.deepEqual(
    list.map((c) => [
      c.field,
      c.path,
      c.line,
      c.offset,
      c.type ?? null,
      c.place ?? null,
      c.part ?? null,
    ]),
    [
      ["typeCheck", null, null, null, "integer", "deep", null],
      ["fallbackCheck", "b.tease", 1, 0, "integer", "'b'", null],
      ["repair", "b.tease", 1, 0, "integer", null, null],
      ["partChecks", "main.tease", 2, 10, "integer", "'a'", ""],
      ["partChecks", "main.tease", 2, 10, "integer", "'a.p'", ".p[]"],
      ["requireExisting", "main.tease", 2, 10, null, null, null],
      ["typeCheck", "main.tease", 2, 10, "integer", "'a'", null],
      ["expected", "main.tease", 3, 22, "list<any>", null, null],
      ["indexCheck", "main.tease", 3, 22, null, null, null],
      ["repair", "main.tease", 3, 22, null, null, null],
    ],
  );
});

test("the differential record of the repository's own build: four modes, a plan's hash and checks, runs (#2298)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-differential-own-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const host = "let n: integer = hostValue\nsay n\nexit\n";
  const cases = join(folder, "cases.jsonl");
  writeFileSync(
    cases,
    [
      { name: "host", source: host, runs: [{ hostValue: 2 }, { hostValue: 2.5 }] },
      { name: "error", source: 'let i: integer = "s"\nexit\n', runs: [{ hostValue: 2 }] },
    ]
      .map((c) => `${JSON.stringify(c)}\n`)
      .join(""),
  );
  const out = join(folder, "records.jsonl");
  const ran = spawnSync(process.execPath, [tool, resolve("."), cases, "--out", out], {
    encoding: "utf8",
  });
  assert.equal(ran.status, 0, ran.stderr);
  const [hostRow, errorRow] = lines<Row>(readFileSync(out, "utf8"));
  assert.ok(hostRow !== undefined && errorRow !== undefined);
  const names = HELD_MODES.map((mode) => mode.name);
  for (const row of [hostRow, errorRow]) {
    assert.deepEqual(
      row.core.modes.map((m) => m.mode),
      names,
    );
    assert.deepEqual(
      row.candidate.modes.map((m) => m.mode),
      names,
    );
  }
  // (the checker's plan: the hash `plans.mjs` gives it, its checks, and the run on a fraction fails where 2 does not)
  const plan = compileProject([{ path: "main.tease", source: host }], {
    globals: ["hostValue"],
  }).plan!;
  assert.equal(
    hostRow.checker.plan!.hash,
    createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 32),
  );
  assert.deepEqual(hostRow.checker.plan!.checks, planCheckList(plan));
  assert.deepEqual(
    hostRow.checker.runs!.map((r) => r.status),
    ["halted", "failed"],
  );
  // (an error: no plan and no run, the error kept)
  assert.equal(errorRow.checker.plan, null);
  assert.equal("runs" in errorRow.checker, false);
  assert.ok(errorRow.checker.diagnostics.some((d) => d.severity === "error"));
  // (a case without storage records none)
  assert.equal("storage" in hostRow.case, false);
  assert.equal("storage" in hostRow.checker.runs![0]!, false);
});

test("a case's storage is what each run's load reads, on the checker and the core's route, and is recorded (#2338)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-differential-storage-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  // (a load whose value a repeat count reads: it takes the stored value, fails on one of another type, and without one
  // runs on its default)
  const source = 'let v = load("k", default: 0)\nsay v\nrepeat v {}\nexit\n';
  const runs = [{ hostValue: 0 }, { hostValue: 1 }];
  const cases = join(folder, "cases.jsonl");
  writeFileSync(
    cases,
    [
      { name: "stored", source, runs, storage: { k: 2 } },
      { name: "wrong", source, runs, storage: { k: "seven" } },
      { name: "none", source, runs },
    ]
      .map((c) => `${JSON.stringify(c)}\n`)
      .join(""),
  );
  const out = join(folder, "records.jsonl");
  const ran = spawnSync(process.execPath, [tool, resolve("."), cases, "--out", out], {
    encoding: "utf8",
  });
  assert.equal(ran.status, 0, ran.stderr);
  const rows = lines<Row>(readFileSync(out, "utf8"));
  const outcomes = (row: Row) =>
    [row.checker, ...row.candidate.modes].map((entry) =>
      entry.runs!.map((r) => [
        r.storage,
        r.status,
        r.said!.map((said) => said.text),
        r.failure !== null,
      ]),
    );
  // (each run of a case, two of them, on the checker and in each of the route's four modes)
  const expected = {
    stored: [{ k: 2 }, "halted", ["2"], false],
    wrong: [{ k: "seven" }, "failed", ["seven"], true],
    none: [undefined, "halted", ["0"], false],
  };
  assert.deepEqual(
    Object.fromEntries(rows.map((row) => [row.name, outcomes(row)])),
    Object.fromEntries(
      Object.entries(expected).map(([name, run]) => [name, Array(5).fill([run, run])]),
    ),
  );
  assert.deepEqual(
    rows.map((row) => row.case.storage),
    [{ k: 2 }, { k: "seven" }, undefined],
  );
});
