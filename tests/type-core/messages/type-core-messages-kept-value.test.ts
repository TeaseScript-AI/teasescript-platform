// A value kept in a variable: an askChoice of more than one type (#1352) and the kept value's free name (#1274).

import assert from "node:assert/strict";
import test from "node:test";
import { compileProject, compileSourceWithBackend } from "../../../src/compiler.js";
import { CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../../src/type-inference/core/budget.js";
import { coreCheckResult } from "../../../src/type-inference/core/check-result/check-result.js";
import { SliceIndex } from "../../../src/type-inference/core/check-result/slice-index.js";
import { coreMessage, messageSource } from "../../../src/type-inference/core/messages.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";
import { reported, main } from "../../helpers/type-core/type-core-messages-setup.js";

const MIXED = "This askChoice returns a whole number (integer) or text (string).";
const BUTTONS = "or give every button a value of one type.";
const C = 'askChoice [{text: "A", value: 1}, {text: "B"}]';
const S = 'askChoice "None", [5, 10]';
const call = "function f(p) {\n  say p\n}\n";
// [source, the error's sentence after MIXED or, from "This askChoice", its whole message (none: no error), the code
// it replaces and the code that replaces it]
const cases: readonly (readonly [string, string | null, readonly [string, string] | null])[] = [
  [
    `let value = ${C}\nif value is integer {\n  say value + 1\n}\nexit\n`,
    `To keep both, declare the variable as 'let value: integer | string = ${C}', ${BUTTONS}`,
    ["let value =", "let value: integer | string ="],
  ],
  [
    `let other = ${S}\nexit\n`,
    `To keep both, declare the variable as 'let other: integer | string = ${S}', ${BUTTONS}`,
    ["let other =", "let other: integer | string ="],
  ],
  [
    `let opts = [{text: "A", value: 1}, {text: "B"}]\nlet value = askChoice opts\nexit\n`,
    `To keep both, declare the variable as 'let value: integer | string = askChoice opts', ${BUTTONS}`,
    ["let value =", "let value: integer | string ="],
  ],
  [
    `${call}f(1)\nf(${S})\nexit\n`,
    `To keep both, declare the parameter as 'p: integer | string', ${BUTTONS}`,
    ["f(p)", "f(p: integer | string)"],
  ],
  [
    `function g {\n  return ${S}\n}\nsay g()\nexit\n`,
    `To return both, declare the result type of function 'g' as 'integer | string', ${BUTTONS}`,
    ["function g {", "function g: integer | string {"],
  ],
  [
    `let xs = [${S}]\nexit\n`,
    `To keep both, declare the list as 'let xs: (integer | string)[] = [${S}]', ${BUTTONS}`,
    ["let xs =", "let xs: (integer | string)[] ="],
  ],
  [
    `let xs = []\nxs.add(${S})\nexit\n`,
    `To keep both, declare the list as 'let xs: (integer | string)[] = []', ${BUTTONS}`,
    ["let xs =", "let xs: (integer | string)[] ="],
  ],
  [
    'let v = askChoice "None", 1, null\nexit\n',
    `This askChoice returns a whole number (integer), text (string), or null. To keep both, declare the variable as 'let v: integer | string | null = askChoice "None", 1, null', ${BUTTONS}`,
    ["let v =", "let v: integer | string | null ="],
  ],
  [
    `let v = null\nv = ${S}\nexit\n`,
    `To keep both, declare the variable as 'let v: integer | string | null = null', ${BUTTONS}`,
    ["let v =", "let v: integer | string | null ="],
  ],
  [
    `let v = hostValue\nv = ${S}\nexit\n`,
    `To keep both, declare the variable as 'let v: integer | string = hostValue', ${BUTTONS}`,
    ["let v =", "let v: integer | string ="],
  ],
  [
    'let v = (askChoice "None", 1, null) otherwise 1\nexit\n',
    `This askChoice returns a whole number (integer), text (string), or null. To keep both, declare the variable as 'let v: integer | string = (askChoice "None", 1, null) otherwise 1', ${BUTTONS}`,
    ["let v =", "let v: integer | string ="],
  ],
  [
    `let xs = null\nxs = [${S}]\nexit\n`,
    `To keep both, declare the list as 'let xs: (integer | string)[]? = null', ${BUTTONS}`,
    ["let xs =", "let xs: (integer | string)[]? ="],
  ],
  [
    // (an unknown button beside two known types: the known ones decide, Codex r2 on #1660)
    `${call}f(askChoice "None", 1, hostValue)\nexit\n`,
    `To keep both, declare the parameter as 'p: integer | string', ${BUTTONS}`,
    ["f(p)", "f(p: integer | string)"],
  ],
  [
    `let xs = []\nlet v = xs.get(0, default: ${S})\nexit\n`,
    `To keep both, declare the variable as 'let v: integer | string = xs.get(0, default: ${S})', ${BUTTONS}`,
    ["let v =", "let v: integer | string ="],
  ],
  [
    `${call}f(true)\nf(${S})\nexit\n`,
    `To keep all of them, declare the parameter as 'p: integer | string | boolean', ${BUTTONS}`,
    ["f(p)", "f(p: integer | string | boolean)"],
  ],
  [
    // (a declaration on more than one line: the type in words, the variable named)
    'let v = askChoice [\n  {text: "A", value: 1},\n  {text: "B"}\n]\nexit\n',
    `To keep both, declare the variable 'v' with the type 'integer | string', ${BUTTONS}`,
    ["let v =", "let v: integer | string ="],
  ],
  [
    `let box = {value: ${S}}\nexit\n`,
    "but 'box.value' holds one type. Give every button a value of one type.",
    null,
  ],
  [
    `${call}let u: integer | string = 1\nf(u)\nf(${S})\nexit\n`,
    `To keep both, declare the parameter as 'p: integer | string', ${BUTTONS}`,
    ["f(p)", "f(p: integer | string)"],
  ],
  [`let other: integer | string = ${S}\nexit\n`, null, null],
  [`let u: integer | string = 1\nlet w = u\nw = ${S}\nexit\n`, null, null],
  [`let xs: list = [${S}]\nexit\n`, null, null],
  [`let xs: list = [{v: ${S}}]\nexit\n`, null, null],
  [`let o: object = {v: ${S}}\nexit\n`, null, null],
  ["let v = (askChoice 1, null) otherwise 2\nexit\n", null, null],
  // (a list option whose elements mix is that list's error alone)
  ['let v = askChoice ["a", 1]\nexit\n', null, null],
  [`let u: integer | string = ${S}\nlet copy = u\nexit\n`, null, null],
  ["let value = askChoice 1, 1.5\nexit\n", null, null],
  ['let value = askChoice "A", null\nexit\n', null, null],
  [
    'let value = askChoice [{text: "A", value: 1}, {text: "B", value: hostValue}]\nexit\n',
    null,
    null,
  ],
  [`let v = 1\nv = ${S}\nexit\n`, null, null],
];

// (a store warning's and a count's kept value: the variable declared with the union, which pasted compiles, or in
// words where no form is proved)
const kept: readonly (readonly [string, string, string | null])[] = [
  [
    `let o = {a: 1}\no.a = ${S}\nexit\n`,
    `Keep '${S}' in a new variable declared with the type 'integer | string' and check that it is a whole number (integer) first.`,
    null,
  ],
  [
    `let v = 1\nv = ${S}\nexit\n`,
    `Keep '${S}' in a new variable, as in 'let value: integer | string = ${S}', and check it, as in 'if value is integer { v = value }'.`,
    `let v = 1\nlet value: integer | string = ${S}\nif value is integer { v = value }\nexit\n`,
  ],
  [
    'repeat (askChoice "None", 1, null) {}\nexit\n',
    `Keep 'askChoice "None", 1, null' in a new variable, as in 'let value: integer | string | null = askChoice "None", 1, null', and check it, as in 'if value is integer { repeat (value) {} }'`,
    'let value: integer | string | null = askChoice "None", 1, null\nif value is integer { repeat (value) {} }\nexit\n',
  ],
  [
    'repeat ((askChoice "None", 1, null) otherwise 1) {}\nexit\n',
    `Keep '(askChoice "None", 1, null) otherwise 1' in a new variable, as in 'let value: integer | string = (askChoice "None", 1, null) otherwise 1', and check it, as in 'if value is integer { repeat (value) {} }'`,
    'let value: integer | string = (askChoice "None", 1, null) otherwise 1\nif value is integer { repeat (value) {} }\nexit\n',
  ],
  [
    `let xs = []\nrepeat xs.get(0, default: ${S}) {}\nexit\n`,
    `Keep 'xs.get(0, default: ${S})' in a new variable, as in 'let value: integer | string = xs.get(0, default: ${S})', and check it, as in 'if value is integer { repeat value {} }'.`,
    `let xs = []\nlet value: integer | string = xs.get(0, default: ${S})\nif value is integer { repeat value {} }\nexit\n`,
  ],
  [
    'repeat (askChoice "None", 1, hostValue) {}\nexit\n',
    `Keep 'askChoice "None", 1, hostValue' in a new variable, as in 'let value: integer | string = askChoice "None", 1, hostValue', and check it, as in 'if value is integer { repeat (value) {} }'`,
    'let value: integer | string = askChoice "None", 1, hostValue\nif value is integer { repeat (value) {} }\nexit\n',
  ],
  [
    // (a block past the nesting limit runs the finishing path, whose reads answer nothing: the walk's own record keeps
    // the union, Codex r6 on #1660)
    `repeat (${S}) {}\n${"if true {\n".repeat(257)}say "Done"\n${"}\n".repeat(257)}exit\n`,
    `Keep '${S}' in a new variable, as in 'let value: integer | string = ${S}', and check it, as in 'if value is integer { repeat (value) {} }'`,
    null,
  ],
  [
    // (a list option whose elements mix: its own error, and what its answer reaches is still recorded)
    'repeat ((askChoice ["A", 1]) otherwise 1) {}\nexit\n',
    `Keep '(askChoice ["A", 1]) otherwise 1' in a new variable declared with the type 'integer | string' and check that it is a whole number (integer) first.`,
    null,
  ],
  [
    `repeat ${C} {}\nexit\n`,
    `Keep '${C}' in a new variable, as in 'let value: integer | string = ${C}', and check it, as in 'if value is integer { repeat value {} }'.`,
    `let value: integer | string = ${C}\nif value is integer { repeat value {} }\nexit\n`,
  ],
];

const plain = "repeat hostValue.count {}\nexit\n";

/**
 * V30 §13, §19 (#1352): an `askChoice` whose buttons return more than one type is a compile error where its answer, as
 * it stands or through an `otherwise`, is stored with its type inferred (a variable's start value or a later store
 * beside an unknown, an untyped parameter's argument at either of two calls, an inferred result, a list's element, an
 * add to an empty list, an object's property), with the declaration of every type the place takes (`null` among them,
 * an optional list), which pasted compiles under both checkers, else buttons of one type in words; in four modes. An
 * argument is typed by its own call (V30 §11), whatever another call passes. A written union, a copy of one, an
 * unrestricted `list` or `object` at any depth, one type (numbers with whole numbers,
 * `null` beside a type, an `otherwise` that leaves one), a button the script cannot know (beside known types of more
 * than one, the error names those alone), a list option whose own
 * elements mix (that list's error), and a place another store decides (whose store warning keeps the choice in a
 * variable declared with the union, as a choice used directly does) get no such error.
 */
test("an askChoice of more than one type errs where its type would be inferred, and its fixes keep both (V30 §19, #1352)", () => {
  // (the current checker rejects a choice as a `get` default whatever written type receives it, a recorded difference
  // from V30 §19 as #1412's: those pastes are checked under the core alone)
  const getDefault = (source: string): boolean => source.includes(".get(0, default: askChoice");
  const v1Errors = (source: string) =>
    compileProject([{ path: "main.tease", source }], { globals: ["hostValue"] }).diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    );
  // (the error names the known types alone, whatever a button the script cannot know adds)
  const hosted = coreRequest(main('let v = askChoice "None", 1, hostValue\nexit\n'));
  assert.ok(hosted !== null);
  assert.deepEqual(
    analyseCore(hosted)
      .diagnostics.filter((diagnostic) => diagnostic.code === "TSV044")
      .map((diagnostic) => ("kinds" in diagnostic ? diagnostic.kinds : null)),
    [["integer", "string"]],
  );
  for (const [source, sentence, fix] of cases) {
    for (const mode of MODES) {
      const mixed = inMode(mode, () => reported(main(source))).filter(
        ({ code, message }) => code === "TSV044" && message.startsWith("This askChoice"),
      );
      const name = `${JSON.stringify(mode)} ${source}`;
      if (sentence === null) {
        assert.deepEqual(mixed, [], name);
        continue;
      }
      assert.equal(mixed.length, 1, name);
      assert.ok(mixed[0]!.error, name);
      assert.ok(source.includes(mixed[0]!.site) && mixed[0]!.site.startsWith("askChoice"), name);
      assert.equal(
        mixed[0]!.message,
        sentence.startsWith("This askChoice")
          ? sentence
          : sentence.startsWith("but")
            ? `${MIXED.slice(0, -1)}, ${sentence}`
            : `${MIXED} ${sentence}`,
        name,
      );
    }
    if (fix === null) continue;
    const pasted = source.replace(fix[0], fix[1]);
    assert.notEqual(pasted, source, fix[1]);
    assert.deepEqual(
      reported(main(pasted)).filter(({ error }) => error),
      [],
      `the core: ${pasted}`,
    );
    if (!getDefault(pasted))
      assert.deepEqual(v1Errors(pasted), [], `the current checker: ${pasted}`);
  }
  for (const [source, sentence, pasted] of kept) {
    // (each warning at the site gives it, the null's and the text's alike)
    const warned = reported(main(source)).filter(({ error }) => !error);
    assert.ok(
      warned.length > 0 && warned.every(({ message }) => message.includes(` ${sentence}`)),
      `${source}: ${JSON.stringify(warned)}`,
    );
    if (pasted === null) continue;
    assert.deepEqual(
      reported(main(pasted)).filter(({ error }) => error),
      [],
      `the core: ${pasted}`,
    );
    if (!getDefault(pasted))
      assert.deepEqual(v1Errors(pasted), [], `the current checker: ${pasted}`);
  }
  // (where a demand stop holds the walk's read of the answer, the kept form proves its union by a read that answers, or
  // is words: never a plain `let`, Codex r7 on #1660)
  // ([source, demand allowance, whether a read that answers proves the union there, as code or in words; else no read
  // does, and the kept form is words])
  for (const [source, allowance, union] of [
    [`repeat (${S}) {}\nexit\n`, 25, true],
    [`let xs = []\nrepeat xs.get(0, default: ${S}) {}\nexit\n`, 64, true],
    [`let xs = []\nrepeat xs.get(0, default: ${S}) {}\nexit\n`, 256, true],
    [`let xs = []\nrepeat xs.get(0, default: ${S}) {}\nexit\n`, 1, false],
    [`repeat ((${S}) otherwise 1) {}\nexit\n`, 4, true],
    // (the walk's read stopped, and a block past the nesting limit ran the finishing walk, so the read again answers
    // nothing either)
    [
      `repeat (${S}) {}\n${"if true {\n".repeat(257)}say "Done"\n${"}\n".repeat(257)}exit\n`,
      1,
      false,
    ],
  ] as const)
    for (const mode of MODES) {
      const stopped = coreRequest(main(source));
      assert.ok(stopped !== null);
      const { diagnostics } = inMode(mode, () =>
        withTestDemandAllowance(allowance, () => analyseCore(stopped)),
      );
      const text = messageSource([source], diagnostics);
      const kept = diagnostics
        .map((diagnostic) => coreMessage(diagnostic, text))
        .filter((message) => message.includes("in a new variable"));
      assert.ok(
        kept.length > 0 &&
          kept.every(
            (message) =>
              !message.includes("as in 'let value = ") &&
              (!union ||
                message.includes("let value: integer | string = ") ||
                message.includes("in a new variable declared with the type 'integer | string'")),
          ),
        `${allowance} ${JSON.stringify(mode)} ${source}: ${JSON.stringify(kept)}`,
      );
    }
  // (r7's witnesses' kept forms pasted compile: under both checkers, the `get` default's under the core alone, #1075)
  for (const pasted of [
    `let value: integer | string = ${S}\nif value is integer { repeat (value) {} }\nexit\n`,
    `let xs = []\nlet value: integer | string = xs.get(0, default: ${S})\nif value is integer { repeat value {} }\nexit\n`,
  ]) {
    assert.deepEqual(
      reported(main(pasted)).filter(({ error }) => error),
      [],
      `the core: ${pasted}`,
    );
    if (!getDefault(pasted))
      assert.deepEqual(v1Errors(pasted), [], `the current checker: ${pasted}`);
  }
  // (a program that holds no mixed askChoice gets nothing of this rule: no kept-value field, also where a stopped
  // decision leaves a subject unfound, and a warning whose facts a stop did not ask keeps main's plain kept `let`)
  const box =
    "let box = {branch: {branch: {n: 1}}}\n" +
    Array.from({ length: 12 }, (_, i) => `box.branch.branch.n = ${i + 2} + ${i + 3}\n`).join("") +
    "box = {branch: {branch: {n: 4}}}\nrepeat box.branch.branch.n {}\nexit\n";
  for (const [source, allowance] of [
    [box, 16],
    ["let xs = []\nrepeat xs.get(0, default: hostValue) {}\nexit\n", 16],
    [plain, null],
  ] as const) {
    const nonChoice = coreRequest(main(source));
    assert.ok(nonChoice !== null);
    const analysed =
      allowance === null
        ? analyseCore(nonChoice)
        : withTestDemandAllowance(allowance, () => analyseCore(nonChoice));
    assert.ok(
      analysed.diagnostics.length > 0 && analysed.diagnostics.every((d) => !("keeps" in d)),
      source,
    );
  }
  // (a stopped read of a non-mixed choice leaves an unrelated warning's subject, not found, its plain `let`: an
  // answer reaches a subject only through its own operands, Codex r8 on #1660)
  // (nor does an askChoice that is only a name in the text: a string, a comment, a property, Codex r9 on #1660)
  for (const unrelated of [
    "let xs = []\nrepeat xs.get(0, default: hostValue) {}\nrepeat (askChoice 1, null) {}\nexit\n",
    'let xs = []\nrepeat xs.get(0, default: "askChoice") {}\nexit\n',
    "let xs = []\nrepeat xs.get(0, /* askChoice */ default: hostValue) {}\nexit\n",
    "let box = {askChoice: hostValue}\nlet xs = []\nrepeat xs.get(0, default: box.askChoice) {}\nexit\n",
    // (a recorded choice in an expression that starts with the warned site but ends past it is not within it)
    'let xs = []\nrepeat xs.get(0, default: hostValue) otherwise askChoice "None", [5, 10] {}\nexit\n',
  ])
    for (const mode of MODES) {
      const request = coreRequest(main(unrelated));
      assert.ok(request !== null);
      const { diagnostics } = inMode(mode, () =>
        withTestDemandAllowance(16, () => analyseCore(request)),
      );
      const atGet = diagnostics.filter(
        (d) =>
          d.site.start === unrelated.indexOf("xs.get") &&
          d.site.end === unrelated.indexOf(") ", unrelated.indexOf("xs.get")) + 1,
      );
      assert.ok(
        atGet.length > 0 && atGet.every((d) => !("keeps" in d)),
        `${JSON.stringify(mode)} ${unrelated}`,
      );
    }
  // (a stop inside the rule's stage takes back the running choice's unit alone: the choice completed before it keeps its
  // error, Codex r10 on #1660; the stop is the second choice's read, so its own error is the one taken back)
  const two = `let a = ${S}\nlet b = ${S}\nexit\n`;
  for (const [mode, allowance] of MODES.map(
    (mode) => [mode, mode.unshared ? 1149 : 1240] as const,
  )) {
    const request = coreRequest(main(two));
    assert.ok(request !== null);
    const stopped = inMode(mode, () => withTestAllowance(allowance, () => analyseCore(request)));
    assert.equal(stopped.budget.exhausted, "work", JSON.stringify(mode));
    assert.equal(
      stopped.diagnostics.filter((d) => d.code === "TSV044").length,
      1,
      `${JSON.stringify(mode)} ${allowance}`,
    );
  }
  // (a non-mixed choice's carried subject whose own publication read stops: the honest unproved fact, its message the
  // same, though a later read of the choice itself settles, which never proves the carried subject (a second home for
  // its types); at the first allowance where the subject's read settles, no fact: the lead's amendment of ruling A on
  // #1660, worded after Codex r10)
  const unsettled = "let xs = []\nrepeat xs.get(0, default: askChoice 1, 2) {}\nexit\n";
  for (const mode of MODES) {
    const request = coreRequest(main(unsettled));
    assert.ok(request !== null);
    const stopped = inMode(mode, () => withTestDemandAllowance(1, () => analyseCore(request)));
    const text = messageSource([unsettled], stopped.diagnostics);
    const facts = stopped.diagnostics.filter((d) => "keeps" in d && d.keeps === "unproved");
    assert.ok(facts.length > 0, JSON.stringify(mode));
    for (const diagnostic of facts) {
      if (!("keeps" in diagnostic)) continue;
      const { keeps: _, ...without } = diagnostic;
      assert.equal(coreMessage(diagnostic, text), coreMessage(without, text), JSON.stringify(mode));
    }
    const settled = inMode(mode, () => withTestDemandAllowance(4, () => analyseCore(request)));
    assert.ok(
      settled.diagnostics.every((d) => !("keeps" in d)),
      `${JSON.stringify(mode)} settles at 4`,
    );
  }
  // (a `get` call's receiver is its own place, however it is grouped or chained: the choice in its arguments never
  // makes the receiver's kept form unproved, Codex r12 on #1660)
  for (const receiverForm of ["(xs)", "((xs))", "(xs.get(0, default: hostValue))", "(f())"]) {
    const grouped = `let xs = []\nfunction f {\n  return hostValue\n}\nrepeat ${receiverForm}.get(0, default: askChoice 1, 2) {}\nexit\n`;
    const at = grouped.indexOf(`${receiverForm}.get(0, default: askChoice`);
    for (const mode of MODES) {
      const request = coreRequest(main(grouped));
      assert.ok(request !== null);
      const { diagnostics } = inMode(mode, () =>
        withTestDemandAllowance(1, () => analyseCore(request)),
      );
      const onReceiver = diagnostics.filter((d) => d.code === "TSV043" && d.site.start === at);
      assert.ok(
        onReceiver.length > 0 && onReceiver.every((d) => !("keeps" in d)),
        `${JSON.stringify(mode)} ${receiverForm}`,
      );
    }
  }
  // (an unfound subject is unproved where its own span holds the recorded choice: the receiver of the outer `get`;
  // the inner `get`'s receiver `xs` holds none, Codex r11 on #1660)
  const holding = `let xs = []\nrepeat (xs.get(0, default: ${S})).get(0, default: 1) {}\nexit\n`;
  for (const mode of MODES) {
    const request = coreRequest(main(holding));
    assert.ok(request !== null);
    const { diagnostics } = inMode(mode, () =>
      withTestDemandAllowance(1, () => analyseCore(request)),
    );
    const outer = diagnostics.filter(
      (d) => d.code === "TSV043" && d.site.start === holding.indexOf("(xs.get"),
    );
    assert.ok(
      outer.length > 0 && outer.every((d) => "keeps" in d && d.keeps === "unproved"),
      JSON.stringify(mode),
    );
    const inner = diagnostics.filter(
      (d) => d.code === "TSV043" && d.site.start === holding.indexOf("xs.get"),
    );
    assert.ok(
      inner.every((d) => !("keeps" in d)),
      JSON.stringify(mode),
    );
  }
  const plainRequest = coreRequest(main(plain));
  assert.ok(plainRequest !== null);
  const plainDiagnostics = analyseCore(plainRequest).diagnostics;
  const plainText = messageSource([plain], plainDiagnostics);
  const unasked = plainDiagnostics.map((diagnostic) => {
    if (!("present" in diagnostic)) return coreMessage(diagnostic, plainText);
    const { present: _, ...rest } = diagnostic;
    return coreMessage(rest, plainText);
  });
  assert.ok(
    unasked.some((message) =>
      message.includes("in a new variable, as in 'let value = hostValue.count'"),
    ),
    JSON.stringify(unasked),
  );
  // (a warning no fact proves a plain `let` for keeps its value in words: Codex r2 on #1660)
  const direct = `repeat ${C} {}\nexit\n`;
  const request = coreRequest(main(direct));
  assert.ok(request !== null);
  const { diagnostics } = analyseCore(request);
  const text = messageSource([direct], diagnostics);
  // (as after a stop: no facts asked)
  const unproved = diagnostics.map((diagnostic) => {
    if (!("keeps" in diagnostic)) return coreMessage(diagnostic, text);
    const { keeps: _, present: __, ...rest } = diagnostic;
    return coreMessage(rest, text);
  });
  assert.ok(
    unproved.some((message) =>
      message.includes(
        `Keep '${C}' in a new variable and check that it is a whole number (integer) first.`,
      ),
    ),
    JSON.stringify(unproved),
  );
});

