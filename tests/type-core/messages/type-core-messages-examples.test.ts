// A fix's example: a text join's operand in '${...}', a length check's selection under every seed, and no example
// without a stable path (#1195).

import assert from "node:assert/strict";
import test from "node:test";
import { compileProject } from "../../../src/compiler.js";
import { createFreshRuntimeSession } from "../../../src/index.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { coreMessage, messageSource } from "../../../src/type-inference/core/messages.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { stablePath } from "../../helpers/type-core/type-core-message-ports.js";

/**
 * Text joins, `⟦…⟧` around the operand that is not text: the example puts it in `${...}` as the source writes it, and
 * the source with the operand so written says these lines (the owner's review; r3's and r4's shapes among them).
 */
const JOINS: readonly (readonly [string, readonly string[] | null])[] = [
  ['let score = 3\nsay "You have " + ⟦score⟧ + " points"\nexit\n', ["You have 3 points"]],
  [
    'function f(n) {\nsay "You have " + ⟦n⟧ + " points"\n}\nf(1)\nf(2)\nexit\n',
    ["You have 1 points", "You have 2 points"],
  ],
  [
    'let prefix = "You have "\nlet n = 1\nsay prefix + ⟦n⟧ + " points"\nexit\n',
    ["You have 1 points"],
  ],
  ['say ⟦1 + 2⟧ + " points"\nexit\n', ["3 points"]],
  ['let n = 1\nsay "Sum: " + (⟦n + 2⟧)\nexit\n', ["Sum: 3"]],
  ['let who = "Alice"\nlet n = 1\nsay "$" + "{who}" + ⟦n⟧\nexit\n', ["${who}1"]],
  ['let box = {n: 2}\nsay "n is " + ⟦box.n⟧\nexit\n', ["n is 2"]],
  // (a chain over two lines, its operand on one)
  ['let n = 1\nsay "Sum: " +\n  ⟦n⟧\nexit\n', ["Sum: 1"]],
  // (after an error, a read by an index or a key, or a call, is not proved there: words)
  ['let xs = [5]\nsay "First: " + ⟦xs[0]⟧\nexit\n', null],
  ['function two { return 2 }\nsay "Two: " + ⟦two()⟧\nexit\n', null],
  ['let d = dict{"a": 1}\nsay "A: " + ⟦d["a"]⟧\nexit\n', null],
  ['say "A: " + ⟦dict{"a": 1}["a"]⟧\nexit\n', null],
];

test("a text join's example puts the operand that is not text in '${...}', and the result says what the join meant (#1195)", () => {
  for (const [marked, says] of JOINS) {
    const source = marked.replace(/[⟦⟧]/g, "");
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const suggested = diagnostics
      .map(
        (diagnostic) =>
          /in the text as '(\$\{[^']*\})' instead/.exec(coreMessage(diagnostic, text))?.[1],
      )
      .find((found) => found !== undefined);
    if (says === null) {
      assert.equal(suggested, undefined, source);
      continue;
    }
    assert.ok(suggested !== undefined, `an example: ${source}`);
    const fixed = marked.replace(/⟦[^⟧]*⟧/, `"${suggested}"`);
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
 * Length checks, `⟦…⟧` around the collection a read selects from, and whether it is a stable path: the
 * fix checks a stable path itself, and keeps any other in a new variable first, so the check and the read see one
 * selection (Astra r2: `if groups.random.length > 0 { say groups.random.last }` checks one and reads another).
 */
const GROUPS = "let groups: integer[][] = [[], [21]]\n";
const SELECTIONS: readonly (readonly [string, boolean])[] = [
  [`${GROUPS}say ⟦groups.random⟧.last\nexit\n`, false],
  ["let catalog = {groups: [[], [21]]}\nsay ⟦catalog.groups.random⟧.last\nexit\n", false],
  [`${GROUPS}function pick { return groups.random }\nsay ⟦pick()⟧.last\nexit\n`, false],
  [`${GROUPS}let i = 0\nsay ⟦groups[i + 1]⟧.last\nexit\n`, false],
  [
    `${GROUPS}let xs: integer[]? = null\nlet ys = groups.random\nsay (⟦xs otherwise ys⟧).last\nexit\n`,
    false,
  ],
  [`${GROUPS}say ⟦groups[1]⟧.last\nexit\n`, true],
  [`${GROUPS}let i = 1\nsay ⟦groups[i]⟧.last\nexit\n`, true],
  ['let d = dict{"a": [21], "b": []}\nsay ⟦d["a"]⟧.last\nexit\n', true],
  // (keys as the parser reads them: an escape, a `$` before no `{`, spaces; Sol r6)
  ['let d = dict{"a\\"b": [21], "c": []}\nsay ⟦d["a\\"b"]⟧.last\nexit\n', true],
  ['let d = dict{"a$b": [21], "c": []}\nsay ⟦d["a$b"]⟧.last\nexit\n', true],
  ['let d = dict{"a": [21], "b": []}\nsay ⟦d[ "a" ]⟧.last\nexit\n', true],
];

