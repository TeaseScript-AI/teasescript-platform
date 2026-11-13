// The asks on the candidate route (#2488's step 1d): every ask but `askForm` and `askBooleans`, its answer stored into
// typed places and run with the player's answers as today's compiler runs it, `as` each speaker, the prefills and
// choices the route refuses, and the order an ask refuses a request in, the derived oracle's too (the lead's R38, R39,
// R40, R42).

import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileProjectWithBackend } from "../../../src/compiler.js";
import type { InstructionPlan } from "../../../src/plan/model.js";
import { run } from "../../../src/runtime/engine.js";
import { completeAction } from "../../../src/runtime/operations/complete-action.js";
import type { SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { SliceIndex } from "../../../src/type-inference/core/check-result/slice-index.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import { recordOfFile, runGlobals } from "../../helpers/type-core-route.js";
import { evaluateProject } from "../../helpers/type-core/derived/derived-transfers.js";
import { syntaxOf } from "../../helpers/type-core/derived/type-core-derived.js";
import { derive } from "../../helpers/type-core/derived/type-core-derived-checks.js";
import { HELD_MODES } from "../../helpers/type-core-held-host.js";
import { createImmediatePacingRuntimeSnapshot } from "../../helpers/immediate-pacing-runtime.js";
import { checksOf } from "../../helpers/type-core/type-core-candidate-setup.js";

const OPTIONS = { globals: ["hostValue"] };
// (blank text too: every prefill takes it as none, V30 §20)
const DOMAIN: readonly SerializableRuntimeValue[] = [2, "text", true, 2.5, null, "", "  "];

/** The answer the player gives each field: valid text, a number, a date or time, a password's hash, the first button. */
const TEMPORAL: Readonly<Record<string, string>> = {
  date: "2027-04-17",
  time: "14:30",
  datetime: "2027-04-17T18:00",
};
function answer(ui: { readonly kind: string; readonly temporalKind?: string }) {
  switch (ui.kind) {
    case "text":
      return { kind: "submittedText", submittedText: "x" };
    case "number":
      return { kind: "submittedText", submittedText: "2" };
    case "temporal":
      return { kind: "submittedText", submittedText: TEMPORAL[ui.temporalKind!]! };
    case "password":
      return { kind: "submittedPassword", hash: "a".repeat(64) };
    case "choice":
      return { kind: "selectedOption", optionIndex: 0 };
    case "form":
      return { kind: "submit" };
    default:
      throw new Error(`no answer to a ${ui.kind}`);
  }
}

/** A run of `plan` with `hostValue`, each ask answered (`answer`): how it ends, what it said, and how many answers. */
function answered(plan: InstructionPlan, hostValue: SerializableRuntimeValue): string {
  let result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue } }));
  const events = [...result.events];
  let answers = 0;
  for (
    let action = result.snapshot.foregroundAction;
    result.snapshot.status === "waiting" && action?.kind === "interaction" && answers < 4;
    action = result.snapshot.foregroundAction
  ) {
    const done = completeAction(plan, result.snapshot, {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: action.interactionKind,
      payload: answer(action.ui),
    });
    assert.equal(done.outcome.kind, "completed", JSON.stringify(done.outcome));
    answers += 1;
    result = run(plan, done.snapshot);
    events.push(...done.events, ...result.events);
  }
  const failure = events.find((event) => event.kind === "runtimeFailure");
  const said = events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
  const failed =
    failure?.kind === "runtimeFailure"
      ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset}`
      : "-";
  return `${result.snapshot.status} ${failed} after ${answers} [${said.join(" | ")}]`;
}

/** Today's compile errors of a source, and its plan. */
function today(source: string) {
  const compiled = compileProject([{ path: "main.tease", source }], OPTIONS);
  return {
    plan: compiled.plan,
    errors: compiled.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => diagnostic.code),
  };
}

/** The route's refusal of a source in a mode, `what: text`, or its plan. */
function route(
  source: string,
  mode: (typeof HELD_MODES)[number],
): { readonly refused: string } | { readonly plan: InstructionPlan | null } {
  try {
    const { plan } = mode.run(() =>
      compileProjectWithBackend([{ path: "main.tease", source }], OPTIONS, CORE_BACKEND),
    );
    return { plan };
  } catch (error) {
    if (!(error instanceof CandidateOutsideSlice)) throw error;
    return { refused: `${error.what}: ${source.slice(error.site.start, error.site.end)}` };
  }
}

/** A source the route publishes in every mode with today's checks, its answered runs equal to today's. */
function asToday(source: string): void {
  const current = today(source);
  assert.ok(current.plan !== null, `${source}: today ${current.errors.join(" ")}`);
  for (const mode of HELD_MODES) {
    const own = route(source, mode);
    const at = `${source} [${mode.name}]`;
    assert.ok("plan" in own && own.plan !== null, `${at}: ${JSON.stringify(own)}`);
    const carried = new Set(checksOf(own.plan));
    assert.deepEqual(
      checksOf(current.plan).filter((check) => !carried.has(check)),
      [],
      `${at}: today's checks`,
    );
    assert.deepEqual(
      DOMAIN.map((hostValue) => answered(own.plan!, hostValue)),
      DOMAIN.map((hostValue) => answered(current.plan!, hostValue)),
      `${at}: runs`,
    );
  }
}

