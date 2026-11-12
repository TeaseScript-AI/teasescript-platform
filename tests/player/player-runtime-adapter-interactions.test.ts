// The runtime adapter's interactions (split from `player-runtime-adapter.test.ts`): their delegation to the engine,
// choices and buttons, pacing and time, timers, and forms.
import { normalizeColor } from "../../src/color.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  activatePlayerRuntimeButton,
  continuePlayerRuntimeSession,
  createPlayerRuntimeRestorePoint,
  observePlayerRuntimeTime,
  restorePlayerRuntimeSession,
  selectPlayerRuntimeChoice,
  skipPlayerRuntimePacing,
  stepPlayerRuntimeFormField,
  submitPlayerRuntimeComposer,
  submitPlayerRuntimeForm,
  cancelPlayerRuntimeForm,
  clearPlayerRuntimeFormField,
  dismissPlayerRuntimeFormField,
  draftPlayerRuntimeForm,
  playerRuntimeSnapshot,
  type PlayerRuntimeSession,
} from "../../player/runtime/runtime-adapter.js";
import { playerRuntimeForm } from "../../player/runtime/runtime-view.js";
import { createPlayerRuntimeSession } from "../../player/runtime/compile-project.js";
import {
  playerTemporalContext,
  playerRuntimeDeadlines,
  playerRuntimeForeground,
  playerRuntimePacingGate,
  playerRuntimeTimers,
} from "../../player/runtime/runtime-view.js";

test("runtime adapter delegates interaction normalization, transcript, and continuation to the engine", () => {
  let session = createPlayerRuntimeSession(`
speaker guide {
  title: "Guide"
  color: "#b784ff"
}
say as guide "**Ready?**", instant
showButton as guide "Continue"
let text = askText as guide hint: "Text"
let amount = askNumber as guide hint: "Number"
let choice = askChoice as guide first: "Same", second: "Same"
say as guide "${"${text}"} / ${"${amount}"} / ${"${choice}"}", instant
exit
`);
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["Ready?"],
  );
  const firstEntry = session.transcriptEntries[0];
  if (firstEntry?.kind !== "message") throw new Error("Expected a runtime message.");
  const guide = session.speakers[firstEntry.speakerId];
  assert.deepEqual(guide, {
    identityId: "guide",
    name: "Guide",
    accent: normalizeColor("#b784ff"),
    avatar: "G",
    fontFamily: "inherit",
  });
  assert.equal(firstEntry.content?.visibleText, "Ready?");
  assert.deepEqual(
    firstEntry.content?.blocks[0]?.kind === "paragraph"
      ? firstEntry.content.blocks[0].lines[0]?.spans.map((span) => span.kind)
      : [],
    ["bold"],
  );

  const buttonSnapshot = structuredClone(playerRuntimeSnapshot(session));
  assert.equal(submitPlayerRuntimeComposer(session, "continue"), null);
  assert.equal(submitPlayerRuntimeComposer(session, "Continue "), null);
  assert.equal(submitPlayerRuntimeComposer(session, ""), null);
  assert.deepEqual(playerRuntimeSnapshot(session), buttonSnapshot);
  const buttonRestorePoint = createPlayerRuntimeRestorePoint(session);
  const button = submitPlayerRuntimeComposer(session, "Continue");
  assert.equal(button?.outcome.kind, "completed");
  const clickedButton = activatePlayerRuntimeButton(
    restorePlayerRuntimeSession(buttonRestorePoint),
  );
  assert.deepEqual(button?.outcome, clickedButton?.outcome);
  assert.deepEqual(
    playerRuntimeSnapshot(button!.session),
    playerRuntimeSnapshot(clickedButton!.session),
  );
  assert.deepEqual(button?.session.transcriptEntries, clickedButton?.session.transcriptEntries);
  session = button!.session;

  const invalidText = submitPlayerRuntimeComposer(session, " \t ");
  assert.equal(invalidText?.outcome.kind, "invalidPayload");
  assert.deepEqual(invalidText?.session.state.foregroundAction, session.state.foregroundAction);
  const text = submitPlayerRuntimeComposer(session, "  A\r\nB\r  ");
  assert.equal(text?.outcome.kind, "completed");
  session = text!.session;

  const invalidNumber = submitPlayerRuntimeComposer(session, "not a number");
  assert.equal(invalidNumber?.outcome.kind, "invalidPayload");
  const number = submitPlayerRuntimeComposer(session, "  -0e2  ");
  assert.equal(number?.outcome.kind, "completed");
  session = number!.session;

  const foreground = playerRuntimeForeground(session);
  assert.equal(foreground?.kind, "choose");
  if (foreground?.kind !== "choose") throw new Error("Expected choice presentation.");
  assert.deepEqual(
    foreground.options.map((option) => option.label),
    ["Same", "Same"],
  );
  const ambiguous = submitPlayerRuntimeComposer(session, "Same");
  assert.equal(ambiguous?.outcome.kind, "invalidPayload");
  assert.deepEqual(ambiguous?.session.state.foregroundAction, session.state.foregroundAction);

  const selected = selectPlayerRuntimeChoice(session, foreground.options[1]!.id);
  assert.equal(selected?.outcome.kind, "completed");
  session = selected!.session;
  assert.equal(session.state.status, "halted");
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["Ready?", "Continue", "  A\nB\n  ", "-0e2", "Same", "  A\nB\n   / 0 / second"],
  );
  const transcriptIds = session.transcriptEntries.map((entry) => entry.id);
  assert.equal(new Set(transcriptIds).size, transcriptIds.length);
  assert.equal(
    session.transcriptEntries[0]?.kind === "message" &&
      session.transcriptEntries[0].content !== undefined,
    true,
  );
  assert.equal(
    session.transcriptEntries[1]?.kind === "message" &&
      session.transcriptEntries[1].content === undefined,
    true,
  );
  assert.equal(
    session.transcriptEntries[5]?.kind === "message" &&
      session.transcriptEntries[5].content !== undefined,
    true,
  );
});

