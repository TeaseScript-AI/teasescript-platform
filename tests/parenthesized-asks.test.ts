import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  playerRuntimeForeground,
  restorePlayerRuntimeSession,
  submitPlayerRuntimeComposer,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import { compileSource } from "../src/compiler.js";
import { parse } from "../src/parser.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { AMSTERDAM } from "./helpers/temporal-fixtures.js";

/** Each basic ask with a default it accepts, an answer, and how `say` shows that answer. */
const ASKS = [
  { command: "askText", fallback: '"Ada"', answer: "Bea", shown: "Bea" },
  { command: "askNumber", fallback: "2.5", answer: "1.5", shown: "1.5" },
  { command: "askInteger", fallback: "3", answer: "4", shown: "4" },
  { command: "askDate", fallback: 'toDate("2026-10-05")', answer: "2026-10-04" },
  { command: "askTime", fallback: 'toTime("12:00")', answer: "14:30" },
  {
    command: "askDateTime",
    fallback: 'toDateTime("2026-10-05T12:00")',
    answer: "2026-10-04T18:00",
  },
] as const;

const PRELUDE = 'speaker mistress {\n  name: "M"\n}\nfunction question { return "Dynamic?" }\n';

/** The plan as JSON without source positions, which differ between the two spellings. */
function planWithoutSpans(expression: string): string {
  const plan = compileValidPlan(`${PRELUDE}let result = ${expression}\nsay question()\nexit`);
  return JSON.stringify(plan, (key: string, value: unknown) =>
    key === "span" || key === "sourceSpan" ? undefined : value,
  );
}

function start(source: string): PlayerRuntimeSession {
  return createPlayerRuntimeSession(source, { temporalContext: AMSTERDAM });
}

function answer(session: PlayerRuntimeSession, text: string): PlayerRuntimeSession {
  const result = submitPlayerRuntimeComposer(session, text);
  assert.equal(result?.outcome.kind, "completed", text);
  return result!.session;
}

test("a parenthesized basic ask compiles to the plan of its compact form", () => {
  for (const { command, fallback } of ASKS) {
    for (const [bounded, compact] of [
      [`${command}()`, command],
      [`${command}("Question?")`, `${command} "Question?"`],
      [
        `${command}("Question?", hint: "Help", default: ${fallback})`,
        `${command} "Question?", hint: "Help", default: ${fallback}`,
      ],
      [
        `${command}(default: ${fallback}, hint: question())`,
        `${command} default: ${fallback}, hint: question()`,
      ],
      [`${command}(default: ${fallback})`, `${command} default: ${fallback}`],
      [
        `${command}(question(), default: ${fallback})`,
        `${command} question(), default: ${fallback}`,
      ],
      [
        `${command} as mistress (\n    "Question?",\n    default: ${fallback}\n)`,
        `${command} as mistress "Question?",\n    default: ${fallback}`,
      ],
    ]) {
      assert.equal(planWithoutSpans(bounded!), planWithoutSpans(compact!), bounded);
    }
  }
});

test("each parenthesized basic ask completes after a checkpoint restore like its compact form", () => {
  for (const { command, fallback, answer: text, ...ask } of ASKS) {
    const transcripts = [
      `${command}("When?", hint: "Pick", default: ${fallback})`,
      `${command} "When?", hint: "Pick", default: ${fallback}`,
    ].map((expression) => {
      const session = start(`let result = ${expression}\nsay result, instant\nexit`);
      const foreground = playerRuntimeForeground(session);
      assert.ok(foreground !== null && "hint" in foreground, expression);
      assert.equal(foreground.hint, "Pick", expression);
      const restored = restorePlayerRuntimeSession(
        JSON.parse(JSON.stringify(createPlayerRuntimeRestorePoint(session))),
      );
      assert.deepEqual(playerRuntimeForeground(restored), foreground, expression);
      const direct = answer(session, text);
      const resumed = answer(restored, text);
      assert.equal(resumed.snapshot.status, "halted", expression);
      assert.deepEqual(resumed.snapshot, direct.snapshot, expression);
      assert.deepEqual(resumed.events, direct.events, expression);
      assert.deepEqual(resumed.transcriptEntries, direct.transcriptEntries, expression);
      return resumed.transcriptEntries.map((entry) => entry.text);
    });
    assert.deepEqual(transcripts[0], transcripts[1], command);
    // The question, the answer, then `say result`, which shows the same value.
    const [question, shownAnswer, said] = transcripts[0]!;
    assert.equal(question, "When?", command);
    assert.equal(transcripts[0]!.length, 3, command);
    assert.equal(said, shownAnswer, command);
    if ("shown" in ask) assert.equal(said, ask.shown, command);
  }
});

