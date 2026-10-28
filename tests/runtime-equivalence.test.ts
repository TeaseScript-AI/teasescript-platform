import assert from "node:assert/strict";
import test from "node:test";

import { HANDLE_MEMBERS } from "../src/handle-members.js";
import type { SerializableRuntimeValue } from "../src/runtime/values/serializable-values.js";
import type { RuntimeSnapshot } from "../src/runtime/snapshot/state.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

test("resume equivalence preserves list warnings and collection state", () => {
  const source = [
    "let values = [1]",
    "values.remove(2)",
    "values.remove(2)",
    'say "after"',
    "exit",
  ].join("\n");
  const result = assertRuntimeResumeEquivalent(source, {
    scenarioName: "list.remove warning corpus",
  });
  const warnings = result.events.filter((event) => event.kind === "developerWarning");

  assert.deepEqual(
    warnings.map((event) => event.code),
    ["TSW002", "TSW002"],
  );
  assert.deepEqual(
    result.events.map((event) => event.kind),
    ["developerWarning", "developerWarning", "say", "exit"],
  );
  // The helper checks increasing sequences; the final snapshot must not hand out a used one again.
  assert.ok(
    result.finalSnapshot.nextEventSequence >
      Math.max(...result.events.map((event) => event.sequence)),
  );
  assert.deepEqual(rootValue(result.finalSnapshot, "values"), { kind: "list", items: [1] });
});

test("resume equivalence preserves structured control flow and lexical scope", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "let total = 0",
      "for value in 1..=4 {",
      "  if value == 2 { continue }",
      "  if value == 4 { break }",
      "  if true {",
      "    let scoped = value * 10",
      "    total = total + scoped",
      "  }",
      "}",
      "say total",
      "exit",
    ].join("\n"),
    { scenarioName: "structured control-flow corpus" },
  );

  assert.ok(result.boundaries.some((snapshot) => snapshot.loopFrames.length > 0));
  assert.ok(result.boundaries.some((snapshot) => snapshot.frames.length > 1));
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["40"],
  );
});

test("resume equivalence preserves collections changed in place inside a loop", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "function dynamic(value) {",
      "    return value",
      "}",
      "let grow = [0]",
      "let marks = set[0]",
      "let state = { rows: [[0], [0]], picks: [1, 0, 1] }",
      "let taken = []",
      "for step in 1..=3 {",
      "    grow.add(step)",
      "    grow[0] = step",
      "    marks.add(step)",
      "    taken.add(grow)",
      // The receiver is prepared before the call, and its index changes the root it is prepared from.
      "    state.rows[state.picks.removeFirst()].add(dynamic(step))",
      "}",
      "say grow",
      "say marks.toList()",
      "say state",
      "say taken",
      "exit",
    ].join("\n"),
    { scenarioName: "in-place collection loop corpus" },
  );

  assert.ok(result.boundaries.some((snapshot) => snapshot.loopFrames.length > 0));
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    [
      "[3, 1, 2, 3]",
      "[0, 1, 2, 3]",
      "{ rows: [[0, 2], [0, 1, 3]], picks: [] }",
      "[[1, 1], [2, 1, 2], [3, 1, 2, 3]]",
    ],
  );
});

test("a prepared receiver whose index removes its ancestor keeps the value it selected", () => {
  // The index empties `rows` after `rows[0]` was selected, so the change goes to the selected copy, not to `rows`.
  for (const change of [
    "rows[0][rows.removeFirst().length - 1].add(dynamic(7))",
    "rows[0][rows.removeFirst().length - 1][0] = 7",
  ]) {
    const result = assertRuntimeResumeEquivalent(
      [
        "function dynamic(value) {",
        "    return value",
        "}",
        "let rows = [[[0]]]",
        change,
        "say rows",
        "exit",
      ].join("\n"),
      { scenarioName: change },
    );

    assert.equal(result.finalSnapshot.failure, null, change);
    assert.deepEqual(
      result.events.filter((event) => event.kind === "say").map((event) => event.text),
      ["[]"],
      change,
    );
  }
});