test("runtime adapter preserves choice order and rendered-selection semantics", () => {
  let session = createPlayerRuntimeSession(
    'let choice = askChoice "First", "Second"\nsay choice, instant\nexit',
  );
  const foreground = playerRuntimeForeground(session);
  assert.equal(foreground?.kind, "choose");
  if (foreground?.kind !== "choose") throw new Error("Expected choice presentation.");
  assert.deepEqual(
    foreground.options.map((option) => option.label),
    ["First", "Second"],
  );
  const selected = selectPlayerRuntimeChoice(session, foreground.options[1]!.id);
  assert.equal(selected?.outcome.kind, "completed");
  session = selected!.session;
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["Second", "Second"],
  );
});

test("runtime adapter selects the rendered button even when two buttons return the same value", () => {
  const session = createPlayerRuntimeSession(
    'let options = [{ text: "A", value: 1 }, { text: "B", value: 1 }]\nlet choice = askChoice options\nsay [choice], instant\nexit',
  );
  const foreground = playerRuntimeForeground(session);
  if (foreground?.kind !== "choose") throw new Error("Expected choice presentation.");
  assert.deepEqual(
    foreground.options.map((option) => option.label),
    ["A", "B"],
  );
  const selected = selectPlayerRuntimeChoice(session, foreground.options[1]!.id);
  assert.equal(selected?.outcome.kind, "completed");
  assert.deepEqual(
    selected!.session.transcriptEntries.map((entry) => entry.text),
    ["B", "[1]"],
  );
});

