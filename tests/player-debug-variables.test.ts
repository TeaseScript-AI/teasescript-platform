import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeDebugContext, type RuntimeDebugRecord } from "../src/index.js";
import {
  PLAYER_DEBUG_TRACE_PAGE,
  playerDebugLiveValue,
  playerDebugMessageOrigin,
  playerDebugTraceRows,
  playerDebugVariables,
  type PlayerDebugTraceRow,
  type PlayerDebugTraceView,
} from "../player/debug-variables.js";
import {
  advancePlayerRuntimeTime,
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  playerRuntimeTranscriptEventSequence,
  playerRuntimeTranscriptMessage,
  restorePlayerRuntimeSession,
  submitPlayerRuntimeComposer,
  withPlayerRuntimeDebugTrace,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import { MESSAGE_TEXT_FUNCTIONS, messageSayPlan } from "./helpers/message-says.js";

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
  expanded: (key: string, record: RuntimeDebugRecord, depth: number, carried: boolean) =>
    open.has(key) || depth === 0 || record.kind === "interpolation" || carried,
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
      `let total = ${names.join(" + ")}`,
      'say "${total}"',
      "exit",
    ].join("\n"),
  );
  const [output] = trace.outputs();
  const rows = playerDebugTraceRows(trace, [output!], defaults());
  const sum = rows.find((row) => row.kind === "record" && row.text.title === "let total")!;
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

test("Explain values finds a message by its event, through parameters and for any value", () => {
  const { session, trace } = traced(
    [
      "let a = 5",
      "let b = 2 + 3",
      "function tell(message) {",
      "    say message",
      "}",
      'tell("You get ${a}")',
      'tell("You get ${b}")',
      "let pair = [1, a]",
      "say pair",
      "exit",
    ].join("\n"),
  );
  const messages = session.transcriptEntries.filter(
    (entry) => entry.kind === "message" && entry.speakerId !== "user",
  );
  const explained = messages.map((entry) => {
    // Found as Explain values finds it, by the entry's identity, for the content it shows.
    const message = playerRuntimeTranscriptMessage(session, entry.id);
    assert.equal(message, entry);
    assert.ok(message?.contentSequence !== undefined);
    const origin = playerDebugMessageOrigin(trace, message.contentSequence);
    assert.equal(origin.kind, "record");
    return summary(
      playerDebugTraceRows(trace, [origin.kind === "record" ? origin.id : 0], defaults()),
    );
  });
  // Equal texts keep their own causes; the parameter passes the message on, so its placeholder shows too.
  assert.deepEqual(explained, [
    [
      'Message "You get 5"',
      '  parameter message of tell() "You get 5"',
      '    argument message of tell() "You get 5"',
      "      let a 5",
    ],
    [
      'Message "You get 5"',
      '  parameter message of tell() "You get 5"',
      '    argument message of tell() "You get 5"',
      "      let b 5",
    ],
    ['Message "[1, 5]"', "  let pair [1, 5]"],
  ]);
  assert.equal(playerRuntimeTranscriptEventSequence("fixture-1"), null);
  assert.equal(playerRuntimeTranscriptEventSequence("runtime-event-01"), null);
  // A restored session finds the same messages.
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(
    messages.map((entry) => playerRuntimeTranscriptMessage(restored, entry.id)),
    messages,
  );
  assert.equal(playerRuntimeTranscriptMessage(restored, "fixture-1"), null);
});

test("a message the trace cannot explain says why", () => {
  const source = 'let count = 1\nsay "${count}"\nlet name = askText "Name?"\nsay "${name}"\nexit';
  const said = (session: PlayerRuntimeSession) =>
    session.events.filter((event) => event.kind === "say").map((event) => event.sequence);
  const reason = (trace: RuntimeDebugContext, sequence: number) => {
    const origin = playerDebugMessageOrigin(trace, sequence);
    return origin.kind === "unavailable" ? origin.reason : "recorded";
  };

  // Turned on mid-session: earlier messages came before recording.
  const late = new RuntimeDebugContext();
  const waiting = advancePlayerRuntimeTime(createPlayerRuntimeSession(source), 60_000);
  const answered = submitPlayerRuntimeComposer(
    withPlayerRuntimeDebugTrace(waiting, late),
    "Bo",
  )!.session;
  assert.deepEqual(
    said(answered).map((sequence) => reason(late, sequence)),
    ["Shown before Debug was turned on", "Shown before Debug was turned on", "recorded"],
  );

  // Continue of a restored session: its messages came before the restored point.
  const { session, trace } = traced(source);
  const restored = restorePlayerRuntimeSession(
    createPlayerRuntimeRestorePoint(session),
    null,
    trace,
  );
  const resumed = submitPlayerRuntimeComposer(restored, "Bo")!.session;
  assert.deepEqual(
    said(resumed).map((sequence) => reason(trace, sequence)),
    [
      "Shown before Continue: a saved point keeps no history",
      "Shown before Continue: a saved point keeps no history",
      "recorded",
    ],
  );

  // A small budget drops the oldest message.
  const small = new RuntimeDebugContext({ maxRecords: 4 });
  const busy = advancePlayerRuntimeTime(
    createPlayerRuntimeSession('say "one"\nlet a = 1\nlet b = a + 1\nsay "${b}"\nexit', {
      debugTrace: small,
    }),
    60_000,
  );
  assert.deepEqual(
    said(busy).map((sequence) => reason(small, sequence)),
    ["Expired: older history was dropped", "recorded"],
  );
});