/** A source today's checker refuses with `code` and the route refuses in every mode with `refused`. */
function refusedAsToday(source: string, code: string, refused: string): void {
  const current = today(source);
  assert.equal(current.plan, null, source);
  assert.ok(current.errors.includes(code), `${source}: today ${current.errors.join(" ")}`);
  for (const mode of HELD_MODES)
    assert.deepEqual(route(source, mode), { refused }, `${source} [${mode.name}]`);
}

/** Each ask but `askForm` and the type of its answer. */
const ANSWERS: readonly (readonly [string, string])[] = [
  ['askText("q")', "string"],
  ['askNumber("q")', "number"],
  ['askInteger("q")', "integer"],
  ['askDate("q")', "date"],
  ['askTime("q")', "time"],
  ['askDateTime("q")', "datetime"],
  ['askPassword("q")', "string"],
  ['askBoolean("q")', "boolean"],
  ["askChoice 1, 2", "integer"],
  ['askChoice "a", "b"', "string"],
];

test("each ask's answer stored into a typed place runs as today's: its type, optional, through a later typed let", () => {
  for (const [ask, type] of ANSWERS) {
    asToday(`let r: ${type} = ${ask}\nsay "after"\nexit\n`);
    asToday(`let r: ${type}? = ${ask}\nsay "after"\nexit\n`);
    asToday(`let r = ${ask}\nlet s: ${type} = r\nsay "after"\nexit\n`);
    // the answer in place of the host global, with the host global's run checks
    asToday(`let r: ${type} = hostValue otherwise ${ask}\nsay "after"\nexit\n`);
  }
});

test("an ask's answer stored where it does not fit is today's compile error, and the route publishes nothing", () => {
  for (const [ask, type] of ANSWERS) {
    const misfit = type === "integer" ? "string" : "integer";
    const source = `let r: ${misfit} = ${ask}\nexit\n`;
    const current = today(source);
    assert.equal(current.plan, null, source);
    for (const mode of HELD_MODES) {
      const own = route(source, mode);
      assert.ok(!("plan" in own) || own.plan === null, `${source} [${mode.name}]`);
    }
  }
});

test("an ask as a speaker, declared or the player, and in a message, a condition, a count and an index runs as today's", () => {
  for (const source of [
    'speaker boss {\n  displayName: "Boss"\n}\nlet r: integer = askInteger as boss("q")\nsay as boss "after"\nexit\n',
    'let r: boolean = askBoolean as player "q", yesText: "y", noText: "n"\nexit\n',
    'say askText("q")\nexit\n',
    'if askBoolean("q") {\n  say "y"\n}\nexit\n',
    'repeat askInteger("q") {\n  say "r"\n}\nexit\n',
    'let r = [1, 2][askInteger("q")]\nexit\n',
    'let r = askText bubble(color: hostValue) "q"\nexit\n',
    'let r = askText as player prose(align: "center") ("q", hint: hostValue, prefill: "p")\nexit\n',
  ])
    asToday(source);
});

