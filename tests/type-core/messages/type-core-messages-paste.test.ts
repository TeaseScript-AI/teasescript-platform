// A fix's code pasted where the fix offers it: it compiles and runs, and counts as run or evaluated only where it ran.

import assert from "node:assert/strict";
import test from "node:test";
import { compileProject } from "../../../src/compiler.js";
import { createFreshRuntimeSession } from "../../../src/index.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { coreMessage, messageSource } from "../../../src/type-inference/core/messages.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import {
  pasteCases,
  pastedForms,
  pasteFailure,
  type Pasted,
} from "../../helpers/type-core/type-core-paste.js";

/**
 * Sources whose diagnostic suggests code, `⟦…⟧` around the code the fix replaces: atomic and composed operands, scalar
 * and structured values, each fix's family once, and for an example of a property shown the lines the repaired source
 * says. A declaration is whole, with its start value (#1268).
 */
const REPAIRS: readonly (readonly [string, RegExp, (readonly string[])?])[] = [
  // date and time operators, composed operands grouped, also as a warning
  [
    'let t = toAbsoluteDateTime("2026-01-01T00:00:00Z")\nlet u = t + 1 s\nsay ⟦u + 1 calendar day⟧\nexit\n',
    /as in '([^']*)'/,
  ],
  ['let t = toDateTime("2026-01-01T00:00:00")\nsay ⟦t + 1 s⟧\nexit\n', /as in '([^']*)'/],
  ['let day = toDate("2026-10-23")\nsay day + ⟦1 day⟧\nexit\n', /Write '([^']*)'/],
  [
    'let day = toDate("2026-10-23")\nlet d = toDateTime("2026-10-23T12:00:00")\nsay day < ⟦d⟧\nexit\n',
    /as in '([^']*)'/,
  ],
  // members of a kind without them, on a composed receiver
  [
    'let t = toAbsoluteDateTime("2026-01-01T00:00:00Z")\nlet u = t + 1 s\nsay ⟦u.year⟧\nexit\n',
    /as in '([^']*)'/,
  ],
  ["let d = 1 s+2 s\nsay ⟦d.seconds⟧\nexit\n", /as in '([^']*)'/, ["3"]],
  // (a divisor's place takes the number, Codex r4's words where no fact proved it before `codeAt`'s site, #1268)
  ["let d = 2 s\nsay 4 / ⟦d.seconds⟧\nexit\n", /as in '([^']*)'/, ["2"]],
  // (#1268: the value in place, read once, where its own text may stand in code: a receiver that is no stable path, a
  // literal or an expression shown or stored as text)
  ["let ns = [12, 13]\nsay ⟦ns.random⟧.length\nexit\n", /with '([^']*)'/],
  ["let caption: string = ⟦1⟧\nsay caption\nexit\n", /write '([^']*)'/, ["1"]],
  ["let caption: string = ⟦true⟧\nsay caption\nexit\n", /write '([^']*)'/, ["true"]],
  ["let n = 1\nlet caption: string = ⟦n + 1⟧\nsay caption\nexit\n", /write '([^']*)'/, ["2"]],
  ['say "⟦${set[4, 7]}⟧"\nexit\n', /with '([^']*)'/, ["4, 7"]],
  ['say "⟦${dict{a: 1}}⟧"\nexit\n', /with '([^']*)'/, ["1"]],
  ['let d = dict{a: 1}\nsay "⟦${d}⟧"\nexit\n', /with '([^']*)'/, ["1"]],
  ['let s = "a"\nif ⟦s⟧ { say "x" }\nexit\n', /as in '([^']*)'/, ["x"]],
  ["let n = 1\nsay ⟦n.length⟧\nexit\n", /as in '([^']*)'/],
  // `${...}`: an object's first property it shows, a set
  // (the first plain property: a list's emptiness is known only when the script runs)
  ['let slave = {nested: {name: "A"}, age: 1}\nsay "⟦${slave}⟧"\nexit\n', /as in '([^']*)'/, ["1"]],
  ['let slave = {names: ["A"], age: 1}\nsay "⟦${slave}⟧"\nexit\n', /as in '([^']*)'/, ["1"]],
  [
    'let box = {first: ["A"], second: 2}\nbox.first.clear()\nsay "⟦${box}⟧"\nexit\n',
    /as in '([^']*)'/,
    ["2"],
  ],
  ['let s = set[1]\nsay "⟦${s}⟧"\nexit\n', /with '([^']*)'/, ["1"]],
  // (Astra r1's control: a named set, the name its own)
  ['let value = set[99]\nlet s = set[4, 7]\nsay "⟦${s}⟧"\nexit\n', /with '([^']*)'/, ["4, 7"]],
  // a condition, a key, text
  ['let count = 2\nif ⟦count⟧ { say "x" }\nexit\n', /as in '([^']*)'/],
  ['let toys = [1]\nif ⟦toys⟧ { say "x" }\nexit\n', /as in '([^']*)'/],
  ['let d = dict{"1": 5}\nlet k = 1\nsay d[⟦k⟧]\nexit\n', /as in '([^']*)'/, ["5"]],
  ["let n = 1\nlet caption: string = ⟦n⟧\nsay caption\nexit\n", /write '([^']*)'/, ["1"]],
  // a stable path through an index variable (Astra r2), in a fix the predicate does not test
  // the null check's fallback, of a kept value and of a composed one; a warning's read by an index, which its program
  // already performs there, wrapped in place
  ["let xs = [7, null]\nsay ⟦xs[0]⟧ + 1\nexit\n", /fallback, as in '([^']*)'/, ["8"]],
  [
    "let xs = [4, null]\nlet v: integer = ⟦xs[1]⟧\nsay v\nexit\n",
    /fallback, as in '([^']*)'/,
    ["0"],
  ],
  [
    'let x: integer? = null\nlet y: integer? = null\nif askBoolean "x" { x = 1 }\nrepeat (⟦x otherwise y⟧) {}\nexit\n',
    /fallback, as in '([^']*)'/,
  ],
  // the declarations a union or null widens (ADR 0021 rules 1.1, 1.2, 1.3, 1.7, 7.3), each start value as written, the
  // author's own, which the declaration adds no read of: a literal (Astra on #1273), a call, a
  // global's `default:`, a parameter's default, a list literal, a fallback
  ['⟦let mood = 1⟧\nmood = "happy"\nsay mood\nexit\n', /as '([^']*)'/, ["happy"]],
  [
    'function make { return 1 }\n⟦let mood = make()⟧\nmood = "happy"\nsay mood\nexit\n',
    /as '([^']*)'/,
    ["happy"],
  ],
  ['⟦global g = 1, default: 2⟧\ng = "x"\nsay g\nexit\n', /as '([^']*)'/, ["x"]],
  ['⟦let d = dict{a: 1}⟧\nd["b"] = "x"\nsay d["b"]\nexit\n', /as '([^']*)'/, ["x"]],
  ['⟦let a = [1, "x"]⟧\nsay a.length\nexit\n', /as '([^']*)'/, ["2"]],
  ['function use(⟦n: integer⟧) { say n }\nuse("x")\nexit\n', /as '([^']*)'/, ["x"]],
  ['function use(⟦n: integer = [1][0]⟧) { say n }\nuse("x")\nexit\n', /as '([^']*)'/, ["x"]],
  ["let n = null\n⟦let whole: integer = n⟧\nexit\n", /as '([^']*)'/],
  ['let source = ["s"]\n⟦let copy = source.removeAt(0)⟧\ncopy = 2\nexit\n', /as '([^']*)'/],
  [
    '⟦let result: integer = load("count", default: ["bad"].last)⟧\nsay result\nexit\n',
    /as '([^']*)'/,
  ],
  [
    'let y: integer? = null\n⟦let x: integer = y otherwise "a"⟧\nsay x\nexit\n',
    /as '([^']*)'/,
    ["a"],
  ],
  // #1241: each code form a fix offers, pasted whole at the site its diagnostic sits on, where its
  // predicate holds: a number given a unit, also an operation's value; text converted; a member the type has, on a
  // receiver written plainly, nested, as an element and as a dict value, also as a range's bound; a join's elements
  // ones it shows; a new list where the site takes one (an untyped or a written list, an operand, a receiver)
  ["let pause: duration = ⟦3⟧\nsay pause\nexit\n", /such as '([^']*)'/],
  ["let n = 2\nlet p: duration = ⟦n + 1⟧\nsay p\nexit\n", /such as '([^']*)'/],
  ['let day: date = ⟦"2026-10-28"⟧\nsay day.year\nexit\n', /with '([^']*)'\./, ["2026"]],
  ['let at: time = ⟦"10:30"⟧\nsay at.hour\nexit\n', /with '([^']*)'\./, ["10"]],
  ['let dt: datetime = ⟦"2026-10-28T10:00:00"⟧\nsay dt.year\nexit\n', /with '([^']*)'\./, ["2026"]],
  [
    'let ad: absoluteDateTime = ⟦"2026-10-28T10:00:00Z"⟧\nsay ad.toDateTime().year\nexit\n',
    /with '([^']*)'\./,
  ],
  ["let a = 90 deg\nsay ⟦a.degrees⟧\nexit\n", /Use '([^']*)' for its size/, ["90"]],
  [
    "let a = 90 deg\nlet n: number = ⟦a.degrees⟧\nsay n\nexit\n",
    /Use '([^']*)' for its size/,
    ["90"],
  ],
  ['let t = "hello"\nsay ⟦t.size⟧\nexit\n', /Use '([^']*)'/, ["5"]],
  ['let t = "hello"\nlet n: integer = ⟦t.size⟧\nsay n\nexit\n', /Use '([^']*)'/, ["5"]],
  ['let t = "hello"\nif ⟦t.size⟧ > 2 {\n  say "long"\n}\nexit\n', /Use '([^']*)'/, ["long"]],
  ['let box = {label: "hello"}\nsay ⟦box.label.size⟧\nexit\n', /Use '([^']*)'/, ["5"]],
  [
    'let t = "hello"\nfor i in 1..⟦t.size⟧ {\n  say i\n}\nexit\n',
    /Use '([^']*)'/,
    ["1", "2", "3", "4"],
  ],
  ['let t = "hello"\nsay ⟦t.toUpperCase()⟧\nexit\n', /Use '([^']*)'/, ["HELLO"]],
  ['let t = "hello"\nsay ⟦t.length()⟧\nexit\n', /Write '([^']*)'/, ["5"]],
  ['let t = " hello "\nsay ⟦t.trim⟧\nexit\n', /Write '([^']*)'/, ["hello"]],
  ['let items = ["a", "b"]\nsay ⟦items.join⟧\nexit\n', /Write '([^']*)'/],
  ['let box = {items: ["a", "b"]}\nsay ⟦box.items.join⟧\nexit\n', /Write '([^']*)'/],
  ["let items: integer[] = []\nsay ⟦items.join⟧\nexit\n", /Write '([^']*)'/],
  [
    'let names = ["Ann"]\nlet more = ⟦names + "Bo"⟧\nsay more.length\nexit\n',
    /Write '([^']*)' for a new list/,
    ["2"],
  ],
  [
    "let xs = [1]\nlet ys: integer[] = ⟦xs + 2⟧\nsay ys.length\nexit\n",
    /Write '([^']*)' for a new list/,
    ["2"],
  ],
  [
    "let xs = [1]\nlet ys = ⟦2 + xs⟧\nsay ys.length\nexit\n",
    /Write '([^']*)' for a new list/,
    ["2"],
  ],
  [
    'let names = ["Ann"]\nsay (⟦names + "Bo"⟧).length\nexit\n',
    /Write '([^']*)' for a new list/,
    ["2"],
  ],
  ["let xs = [1]\nsay (xs + (⟦1..3⟧)).length\nexit\n", /Write '([^']*)' to add the numbers/, ["3"]],
  // an argument of a parameter without a type, as its body takes it, also through its result (Codex r7)
  [
    'let t = "hello"\nfunction show(p) {\n  say p\n}\nshow(⟦t.size⟧)\nexit\n',
    /Use '([^']*)'/,
    ["5"],
  ],
  [
    'let t = "hello"\nfunction count(p) {\n  return p + 1\n}\nsay count(⟦t.size⟧)\nexit\n',
    /Use '([^']*)'/,
    ["6"],
  ],
  // a fallback the fix writes (ADR 0021 rule 1.9) where the value does not divide, and a receiver's in parentheses
  // (Astra on #1273)
  [
    "function half(x: integer?) {\n  say ⟦x⟧ / 2\n}\nhalf(4)\nhalf(null)\nexit\n",
    /fallback, as in '([^']*)'/,
    ["2", "0"],
  ],
  [
    'function size(t: string?) {\n  say ⟦t⟧.length\n}\nsize("ab")\nsize(null)\nexit\n',
    /fallback, as in '([^']*)'/,
    ["2", "0"],
  ],
];