test("runtime adapter routes pacing skip and explicit time through canonical operations", () => {
  let session = createPlayerRuntimeSession(
    'say unskippable "First", 10 s\nsay skippable "Second", 10 s\nwait 20 s\nexit',
  );
  const firstGate = playerRuntimePacingGate(session);
  assert.equal(firstGate?.skippable, false);
  const beforeRejectedSkip = structuredClone(playerRuntimeSnapshot(session));
  const rejected = skipPlayerRuntimePacing(session);
  assert.equal(rejected?.outcome.kind, "invalidPayload");
  assert.deepEqual(playerRuntimeSnapshot(rejected?.session), beforeRejectedSkip);

  const beforeObservation = structuredClone(session.state);
  const observed = observePlayerRuntimeTime(session, firstGate!.deadlineMs);
  assert.equal(observed.outcome.kind, "observed");
  // The observation continues execution in a new publication; the earlier one shows what it showed, and only the new
  // one continues, as the refused skip left the state unchanged.
  assert.deepEqual(session.state, beforeObservation);
  assert.throws(() => playerRuntimeSnapshot(session), /replaced by a newer one/u);
  session = observed.session;
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["First", "Second"],
  );
  assert.equal(playerRuntimePacingGate(session)?.skippable, true);

  const skipped = skipPlayerRuntimePacing(session);
  assert.equal(skipped?.outcome.kind, "completed");
  assert.equal(playerRuntimePacingGate(skipped!.session), null);
  assert.equal(skipped?.session.state.foregroundAction?.kind, "delay");
});

test("blocking timer scenario presents runtime timers, hides waits, and restores the same draw", async () => {
  const source = await readFile(
    resolve(process.cwd(), "tests/fixtures/timers/blocking-timer.tease"),
    "utf8",
  );
  let session = createPlayerRuntimeSession(source);
  const presented: Array<number | null> = [];
  let restoredChecked = false;
  for (let guard = 0; session.state.foregroundAction?.kind === "delay"; guard += 1) {
    assert.ok(guard < 10, "scenario must reach its final button");
    const action = session.state.foregroundAction;
    const now = session.state.currentSessionTimeMs;
    const timers = playerRuntimeTimers(session.state, now);
    if (action.display === "hidden") {
      assert.deepEqual(timers, [], "a hidden wait has no timer presentation");
      presented.push(null);
    } else {
      const total = (action.deadlineMs - action.createdAtMs) / 1000;
      // The entry ID is an opaque key; restore below compares it for equality.
      assert.deepEqual(
        timers.map(({ kind, name, remainingSeconds, totalSeconds }) => ({
          kind,
          name,
          remainingSeconds,
          totalSeconds,
        })),
        [{ kind: "visible", name: undefined, remainingSeconds: total, totalSeconds: total }],
      );
      assert.equal(
        playerRuntimeTimers(session.state, now + 1_250)[0]?.remainingSeconds,
        total - 1.25,
      );
      assert.equal(
        playerRuntimeTimers(session.state, action.deadlineMs + 5_000)[0]?.remainingSeconds,
        0,
      );
      assert.equal(playerRuntimeTimers(session.state, now - 5_000)[0]?.remainingSeconds, total);
      presented.push(total);

      if (!restoredChecked && presented.length === 2) {
        const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
        assert.deepEqual(
          playerRuntimeSnapshot(restored),
          playerRuntimeSnapshot(session),
          "restore keeps the drawn duration",
        );
        assert.deepEqual(
          playerRuntimeTimers(restored.state, now + 500),
          playerRuntimeTimers(session.state, now + 500),
        );
        session = restored;
        restoredChecked = true;
      }
    }
    const early = observePlayerRuntimeTime(session, action.deadlineMs - 1);
    assert.equal(early.session.state.foregroundAction?.actionId, action.actionId);
    session = observePlayerRuntimeTime(early.session, action.deadlineMs).session;
    assert.notEqual(
      session.state.foregroundAction?.actionId,
      action.actionId,
      "settled timer is removed",
    );
  }
  assert.ok(restoredChecked);
  assert.equal(presented.length, 5);
  assert.equal(presented[0], 5);
  assert.ok(presented[1]! >= 4 && presented[1]! <= 8);
  assert.equal(presented[2], null);
  assert.ok(presented.slice(3).every((total) => total! >= 3 && total! <= 5));
  assert.equal(playerRuntimeForeground(session)?.kind, "show-button");
  assert.deepEqual(playerRuntimeTimers(session.state, session.state.currentSessionTimeMs), []);
  assert.deepEqual(
    session.transcriptEntries.map((entry) => (entry.kind === "message" ? entry.text : "")).at(-1),
    "Every timer has settled.",
  );
});

