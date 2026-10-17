import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { validateSerializableValue } from "../src/runtime/serializable-values.js";
import type { RuntimeSnapshot } from "../src/runtime/state.js";
import { assertCheckpointRejected } from "./helpers/checkpoint-rejection.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { sayTexts } from "./helpers/runtime-events.js";

// Angles (V30 §13, owner decision 2026-10-16): a number with the unit deg or rad, kept as its size in degrees.

function said(source: string): string[] {
  const result = runValidSource(`${source}\nexit`);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return sayTexts(result);
}

function errors(source: string): [string, string, string][] {
  const result = compileSource(`${source}\nexit`);
  assert.equal(result.plan, null, `${JSON.stringify(source)} must not compile`);
  return result.diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    `${source}\nexit`.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

function failure(source: string): [string | undefined, string | undefined] {
  const failed = runValidSource(`${DYNAMIC}${source}\nexit`).snapshot.failure;
  return [failed?.code, failed?.message];
}

/** Hides a value's type from the compiler, so a contradiction reaches the runtime check. */
const DYNAMIC = "function dynamic(value) {\n  return value\n}\n";

test("a unit of angle follows a number, pi, a name, a member, an element, a call, or parentheses", () => {
  assert.deepEqual(
    said(
      [
        'say "${90 deg} ${90 degree} ${90 degrees} ${1 rad} ${1 radian} ${2 radians} ${pi rad}"',
        "let half = 90",
        "let turn = { quarter: 90 }",
        "let items = [30]",
        'say "${half deg} ${turn.quarter deg} ${items[0] deg} ${abs(-45) deg} ${(half / 2) deg}"',
        // It binds like a duration unit: `a + b rad` is `a + (b rad)`.
        "let a = 10 deg",
        'say "${a + half deg} ${-(1 rad)}"',
        // A unit word is a name where no unit can stand.
        "let rad = 2",
        "let deg = rad + 1",
        'say "${rad} ${deg} ${rad rad} ${deg deg}"',
      ].join("\n"),
    ),
    [
      "90° 90° 90° 57.29577951308232° 57.29577951308232° 114.59155902616465° 180°",
      "90° 90° 30° 45° 45°",
      "100° -57.29577951308232°",
      "2 3 114.59155902616465° 3°",
    ],
  );
  assert.deepEqual(errors("let a = 90deg"), [
    ["TSP033", "A unit needs a space before it. Write '90 deg'.", "deg"],
  ]);
  assert.deepEqual(errors("let h = 1\nlet a = (h)rad"), [
    ["TSP033", "A unit needs a space before it. Write '(h) rad'.", "rad"],
  ]);
  assert.deepEqual(errors("let a = 90 deg rad"), [
    ["TSP033", "This angle already has a unit. Remove the 'rad' after it.", "rad"],
  ]);
  assert.deepEqual(errors("let a = 90 deg 30 deg"), [
    ["TSP033", "Add the parts of an angle with '+', as in '90 deg + 30 deg'.", "30 deg"],
  ]);
  assert.deepEqual(errors("let a = 5 s deg"), [
    ["TSP033", "This duration already has a unit. Remove the 'deg' after it.", "deg"],
  ]);
});

test("exact angles give exact results, and the inverse functions give angles", () => {
  assert.deepEqual(
    said(
      [
        'say "${sin(30 deg)} ${cos(90 deg)} ${tan(45 deg)} ${sin(pi rad)} ${cos(pi rad)} ${sin(-390 deg)}"',
        'say "${toDeg(pi rad)} ${toRad(180 deg)} ${toDeg(90 deg)} ${toRad(1 rad)} ${toRad(-0 deg)}"',
        'say "${asin(0.5)} ${acos(-1)} ${atan(1)} ${atan2(1, -1)} ${atan2(0, 0)} ${sin(asin(0.5))}"',
        "say 180 deg == pi rad",
        "let height: number = sin(30 deg) * 10",
        "let heading: angle = atan2(1, 1)",
        "say height",
        "say heading",
      ].join("\n"),
    ),
    [
      "0.5 0 1 0 -1 -0.5",
      "180 3.141592653589793 90 1 0",
      "30° 180° 45° 135° 0° 0.5",
      "true",
      "5",
      "45°",
    ],
  );
});

test("angles add, subtract, scale, divide, and compare by size", () => {
  assert.deepEqual(
    said(
      [
        'say "${90 deg + 1 rad} ${90 deg - 30 deg} ${-(45 deg)} ${90 deg * 2} ${2 * 90 deg} ${90 deg / 4}"',
        'say "${90 deg / 45 deg} ${pi rad / 90 deg} ${90 deg < 2 rad} ${1 rad >= 57 deg} ${360 deg != 2 * pi rad}"',
        'say "${min(90 deg, 1 rad)} ${max(10 deg, 2 rad, 30 deg)} ${max([10 deg, 2 rad])}"',
        "let angles = [3 rad, 10 deg, 1 rad]",
        "angles.sort()",
        "say angles",
        "say set[90 deg, pi rad / 2, 180 deg].length",
      ].join("\n"),
    ),
    [
      "147.29577951308232° 60° -45° 180° 180° 22.5°",
      "2 2 true true false",
      "57.29577951308232° 114.59155902616465° 114.59155902616465°",
      "[10°, 57.29577951308232°, 171.88733853924697°]",
      "2",
    ],
  );
});

test("sum adds angles, while the other statistics and the numeric functions do not take them", () => {
  assert.deepEqual(
    said('say sum([350 deg, 10 deg])\nsay sum([{ turn: pi rad }, { turn: 90 deg }], by: "turn")'),
    ["360°", "270°"],
  );
  const wraps = (name: string) =>
    `${name} does not take angles: angles wrap around at 360°, so the average of 350° and 10° would not be 0°. Convert them first, as in 'toDeg(angle)', if a plain ${name} is what you want.`;
  for (const [name, call] of [
    ["average", "average([350 deg, 10 deg])"],
    ["median", 'median([{ turn: 1 rad }], by: "turn")'],
    ["percentile", "percentile([1 deg], 50)"],
    ["stddev", "stddev([1 deg, 2 deg])"],
    ["linearRegression", 'linearRegression([{ y: 1 deg }, { y: 2 deg }], y: "y")'],
    ["predict", "predict(linearRegression([1, 2]), 3 deg)"],
  ] as const) {
    assert.deepEqual(
      errors(`say ${call}`).map(([, message]) => message),
      [wraps(name)],
      call,
    );
    const hidden = call
      .replace(/\(\[(.*)\]/u, "(dynamic([$1])")
      .replace(/, 3 deg\)/u, ", dynamic(3 deg))");
    assert.deepEqual(failure(`say ${hidden}`)[1], wraps(name), hidden);
  }
  const numeric =
    "abs(...) needs a number, not an angle. Convert it to a number of degrees with toDeg(...) first.";
  assert.deepEqual(
    errors("say abs(-90 deg)").map(([, message]) => message),
    [numeric],
  );
  assert.deepEqual(failure("say abs(dynamic(-90 deg))"), ["TSR059", numeric]);
});

test("an angle shows in degrees with a degree sign, alone and in collection notation", () => {
  assert.deepEqual(
    said(
      [
        "let a = 1 rad",
        "say a",
        'say "${pi rad} ${toString(-0.5 deg)}"',
        "say [90 deg, a]",
        "say set[45 deg]",
        "say { heading: 30 deg, turns: [pi rad] }",
        'say dict{ "north": 0 deg }',
        'say [a].join(", ")',
        "say toJson({ heading: 90 deg, turns: [pi rad] })",
      ].join("\n"),
    ),
    [
      "57.29577951308232°",
      "180° -0.5°",
      "[90°, 57.29577951308232°]",
      "[45°]",
      "{ heading: 30°, turns: [180°] }",
      'dict{ "north": 0° }',
      "57.29577951308232°",
      '{"heading":90,"turns":[180]}',
    ],
  );
});

test("a plain number where an angle is needed, and other combinations, are errors that name what works", () => {
  for (const [source, message, span] of [
    [
      "let s = sin(90)",
      "sin needs an angle: write 'sin(90 deg)' for degrees or 'sin(1.5 rad)' for radians.",
      "90",
    ],
    [
      "let c = cos(1.5)",
      "cos needs an angle: write 'cos(90 deg)' for degrees or 'cos(1.5 rad)' for radians.",
      "1.5",
    ],
    [
      "let t = tan(45)",
      "tan needs an angle: write 'tan(45 deg)' for degrees or 'tan(1.5 rad)' for radians.",
      "45",
    ],
    ['let s = sin("90")', "sin(...) needs an angle, not text (string).", '"90"'],
    ["let a = asin(30 deg)", "asin(...) needs a number, not an angle.", "30 deg"],
    ["let d = toDeg(pi)", "toDeg needs an angle: write 'toDeg(pi rad)' for radians.", "pi"],
    ["let r = toRad(180)", "toRad needs an angle: write 'toRad(180 deg)' for degrees.", "180"],
    ['let d = toDeg("x")', "toDeg(...) needs an angle, not text (string).", '"x"'],
    [
      "let t = tan(90 deg)",
      "tan(90°) has no result: the tangent of 90° is infinite.",
      "tan(90 deg)",
    ],
    [
      "let a = 90 deg + 3",
      "An angle and a number cannot be combined with '+'. Give the number a unit, such as '3 deg'.",
      "90 deg + 3",
    ],
    [
      "let s = sin(pi / 6 rad)",
      "'/' cannot combine a number and an angle. Group the numbers before the unit, as in '(pi / 6) rad'.",
      "pi / 6 rad",
    ],
    [
      "let a = 3 - 90 deg",
      "An angle and a number cannot be combined with '-'. Give the number a unit, such as '3 deg'. Or group the numbers before the unit, as in '(3 - 90) deg'.",
      "3 - 90 deg",
    ],
    [
      "let a = 90 deg * 2 deg",
      "'*' cannot combine an angle and an angle. Add or subtract two angles, or multiply or divide an angle by a number.",
      "90 deg * 2 deg",
    ],
    [
      "let a = 90 deg % 360 deg",
      "'%' cannot combine an angle and an angle. Add or subtract two angles, or multiply or divide an angle by a number.",
      "90 deg % 360 deg",
    ],
    [
      "let a = 5 s + 90 deg",
      "'+' cannot combine a duration and an angle. Add or subtract two angles, or multiply or divide an angle by a number.",
      "5 s + 90 deg",
    ],
    [
      "let a = 90 deg < 3",
      "'<' compares two numbers, two texts, two durations, two calendar durations, or two angles, but these are an angle and a whole number (integer).",
      "90 deg < 3",
    ],
    [
      'let a = ("x") deg',
      "A unit follows a number, but this is text (string). Use a number before the 'deg'.",
      '("x")',
    ],
    [
      "let a = (90 deg) rad",
      "A unit follows a number, but this is an angle. Remove the 'rad' after it.",
      "(90 deg)",
    ],
    [
      "let a: angle = 90",
      "'a' is declared as angle, so it cannot start as a whole number (integer). Give the number a unit, such as '90 deg'.",
      "90",
    ],
    [
      "let a = 90 deg\nlet b = a.degrees",
      "An angle has no property 'degrees'. Use 'toDeg(a)' for its size in degrees.",
      "degrees",
    ],
    [
      "let a = 1e308 rad",
      "This calculation gives an angle too large to represent. Use a smaller angle.",
      "1e308 rad",
    ],
  ] as const)
    assert.deepEqual(
      errors(source).map(([, text, at]) => [text, at]),
      [[message, span]],
      source,
    );
  // Grouping is suggested only for a number before the unit: grouping a duration would not fix it.
  assert.ok(
    errors("let a = 1 / (2 s) rad").every(([, message]) => !message.includes("Group the numbers")),
  );
});

test("where the compiler cannot see the type, the same mistakes fail at runtime", () => {
  for (const [source, code, message] of [
    [
      "say sin(dynamic(90))",
      "TSR059",
      "sin needs an angle: write 'sin(90 deg)' for degrees or 'sin(1.5 rad)' for radians.",
    ],
    ["say asin(dynamic(30 deg))", "TSR059", "asin(...) needs a number, not an angle."],
    [
      "say toRad(dynamic(180))",
      "TSR059",
      "toRad needs an angle: write 'toRad(180 deg)' for degrees.",
    ],
    [
      "say tan(dynamic(-90 deg))",
      "TSR036",
      "tan(-90°) has no result: the tangent of -90° is infinite.",
    ],
    [
      "say dynamic(90 deg) + dynamic(3)",
      "TSR009",
      "'+' cannot combine an angle (90°) and the number 3. Add or subtract two angles, or multiply or divide an angle by a number.",
    ],
    [
      "say dynamic(5 s) - dynamic(90 deg)",
      "TSR009",
      "'-' cannot combine a duration (5 seconds) and an angle (90°). Add or subtract two angles, or multiply or divide an angle by a number.",
    ],
    [
      "say dynamic(90 deg) >= dynamic(3)",
      "TSR009",
      "'>=' cannot compare an angle (90°) with a number (3). Use an angle on both sides.",
    ],
    [
      'say dynamic("x") rad',
      "TSR027",
      "A unit follows a number, but this is text (string) \"x\". Use a number before the 'rad'.",
    ],
    [
      "say dynamic(1e308) rad",
      "TSR036",
      "The number 1e+308 before the 'rad' gives an angle too large to represent. Use a smaller number.",
    ],
    [
      "say dynamic(90 deg) / dynamic(0 deg)",
      "TSR036",
      "Division by zero: 90° / 0° has no result. Check that the divisor is not 0° first.",
    ],
    [
      "say min(dynamic(90 deg), dynamic(3))",
      "TSR059",
      "min(...) needs values of one kind: all numbers, all durations, all calendar durations, all angles, or all dates, times, datetimes, or absolute dates and times.",
    ],
    [
      "say [dynamic(90 deg), dynamic(3)].sort()",
      "TSR060",
      "sort() needs elements of one kind, but this list has angles and numbers.",
    ],
    [
      "wait dynamic(90 deg)",
      "TSR050",
      "A wait takes a duration, but this is 90°. Use a duration such as '30 s'.",
    ],
  ] as const)
    assert.deepEqual(failure(source), [code, message], source);
});

test("an angle is a type of its own in annotations, unions, type tests, and choices", () => {
  assert.deepEqual(
    said(
      [
        DYNAMIC,
        "let a: angle = 90 deg",
        "let b: angle | null = null",
        "b = a",
        "let items: angle[] = [a, 1 rad]",
        'say "${dynamic(a) is angle} ${dynamic(90) is angle} ${dynamic(90 deg) is number} ${dynamic(90 deg) == dynamic(90)}"',
        "say [b, items.last]",
      ].join("\n"),
    ),
    ["true false false false", "[90°, 57.29577951308232°]"],
  );
  // A case compares by size, so `180 deg` and `pi rad` are one case value.
  const turn = [
    DYNAMIC,
    "let turn: angle = dynamic(pi rad)",
    "switch turn {",
    "  case 90 deg {",
    '    say "right"',
    "  }",
    "  case 180 deg {",
    '    say "back"',
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(said(turn), ["back"]);
  assert.deepEqual(
    errors(turn.replace("case 90 deg", "case pi rad")).map(([code, message]) => [code, message]),
    [["TSV048", "The case value 180 deg already appears on line 7. Remove one of them."]],
  );

  const plan = compileValidPlan("let pick = askChoice [90 deg, pi rad]\nsay [pick]\nexit");
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  const action = waiting.snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.ui.kind === "choice");
  assert.deepEqual(
    action.ui.options.map((option) => [option.text, option.value]),
    [
      ["90°", { kind: "angle", degrees: 90 }],
      ["180°", { kind: "angle", degrees: 180 }],
    ],
  );
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, waiting.snapshot)),
  ).snapshot;
  const completed = completeAction(plan, restored, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "selectedOption", optionIndex: 1 },
  });
  assert.deepEqual(sayTexts(run(plan, completed.snapshot)), ["[180°]"]);
});