test("a message shown inside a branch shows the decision that took it", () => {
  const { session, trace } = traced(
    ['let mood = "calm"', 'if mood == "calm" {', '    say "Stay ${mood}"', "}", "exit"].join("\n"),
  );
  const [output] = trace.outputs();
  const rows = playerDebugTraceRows(trace, [output!], defaults());
  assert.deepEqual(summary(rows), [
    'Message "Stay calm"',
    '  let mood "calm"',
    "  Branch condition true",
  ]);
  const condition = rows.at(-1)!;
  assert.equal(condition.kind === "record" && condition.text.location, "main.tease:2");
  // The decision opens to its condition's causes, the one shown above.
  const opened = playerDebugTraceRows(trace, [output!], defaults(new Set([condition.key])));
  assert.equal(summary(opened).at(-1), '    ↑ let mood "calm"');
  assert.equal(session.snapshot.status, "halted");
});

test("a changed message is explained by its latest change, also in Recent chat, and its handle shows its text", () => {
  const trace = new RuntimeDebugContext();
  const session = advancePlayerRuntimeTime(
    createPlayerRuntimeSession(
      messageSayPlan(
        [
          MESSAGE_TEXT_FUNCTIONS,
          "let count = 0",
          'let strokes = timer(duration: 1 ms, async: true, label: "Strokes: 0")',
          "repeat 2 {",
          "    count += 1",
          '    setText(strokes, "Strokes: ${count}")',
          "}",
          'say "Later", instant',
          "wait 1 s",
          "exit",
        ].join("\n"),
      ),
      { debugTrace: trace },
    ),
    500,
  );
  const first = session.transcriptEntries[0]!;
  const message = playerRuntimeTranscriptMessage(session, first.id);
  assert.equal(message?.text, "Strokes: 2");
  const origin = playerDebugMessageOrigin(trace, message!.contentSequence!);
  assert.ok(origin.kind === "record");
  const explained = summary(playerDebugTraceRows(trace, [origin.id], defaults()));
  assert.deepEqual(explained.slice(0, 1), ['message.text = "Strokes: 2"']);
  assert.ok(
    explained.some((line) => line.trim().startsWith("count = 2")),
    explained.join("\n"),
  );

  // Recent chat lists each message once, newest first, by the record of the text it shows now.
  const [later, strokes] = trace.recentMessages(PLAYER_DEBUG_TRACE_PAGE);
  assert.equal(strokes, origin.id);
  assert.equal(trace.record(later!)?.kind, "output");

  // A handle shows its message's text now, beside its identity, also on its recorded origin.
  const handle = playerDebugVariables(session.plan, session.snapshot, trace)
    .flatMap((group) => group.variables)
    .find((variable) => variable.name === "strokes");
  const shown = `<message ${first.id.replace("runtime-event-", "")} "Strokes: 2">`;
  assert.equal(handle?.value, shown);
  const [row] = playerDebugTraceRows(
    trace,
    [handle!.record!],
    defaults(),
    playerDebugLiveValue(session.snapshot),
  );
  assert.equal(row?.kind === "record" && row.text.now, shown);
});

test("Recent chat shows a message changed while Debug runs, also one said before", () => {
  const plan = messageSayPlan(
    [
      MESSAGE_TEXT_FUNCTIONS,
      'let line = timer(duration: 1 ms, async: true, label: "Waiting")',
      "wait 1 s",
      'setText(line, "Ready")',
      "wait 1 s",
      "exit",
    ].join("\n"),
  );
  const trace = new RuntimeDebugContext();
  const session = advancePlayerRuntimeTime(
    withPlayerRuntimeDebugTrace(createPlayerRuntimeSession(plan), trace),
    1_000,
  );
  assert.equal(session.transcriptEntries[0]?.text, "Ready");
  const [ready] = trace.recentMessages(PLAYER_DEBUG_TRACE_PAGE);
  assert.equal(trace.record(ready!)?.preview, '"Ready"');
});