test("authored timers scenario presents concurrent timers and interrupts the unanswered question", async () => {
  const source = await readFile(
    resolve(process.cwd(), "tests/fixtures/timers/authored-timers.tease"),
    "utf8",
  );
  const texts = (session: ReturnType<typeof createPlayerRuntimeSession>) =>
    session.transcriptEntries.flatMap((entry) => (entry.kind === "message" ? [entry.text] : []));
  const presented = (session: ReturnType<typeof createPlayerRuntimeSession>, now: number) =>
    playerRuntimeTimers(session.state, now).map((timer) => [
      timer.kind,
      timer.name ?? null,
      timer.remainingSeconds,
    ]);

  let session = createPlayerRuntimeSession(source);
  assert.equal(playerRuntimeForeground(session)?.kind, "ask-text");
  const pulse = presented(session, 0)[0]!;
  assert.deepEqual(presented(session, 0).slice(1), [
    ["mystery", "Secret", 40],
    ["visible", "Answer deadline", 20],
  ]);
  assert.deepEqual(pulse.slice(0, 2), ["visible", "Pulse"], "the hidden reminder is not presented");
  assert.ok(Number(pulse[2]) >= 2 && Number(pulse[2]) <= 4);
  assert.ok(playerRuntimeDeadlines(session.state).includes(6_000));

  session = observePlayerRuntimeTime(session, 6_000).session;
  assert.match(texts(session).at(-1)!, /^A hidden timer just expired\. [1-3] pulses so far\.$/u);
  assert.equal(playerRuntimeForeground(session)?.kind, "ask-text", "the question returns");
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(playerRuntimeSnapshot(restored), playerRuntimeSnapshot(session));

  const answered = submitPlayerRuntimeComposer(
    observePlayerRuntimeTime(restored, 8_000).session,
    "Ada",
  );
  assert.equal(answered?.outcome.kind, "completed");
  session = answered!.session;
  assert.ok(texts(session).includes("Thank you, Ada. 12 seconds were left on the deadline."));
  assert.deepEqual(
    presented(session, 8_000).map(([kind, name]) => [kind, name]),
    [
      ["visible", "Pulse"],
      ["mystery", "Secret"],
    ],
    "the stopped deadline disappears",
  );
  assert.equal(presented(session, 10_000)[1]?.[2], 32, "a paused timer keeps its remaining time");
  session = observePlayerRuntimeTime(session, 11_000).session;
  assert.deepEqual(presented(session, 11_000).at(-2)?.slice(0, 2), ["visible", "Secret"]);
  assert.deepEqual(presented(session, 11_000).at(-1), ["visible", "Final countdown", 3]);
  session = observePlayerRuntimeTime(session, 14_000).session;
  assert.match(texts(session).at(-1)!, /^Done after \d+ pulses\.$/u);
  assert.equal(playerRuntimeForeground(session)?.kind, "show-button");

  let unanswered = createPlayerRuntimeSession(source);
  for (const now of [6_000, 12_000, 20_000]) {
    unanswered = observePlayerRuntimeTime(unanswered, now).session;
  }
  assert.equal(texts(unanswered).at(-1), "Time is up, so the question is cancelled.");
  assert.equal(playerRuntimeForeground(unanswered)?.kind, "show-button");
  unanswered = activatePlayerRuntimeButton(unanswered)!.session;
  assert.equal(unanswered.state.status, "halted");
  assert.deepEqual(playerRuntimeTimers(unanswered.state, 20_000), []);
});