/**
 * #1352 (Codex r10 on #1660): the kept-value fact's work, counted apart from the allowance, grows with the warnings and
 * choices no faster than linearly: k warnings each holding its own mixed choice, k = 16 to 128, four modes, at most
 * ×2.05 per doubling (a scan of every recorded choice per warning grows by more).
 */
test("the kept-value fact's work grows linearly with the warnings and the choices (#1352)", () => {
  for (const mode of MODES) {
    const work = [16, 32, 64, 128].map((k) => {
      const source = `${'repeat (askChoice "None", [5, 10]) {}\n'.repeat(k)}exit\n`;
      const request = coreRequest(main(source));
      assert.ok(request !== null);
      return inMode(mode, () => analyseCore(request)).budget.apart.get("checks") ?? 0;
    });
    for (let at = 1; at < work.length; at += 1)
      assert.ok(work[at]! <= 2.05 * work[at - 1]!, `${JSON.stringify(mode)} ${work.join(", ")}`);
  }
});

/**
 * #1274: a fix that keeps a value in a new variable names one free in the whole project (`MessageSource.freeName`):
 * `value`, else `value2`, `value3`, …, the first no identifier of any file's code spells (a property's name aside) and
 * no host global or built-in reserves, and its check reads that name. Each of the sentence's three forms (a null check,
 * a type check of a kept union, a selection's length) beside each way a name is or is not taken (declared before the
 * use or after it, as a function, a parameter, two names at once; only in a text or as a property's name; a host
 * global): the `let` and the check pasted in place of the use's line compile.
 */