test("a prefill that may be null among the kinds its request takes runs as today's", () => {
  for (const source of [
    'let m: string? = hostValue\nlet r = askText("q", prefill: m)\nexit\n',
    'let m: integer? = hostValue\nlet r = askInteger("q", prefill: m)\nexit\n',
    'let m: boolean? = hostValue\nlet r = askBoolean("q", prefill: m)\nexit\n',
    'let r = askText("q", prefill: ["a", null][1])\nexit\n',
    'let r = askText("q", prefill: hostValue)\nexit\n',
    "let r = askChoice 1, 2, prefill: null\nexit\n",
  ])
    asToday(source);
});

test("a choice whose buttons are one type by V30's rules runs as today's", () => {
  // (a whole number with a number, and `null` beside a type, are one type: not R40's mix)
  for (const ask of ["askChoice 1, 2.5", "askChoice 1, null", "askChoice [1, 2.5]"])
    asToday(`let r = ${ask}\nsay "after"\nexit\n`);
});

test("the prefills, choices and asks the route refuses: today's compile error each", () => {
  // `askPassword` takes no prefill (an (S) where the route ran: the request was passed a value it does not take)
  refusedAsToday(
    'let r = askPassword("q", prefill: hostValue)\nexit\n',
    "TSV043",
    'this ask: askPassword("q", prefill: hostValue)',
  );
  // a literal the request does not take as written (blank text; a whole number written as a number; one past the safe
  // range: the plan's request would hold it, whose validation refuses it)
  for (const [ask, prefill] of [
    ["askText", '"  "'],
    ["askText", "2"],
    ["askInteger", "2.0"],
    ["askInteger", "9007199254740993"],
    ["askBoolean", "null"],
    ["askDate", '"2027-04-17"'],
  ])
    refusedAsToday(
      `let r = ${ask}("q", prefill: ${prefill})\nexit\n`,
      "TSV039",
      `this ask: ${ask}("q", prefill: ${prefill})`,
    );
  // a prefill that is only null, as the core knows it: computed, or narrowed
  for (const [source, prefill] of [
    ['let r = askText("q", prefill: [null][0])\nexit\n', "[null][0]"],
    ['let r = askText("q", prefill: null otherwise null)\nexit\n', "null otherwise null"],
    [
      'let m: string? = hostValue\nif m == null {\n  let r = askText("q", prefill: m)\n}\nexit\n',
      "m",
    ],
    [
      'let m: string? = hostValue\nif m != null {\n  exit\n}\nlet r = askNumber("q", prefill: [m].get(0, default: null))\nexit\n',
      "[m].get(0, default: null)",
    ],
  ])
    refusedAsToday(source, "TSV039", `this prefill: ${prefill}`);
  // a written type only `null` fills, wherever the value goes from it: the slice takes no such type (the lead's R44)
  for (const [written, at, prefill] of [
    ["null", "null", "m"],
    ["null", "null", "[m][0]"],
    ["null", "null", "m otherwise m"],
    ["null", "null", "[[m]][0][0]"],
    ["null", "null", "[m].get(0, default: null)"],
    ["null?", "null?", "m otherwise m"],
    ["null[]", "null", "[m[0]][0]"],
  ])
    refusedAsToday(
      `let m: ${written} = hostValue\nlet r = askText("q", prefill: ${prefill})\nexit\n`,
      "TSV039",
      `this written type: ${at}`,
    );
  refusedAsToday(
    'let m: null = hostValue\nlet p = m otherwise m\nlet r = askInteger("q", prefill: p)\nexit\n',
    "TSV039",
    "this written type: null",
  );
  refusedAsToday(
    'let m: null = hostValue\nfor x in [m otherwise m] {\n  let r = askBoolean("q", prefill: x)\n}\nexit\n',
    "TSV039",
    "this written type: null",
  );
  // a prefill that may be text at an ask of another kind: blank text is none to the runtime, and the core's kinds do not
  // tell blank text from other text
  for (const ask of ["askNumber", "askInteger", "askDate", "askTime", "askDateTime", "askBoolean"])
    for (const [prelude, prefill] of [
      ['let b = ""\n', "b"],
      ['let b = "  "\n', "b"],
      ["let m: string = hostValue\n", "m"],
      ["let m: string? = hostValue\n", "m"],
      ['let o = {p: ""}\n', "o.p"],
      ["let m: string = hostValue\n", "[m][0]"],
      ["let m: string = hostValue\n", "m otherwise m"],
      ["let m: string = hostValue\n", "{p: m}.p"],
    ])
      refusedAsToday(
        `${prelude}let r = ${ask}("q", prefill: ${prefill})\nexit\n`,
        "TSV039",
        `this prefill: ${prefill}`,
      );
  // a choice whose buttons return more than one type, whatever holds its answer (R40)
  refusedAsToday(
    'let r: integer = askChoice 1, "a"\nexit\n',
    "TSV041",
    'this ask: askChoice 1, "a"',
  );
  refusedAsToday('let r = askChoice 1, "a"\nexit\n', "TSV044", 'this ask: askChoice 1, "a"');
  // `askForm` and `askBooleans`, the form built on it, stay outside: the core gives their answer no kind
  for (const ask of [
    'askForm "q", fields: {name: "text"}',
    'askBooleans "q", texts: ["a"], prefill: [true]',
  ])
    for (const mode of HELD_MODES)
      assert.deepEqual(
        route(`let r = ${ask}\nexit\n`, mode),
        { refused: `this ask: ${ask}` },
        mode.name,
      );
});