/**
 * #1241 (Astra r1 B2): an `add` a list fix offers on a line of its own, which gives no list: pasted as a line before the
 * join's line, the list itself where the join stood, `⟦…⟧` around the join; the run says the lines given.
 */
const ADDS: readonly (readonly [string, readonly string[]])[] = [
  ['let names = ["Ann"]\nsay (⟦names + "Bo"⟧).length\nexit\n', ["2"]],
  ["let xs = [1]\nlet ys: integer[] = ⟦xs + 2⟧\nsay ys.length\nexit\n", ["2"]],
];

test("a list fix's add, on a line of its own, compiles and runs where the fix offers it (#1241)", () => {
  for (const [marked, says] of ADDS) {
    const source = marked.replace(/[⟦⟧]/g, "");
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const found = diagnostics
      .map((diagnostic) =>
        /add the element to '([^']*)' itself with '([^']*)' on a line of its own/.exec(
          coreMessage(diagnostic, text),
        ),
      )
      .find((match) => match !== null);
    assert.ok(found !== undefined && found !== null, `an add: ${source}`);
    const [, list, statement] = found;
    const line = marked.split("\n").find((candidate) => candidate.includes("⟦"))!;
    const fixed = marked.replace(line, `${statement!}\n${line.replace(/⟦[^⟧]*⟧/, list!)}`);
    const compiled = compileProject([{ path: "main.tease", source: fixed }]);
    assert.deepEqual(
      compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
      fixed,
    );
    assert.ok(compiled.plan !== null, fixed);
    const events = createFreshRuntimeSession(compiled.plan, {
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    }).run().events;
    assert.deepEqual(
      events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
      says,
      fixed,
    );
  }
});