test("the angles of a choice's buttons decide comparisons, cases, and type tests, as durations do", () => {
  const warned = (source: string): [string, string, string][] => {
    const result = compileSource(`${source}\nexit`);
    assert.notEqual(result.plan, null, `${JSON.stringify(source)} must compile`);
    return result.diagnostics.map((diagnostic) => [
      diagnostic.code,
      `${source}\nexit`.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
      diagnostic.message,
    ]);
  };
  const choice = "let a = askChoice 90 deg, 180 deg\n";
  const switched = (cases: string) => `${choice}switch a {\n${cases}}`;
  const always = (subject: string, values: string, outcome: string) =>
    `'${subject}' is always ${values} here, so this ${outcome}.`;
  // A button angle is its size in degrees, which is never a number or another angle: shown with a degree sign.
  const warnings: [string, string, string][] = [
    [
      `${choice}let same = a == 45 deg`,
      "a == 45 deg",
      always("a", "90° or 180°", "comparison is always false"),
    ],
    [
      `${choice}let differ = a != 45 deg`,
      "a != 45 deg",
      always("a", "90° or 180°", "comparison is always true"),
    ],
    [
      `${choice}let same = a == 90`,
      "a == 90",
      always("a", "90° or 180°", "comparison is always false"),
    ],
    [
      "let n = askChoice 90, 180\nlet same = n == 90 deg",
      "n == 90 deg",
      always("n", "90 or 180", "comparison is always false"),
    ],
    [
      `${choice}let whole = a is angle`,
      "a is angle",
      always("a", "90° or 180°", "test is always true"),
    ],
    [
      `${choice}let b = -a\nlet same = b == 90 deg`,
      "b == 90 deg",
      always("b", "-90° or -180°", "comparison is always false"),
    ],
    [
      "let a = askChoice 1.5 deg, null\nlet same = a == 2 deg",
      "a == 2 deg",
      always("a", "null or 1.5°", "comparison is always false"),
    ],
    [
      "let value: angle | integer = askChoice 90 deg, 2\nlet same = value == 3 deg",
      "value == 3 deg",
      always("value", "90° or 2", "comparison is always false"),
    ],
    [
      switched('  case 45 deg {\n    say "x"\n  }\n  case 90 deg {\n    say "y"\n  }\n'),
      "45 deg",
      always("a", "90° or 180°", "case never matches"),
    ],
    [
      'let a: angle | string = askChoice 90 deg, "x"\nswitch a {\n  case is angle {\n    say "x"\n  }\n  case 90 deg {\n    say "y"\n  }\n  case "x" {\n    say "z"\n  }\n}',
      "90 deg",
      "'case is angle' on line 3 already takes 90 deg, so this case never matches.",
    ],
  ];
  for (const [source, written, message] of warnings)
    assert.deepEqual(warned(source), [["TSV046", written, message]], source);
  // A value a button gives, also in other units, may match; so may any angle once another one is stored.
  for (const source of [
    `${choice}let same = a == 90 deg`,
    "let a = askChoice 90 deg, pi rad\nlet same = a == 180 deg",
    "let a = askChoice 1 rad, 2 rad\nlet same = a == 1 rad",
    `${choice}let b = -a\nlet same = b == -90 deg`,
    `${choice}a = 45 deg\nlet same = a == 45 deg`,
    "let value: angle | integer = askChoice 90 deg, 2\nlet same = value == 2",
    switched('  case pi rad {\n    say "x"\n  }\n'),
  ])
    assert.deepEqual(warned(source), [], source);
});

