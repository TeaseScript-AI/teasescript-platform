import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const tool = resolve("tests/families/receiving.mjs");

interface Summary {
  readonly summary: true;
  readonly case: string;
  readonly class: string;
  readonly termsAgree: boolean;
}
interface Call {
  readonly call: true;
  readonly case: string;
  readonly mode: number;
  readonly levels: readonly {
    readonly rest: string;
    readonly w0: string;
    readonly alts: readonly string[];
  }[];
}

/** This tree's records for `cases` (each `[name, source]`): the exit status and the output's lines. */
function run(cases: readonly (readonly [string, string])[]): {
  status: number | null;
  lines: Record<string, unknown>[];
} {
  const dir = mkdtempSync(join(tmpdir(), "receiving-"));
  try {
    const file = join(dir, "cases.jsonl");
    const out = join(dir, "out.jsonl");
    writeFileSync(
      file,
      cases.map(([name, source]) => JSON.stringify({ name, source })).join("\n") + "\n",
    );
    const ran = spawnSync(process.execPath, [tool, resolve("."), file, "--out", out], {
      encoding: "utf8",
    });
    assert.equal(ran.stderr, "");
    const lines = readFileSync(out, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        // EVIDENCE: the tool writes each output line as one JSON object (its header's output contract).
        return JSON.parse(line) as Record<string, unknown>;
      });
    return { status: ran.status, lines };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The design round's witness (#1072, cyclic class, round 1): a typed call inside a literal whose destination a later
// written copy decides. The call's level is `b.element`, and `number` is a second fixed point there beside none.
const WITNESS =
  "let a: number[] = [0]\nlet b = [fromJson(hostValue, default: 0)]\nb = a\nsay b[0]\nexit\n";
// The same with an unrelated written binding, which put `number` among root-only candidates.
const CONTROL = `let witness: number = 0\n${WITNESS}`;
// A copy of a written binding decides the destination first: its A4 proof never reads the call.
const NEGATIVE =
  "let lives: integer = 3\nlet copy = lives\ncopy = fromJson(hostValue, default: 0)\nsay copy\nexit\n";

test("receiving.mjs finds the witness's second fixed point, unchanged by an unrelated written binding", () => {
  const { status, lines } = run([
    ["witness", WITNESS],
    ["control", CONTROL],
    ["negative", NEGATIVE],
  ]);
  assert.equal(status, 0);
  const summaries = lines.filter(
    (line): line is Summary & Record<string, unknown> => line["summary"] === true,
  );
  assert.deepEqual(
    summaries.map((s) => [s.case, s.class, s.termsAgree]),
    [
      ["witness", "L", true],
      ["control", "L", true],
      ["negative", "A", true],
    ],
  );
  const alternates = (name: string): string[][] =>
    lines
      .filter(
        (line): line is Call & Record<string, unknown> =>
          line["call"] === true && line["case"] === name,
      )
      .map((call) =>
        call.levels.flatMap((level) =>
          level.alts.map((alt) => `${level.rest}:${level.w0}->${alt}`),
        ),
      );
  // (in every mode, at the call's root level, whose destination is `b.element`: `number` and its optional form)
  assert.deepEqual(
    alternates("witness"),
    Array(4).fill([":none->number", ':none->{"kind":"union","members":[number,null]}']),
  );
  assert.deepEqual(alternates("control"), alternates("witness"));
  // (every evaluation is a line: the analysis's and each query's)
  const queries = new Set(lines.filter((line) => "ev" in line).map((line) => line["query"]));
  assert.ok(["analysis", "w0", "w1"].every((query) => queries.has(query)));
  assert.deepEqual(lines.at(-1), {
    totals: {
      cases: 3,
      unparsed: 0,
      threw: 0,
      calls: 3,
      modeDiffering: 0,
      A: 1,
      R: 0,
      "R+": 0,
      L: 2,
      I: 0,
    },
  });
});

// Two loads in one literal: with sharing on, one class's keys answer some of their levels, so the modes ask different
// levels; their terms are compared on the levels every mode asked.
const SHARED =
  "let i: integer = 1\nlet seed = [{f0: i, f1: i}]\nlet wide = seed\n" +
  'wide = [load("k", default: hostValue), load("k", default: hostValue)]\n' +
  "let first = wide[0]\nlet a0: integer = first.f0\nlet a1: integer = first.f1\nexit\n";

test("receiving.mjs compares the modes on the levels each asked", () => {
  const { status, lines } = run([["shared", SHARED]]);
  assert.equal(status, 0);
  const asked = new Set(
    lines
      .filter((line): line is Call & Record<string, unknown> => line["call"] === true)
      .map((call) => call.levels.map((level) => level.rest).join(",")),
  );
  assert.ok(
    asked.size > 1,
    "the modes ask the same levels: the case no longer shows the difference",
  );
  const summaries = lines.filter(
    (line): line is Summary & Record<string, unknown> => line["summary"] === true,
  );
  assert.ok(summaries.length > 0 && summaries.every((s) => s.termsAgree));
});

test("receiving.mjs refuses a case with a field it does not know, before any record", () => {
  const dir = mkdtempSync(join(tmpdir(), "receiving-"));
  try {
    const file = join(dir, "cases.jsonl");
    writeFileSync(file, JSON.stringify({ name: "x", source: "exit\n", runs: [] }) + "\n");
    const ran = spawnSync(
      process.execPath,
      [tool, resolve("."), file, "--out", join(dir, "out.jsonl")],
      { encoding: "utf8" },
    );
    assert.equal(ran.status, 2);
    assert.match(
      ran.stderr,
      /cases\.jsonl:1: a case is \{name, source \| files, globals\?\}, not runs/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