test("a kept value's variable takes a name free in the project, and the fix compiles where pasted (#1274)", () => {
  const uses = [
    { setup: "let xs = [7, null]", use: "say xs[0] + 1" },
    { setup: "let v = 1", use: 'v = askChoice "None", [5, 10]' },
    { setup: "let groups: integer[][] = [[], [21]]", use: "say groups.random.last" },
  ];
  const taken: readonly (readonly [string, readonly string[], readonly string[], string])[] = [
    ["free", [], [], "value"],
    ["declared before", ["let value = 2"], ["say value"], "value2"],
    ["declared after", [], ["let value = 2", "say value"], "value2"],
    ["a function", ["function value { return 1 }"], [], "value2"],
    ["a parameter", ["function f(value) { return value }"], [], "value2"],
    ["two names", ["let value = 2", "let value2 = 3"], ["say value + value2"], "value3"],
    ["only in a text", ['say "value"'], [], "value"],
    ["only a property's name", ["let o = {value: 1}", "say o.value"], [], "value"],
  ];
  for (const { setup, use } of uses)
    for (const [name, before, after, expected] of taken) {
      const source = [setup, ...before, use, ...after, "exit", ""].join("\n");
      const request = coreRequest([{ path: "main.tease", source }]);
      assert.ok(request !== null, source);
      const { diagnostics } = analyseCore(request);
      const text = messageSource([source], diagnostics);
      const fix = diagnostics
        .map((diagnostic) => coreMessage(diagnostic, text))
        .map((message) =>
          /as in '(let [^']*)', and check (?:it|its length), as in '(if [^']*)'/.exec(message),
        )
        .find((found) => found !== null);
      assert.ok(fix !== undefined && fix !== null, `${name}: ${source}`);
      const [, keep, check] = fix;
      assert.ok(keep!.startsWith(`let ${expected}`), `${name}: ${keep}`);
      assert.ok(new RegExp(`\\b${expected}\\b`).test(check!), `${name}: ${check}`);
      const pasted = source.replace(`${use}\n`, `${keep}\n${check}\n`);
      const fixed = coreRequest([{ path: "main.tease", source: pasted }]);
      assert.ok(fixed !== null, `${name}: the pasted names resolve: ${pasted}`);
      assert.deepEqual(
        analyseCore(fixed).diagnostics.filter((d) => d.class === "compile-error"),
        [],
        `${name}: ${pasted}`,
      );
    }
  // (a host global the script never names is reserved too, as the compile reads the analysis: `coreCheckResult`, the
  // one that forwards the request's globals and built-ins to its message source)
  const source = "let xs = [7, null]\nsay xs[0] + 1\nexit\n";
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "value"])!;
  const checked = coreCheckResult(
    analyseCore(request),
    new SliceIndex(request.files.map((file) => file.program)),
    request,
  );
  const messages = checked.diagnostics.flat().map((diagnostic) => diagnostic.message);
  assert.ok(
    messages.some((message) => message.includes("as in 'let value2 = xs[0]'")),
    JSON.stringify(messages),
  );
});