/** Seeds under which `groups.random` picks, in turn, the same and different selections. */
const SEEDS = [2026, 31337, 123456, 424242, 654321, 987654, 999999];

test("a length check's fix checks the selection the read takes, under every seed (Astra r2)", () => {
  const run = (source: string, seed: number): { failed: boolean; says: string[] } => {
    const compiled = compileProject([{ path: "main.tease", source }]);
    assert.deepEqual(
      compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
      source,
    );
    assert.ok(compiled.plan !== null, source);
    const { events } = createFreshRuntimeSession(compiled.plan, {
      seed,
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    }).run();
    return {
      failed: events.some((event) => event.kind === "runtimeFailure"),
      says: events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    };
  };
  // (the control: a check of `groups.random` itself and its read pick different selections under one of the seeds)
  const unstable = `${GROUPS}if groups.random.length > 0 { say groups.random.last }\nexit\n`;
  assert.ok(SEEDS.some((seed) => run(unstable, seed).failed));
  for (const [marked, stable] of SELECTIONS) {
    const collection = /⟦([^⟧]*)⟧/.exec(marked)![1]!;
    const source = marked.replace(/[⟦⟧]/g, "");
    // (the parity's own oracle agrees with each case)
    assert.equal(stablePath(collection), stable, collection);
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const message = diagnostics
      .map((diagnostic) => coreMessage(diagnostic, text))
      .find((found) => found.startsWith(`'${collection}' may be empty here.`));
    assert.ok(message !== undefined, source);
    // (the fix as its message writes it, in place of the read's statement, its `let` on a line before; #1268)
    const read = source.split("\n").find((line) => line.includes(collection))!;
    const checked = /Check '[^']*' first, as in '(if [^']*)'\./.exec(message);
    const kept =
      /Keep '[^']*' in a new variable, as in '(let value = [^']*)', and check its length, as in '(if [^']*)'\./.exec(
        message,
      );
    assert.equal(checked !== null, stable, message);
    assert.equal(kept !== null, !stable, message);
    const fixed = source.replace(
      read,
      checked !== null ? checked[1]! : `${kept![1]!}\n${kept![2]!}`,
    );
    const runs = SEEDS.map((seed) => run(fixed, seed));
    assert.deepEqual(
      runs.filter(({ failed, says }) => failed || !(says.length === 0 || says.join() === "21")),
      [],
      fixed,
    );
    assert.ok(
      runs.some(({ says }) => says.join() === "21"),
      fixed,
    );
  }
});

/**
 * A fix whose subject is no stable path or not on one line loses its example, never its advice (#1195 rule 1, the lead
 * after Astra r3): each such outcome of every fix with an example, as a whole sentence of its message.
 */