test("a parenthesized ask ends at its ')' inside larger expressions", () => {
  let session = start(
    [
      'let more = askInteger("How many?", default: 3) + 1',
      'let record = { name: askText("Name?"), default: 1 }',
      'let nested = askText("Again?", default: askText("Default?"))',
      'let stored = load(askText("Key?"), default: "none")',
      'say "${more} ${record.name} ${record.default} ${nested} ${stored}", instant',
      "exit",
    ].join("\n"),
  );
  const asked: unknown[] = [];
  for (const text of ["4", "Ada", "Bea", "Cy", "key"]) {
    const foreground = playerRuntimeForeground(session);
    assert.ok(foreground !== null && "hint" in foreground);
    // Each field opens right after its question.
    asked.push([
      session.transcriptEntries.at(-1)?.text,
      "prefill" in foreground ? foreground.prefill : null,
    ]);
    session = answer(session, text);
  }
  // The nested default asks first and prefills the outer ask.
  assert.deepEqual(asked, [
    ["How many?", "3"],
    ["Name?", null],
    ["Default?", null],
    ["Again?", "Bea"],
    ["Key?", null],
  ]);
  assert.equal(session.snapshot.status, "halted");
  assert.equal(session.transcriptEntries.at(-1)?.text, "5 Ada 1 Cy none");
});

test("a parenthesized ask records its command, speaker, arguments, and closing parenthesis", () => {
  const source = 'let result = askText as mistress ("Question?", default: "Ada", hint: "Help")';
  const parsed = parse(source);
  assert.deepEqual(parsed.diagnostics, []);
  const statement = parsed.program.statements[0];
  assert.ok(statement?.kind === "letStatement");
  const ask = statement.initializer;
  assert.ok(ask.kind === "interactionExpression");
  const offsets = (span: { start: { offset: number }; end: { offset: number } } | undefined) =>
    span === undefined ? null : [span.start.offset, span.end.offset];
  const at = (text: string) => [source.indexOf(text), source.indexOf(text) + text.length];
  assert.deepEqual(offsets(ask.commandSpan), at("askText"));
  const asStart = source.indexOf(" as ") + 1;
  assert.deepEqual(offsets(ask.asSpan ?? undefined), [asStart, asStart + 2]);
  assert.deepEqual(offsets(ask.speaker?.span), at("mistress"));
  assert.deepEqual(offsets(ask.question?.span), at('"Question?"'));
  assert.deepEqual(offsets(ask.defaultValue?.span), at('"Ada"'));
  assert.deepEqual(offsets(ask.hint?.span), at('"Help"'));
  assert.deepEqual(offsets(ask.span), [source.indexOf("askText"), source.length]);
});

test("a parenthesized ask takes one question and the options 'hint:' and 'default:', and names what is wrong", () => {
  const errors = (source: string) =>
    compileSource(`${PRELUDE}${source}\nlet = 1\nsay question()\nexit`)
      .diagnostics.filter((diagnostic) => diagnostic.severity === "error")
      .map(
        (item) =>
          `${item.code} ${item.span.start.line - 4}:${item.span.start.column} ${item.message}`,
      );
  // Each case ends with the error of the next statement, which shows that parsing recovered there.
  const next = "TSP013 1:4 Expected a variable identifier after 'let'.";
  for (const [source, error] of [
    [
      'let v = askText("a", "b")',
      "TSP032 0:21 askText(...) takes one unnamed value; name the others, such as 'default:'.",
    ],
    [
      'let v = askNumber("a", help: "b")',
      "TSP032 0:23 Unknown askNumber option 'help'; use 'default:' or 'hint:'.",
    ],
    [
      'let v = askDate("a", default: 1, default: 2)',
      "TSP032 0:33 Duplicate askDate option 'default'.",
    ],
    [
      'let v = askTime("a") as mistress',
      "TSP032 0:21 The 'as speaker' clause must appear immediately after 'askTime'.",
    ],
  ] as const) {
    assert.deepEqual(errors(source), [error, next], source);
  }
});