/**
 * #1274, Codex r1's B1: the names a fix may not declare are surveyed without a native call per level, so a warning's
 * message beside an expression of any depth still compiles (12,800 nested parentheses).
 */
test("a warning's fix beside a deeply nested expression still compiles (#1274)", () => {
  const source = `let n = ${"(".repeat(12800)}1${")".repeat(12800)}\nrepeat hostValue {}\nexit\n`;
  const result = compileSourceWithBackend(source, { globals: ["hostValue"] }, CORE_BACKEND);
  assert.ok(result.plan !== null);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSV011"],
  );
});

/**
 * #1274, Astra r1 on #1715: the kept variable's name is chosen once per program, its survey charged to the analysis's
 * total as a shared build and to no demand. k warnings beside a taken `value`, k = 16 to 256: each fix names `value2`,
 * the survey's charge is at least one unit per syntax node, the demands' records stay as the analysis left them, and
 * the total after the messages grows at most ×2.15 per doubling of the nodes (a survey per warning grows by ×4).
 */
test("a kept value's name is surveyed once, charged to the analysis and no demand (#1274)", () => {
  const measured = [16, 32, 64, 128, 256].map((k) => {
    const source = `let value = 1\nlet xs = [7, null]\n${"say xs[0] + 1\n".repeat(k)}exit\n`;
    const request = coreRequest([{ path: "main.tease", source }])!;
    const answers = analyseCore(request);
    const before = answers.budget;
    // (the records as the analysis left them, copied: the budget's lists are the answers' own, Codex r4 T1 on #1730)
    const [demands, decisions] = [
      structuredClone(before.demands),
      structuredClone(before.decisions),
    ];
    const checked = coreCheckResult(
      answers,
      new SliceIndex(request.files.map((file) => file.program)),
      request,
    );
    const fixes = checked.diagnostics
      .flat()
      .filter((diagnostic) => diagnostic.message.includes("as in 'let value2 = xs[0]'"));
    assert.equal(fixes.length, k, `k = ${k}`);
    const nodes = before.counts.get("syntaxNodes")!;
    const surveyed =
      (answers.budget.counts.get("indexSteps") ?? 0) - (before.counts.get("indexSteps") ?? 0);
    assert.ok(surveyed >= nodes, `k = ${k}: ${surveyed} survey units for ${nodes} nodes`);
    assert.deepEqual(answers.budget.demands, demands, `k = ${k}`);
    assert.deepEqual(answers.budget.decisions, decisions, `k = ${k}`);
    return { total: answers.budget.total, nodes };
  });
  for (let at = 1; at < measured.length; at += 1) {
    const [small, large] = [measured[at - 1]!, measured[at]!];
    const doubling = (2 * (large.total / small.total)) / (large.nodes / small.nodes);
    assert.ok(doubling <= 2.15, `${JSON.stringify(measured)}: ${doubling.toFixed(3)} per doubling`);
  }
});

