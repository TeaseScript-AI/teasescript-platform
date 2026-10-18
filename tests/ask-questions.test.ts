import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { executeInstruction, run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { RuntimeSnapshot } from "../src/runtime/state.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { withValidationTestStatistics } from "../src/validation-testing.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { AMSTERDAM } from "./helpers/temporal-fixtures.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/snapshot-construction.js";

const SPEAKERS = 'speaker mistress {\n  displayName: "Mistress"\n}\nspeaker guide {}\n';

/** Each basic ask with a prefill it accepts. */
const ASKS = [
  ["askText", '"Ada"'],
  ["askNumber", "2.5"],
  ["askInteger", "3"],
  ["askDate", 'toDate("2026-10-05")'],
  ["askTime", 'toTime("12:00")'],
  ["askDateTime", 'toDateTime("2026-10-05T12:00")'],
] as const;

/** The events up to the open field: each said text with its speaker, then the field's speaker and hint. */
function openField(source: string): string[] {
  const plan = compileValidPlan(source);
  const result = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { temporalContext: AMSTERDAM }),
  );
  assert.equal(result.snapshot.foregroundAction?.kind, "interaction", source);
  const speakerName = (id: number | null | undefined) =>
    result.snapshot.speakers.find((speaker) => speaker.id === id)?.identifier ?? "nobody";
  return result.events.flatMap((event) => {
    if (event.kind === "say")
      return [`say ${event.speaker?.identifier ?? "nobody"}: ${event.text}`];
    if (event.kind === "actionRequested" && event.action.kind === "interaction") {
      const ui = event.action.ui;
      return [`field ${speakerName(event.action.speakerId)}: ${"hint" in ui ? ui.hint : ""}`];
    }
    return [];
  });
}

test("a basic ask says its question as its speaker, then opens its field with the hint", () => {
  for (const [command, fallback] of ASKS) {
    for (const [ask, expected] of [
      // The named speaker says the question and asks; `hint:` only labels the field.
      [
        `${command} as mistress "Question?", hint: "Help", prefill: ${fallback}`,
        ["say mistress: Question?", "field mistress: Help"],
      ],
      [
        `${command} as mistress ("Question?", prefill: ${fallback}, hint: "Help")`,
        ["say mistress: Question?", "field mistress: Help"],
      ],
      // Without one, the default speaker does both, here after `speaker guide`.
      [`${command}("Question?")`, ["say guide: Question?", "field guide: null"]],
      // Without a question nothing is said.
      [`${command} hint: "Help"`, ["field guide: Help"]],
      [`${command}()`, ["field guide: null"]],
    ] as const) {
      const source = `${SPEAKERS}speaker guide\nlet answer = ${ask}\nexit`;
      assert.deepEqual(openField(source), expected, source);
    }
  }
});

/** Every ask that takes a question, written with `mode` before it, or with its question `message:` named. */
function asksWithQuestion(mode: string): readonly string[] {
  const before = mode === "" ? "" : `${mode} `;
  // Before the parentheses of an ask, a mode is written with its own parentheses, as for a `say` value.
  const beforeParentheses = mode === "" || mode.endsWith(")") ? before : `${mode}() `;
  return [
    ...ASKS.flatMap(([command]) => [
      `${command} as mistress ${before}"Question?"`,
      `${command} ${beforeParentheses}("Question?", hint: "Help")`,
    ]),
    `askBoolean ${before}"Question?", yesText: "Sure"`,
    `askBoolean ${beforeParentheses}(message: "Question?")`,
    `askForm ${before}"Question?", fields: { level: 5 }`,
    `askBooleans ${before}"Question?", texts: ["A"], prefill: [true]`,
    `askImage ${before}("Question?", hint: "Help")`,
    `askImage ${before}(message: "Question?")`,
  ];
}

/** The mode, alignment, and text of each message said before the ask opens, and the kind of its input. */
function questionShown(ask: string): string[] {
  const source = `${SPEAKERS}speaker guide\nlet answer = ${ask}\nexit`;
  const plan = compileValidPlan(source);
  const result = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { temporalContext: AMSTERDAM }),
  );
  const action = result.snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction", source);
  return [
    ...result.events.flatMap((event) =>
      event.kind === "say"
        ? [`${event.presentation.kind} ${event.presentation.align ?? "-"}: ${event.text}`]
        : [],
    ),
    `opens ${action.ui.kind}`,
  ];
}