test("an ask refuses a request's value after saying its question, as today's runtime does", () => {
  // a prefill the runtime checks as the field opens: today's plan and the route's both say the question, then fail at
  // the ask, opening no field
  const source = 'let r = askInteger("q", prefill: hostValue)\nexit\n';
  const current = today(source);
  assert.ok(current.plan !== null);
  const ask = source.indexOf("askInteger");
  const end = source.indexOf("\n");
  for (const mode of HELD_MODES) {
    const own = route(source, mode);
    assert.ok("plan" in own && own.plan !== null, mode.name);
    for (const plan of [own.plan, current.plan])
      assert.equal(answered(plan, "text"), `failed TSR052@${ask}:${end} after 0 [q]`, mode.name);
  }
});

test("the derived oracle ends an ask's run as the route's plan does: its question said, then its request's failure", () => {
  // (a request that fails after its question is said keeps it said; a failing question says nothing; a wait)
  const list = { kind: "list", items: [1] } satisfies SerializableRuntimeValue;
  const cases: readonly (readonly [string, SerializableRuntimeValue])[] = [
    ['let r = askInteger("q", prefill: hostValue)\nexit\n', "text"],
    ['let r = askText("q", hint: hostValue)\nexit\n', list],
    ['let r = askDate("q", prefill: hostValue)\nexit\n', 2],
    ['let r = askBoolean("q", yesText: hostValue)\nexit\n', list],
    ['let r = askBoolean("q", prefill: hostValue)\nexit\n', 2],
    ["let r = askText(hostValue)\nexit\n", list],
    ['let r = askInteger("q", prefill: hostValue)\nexit\n', 2],
  ];
  for (const [source, hostValue] of cases) {
    const files = [{ path: "main.tease", source }];
    const request = coreRequest(files, OPTIONS.globals);
    assert.ok(request !== null, source);
    const record = compactAnalysis(request);
    const syntax = syntaxOf(source);
    const project = [
      { path: "main.tease", syntax, ...derive(syntax, recordOfFile(record, "main.tease")) },
    ];
    const own = route(source, HELD_MODES[0]!);
    assert.ok("plan" in own && own.plan !== null, source);
    assert.deepEqual(
      evaluateProject(project, { hostValue }).run,
      runGlobals(own.plan, { hostValue }),
      `${source} with ${JSON.stringify(hostValue)}`,
    );
  }
});

test("an ask's presentation options are no written property names: the program's field order is its records'", () => {
  const source = 'let a = askText prose(align: "center") "q"\nlet r = {zeta: 1, align: 2}\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const index = new SliceIndex(request.files.map((file) => file.program));
  assert.deepEqual(index.inWrittenOrder(["align", "zeta"]), ["zeta", "align"]);
});