/**
 * #1241: the paste family's sample (`type-core-paste.ts`): every offer once, the sites in turn, every
 * code form its fix offers pasted at its own position compiles and runs to its end through it, a store that receives an
 * answer among them (#1586). The whole family, every offer at every site, is the step's evidence outside CI.
 */
test("every code form a fix offers compiles and runs where pasted, on the paste family's sample", () => {
  const failures: string[] = [];
  let pasted = 0;
  for (const { name, source, start, end } of pasteCases(true)) {
    const { diagnosed, forms } = pastedForms(source, start, end);
    if (!diagnosed) failures.push(`${name}: no error at the expression`);
    for (const form of forms) {
      pasted += 1;
      const failure = pasteFailure(form);
      if (failure !== null) failures.push(`${name}: '${form.code}': ${failure}`);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(pasted > 0, `${pasted} forms pasted`);
});

test("a pasted form counts as run only where its run ends through it, answered where it asks (#1586)", () => {
  const pasted = (source: string, code: string): Pasted => {
    const start = source.indexOf(code);
    return { code, source, at: { start, end: start + code.length } };
  };
  // (a failure after a valid answer)
  const canary = 'let answer = askInteger("Number?")\nsay 1 / (answer - answer)\nexit\n';
  assert.match(pasteFailure(pasted(canary, "1 / (answer - answer)")) ?? "", /"code":"TSR036"/);
  // (a prompt's code, which runs before the answer and counts once the run has ended, Codex r1 on #1589)
  const prompt = 'let t = "hello"\nlet answer = askInteger("${t.length}")\nexit\n';
  assert.equal(pasteFailure(pasted(prompt, "t.length")), null);
  // (code whose statement ends before a later answer, in a run before the last)
  const earlier = 'let t = "hello"\nsay t.length\nlet answer = askInteger("Number?")\nexit\n';
  assert.equal(pasteFailure(pasted(earlier, "t.length")), null);
  // (a list's addition that receives the answer, as the family's duration stores do)
  const added =
    'let ps: duration[] = [1 s]\nps.add((askInteger("How many?")) s)\nsay ps.length\nexit\n';
  assert.equal(pasteFailure(pasted(added, '(askInteger("How many?")) s')), null);
  // (code in a branch the answer does not take)
  const skipped = 'let n = askInteger("How many?")\nif n > 5 {\n  say n * 1 s\n}\nexit\n';
  assert.equal(
    pasteFailure(pasted(skipped, "n * 1 s")),
    "unreached: the run ended without executing 'n * 1 s'",
  );
  // (a run that still asks once its answers run out)
  const asking = 'repeat 5 {\n  say askInteger("Again?")\n}\nexit\n';
  assert.equal(
    pasteFailure(pasted(asking, 'askInteger("Again?")')),
    "incomplete execution: waiting for number after 4 completions",
  );
});

/**
 * Codex r1 and r2 on #1589: only the instruction that consumes a pasted form's evaluated operands shows the form ran,
 * the last the lowering emits for its statement and for each position on the way down that a run may skip
 * (`unevaluated` in `type-core-paste.ts`). A setup instruction with the same span runs before the operands, and one
 * around a skipped position runs too: at each position, taken through an answer's prompt; skipped, or without an
 * instruction of its own span, unproved.
 */
test("a pasted form counts as evaluated only where the instruction that consumes it ran (Codex r1 and r2 on #1589)", () => {
  const ask = 'askInteger("${t.length}")';
  const at = (source: string, code: string, from = 0): Pasted => {
    const start = source.indexOf(code, from);
    return { code, source, at: { start, end: start + code.length } };
  };
  const unproved = (position: string): string => `unproved evaluation: ${position}`;
  for (const [lines, outcome] of [
    [`say true and ${ask} > 0`, null],
    ["say false and t.length > 0", unproved("the right side of 'and'")],
    [`say false or ${ask} > 0`, null],
    ["say true or t.length > 0", unproved("the right side of 'or'")],
    [`let n: integer? = null\nsay n otherwise ${ask}`, null],
    ["let n: integer? = 2\nsay n otherwise t.length", unproved("the right side of 'otherwise'")],
    [`let ys = [1]\nsay ys.get(9, default: ${ask})`, null],
    ["let ys = [1]\nsay ys.get(0, default: t.length)", unproved("the default of 'get'")],
    [`let v = load "k", default: ${ask}\nsay v`, null],
    [
      'save 1 as "k"\nlet v = load "k", default: t.length\nsay v',
      unproved("the default of 'load'"),
    ],
    // (a parameter's default, which no answer can stand in, TSV032, in a function, whose own instruction comes before
    // its parameters)
    ...["f()", "f(3)"].map(
      (call) =>
        [
          `function f(p = t.length) {\n  say p\n}\n${call}`,
          unproved("its 'functionDeclaration' emits its own instruction before its operands"),
        ] as const,
    ),
  ] as const)
    assert.equal(pasteFailure(at(`let t = "hello"\n${lines}\nexit\n`, "t.length")), outcome, lines);
  // (a statement with no instruction of its own span, whose condition, subject or cases nothing shows evaluated: an
  // `if`; a switch, also at a case's later value, which only a literal can be, TSV047, tested and not)
  assert.equal(
    pasteFailure(at('let t = "hello"\nif t.length > 2 {\n  say "yes"\n}\nexit\n', "t.length")),
    unproved("no instruction has the span of its 'ifStatement'"),
  );
  for (const subject of ["5", "1"]) {
    const source = `switch ${subject} {\n  case 1, 5 {\n    say "case"\n  }\n}\nexit\n`;
    assert.equal(
      pasteFailure(at(source, "5", source.indexOf("case"))),
      unproved("no instruction has the span of its 'switchStatement'"),
    );
  }
  // (the reviews' witnesses, through the fix the core offers: a skipped right side, Codex r1; an exit in an earlier
  // operand, plain and at each position a run may skip, and the call returning, Codex r2)
  const offered = (source: string): readonly (readonly [string, string | null])[] => {
    const start = source.indexOf("t.size");
    return pastedForms(source, start, start + "t.size".length).forms.map(
      (form) => [form.code, pasteFailure(form)] as const,
    );
  };
  assert.deepEqual(offered('let t = "hello"\nsay false and t.size > 0\nexit\n'), [
    ["t.length", unproved("the right side of 'and'")],
  ]);
  const stop =
    "function stop(p: integer): integer {\n  if p == 0 {\n    exit\n  }\n  return 1\n}\n";
  for (const body of [
    'say "${stop(@)}${t.size}"',
    'let h: messageHandle? = null\nlet chosen = h otherwise (say "${stop(@)}${t.size}")',
    'let chosen = true and ((say "${stop(@)}${t.size}") is messageHandle)',
    'let chosen = false or ((say "${stop(@)}${t.size}") is messageHandle)',
    'let ys: messageHandle[] = []\nlet chosen = ys.get(0, default: (say "${stop(@)}${t.size}"))',
  ])
    for (const [argument, outcome] of [
      ["0", "unreached: the run ended without executing 't.length'"],
      ["1", null],
    ] as const) {
      const source = `let t = "hello"\n${stop}${body.replace("@", argument)}\nexit\n`;
      assert.deepEqual(offered(source), [["t.length", outcome]], source);
    }
});

test("a join's pasted declaration is checked under the core alone at the joins its type receives, and the current checker's other join errors stand (#1412, Codex r12 and r13 on #1310)", () => {
  const pasted = (source: string, line: string): string | null => {
    const start = source.indexOf(line);
    const forms = pastedForms(source, start, start + line.length).forms.filter(
      (form) => form.declared !== undefined,
    );
    assert.equal(forms.length, 1, source);
    return pasteFailure(forms[0]!);
  };
  const objects = 'let a = [{n: 1}]\nlet b = [{n: "x"}]\n';
  assert.equal(pasted('let xs = [1]\nlet both = xs + ["x"]\nexit\n', 'xs + ["x"]'), null);
  // (a join of objects whose property differs, which the core misses, #1383: beside the declaration, and inside its
  // text where the declared type does not receive it)
  for (const [source, line] of [
    [`let xs = [1]\nlet both = xs + ["x"]\n${objects}say (a + b).length\nexit\n`, 'xs + ["x"]'],
    [
      `let xs = [1]\n${objects}let both = xs + ["x"] + [(a + b).length]\nexit\n`,
      'let both = xs + ["x"] + [(a + b).length]',
    ],
  ] as const)
    assert.match(pasted(source, line) ?? "", /^TSV044: '\+' would mix objects/, source);
});

test("what a site takes is read through a long chain of untyped copies or calls, and a wide literal (#1241, Codex r8, r13)", () => {
  const lines = (count: number, line: (index: number) => string): string =>
    Array.from({ length: count }, (_, index) => line(index)).join("\n");
  const call = (index: number): string => (index === 1023 ? "p" : `f${index + 1}(p)`);
  for (const source of [
    `let t = "x"\nlet v0 = t.size\n${lines(2048, (i) => `let v${i + 1} = v${i}`)}\nsay v2048.trim()\nexit\n`,
    `let t = "x"\n${lines(1024, (i) => `function f${i}(p) {\n  return ${call(i)}\n}`)}\nlet v: string = f0(t.size)\nsay v\nexit\n`,
  ]) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    assert.ok(
      diagnostics.some((diagnostic) =>
        coreMessage(diagnostic, text).endsWith(" Use the length property."),
      ),
    );
  }
  // (Codex r13: a literal wide enough that one native call per element would exhaust the stack, where its presence is
  // walked)
  const wide = `let d: duration = [${"1, ".repeat(131071)}2].length\nexit\n`;
  const request = coreRequest([{ path: "main.tease", source: wide }]);
  assert.ok(request !== null);
  assert.deepEqual(
    analyseCore(request).diagnostics.map((diagnostic) => diagnostic.code),
    ["TSV041"],
  );
});

test("the code each fix suggests compiles where it stands and runs, saying what it should (#1195)", () => {
  for (const [marked, pick, says] of REPAIRS) {
    const source = marked.replace(/[⟦⟧]/g, "");
    const files = [{ path: "main.tease", source }];
    const request = coreRequest(files);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const suggested = diagnostics
      .map((diagnostic) => pick.exec(coreMessage(diagnostic, text))?.[1])
      .find((found) => found !== undefined);
    assert.ok(suggested !== undefined, `a fix: ${source}`);
    const fixed = marked.replace(/⟦[^⟧]*⟧/, suggested);
    const errors = compileProject([{ path: "main.tease", source: fixed }]).diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    );
    assert.deepEqual(
      errors.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
      [],
      fixed,
    );
    // (until it exits, fails, or waits for the player)
    const { plan } = compileProject([{ path: "main.tease", source: fixed }]);
    assert.ok(plan !== null, fixed);
    const session = createFreshRuntimeSession(plan, {
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    });
    const events = session.run().events;
    assert.deepEqual(
      events.filter((event) => event.kind === "runtimeFailure"),
      [],
      fixed,
    );
    if (says !== undefined)
      assert.deepEqual(
        events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
        says,
        fixed,
      );
  }
});