test("an ask's question may be shown as prose or a bubble, as by say, and stays a bubble by default", () => {
  for (const [mode, shown] of [
    ["", "bubble -"],
    ["prose", "prose -"],
    ['prose(align: "center")', "prose center"],
    ["bubble", "bubble -"],
  ] as const) {
    for (const ask of asksWithQuestion(mode)) {
      const said = questionShown(ask);
      assert.deepEqual(said.slice(0, -1), [`${shown}: Question?`], ask);
    }
  }
  // The question is said once, in its mode, and the input opens with it, also inside interpolation.
  assert.deepEqual(questionShown('askNumber prose "How many?", prefill: 2'), [
    "prose -: How many?",
    "opens number",
  ]);
  assert.deepEqual(questionShown('"${askText as mistress prose(align: "center") "Name?"}"'), [
    "prose center: Name?",
    "opens text",
  ]);
  // Also when an option is a string with its own interpolation, which may hold another such ask, asked first.
  assert.deepEqual(questionShown('"${askText prose(align: "${"cen" + "ter"}") "Name?"}"'), [
    "prose center: Name?",
    "opens text",
  ]);
  assert.deepEqual(
    questionShown('"${askText prose(font: "${askText prose(align: "right") "Font?"}") "Name?"}"'),
    ["prose right: Font?", "opens text"],
  );
});

test("an ask without a question says nothing and opens its input, in every kind of ask", () => {
  for (const ask of [
    ...ASKS.flatMap(([command]) => [command, `${command}()`, `${command} hint: "Help"`]),
    "askBoolean",
    'askBoolean(yesText: "Sure")',
    'askChoice "A", "B"',
    "askForm fields: { level: 5 }",
    'askBooleans texts: ["A"], prefill: [true]',
    "askImage()",
    'askImage(hint: "Help")',
  ]) {
    const said = questionShown(ask);
    assert.equal(said.length, 1, `${ask}: ${said.join(", ")}`);
    assert.match(said[0]!, /^opens /u, ask);
  }
});

test("a mode needs a question, askChoice has none, and parentheses after the mode hold its options", () => {
  const errors = (source: string) =>
    compileSource(`${source}\nexit`).diagnostics.map(
      (diagnostic) =>
        `${diagnostic.code} ${diagnostic.span.start.column}-${diagnostic.span.end.column} ${diagnostic.message}`,
    );
  assert.deepEqual(errors('let name = askText prose hint: "Help"'), [
    "TSP032 19-24 'prose' shows the question, but this askText has none. Write the question after 'prose', or leave 'prose' out.",
  ]);
  assert.deepEqual(errors("let answers = askForm bubble() (fields: { level: 5 })"), [
    "TSP032 22-30 'bubble' shows the question, but this askForm has none. Write the question after 'bubble', or leave 'bubble' out.",
  ]);
  assert.deepEqual(errors('let picture = askImage prose (hint: "Help")'), [
    "TSP032 23-28 'prose' shows the question, but this askImage has none. Write the question after 'prose', or leave 'prose' out.",
  ]);
  assert.deepEqual(errors('let picture = askImage prose "Show me"'), [
    `TSP017 29-29 askImage takes its question in parentheses after 'prose', as in 'askImage prose ("Show me")'.`,
  ]);
  assert.deepEqual(errors('let pick = askChoice prose "A", "B"'), [
    `TSP032 21-26 askChoice has no question, so it takes no 'prose'. Say the question before it, as in 'say prose "Which one?"'.`,
  ]);
  // As for `say`, parentheses right after the word that nothing follows make the question a call.
  assert.deepEqual(errors('let name = askText prose ("Your name?")'), [
    `TSV018 19-24 Unknown function 'prose'. To show the question as prose, write the question after 'prose' without parentheses around it, as in 'prose "Name?"', or give 'prose' its own parentheses first, as in 'prose() ("Name?")'.`,
  ]);
  // A variable of that name is still a question, and an unknown option is reported as for `say`.
  assert.deepEqual(errors('let prose = "Your name?"\nlet name = askText prose, hint: "Help"'), []);
  assert.deepEqual(errors('let name = askText prose(size: 3) "Your name?"'), [
    "TSP004 29-29 Unknown prose presentation option 'size'.",
  ]);
});

test("the question, hint, and prefill are evaluated once in written order before the question is said", () => {
  for (const [ask, order] of [
    [
      'askText mark("question"), hint: mark("hint"), prefill: mark("prefill")',
      "question hint prefill",
    ],
    [
      'askText(mark("question"), prefill: mark("prefill"), hint: mark("hint"))',
      "question prefill hint",
    ],
  ] as const) {
    const source = [
      'let order = ""',
      "function mark(text) {",
      '    order = "${order} ${text}".trim()',
      '    say "marked ${text}"',
      "    return text",
      "}",
      `let answer = ${ask}`,
      "exit",
    ].join("\n");
    const said = openField(source).filter((event) => event.startsWith("say"));
    assert.deepEqual(
      said,
      [...order.split(" ").map((text) => `say nobody: marked ${text}`), "say nobody: question"],
      source,
    );
  }
});

