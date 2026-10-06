import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeDebugContext, type RuntimeDebugRecord } from "../src/index.js";
import {
  PLAYER_DEBUG_TRACE_PAGE,
  playerDebugLiveValue,
  playerDebugTraceRows,
  playerDebugVariables,
  type PlayerDebugTraceRow,
  type PlayerDebugTraceView,
} from "../player/debug-variables.js";
import {
  advancePlayerRuntimeTime,
  createPlayerRuntimeSession,
  submitPlayerRuntimeComposer,
  withPlayerRuntimeDebugTrace,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";

/*
 * Player Debug's Variables view (DEBUGGER.md "Player Debug") as the Player derives it from a session and its value trace:
 * live variables by where they live, and derivation rows that open level by level.
 */

function traced(source: string): { session: PlayerRuntimeSession; trace: RuntimeDebugContext } {
  const trace = new RuntimeDebugContext();
  const session = advancePlayerRuntimeTime(
    createPlayerRuntimeSession(source, { debugTrace: trace }),
    60_000,
  );
  return { session, trace };
}

/** The view the Variables tab starts with: roots open, values of messages shown, nothing else. */
const defaults = (open: ReadonlySet<string> = new Set()): PlayerDebugTraceView => ({
  expanded: (key: string, record: RuntimeDebugRecord, depth: number) =>
    open.has(key) || depth === 0 || record.kind === "interpolation",
  pages: () => 1,
});

const summary = (rows: readonly PlayerDebugTraceRow[]) =>
  rows.map((row) =>
    row.kind === "record" || row.kind === "reference"
      ? `${"  ".repeat(row.depth)}${row.kind === "reference" ? "↑ " : ""}${row.text.title}${
          row.text.value === null ? "" : ` ${row.text.value}`
        }${row.text.note === null ? "" : ` (${row.text.note})`}`
      : `${"  ".repeat(row.depth)}[${row.kind}]`,
  );

test("a message opens to its values and their immediate causes, and further levels on request", () => {
  const { session, trace } = traced(
    [
      "let low = 10",
      "let spanks = randomInteger(low..=30)",
      'say "You get ${spanks} spanks, ${spanks} in total"',
      "exit",
    ].join("\n"),
  );
  const [output] = trace.outputs();
  const live = playerDebugLiveValue(session.snapshot);
  const rows = playerDebugTraceRows(trace, [output!], defaults(), live);
  const said = session.events.find((event) => event.kind === "say")!;
  const spanks = /You get (\d+)/u.exec(said.kind === "say" ? said.text : "")![1]!;
  // Each value shown takes the place of its placeholder; the repeated one refers to its first row.
  assert.deepEqual(summary(rows), [
    `Message "You get ${spanks} spanks, ${spanks} in total"`,
    `  let spanks ${spanks}`,
    `  ↑ let spanks ${spanks}`,
  ]);
  const reference = rows.find((row) => row.kind === "reference")!;
  assert.equal(reference.kind === "reference" && reference.target, rows[1]!.key);
  assert.equal(rows[1]!.kind === "record" && rows[1]!.text.location, "main.tease:2");

  // Opening the variable shows the draw that chose it.
  const opened = playerDebugTraceRows(trace, [output!], defaults(new Set([rows[1]!.key])), live);
  assert.deepEqual(summary(opened).slice(1, 4), [
    `  let spanks ${spanks}`,
    "    let low 10",
    `    randomInteger(10..=30) ${spanks} (draw #1)`,
  ]);

  // A list shown as one element keeps its placeholder, which the selection draw explains.
  const { trace: picks } = traced('let tools = ["cane", "paddle"]\nsay "${tools}"\nexit');
  const [message] = picks.outputs();
  const shown = summary(playerDebugTraceRows(picks, [message!], defaults()));
  assert.equal(shown[1]!.startsWith("  Shown as "), true);
  assert.deepEqual(
    shown.slice(2).map((row) => row.trim().split(" ")[0]),
    ["let", "random"],
  );
});

test("an earlier version shows the variable's value now, and unknown origins say why", () => {
  const source = [
    "let count = 1",
    'say "${count}"',
    "count = 5",
    'let name = askText "Name?"',
    'say "${name} ${count}"',
    "exit",
  ].join("\n");
  const { session, trace } = traced(source);
  // The ask's question is a message too; this is the first message.
  const output = trace.outputs().find((id) => trace.record(id)?.preview === '"1"');
  const live = playerDebugLiveValue(session.snapshot);
  const rows = playerDebugTraceRows(trace, [output!], defaults(), live);
  const version = rows.find((row) => row.kind === "record" && row.text.title === "let count")!;
  assert.equal(version.kind === "record" && version.text.now, "5");

  // A trace turned on mid-session explains values from before it honestly.
  const late = new RuntimeDebugContext();
  const answered = submitPlayerRuntimeComposer(
    withPlayerRuntimeDebugTrace(
      advancePlayerRuntimeTime(createPlayerRuntimeSession(source), 60_000),
      late,
    ),
    "Bo",
  )!.session;
  const [message] = late.outputs();
  const unknown = playerDebugTraceRows(
    late,
    [message!],
    defaults(),
    playerDebugLiveValue(answered.snapshot),
  ).find((row) => row.kind === "record" && row.text.unknown);
  assert.deepEqual(
    unknown?.kind === "record" && [unknown.text.title, unknown.text.value, unknown.text.note],
    ["count", "5", "Not recorded before Debug"],
  );
});

test("expired causes, omitted causes, and long cause lists show as such", () => {
  const names = Array.from({ length: 40 }, (_, index) => `v${index}`);
  const { trace } = traced(
    [
      ...names.map((name, index) => `let ${name} = ${index}`),
      `let sum = ${names.join(" + ")}`,
      'say "${sum}"',
      "exit",
    ].join("\n"),
  );
  const [output] = trace.outputs();
  const rows = playerDebugTraceRows(trace, [output!], defaults());
  const sum = rows.find((row) => row.kind === "record" && row.text.title === "let sum")!;
  const opened = playerDebugTraceRows(trace, [output!], defaults(new Set([sum.key])));
  const kinds = opened.map((row) => row.kind);
  assert.equal(
    opened.filter((row) => row.kind === "record" && row.depth === 2).length,
    PLAYER_DEBUG_TRACE_PAGE,
  );
  assert.ok(kinds.includes("more"));
  // A second page shows the rest of the kept causes, then how many were not kept.
  const paged = playerDebugTraceRows(trace, [output!], {
    ...defaults(new Set([sum.key])),
    pages: (key) => (key === sum.key ? 2 : 1),
  });
  assert.equal(paged.filter((row) => row.kind === "record" && row.depth === 2).length, 32);
  assert.deepEqual(
    paged.filter((row) => row.kind === "omitted").map((row) => row.kind === "omitted" && row.count),
    [8],
  );

  // A small budget drops older records, which show as expired.
  const small = new RuntimeDebugContext({ maxRecords: 3 });
  advancePlayerRuntimeTime(
    createPlayerRuntimeSession('let a = 1\nlet b = a + 1\nlet c = b + 1\nsay "${c}"\nexit', {
      debugTrace: small,
    }),
    60_000,
  );
  const [last] = small.outputs();
  const chain = playerDebugTraceRows(small, [last!], { expanded: () => true, pages: () => 1 });
  assert.ok(chain.some((row) => row.kind === "expired"));
});

test("live variables group by globals, files, calls, and blocks, and filter by name", () => {
  const { session, trace } = traced(
    [
      'global title = "Coach"',
      "let rounds = 3",
      "function drill(times) {",
      "    let left = times",
      '    let reply = askText "Ready?"',
      "}",
      "drill(rounds)",
      "exit",
    ].join("\n"),
  );
  const groups = playerDebugVariables(session.plan, session.snapshot, trace);
  assert.deepEqual(
    groups.map((group) => [group.label, group.variables.map((variable) => variable.name)]),
    [
      ["Globals", ["title"]],
      ["main.tease", ["rounds"]],
      ["drill() in main.tease", ["times", "left"]],
    ],
  );
  for (const group of groups)
    for (const variable of group.variables) assert.notEqual(variable.record, null);
  assert.deepEqual(
    playerDebugVariables(session.plan, session.snapshot, trace, "LEF").map((group) =>
      group.variables.map((variable) => variable.name),
    ),
    [["left"]],
  );
  // Without a trace the values still show, with no record.
  const untraced = playerDebugVariables(session.plan, session.snapshot, null);
  assert.equal(untraced[0]!.variables[0]!.value, '"Coach"');
  assert.equal(untraced[0]!.variables[0]!.record, null);
});