test("a form presents its fields as their answers stand, takes edits, and survives a restore", () => {
  const session = createPlayerRuntimeSession(
    [
      "let answers = askForm fields: {",
      '  rope: { value: true, text: "Rope" }, cuffs: false,',
      '  pace: { text: "Pace", options: [{ text: "Slow", background: "seagreen" }, { text: "Fast" }] }',
      '}, submit: { text: "Continue", background: "red" }',
      'say "${answers.cuffs} ${answers.pace}", instant',
      'showButton "Done"',
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(playerRuntimeForeground(session), {
    kind: "form",
    accessibleName: "Answer",
    hint: "Type your response…",
  });
  const form = playerRuntimeForm(session)!;
  assert.deepEqual(
    form.fields.map((field) => [field.id, field.label, field.kind, field.pressed, field.state]),
    [
      ["rope", "Rope", "toggle", true, null],
      ["cuffs", "cuffs", "toggle", false, null],
      ["pace", "Pace", "cycle", false, "Slow"],
    ],
  );
  assert.equal(form.fields[2]!.authoredFill, normalizeColor("seagreen"));
  assert.deepEqual(form.submit, { label: "Continue", authoredFill: normalizeColor("red") });
  // The same answers keep the same presentation, so frequent observations do not re-render the form.
  assert.equal(playerRuntimeForm(session), form);

  const stepped = stepPlayerRuntimeFormField(session, "cuffs")!;
  assert.equal(stepped.outcome.kind, "updated");
  // A cycle steps through its options by exact composer text too, and wraps around.
  const cycled = submitPlayerRuntimeComposer(stepped.session, "Pace")!;
  assert.equal(cycled.outcome.kind, "updated");
  const presented = playerRuntimeForm(cycled.session)!;
  assert.deepEqual(
    presented.fields.map((field) => [field.pressed, field.state]),
    [
      [true, null],
      [true, null],
      [false, "Fast"],
    ],
  );
  assert.equal(presented.fields[2]!.authoredFill, undefined);
  // Ambiguous or unknown text is not an edit, and edits add nothing to the transcript.
  assert.equal(submitPlayerRuntimeComposer(cycled.session, "Slow"), null);
  assert.deepEqual(cycled.session.transcriptEntries, session.transcriptEntries);

  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(cycled.session));
  assert.deepEqual(playerRuntimeForm(restored), presented);
  const done = submitPlayerRuntimeForm(restored)!;
  assert.equal(done.outcome.kind, "completed");
  assert.deepEqual(
    done.session.transcriptEntries.map((entry) => [
      entry.text,
      entry.kind === "message" ? (entry.responseKind ?? null) : null,
    ]),
    [
      ["✓ Rope, ✓ cuffs, Pace: Fast", "form"],
      ["true Fast", null],
    ],
  );
  const answer = done.session.transcriptEntries[0]!;
  assert.deepEqual(answer.kind === "message" ? answer.formSummary : undefined, [
    { kind: "toggle", label: "Rope", on: true },
    { kind: "toggle", label: "cuffs", on: true },
    { kind: "value", label: "Pace", value: "Fast" },
  ]);
  assert.equal(playerRuntimeForm(done.session), null);
});

test("the composer's text answers a form only as the exact text of one of its buttons", () => {
  const session = createPlayerRuntimeSession(
    [
      'let answers = askForm fields: { go: { value: false, text: "Go" }, rope: { value: false, text: "Rope" } }, submit: "Go"',
      "exit",
    ].join("\n"),
  );
  // A field and the submit button both read "Go", so it names neither.
  assert.equal(submitPlayerRuntimeComposer(session, "Go"), null);
  assert.equal(submitPlayerRuntimeComposer(session, "rope"), null);
  const stepped = submitPlayerRuntimeComposer(session, "Rope");
  assert.equal(stepped?.outcome.kind, "updated");
  assert.equal(playerRuntimeForm(stepped!.session)?.fields[1]?.pressed, true);
});

test("a toggle with options and a cycle list every text they can show, so a press keeps their width", () => {
  const session = createPlayerRuntimeSession(
    [
      "let answers = askForm fields: {",
      '  rope: true, access: { value: false, text: "Access", options: [{ value: false, text: "Off" }, { value: true, text: "On" }] },',
      '  pace: { text: "Pace", options: [{ text: "Slow" }, { text: "Much faster" }, { text: "Fast" }] }',
      "}",
      'showButton "Done"',
      "exit",
    ].join("\n"),
  );
  const states = (form: ReturnType<typeof playerRuntimeForm>) =>
    form!.fields.map((field) => [field.id, field.state, field.states]);
  assert.deepEqual(states(playerRuntimeForm(session)), [
    ["rope", null, []],
    ["access", "Off", ["Off", "On"]],
    ["pace", "Slow", ["Slow", "Much faster", "Fast"]],
  ]);
  const stepped = stepPlayerRuntimeFormField(
    stepPlayerRuntimeFormField(session, "access")!.session,
    "pace",
  )!.session;
  assert.deepEqual(states(playerRuntimeForm(stepped)), [
    ["rope", null, []],
    ["access", "On", ["Off", "On"]],
    ["pace", "Much faster", ["Slow", "Much faster", "Fast"]],
  ]);
});

test("a cycle whose options share its value is answered with the option it showed, line by line", () => {
  const session = createPlayerRuntimeSession(
    [
      "let answers = askForm fields: {",
      '  pace: { text: "Pace", options: [{ value: 1, text: "Slow" }, { value: 1, text: "Fast" }] }',
      "}",
      'showButton "Done"',
      "exit",
    ].join("\n"),
  );
  const stepped = stepPlayerRuntimeFormField(session, "pace")!;
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(stepped.session));
  const done = submitPlayerRuntimeForm(restored)!;
  assert.equal(done.outcome.kind, "completed");
  // The result cannot tell the options apart; the settlement's shown option can, also after a restore.
  for (const shown of [
    done.session,
    restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(done.session)),
  ]) {
    const answer = shown.transcriptEntries.find(
      (entry) => entry.kind === "message" && entry.responseKind === "form",
    );
    assert.deepEqual(answer?.kind === "message" ? [answer.text, answer.formSummary] : undefined, [
      "Pace: Fast",
      [{ kind: "value", label: "Pace", value: "Fast" }],
    ]);
  }
});