test("a question is text: a list is rejected, and a scalar is shown as text", () => {
  assert.deepEqual(
    compileSource('let answer = askText ["Name?"]\nexit').diagnostics.map(({ code }) => code),
    ["TSV040"],
  );
  assert.deepEqual(openField("let answer = askNumber 5\nexit"), [
    "say nobody: 5",
    "field nobody: null",
  ]);
  // A list the compiler cannot see fails before anything is said or asked.
  const plan = compileValidPlan(
    'save ["Name?"] as "q"\nlet answer = askText(load("" + "q", default: null))\nexit',
  );
  const failed = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(failed.snapshot.failure?.code, "TSR021");
  assert.deepEqual(
    failed.events.filter((event) => event.kind === "say" || event.kind === "actionRequested"),
    [],
  );
});

test("a question has no reading time of its own, so it opens with its field even where no pause fits", () => {
  // Near the end of scene time, a paced message could not pause; the question needs no pause.
  const plan = compileValidPlan('wait 9007199254740 s\nlet answer = askText "Name?"\nexit');
  const waiting = run(plan, createFreshRuntimeSnapshot(plan));
  const observed = observeTime(plan, waiting.snapshot, 9_007_199_254_740_000);
  assert.equal(observed.outcome.kind, "observed");
  const asking = run(plan, observed.snapshot);
  assert.deepEqual(
    asking.events.map((event) => (event.kind === "say" ? event.text : event.kind)),
    ["Name?", "actionRequested"],
  );
  assert.equal(asking.snapshot.foregroundAction?.kind, "interaction");
  assert.deepEqual(asking.snapshot.backgroundActions, []);
});

/**
 * Drives a session one instruction or host input at a time: it observes due pacing and delays, and answers a text
 * field first with a blank answer, which is refused, then with "Bo" when its hint is "Type it", or else "Ada".
 */
function drive(
  plan: InstructionPlan,
  start: RuntimeSnapshot,
): { boundaries: RuntimeSnapshot[]; events: InterpreterEvent[][] } {
  const boundaries: RuntimeSnapshot[] = [];
  const events: InterpreterEvent[][] = [];
  let snapshot = start;
  for (let guard = 0; snapshot.status !== "halted" && snapshot.status !== "failed"; guard += 1) {
    assert.ok(guard < 500, "the session finishes");
    boundaries.push(snapshot);
    const action = snapshot.foregroundAction;
    let step: { snapshot: RuntimeSnapshot; events: readonly InterpreterEvent[] };
    if (snapshot.status === "ready" || snapshot.status === "running")
      step = executeInstruction(plan, snapshot);
    else if (action?.kind === "interaction") {
      const submit = (text: string) =>
        completeAction(plan, snapshot, {
          actionId: action.actionId,
          actionKind: "interaction",
          interactionKind: "text",
          payload: { kind: "submittedText", submittedText: text },
        });
      const refused = submit("  ");
      assert.equal(refused.outcome.kind, "invalidPayload");
      assert.deepEqual(refused.events, []);
      step = submit("hint" in action.ui && action.ui.hint === "Type it" ? "Bo" : "Ada");
    } else {
      const due = [action, ...snapshot.backgroundActions].flatMap((pending) =>
        pending !== null && "deadlineMs" in pending ? [pending.deadlineMs] : [],
      );
      assert.ok(due.length > 0, "a waiting session has something due");
      step = observeTime(plan, snapshot, Math.min(...due));
    }
    events.push([...step.events]);
    snapshot = step.snapshot;
  }
  boundaries.push(snapshot);
  return { boundaries, events };
}