test("angles in variables, lists, and objects resume from every checkpoint, and malformed angles are rejected", () => {
  const source = [
    "let heading = 30 deg",
    "let turns = [pi rad, heading * 2]",
    "let pose = { heading: heading, tilt: -(1 rad) }",
    "wait 1 s",
    "heading += 15 deg",
    "turns.add(pose.tilt)",
    "say { heading: heading, turns: turns, pose: pose, sine: sin(heading - 15 deg) }",
    "exit",
  ].join("\n");
  const result = assertRuntimeResumeEquivalent(source);
  assert.deepEqual(
    result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    [
      "{ heading: 45°, turns: [180°, 60°, -57.29577951308232°], pose: { heading: 30°, tilt: -57.29577951308232° }, sine: 0.5 }",
    ],
  );

  const plan = compileValidPlan(source);
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  const serialized = serializeCheckpoint(createCheckpoint(plan, waiting.snapshot));
  for (const change of [{ degrees: "30" }, { degrees: null }, { unit: "deg" }]) {
    // EVIDENCE: fixture: the parsed checkpoint was serialized from a valid snapshot just above.
    const json = JSON.parse(serialized) as { snapshot: RuntimeSnapshot };
    const binding = json.snapshot.frames[0]!.bindings.find((entry) => entry.name === "heading");
    assert.ok(binding !== undefined && typeof binding.value === "object" && binding.value !== null);
    Object.assign(binding.value, change);
    assertCheckpointRejected(json, "TSK002");
  }
  assert.equal(validateSerializableValue({ kind: "angle", degrees: Number.NaN }) === null, false);
  assert.equal(validateSerializableValue({ kind: "angle", degrees: -400 }), null);

  // A plan's angle unit is deg or rad.
  const planned = compileValidPlan("let n = 3\nlet a = n rad\nexit");
  const forged = JSON.parse(JSON.stringify(planned).replace('"unit":"rad"', '"unit":"grad"'));
  assert.equal(validateInstructionPlan(forged).valid, false);
});