test("a fix whose subject is no stable path, or not on one line, keeps its advice without an example (#1195)", () => {
  const cases: readonly (readonly [string, string])[] = [
    // a condition (Astra r3: a selection, its text and list variants, a call)
    [
      'let readings = [0, 73]\nif readings.random { say "selected" }\nexit\n',
      "Compare it instead.",
    ],
    [
      'let readings = ["", "Harbor"]\nif readings.random { say "selected" }\nexit\n',
      "Compare it instead.",
    ],
    [
      'let readings = [[], [73]]\nif readings.random { say "selected" }\nexit\n',
      "Check its length instead.",
    ],
    ['function f { return 1 }\nif f() { say "x" }\nexit\n', "Compare it instead."],
    // a member of a type without it, a speaker's member (#1268: words for the function, never a template)
    [
      "let ns = [1, 2]\nsay (ns /* any */ .random).length\nexit\n",
      "Convert the value to text first with the toString function.",
    ],
    [
      'let ts = [toAbsoluteDateTime("2026-01-01T00:00:00Z")]\nsay ts.random.year\nexit\n',
      "Convert 'ts.random' with the toDateTime method first.",
    ],
    [
      "let ss = [set[1]]\nsay ss.random.indexOf(1)\nexit\n",
      "Copy 'ss.random' into a list with the toList method first.",
    ],
    ["let rack = [player]\nsay rack.random.rank\nexit\n", "Assign the property before this line."],
    [
      'speaker sage { title: "Sage" }\nlet value = sage\nsay value.get(0, default: 3)\nexit\n',
      "A speaker has no methods. Use one of its properties instead.",
    ],
    // (members named in words, each of its own type, Codex r4)
    [
      'let xs = ["a"]\nsay xs.foo + 1\nexit\n',
      "Use one of its properties instead: length, first, last, or random.",
    ],
    [
      "let d = 1 calendar day\nsay d.seconds + 1\nexit\n",
      "Use one of its properties instead: months, days, or exactOffset.",
    ],
    // (a conversion only where the receiver has no other type, Codex r4)
    [
      "let vs: (integer | duration)[] = [1, 1 s]\nlet v = vs[0]\nsay v.seconds\nexit\n",
      "Divide the duration by a unit of time instead.",
    ],
    // (a conversion, a date and time form or a join whose result no use was checked for, where its use is not what a
    // `say` shows, a `${...}` holds or a condition takes: words, Codex r6)
    [
      "let n = 12\nif n.length { say 1 }\nexit\n",
      "Convert the value to text first with the toString function.",
    ],
    [
      'let n = 12\nsay n.replace("1", "a")\nexit\n',
      "Convert the value to text first with the toString function.",
    ],
    [
      "let d = 2 s\nrepeat d.seconds { say 1 }\nexit\n",
      "Divide the duration by a unit of time instead.",
    ],
    // (after an error, a call's reads are not proved)
    [
      'say toDate("2026-10-23") + 1 day\nexit\n',
      "A date moves only by calendar units, such as calendar days.",
    ],
    // (an operand's diagnostic proves neither the other operand's kinds nor the operation's place, #1268: a duration
    // on the left would take no toDate)
    [
      'let a = toDateTime("2026-10-23T12:00:00")\nlet b = toDateTime("2026-10-22T12:00:00")\nsay a - b\nexit\n',
      "Subtract their dates with the toDate function, or convert both with the toAbsoluteDateTime method for the elapsed time.",
    ],
    [
      'let t = toDateTime("2026-10-23T12:00:00")\nif t + 1 s { say 1 }\nexit\n',
      "Convert it with the toAbsoluteDateTime method first, or use calendar units to keep the clock time.",
    ],
    ['let n = 1\nif "x" + n { say 1 }\nexit\n', "Put the value in the text instead."],
    // (no list copy for a method that changes it, whose change the copy would lose, Codex r4)
    [
      "let s = set[3, 1]\nsay s.sort() + 1\nexit\n",
      "Copy 's' into a list with the toList method first.",
    ],
    // a null check of a value not on one line
    [
      "let xs = [7, null]\nsay (xs /* c */ [0]) + 1\nexit\n",
      "Keep 'xs /* c */ [0]' in a new variable and check that it is not null first.",
    ],
    // the text join where the operand that is not text spans lines or holds a comment (the owner's review)
    ['let n = 1\nsay "Sum: " + (n\n+2)\nexit\n', "Put the value in the text instead."],
    ['let n = 1\nsay "Sum: " + (n /* two */ + 2)\nexit\n', "Put the value in the text instead."],
    // a value not on one line (Astra r1: never a name of another declaration; #1268: a literal or an expression on
    // one line is shown in place, `REPAIRS`)
    [
      'let value = set[99]\nsay "${set[4, /* s */ 7]}"\nexit\n',
      "Show its elements with the toList and join methods instead.",
    ],
    [
      'say "${dict{a: /* d */ 1}}"\nexit\n',
      "Select one value with a key, or show every value with the values and join methods.",
    ],
    ['let rec = {names: ["A"]}\nsay "${rec}"\nexit\n', "Show one of its properties instead."],
    ['let d = dict{"1": 5}\nsay d[1]\nexit\n', "Write a number key as text."],
    ["let caption: string = (1 /* one */)\nexit\n", "To show the value as text, put it in a text."],
    // (a selection that is no stable path, its text not code on one line: kept first, without the example)
    [
      "let groups: integer[][] = [[], [21]]\nsay (groups /* any */ .random).last\nexit\n",
      "Keep 'groups /* any */ .random' in a new variable and check its length first.",
    ],
    ["say (1 s + 2 s).seconds\nexit\n", "Divide '1 s + 2 s' by a unit, such as '1 second'."],
    [
      'let t = toAbsoluteDateTime("2026-01-01T00:00:00Z")\nsay (t + 1 s) + 1 calendar day\nexit\n',
      "Convert it with the toDateTime method first.",
    ],
    [
      'say toDate("2026-10-23") < toDateTime("2026-10-23T12:00:00")\nexit\n',
      "Compare its date with the toDate function.",
    ],
    [
      'let ds = [toDateTime("2026-01-01T00:00:00")]\nsay ds.random + 1 s\nexit\n',
      "Convert it with the toAbsoluteDateTime method first, or use calendar units to keep the clock time.",
    ],
    [
      'let ds = [toDateTime("2026-01-01T00:00:00")]\nsay ds.random - ds[0]\nexit\n',
      "Subtract their dates with the toDate function, or convert both with the toAbsoluteDateTime method for the " +
        "elapsed time.",
    ],
    // #1241: where no complete code form stands at the site, the function or the step in words: a unit,
    // a conversion of text not on one line; members of a receiver that is no stable path; a method's arguments; an
    // add's key; a list joined of a receiver that is no stable path
    [
      "let n = 1\nlet p: duration = n /* c */ + 1\nexit\n",
      "Put the expression in parentheses with a unit after them.",
    ],
    ['let day: date = ("2026-" +\n"10-28")\nexit\n', "Convert the text with the toDate function."],
    // (Codex r3: a text the conversion does not read, or another value, which may be one)
    ['let day: date = "bad"\nexit\n', "Convert the text with the toDate function."],
    ['let day: date = "2026-02-30"\nexit\n', "Convert the text with the toDate function."],
    ['let at: time = "25:00"\nexit\n', "Convert the text with the toTime function."],
    [
      'let text = "bad"\nlet day: date = text\nexit\n',
      "Convert the text with the toDate function.",
    ],
    [
      "let angles = [90 deg]\nsay angles.random.degrees\nexit\n",
      "Use the toDeg function for its size in degrees.",
    ],
    ['let ts = ["a"]\nsay ts.random.trim\nexit\n', "Call the trim method with parentheses."],
    [
      'let ts = ["a"]\nsay ts.random.length()\nexit\n',
      "Read the length property without parentheses.",
    ],
    ['let ts = ["a"]\nsay ts.random.size\nexit\n', "Use the length property."],
    [
      'let t = "hello"\nsay t.substring\nexit\n',
      "Call the substring method with its arguments in parentheses.",
    ],
    ['let t = "hello"\nsay t.includes("l")\nexit\n', "Use the contains method."],
    [
      'let os = [{n: 1}]\nsay os.random["n"]\nexit\n',
      "If the object has a property 'n', use a dot instead of brackets.",
    ],
    [
      "let ds = [dict{a: 1}]\nsay ds.random.collar\nexit\n",
      "To read a value by its key, write the key in brackets, where 'ds.random' has that key.",
    ],
    // (Codex r6: a key the dict may not have, also a value of objects; a loop's iterable, whose variable the body reads;
    // a list of objects, whose element's properties the fix cannot prove)
    [
      "let d = dict{k: 1}\nsay d.missing\nexit\n",
      "To read a value by its key, write the key in brackets, where 'd' has that key.",
    ],
    [
      'let d = dict{k: {n: 1}}\nlet v = {n: "x"}\nv = d.k\nexit\n',
      "To read a value by its key, write the key in brackets, where 'd' has that key.",
    ],
    [
      "let xs = [1]\nfor v in xs + 2 {\n  say v\n}\nexit\n",
      "To add one element, put the element in brackets for a new list, or call the add method on a line of its own.",
    ],
    [
      'let xs = [{n: 1}]\nsay xs + {n: "x"}\nexit\n',
      "To add one element, put the element in brackets for a new list, or call the add method on a line of its own.",
    ],
    [
      "let ds = [dict{a: 1}]\nds.random.b = 2\nexit\n",
      "To store a value by its key, write the key in brackets.",
    ],
    [
      "let toys = dict{collar: 1}\ntoys.add(2)\nexit\n",
      "Assign the value to a key of the dict instead.",
    ],
    [
      'let ls = [["A"]]\nsay ls.random + "B"\nexit\n',
      "To add one element, put the element in brackets for a new list, or call the add method on a line of its own.",
    ],
    ["let ls = [[1]]\nsay 2 + ls.random\nexit\n", "Put the element in brackets for a new list."],
    // (Astra r2, Codex r4: a join of elements whose type it cannot show, also of a list cleared or filled later, of
    // lists, of a dict's objects, nested; of elements whose type is not known; a warning's receiver, which may be of
    // another type or null, so its fix is in words)
    ...[
      "let items = [{n: 1}]\nsay items.join\nexit\n",
      "let items = [{n: 1}]\nitems.clear()\nsay items.join\nexit\n",
      "let items = []\nitems.add({n: 1})\nsay items.join\nexit\n",
      "let items = [[1]]\nsay items.join\nexit\n",
      "let ds = dict{a: {n: 1}}\nsay ds.values.join\nexit\n",
      "let box = {items: [{n: 1}]}\nsay box.items.join\nexit\n",
    ].map(
      (source) =>
        [
          source,
          "The join method joins only elements that can be shown as text, so select an element or a property first.",
        ] as const,
    ),
    [
      "let items = [hostValue]\nsay items.join\nexit\n",
      "Call the join method with parentheses, on elements that can be shown as text.",
    ],
    [
      'function show(x: string | integer) {\n  say x.trim\n}\nshow("a")\nshow(1)\nexit\n',
      "Call the trim method with parentheses.",
    ],
    ['function show(x) {\n  say x.size\n}\nshow("a")\nshow(1)\nexit\n', "Use the length property."],
    [
      'function show(x: string?) {\n  say x.trim\n}\nshow("a")\nshow(null)\nexit\n',
      "Call the trim method with parentheses.",
    ],
    // (Codex r7: an argument of a parameter without a type that its body or its result's use does not
    // take, a variable's value its reads do not take; a receiver read through a dict's key, which may be absent)
    [
      'let t = "hello"\nfunction use(p) {\n  say p.trim()\n}\nuse(t.size)\nexit\n',
      "Use the length property.",
    ],
    [
      'let t = "hello"\nfunction id(p) {\n  return p\n}\nlet q: string[] = id(t.size)\nexit\n',
      "Use the length property.",
    ],
    ['let t = "hello"\nlet v = t.size\nsay v.trim()\nexit\n', "Use the length property."],
    // (Astra on #1296: an error's value read by an index or a dict's key, which may be absent,
    // the list or the operand a list or a conversion fix reads, either way; an element as a receiver)
    [
      'let d = dict{found: [1]}\nsay d["absent"] + 2\nexit\n',
      "To add one element, put the element in brackets for a new list, or call the add method on a line of its own.",
    ],
    [
      "let ls = [[1]]\nsay ls[0] + 2\nexit\n",
      "To add one element, put the element in brackets for a new list, or call the add method on a line of its own.",
    ],
    [
      'let d = dict{found: 2}\nlet v: duration = d["absent"]\nsay v\nexit\n',
      "Give the number a unit.",
    ],
    ["let ns = [2]\nlet v: duration = ns[0]\nsay v\nexit\n", "Give the number a unit."],
    // (Codex r12: such a read inside a literal or an interpolation, also before another part)
    [
      'let d = dict{found: 2}\nlet v: duration = ({n: d["absent"]}).n\nsay v\nexit\n',
      "Give the number a unit.",
    ],
    [
      'let d = dict{found: 2}\nlet v: duration = toInteger("${d["absent"]}${1}", default: 1)\nsay v\nexit\n',
      "Give the number a unit.",
    ],
    // (Astra r2 on #1296: a property of a receiver that may be null, as a variable or a property holds it)
    [
      "let boxes = [{n: 2}, null]\nlet box = boxes[1]\nlet converted: duration = box.n\nsay converted\nexit\n",
      "Give the number a unit.",
    ],
    [
      'let boxes = [{text: "hi", items: [1]}, null]\nlet outer = {inner: boxes[1]}\nsay outer.inner.text.size\nexit\n',
      "Use the length property.",
    ],
    [
      'let boxes = [{text: "hi", items: [1]}, null]\nlet box = boxes[1]\nsay box.items + 2\nexit\n',
      "To add one element, put the element in brackets for a new list, or call the add method on a line of its own.",
    ],
    // (Astra r3 on #1296: an operand that may be null, nested in arithmetic)
    [
      "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = n + 1\nsay converted\nexit\n",
      "Give the number a unit.",
    ],
    [
      "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = -n\nsay converted\nexit\n",
      "Give the number a unit.",
    ],
    // (Codex r13: such a read in an ask's operand)
    [
      'let d = dict{found: "Q"}\nlet v: duration = askInteger(d["absent"])\nsay v\nexit\n',
      "Give the number a unit.",
    ],
    ['let items = ["hello"]\nsay items[0].size\nexit\n', "Use the length property."],
    ['let lists = [["a"]]\nsay lists[0].join\nexit\n', "Call the join method with parentheses."],
    [
      "let xs = [1]\nlet caption: string = xs[0]\nsay caption\nexit\n",
      "To show the value as text, put it in a text.",
    ],
    [
      'let d = dict{"a": 2}\nlet caption: string = d["a"]\nsay caption\nexit\n',
      "To show the value as text, put it in a text.",
    ],
    // (Codex r9: a default's or a fallback's type must also fit the value it stands beside, C10)
    [
      'let t = "hello"\nlet ys = ["x"]\nsay ys.get(9, default: t.size)\nexit\n',
      "Use the length property.",
    ],
    ['let t = "hello"\nsay t.size otherwise "x"\nexit\n', "Use the length property."],
    // (Codex r8: a compound assignment's operands, which have no flow point here)
    ['let t = "hello"\nlet v = t.size\nv += "x"\nsay v\nexit\n', "Use the length property."],
    [
      'let t = "hello"\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(t.size)\nexit\n',
      "Use the length property.",
    ],
    [
      'let d = dict{a: " hello "}\nsay d["missing"].trim\nexit\n',
      "Call the trim method with parentheses.",
    ],
    [
      'let d = dict{a: " hello "}\nsay d["a"].trim\nexit\n',
      "Call the trim method with parentheses.",
    ],
    // (Astra on #1273: a fallback the fix would write where the value divides, as a divisor, through a calculation or a
    // member, where a written zero stops the run)
    ...[
      "let xs = [4, null]\nsay 1 / xs[1]\nexit\n",
      "let xs = [4, null]\nsay 7 % xs[1]\nexit\n",
      "let xs = [4, null]\nsay 1 / (xs[1] * 2)\nexit\n",
      'let xs = ["ab", null]\nsay 4 / xs[1].length\nexit\n',
      // (Codex r8, r9: through a side of 'otherwise', a default)
      'let xs = ["ab", null]\nsay 1 / (xs[1].length otherwise 1)\nexit\n',
      'let xs = ["ab", null]\nsay 1 / load("missing", default: xs[1].length)\nexit\n',
      // (Codex r10: through a literal's contents, an interpolation's text)
      'let xs = ["ab", null]\nsay 1 / [xs[1].length][0]\nexit\n',
      'let xs = ["ab", null]\nsay 1 / ({n: xs[1].length}).n\nexit\n',
      'let xs = ["ab", null]\nsay 1 / toInteger("${xs[1].length}", default: 1)\nexit\n',
      'function f(s: string, xs: string?[]) {\n  say 1 / toInteger(s, default: xs[1].length)\n}\nf("bad", ["ab", null])\nexit\n',
    ].map(
      (source) =>
        [
          source,
          "or give a fallback after 'otherwise' that does not lead to a division by zero.",
        ] as const,
    ),
  ];
  for (const [source, fix] of cases) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const messages = diagnostics.map((diagnostic) => coreMessage(diagnostic, text));
    assert.ok(
      messages.some((message) => message.includes(fix)),
      `${source}: ${messages.join(" | ")}`,
    );
  }
});