test("a prepared receiver whose argument removes or clears its entry keeps the value it selected", () => {
  // The argument takes the selected entry out of its dict or list, so the change goes to the selected copy, and every
  // entry that the receiver did not go through stays as it was.
  for (const [change, said] of [
    ['table["k"].add(dynamic(table.remove("k").length))', 'dict{ "j": [1] }'],
    ['table["k"].add(dynamic(({ drop: table.clear(), n: 5 }).n))', "dict{}"],
    ['table["j"].add(dynamic(table.remove("k").length))', 'dict{ "j": [1, 1] }'],
    ['nested["k"]["m"][dynamic(({ drop: nested.remove("k"), i: 0 }).i)] = 9', "dict{}"],
    ["rows[0].add(dynamic(({ drop: rows.clear(), n: 5 }).n))", "[]"],
  ] as const) {
    const subject = change.split(/[[.]/u, 1)[0]!;
    const result = assertRuntimeResumeEquivalent(
      [
        "function dynamic(value) {",
        "    return value",
        "}",
        'let table = dict{ "k": [0], "j": [1] }',
        'let nested = dict{ "k": dict{ "m": [0] } }',
        "let rows = [[0], [1]]",
        change,
        `say ${subject}`,
        "exit",
      ].join("\n"),
      { scenarioName: change },
    );

    assert.equal(result.finalSnapshot.failure, null, change);
    assert.deepEqual(
      result.events.filter((event) => event.kind === "say").map((event) => event.text),
      [said],
      change,
    );
  }
});

test("a list joined with += under a prepared receiver leaves the receiver the value it selected", () => {
  // `rows += more` stores a new list in `rows` (V30 §16), so the receiver selected before the call keeps the old one.
  const result = assertRuntimeResumeEquivalent(
    [
      "let rows = [[0]]",
      "function grow: integer {",
      "    rows += [[1]]",
      "    return 7",
      "}",
      "rows[0].add(grow())",
      "say rows",
      "exit",
    ].join("\n"),
  );

  assert.equal(result.finalSnapshot.failure, null);
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["[[0], [1]]"],
  );
});

test("+= with a call that waits appends in place across checkpoints, and joins the value it read when a block changed it", () => {
  // A value read before the call is stored as it was (V30 §14), so the element a block adds meanwhile is lost, also to a
  // speaker's list that it changes through another name.
  const result = assertRuntimeResumeEquivalent(
    [
      'speaker guide {\n    displayName: "Guide"\n    items: [1]\n}',
      "let s = guide",
      "let t = [1]",
      "let o = { items: [1] }",
      "function slow(n) {",
      "    wait 2 s",
      "    return n",
      "}",
      "timer async 1 s {",
      "    t.add(9)",
      "}",
      "timer async 5 s {",
      "    s.items.add(8)",
      "}",
      "t += [slow(2)]",
      "o.items += [slow(3)]",
      "guide.items = guide.items + [slow(4)]",
      "say t",
      "say o",
      "say guide.items",
      "exit",
    ].join("\n"),
  );

  assert.equal(result.finalSnapshot.failure, null);
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["[1, 2]", "{ items: [1, 3] }", "[1, 4]"],
  );
});

test("a prepared receiver whose index adds the value it names resumes from every checkpoint", () => {
  // The receiver's root is captured before its index runs, and the index adds the element or entry it names.
  for (const [setup, change, shown, expected] of [
    [
      "let rows = [[0]]\nfunction pick {\n    rows.add([1])\n    return 1\n}",
      "rows[pick()].add(dynamic(7))",
      "rows",
      "[[0], [1, 7]]",
    ],
    [
      'let table = dict{}\nfunction pick {\n    table["added"] = [0]\n    return "added"\n}',
      "table[pick()].add(dynamic(7))",
      'table["added"]',
      "[0, 7]",
    ],
    [
      "let state = { rows: [] }\nfunction pick {\n    state.rows.add([0])\n    return 0\n}",
      "state.rows[pick()].add(dynamic(7))",
      "state",
      "{ rows: [[0, 7]] }",
    ],
    [
      "let rows = [[0]]",
      "rows[({ grow: rows.add([1]), index: 1 }).index].add(dynamic(7))",
      "rows",
      "[[0], [1, 7]]",
    ],
    [
      "let rows = [[0]]",
      "rows[({ grow: rows.add([1]), index: 1 }).index][0] = dynamic(7)",
      "rows",
      "[[0], [7]]",
    ],
  ] as const) {
    const result = assertRuntimeResumeEquivalent(
      [
        "function dynamic(value) {",
        "    return value",
        "}",
        setup,
        change,
        `say ${shown}`,
        "exit",
      ].join("\n"),
      { scenarioName: change },
    );

    assert.deepEqual(
      result.events.filter((event) => event.kind === "say").map((event) => event.text),
      [expected],
      change,
    );
  }
});