test("a restored form answer keeps the date and time presentation it was sent in after a Continue in another", () => {
  const session = createPlayerRuntimeSession(
    [
      'let when = askForm "When?", fields: { day: toDate("2026-10-04"), at: toTime("18:30") }',
      'showButton "Next"',
      "exit",
    ].join("\n"),
    { temporalContext: playerTemporalContext({ timeZone: "UTC", locale: "en-US" }) },
  );
  const done = submitPlayerRuntimeForm(session)!.session;
  const summary = (shown: PlayerRuntimeSession) => {
    const answer = shown.transcriptEntries.find(
      (entry) => entry.kind === "message" && entry.responseKind === "form",
    );
    return answer?.kind === "message" ? answer.formSummary : undefined;
  };
  const sent = summary(done);
  // The live summary writes the answers as the player's language does.
  assert.ok(sent?.[0]?.kind === "value" && sent[0].value !== "2026-10-04");
  // The kept state after a Continue in Dutch has only the Dutch presentation.
  const continued = continuePlayerRuntimeSession(
    restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(done)),
    {
      wallClockMs: Date.UTC(2026, 9, 5),
      temporalContext: playerTemporalContext({ timeZone: "UTC", locale: "nl-NL" }),
    },
  ).session;
  const again = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(continued));
  assert.notDeepEqual(again.state.temporalPresentation, done.state.temporalPresentation);
  assert.deepEqual(summary(again), sent);
});