test("a question resumes from a checkpoint at every boundary as without one, and is said once", () => {
  const plan = compileValidPlan(
    [
      SPEAKERS,
      'say "Listen", 2 s',
      'let name = askText as mistress ("Name ${1 + 1}?", prefill: askText("Default?"), hint: "Type it")',
      'say "Hello ${name}", instant',
      "exit",
    ].join("\n"),
  );
  const uninterrupted = drive(plan, createFreshRuntimeSnapshot(plan));
  const said = uninterrupted.events
    .flat()
    .flatMap((event) =>
      event.kind === "say" ? [`${event.speaker?.identifier ?? "nobody"}: ${event.text}`] : [],
    );
  // The asking prefill comes first and prefills the field; a refused answer says nothing again.
  assert.deepEqual(said, [
    "nobody: Listen",
    "nobody: Default?",
    "mistress: Name 2?",
    "nobody: Hello Bo",
  ]);
  const final = uninterrupted.boundaries.at(-1)!;
  assert.equal(final.status, "halted");
  uninterrupted.boundaries.slice(0, -1).forEach((boundary, index) => {
    const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, boundary)));
    assert.deepEqual(restored.snapshot, boundary, `boundary ${index}`);
    const resumed = drive(restored.plan, restored.snapshot);
    assert.deepEqual(resumed.boundaries.at(-1), final, `boundary ${index}`);
    assert.deepEqual(resumed.events, uninterrupted.events.slice(index), `boundary ${index}`);
  });
});

test("a prose question keeps its mode from a checkpoint at every boundary, also while its question asks first", () => {
  // The mode's options are evaluated before the question, so they are kept while the ask in the question waits.
  const plan = compileValidPlan(
    [
      SPEAKERS,
      'let name = askText as mistress prose(align: "center") ("Name ${askText("Inner?")}?", hint: "Type it")',
      'say "Hello ${name}", instant',
      "exit",
    ].join("\n"),
  );
  const uninterrupted = drive(plan, createFreshRuntimeSnapshot(plan));
  assert.deepEqual(
    uninterrupted.events
      .flat()
      .flatMap((event) =>
        event.kind === "say"
          ? [
              `${event.speaker?.identifier ?? "nobody"} ${event.presentation.kind} ${event.presentation.align ?? "-"}: ${event.text}`,
            ]
          : [],
      ),
    ["nobody bubble -: Inner?", "mistress prose center: Name Ada?", "nobody bubble -: Hello Bo"],
  );
  const final = uninterrupted.boundaries.at(-1)!;
  uninterrupted.boundaries.slice(0, -1).forEach((boundary, index) => {
    const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, boundary)));
    assert.deepEqual(restored.snapshot, boundary, `boundary ${index}`);
    const resumed = drive(restored.plan, restored.snapshot);
    assert.deepEqual(resumed.boundaries.at(-1), final, `boundary ${index}`);
    assert.deepEqual(resumed.events, uninterrupted.events.slice(index), `boundary ${index}`);
  });
});

test("hint: and prefill: each follow a comma once, and a mistake names its fix", () => {
  for (const [ask, error] of [
    ['askText "Q", hint: "a", hint: "b"', "TSP032 0:32 Duplicate askText option 'hint'."],
    ['askText "Q" hint: "a"', "TSP017 0:20 Expected ',' before 'hint:'."],
    ['askText "Q", prefill: "d" hint: "a"', "TSP017 0:34 Expected ',' before 'hint:'."],
    ['askText "Q", hint:', "TSP028 1:0 Expected hint text after 'hint:'."],
  ] as const) {
    // The error of the next statement shows that parsing recovered there.
    assert.deepEqual(
      compileSource(`let a = ${ask}\nlet = 1\nexit`).diagnostics.map(
        (item) => `${item.code} ${item.span.start.line}:${item.span.start.column} ${item.message}`,
      ),
      [error, "TSP013 1:4 Expected a variable identifier after 'let'."],
      ask,
    );
  }
});

test("a pending ask with a long question restores from its JSON checkpoint", () => {
  // The question appears in its text preparation and in its say; restore compares the two without native recursion.
  const plan = compileValidPlan(
    `let q = "Q"\nlet answer = askText(${Array(8000).fill("q").join(" + ")})\nexit`,
  );
  const pending = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(pending.snapshot.foregroundAction?.kind, "interaction");
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, pending.snapshot)),
  );
  assert.deepEqual(restored.snapshot, pending.snapshot);
});

test("validating nested asking prefills takes work in proportion to the plan", () => {
  // Each question's preparation spans its nested prefills; the clear and bypass checks must not walk each span.
  const work = (asks: number) => {
    const plan = compileValidPlan(
      `let answer = ${'askText("Q", prefill: '.repeat(asks - 1)}askText("Q")${")".repeat(asks - 1)}\nexit`,
    );
    return withValidationTestStatistics((finish) => {
      assert.equal(validateInstructionPlan(JSON.parse(JSON.stringify(plan))).valid, true);
      return finish().counts.preparedSayRangeSteps!;
    });
  };
  // A scoped regression oracle for the indexed checks: doubling the nesting at most about doubles the steps.
  assert.ok(work(400) <= 2.2 * work(200), `${work(400)} steps for 400 asks, ${work(200)} for 200`);
});