test("a prepared receiver that leads nowhere fails with a checkpoint that resumes", () => {
  // The index adds the selected element to a list that it then removes from `rows`, after `rows` was captured without
  // that element, so neither `rows` nor its capture leads to the element.
  for (const change of [
    "rows[0][({ grow: rows[0].add([0]), drop: rows.removeFirst(), index: 0 }).index].add(dynamic(7))",
    "rows[0][({ grow: rows[0].add([0]), drop: rows.removeFirst(), index: 0 }).index][0] = dynamic(7)",
  ]) {
    const result = assertRuntimeResumeEquivalent(
      [
        "function dynamic(value) {",
        "    return value",
        "}",
        "let rows = [[]]",
        change,
        "say rows",
        "exit",
      ].join("\n"),
      { scenarioName: change, ending: "failed" },
    );

    assert.equal(result.finalSnapshot.failure?.code, "TSR025", change);
    assert.deepEqual(
      result.events.filter((event) => event.kind === "say"),
      [],
      change,
    );
  }
});

test("a prepared receiver through any property that its value does not hold resumes from every checkpoint", () => {
  // The receiver `subject.<property>` is prepared before its index runs, which then fails, as no such property is a list.
  const dateFields = ["year", "month", "day", "weekday", "weekdayNumber", "weekNumber", "weekYear"];
  const timeFields = ["hour", "minute", "second", "millisecond"];
  const cases: [setup: string, properties: readonly string[]][] = [
    ['let subject = dynamic("abc")', ["length"]],
    ["let subject = dynamic(1 calendar month)", ["months", "days", "exactOffset"]],
    ['let subject = dynamic(toDate("2026-10-05"))', dateFields],
    ['let subject = dynamic(toTime("20:15"))', timeFields],
    [
      'let subject = dynamic(toDateTime(toDate("2026-10-05"), toTime("20:15")))',
      [...dateFields, ...timeFields],
    ],
    [
      'let clock = timer async 10 s {\n    say "done"\n}\nlet subject = dynamic(clock)',
      [...Object.keys(HANDLE_MEMBERS.timer.properties), "state.length"],
    ],
    [
      'let sound = playAudio async "a.mp3"\nlet subject = dynamic(sound)',
      Object.keys(HANDLE_MEMBERS.media.properties),
    ],
    [
      "let view = showCamera stage\nlet subject = dynamic(view)",
      Object.keys(HANDLE_MEMBERS.camera.properties),
    ],
  ];
  for (const [setup, properties] of cases)
    for (const property of properties) {
      const result = assertRuntimeResumeEquivalent(
        [
          "function dynamic(value) {",
          "    return value",
          "}",
          setup,
          `let probe = subject.${property}[dynamic(0)]`,
          "exit",
        ].join("\n"),
        { scenarioName: `${setup}: ${property}`, ending: "failed", mediaDurationMs: 1_000 },
      );
      // Not TSR017: the runtime read the property while preparing the receiver.
      assert.equal(result.finalSnapshot.failure?.code, "TSR008", `${setup}: ${property}`);
    }
  // A receiver that a method uses keeps working through such a property.
  const said = assertRuntimeResumeEquivalent(
    [
      "function dynamic(value) {",
      "    return value",
      "}",
      'let day = toDate("2026-10-05")',
      'say day.weekday.startsWith(dynamic("Mon"))',
      "exit",
    ].join("\n"),
    { scenarioName: "weekday startsWith" },
  );
  assert.deepEqual(
    said.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["true"],
  );
});

test("resume equivalence preserves deterministic random advancement", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      'let values = ["a", "b", "c", "d"]',
      "say values.random",
      "say random()",
      "say randomInteger(1..=6)",
      "say chance(50)",
      "exit",
    ].join("\n"),
    { scenarioName: "deterministic random corpus", seed: 0x2468_ace1 },
  );

  assert.equal(result.events.filter((event) => event.kind === "say").length, 4);
  assert.ok(new Set(result.boundaries.map((snapshot) => snapshot.rng.state)).size > 1);
});

function rootValue(snapshot: RuntimeSnapshot, name: string): SerializableRuntimeValue {
  const binding = snapshot.frames[0]?.bindings.find((item) => item.name === name);
  assert.ok(binding !== undefined);
  return binding.value;
}