test("a typed form field opens in the composer, keeps its draft through a restore, and takes the composer's text", () => {
  const session = createPlayerRuntimeSession(
    [
      "let details = askForm fields: {",
      '  impact: { value: 5, min: 1, max: 10, text: "Impact" }, weight: { type: "number", optional: true },',
      '  day: { type: "date", hint: "Pick a day" }',
      "}",
      'say "${details.impact} ${details.weight} ${details.day}", instant',
      'showButton "Done"',
      "exit",
    ].join("\n"),
  );
  const form = playerRuntimeForm(session)!;
  assert.deepEqual(
    form.fields.map((field) => [field.id, field.kind, field.state, field.optional]),
    [
      ["impact", "value", "5", false],
      ["weight", "value", null, true],
      ["day", "value", null, false],
    ],
  );
  assert.equal(form.editor, null);
  const opened = stepPlayerRuntimeFormField(session, "impact")!;
  assert.deepEqual(playerRuntimeForm(opened.session)!.editor, {
    fieldId: "impact",
    label: "Impact",
    hint: "Impact…",
    optional: false,
    text: "5",
    inputMode: "numeric",
    inputType: "text",
  });
  // The composer's text reaches the form before a checkpoint, and a restore shows it again.
  const target = { actionId: playerRuntimeForm(opened.session)!.actionId, fieldId: "impact" };
  // A draft for another action or field changes nothing.
  assert.equal(
    draftPlayerRuntimeForm(opened.session, { ...target, actionId: target.actionId + 1 }, "1"),
    null,
  );
  assert.equal(draftPlayerRuntimeForm(opened.session, { ...target, fieldId: "day" }, "1"), null);
  const drafted = draftPlayerRuntimeForm(opened.session, target, "1")!;
  assert.equal(drafted.outcome.kind, "updated");
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(drafted.session));
  assert.equal(playerRuntimeForm(restored)!.editor?.text, "1");
  // Enter in the composer commits its text; a refused one stays, with the engine's message.
  const refused = submitPlayerRuntimeComposer(restored, "12")!;
  assert.deepEqual(refused.outcome, {
    kind: "invalidPayload",
    message: "That is wrong. Impact must be from 1 to 10.",
  });
  assert.equal(playerRuntimeForm(refused.session)!.editor?.text, "12");
  const committed = submitPlayerRuntimeComposer(refused.session, "7")!;
  assert.equal(committed.outcome.kind, "updated");
  assert.equal(playerRuntimeForm(committed.session)!.fields[0]!.state, "7");
  // A date field uses the date control and its own hint; Back drops the text.
  const day = stepPlayerRuntimeFormField(committed.session, "day")!;
  assert.deepEqual(
    [
      playerRuntimeForm(day.session)!.editor?.inputType,
      playerRuntimeForm(day.session)!.editor?.hint,
    ],
    ["date", "Pick a day"],
  );
  const back = dismissPlayerRuntimeFormField(day.session)!;
  assert.equal(playerRuntimeForm(back.session)!.editor, null);
  // Opening another field commits the text typed for this one; Clear leaves an optional field without a value.
  const weight = stepPlayerRuntimeFormField(back.session, "weight")!;
  const switched = stepPlayerRuntimeFormField(weight.session, "day", "2.5")!;
  assert.equal(playerRuntimeForm(switched.session)!.fields[1]!.state, "2.5");
  const reopened = stepPlayerRuntimeFormField(
    dismissPlayerRuntimeFormField(switched.session)!.session,
    "weight",
  )!;
  const cleared = clearPlayerRuntimeFormField(reopened.session)!;
  assert.equal(playerRuntimeForm(cleared.session)!.fields[1]!.state, null);
  // Submitting takes the composer's text for the edited field first.
  const day2 = stepPlayerRuntimeFormField(cleared.session, "day")!;
  const done = submitPlayerRuntimeForm(day2.session, "2026-10-05")!;
  assert.equal(done.outcome.kind, "completed");
  assert.deepEqual(done.session.transcriptEntries.map((entry) => entry.text).slice(-2), [
    "Impact: 7, weight: Not set, day: 2026-10-05",
    "7 null 2026-10-05",
  ]);
});

test("a form's cancel button and its exact text cancel the form", () => {
  const source = [
    'let answers = askForm fields: { on: false }, cancel: { text: "Back", background: "gray" }',
    'if answers == null { say "none", instant }',
    'showButton "Done"',
    "exit",
  ].join("\n");
  const session = createPlayerRuntimeSession(source);
  assert.deepEqual(playerRuntimeForm(session)!.cancel, {
    label: "Back",
    authoredFill: normalizeColor("gray"),
  });
  // A session's transcript grows in place, so each way starts from its own session.
  for (const cancelled of [
    cancelPlayerRuntimeForm(session)!,
    submitPlayerRuntimeComposer(createPlayerRuntimeSession(source), "Back")!,
  ]) {
    assert.equal(cancelled.outcome.kind, "completed");
    assert.deepEqual(
      cancelled.session.transcriptEntries.map((entry) => entry.text),
      ["Back", "none"],
    );
  }
  assert.equal(
    cancelPlayerRuntimeForm(
      createPlayerRuntimeSession("let a = askForm fields: { on: false }\nexit"),
    ),
    null,
  );
});