/**
 * #1274, Codex r3 on #1715: the kept name's survey charges each name the host reserves and each file's root too, so its
 * charge grows with unused host globals and with empty files (16 and 256 of each). After a stop, its units are
 * finishing work, counted in the finishing breakdown as in the total.
 */
test("a kept value's name survey charges the host's names and every file (#1274)", () => {
  const source = "let value = 1\nlet xs = [7, null]\nsay xs[0] + 1\nexit\n";
  for (const [globals, empty] of [
    [16, 0],
    [256, 0],
    [0, 16],
    [0, 256],
  ] as const) {
    const files = [
      { path: "main.tease", source },
      ...Array.from({ length: empty }, (_, at) => ({ path: `empty${at}.tease`, source: "" })),
    ];
    const hosts = ["hostValue", ...Array.from({ length: globals }, (_, at) => `host${at}`)];
    const request = coreRequest(files, hosts)!;
    const answers = analyseCore(request);
    const before = answers.budget;
    assert.equal(answers.keptName("value"), "value2");
    const nodes = before.counts.get("syntaxNodes")!;
    const surveyed =
      (answers.budget.counts.get("indexSteps") ?? 0) - (before.counts.get("indexSteps") ?? 0);
    assert.ok(
      surveyed >= nodes + hosts.length,
      `${globals} globals, ${empty} empty files: ${surveyed} units for ${nodes} nodes and ${hosts.length} names`,
    );
  }
  const request = coreRequest([{ path: "main.tease", source }])!;
  const stopped = analyseCore(request).stoppedAt("work");
  stopped.keptName("value");
  const { finishing, apart } = stopped.budget;
  assert.equal(
    [...apart.values()].reduce((sum, units) => sum + units, 0),
    finishing,
  );
});
