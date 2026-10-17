import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

// A store into a value that no variable holds is a compile error, because the change would be lost with the copy; a
// speaker or a handle reached through a call is changed itself (owner decision O3, 2026-10-16).

const VERA = 'speaker vera {\n    firstName: "Vera"\n    mood: "calm"\n    items: [1]\n}\n';
const OBJ = "let o = { n: 1, items: [1], guide: vera }\nfunction obj {\n    return o\n}\n";
const LISTS = "let ll = [[1], [2]]\nfunction listOfLists {\n    return ll\n}\n";
const THINGS = "let xs = [3, 1, 2]\nfunction things {\n    return xs\n}\n";
const SELECTED =
  "function selected {\n    return vera\n}\nfunction speakers {\n    return [vera]\n}\n";

/** The diagnostics of `source` as code, message, and the source each span covers. */
function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

function copyError(
  call: string,
  name: string,
  changed: string,
  span: string,
): [string, string, string] {
  return [
    "TSV067",
    `This changes a copy that no variable holds: '${call}' gives a new value each time, so the change is lost. Store it in a variable first, as in 'let ${name} = ${call}', then change '${changed}'.`,
    span,
  ];
}

const UNNAMED_ERROR =
  "This changes a copy that no variable holds, so the change is lost. Store the value in a variable first, then change the variable.";

test("a change of a value no variable holds, through members and elements, is a compile error", () => {
  const source = `${VERA}${OBJ}${LISTS}${THINGS}obj().n = 5\nobj().n += 1\nthings()[0] = 9\nobj().items.add(7)\nlistOfLists()[0].add(7)\nthings().sort()\nthings().removeAt(0)\nxs.take(2)[0] = 9\n[1, 2][0] = 3\n{ n: 1 }.n = 2\n(xs + [4])[0] = 1\nload("k", default: [1]).add(2)\nexit`;
  assert.deepEqual(diagnostics(source), [
    copyError("obj()", "o", "o.n", "obj().n"),
    copyError("obj()", "o", "o.n", "obj().n"),
    copyError("things()", "t", "t[0]", "things()[0]"),
    copyError("obj()", "o", "o.items", "obj().items"),
    copyError("listOfLists()", "l", "l[0]", "listOfLists()[0]"),
    copyError("things()", "t", "t", "things()"),
    copyError("things()", "t", "t", "things()"),
    copyError("xs.take(...)", "t", "t[0]", "xs.take(2)[0]"),
    ["TSV067", UNNAMED_ERROR, "[1, 2][0]"],
    ["TSV067", UNNAMED_ERROR, "{ n: 1 }.n"],
    ["TSV067", UNNAMED_ERROR, "(xs + [4])[0]"],
    ["TSV067", UNNAMED_ERROR, 'load("k", default: [1])'],
  ]);
  // A method that the value does not have is no change of it, and text `reverse` gives a new text.
  assert.deepEqual(
    diagnostics('dict{ a: 1 }.add(3)\nset[1, 2].removeAt(0)\n"abc".reverse()\nexit').map(
      ([code, , span]) => [code, span],
    ),
    [
      ["TSV043", "add"],
      ["TSV043", "removeAt"],
    ],
  );
});

test("a speaker or a handle on the way from the change to the call takes the change", () => {
  const changes =
    'selected().mood = "angry"\nselected().items.add(7)\nsay "${vera.mood} ${vera.items.length}"\nvera.mood = "calm"\nspeakers()[0].mood = "cross"\nsay vera.mood\nobj().guide.mood = "sulky"\nsay vera.mood\n';
  assert.deepEqual(sayTexts(runValidSource(`${VERA}${OBJ}${SELECTED}${changes}exit`)), [
    "angry 2",
    "cross",
    "sulky",
  ]);
  // A message handle that a call gives names the message it showed.
  const line = 'function line {\n    return say "hello"\n}\nline().text = "changed"\nexit';
  const events = runValidSource(line).events.filter((event) => event.kind === "messageUpdated");
  assert.deepEqual(
    events.map((event) => event.text),
    ["changed"],
  );
  // A value the compiler cannot know may be a speaker, so its change compiles.
  const pick =
    'function pick(value) {\n    return value\n}\npick(vera).mood = "angry"\nsay vera.mood\nexit';
  assert.deepEqual(sayTexts(runValidSource(`${VERA}${pick}`)), ["angry"]);
});

test("the same changes through a variable change the variable, and a call that only reads may remove", () => {
  const changes =
    'let a = obj()\na.n = 5\na.items.add(7)\nlet t = things()\nt[0] = 9\nt.sort()\nlet l = listOfLists()\nl[0].add(7)\nsay "${a.n} ${a.items.length} ${l[0].length} ${o.n} ${xs[0]}"\nsay t\nlet first = things().removeFirst()\nsay "${first} ${xs.length}"\nexit';
  assert.deepEqual(sayTexts(runValidSource(`${VERA}${OBJ}${LISTS}${THINGS}${changes}`)), [
    "5 2 2 1 3",
    "[1, 2, 9]",
    "3 3",
  ]);
});

const COLLECTIONS =
  "let d = dict{ a: [1], b: [2] }\nlet s = set[[1], [2]]\nlet os = set[{ n: 1 }]\nlet o = { d: dict{ a: [1] } }\nlet dl = [dict{ a: [1] }]\n";

function computedError(property: string, span: string): [string, string, string] {
  const receiver = property.slice(0, property.lastIndexOf("."));
  const message = `This changes a copy that no variable holds: '${property}'`;
  return [
    "TSV067",
    property.endsWith(".keys")
      ? `${message} gives a new list each time, so the change is lost. Change the dict itself, as in '${receiver}[key] = value' or '${receiver}.remove(key)'.`
      : property.endsWith(".values")
        ? `${message} gives a new list each time, so the change is lost. Change the dict through its keys, as in '${receiver}[key]'.`
        : `${message} gives a copy of the member, so the change is lost. To change the set, replace the member: 'let member = ${property}', '${receiver}.remove(member)', then change 'member' and '${receiver}.add(member)'.`,
    span,
  ];
}

test("a change through a property that computes a new value, such as a dict's values, is a compile error", () => {
  const changes =
    'd.values[0].add(3)\nd.values[0] = [7]\nd.values.add([5])\nd.keys.add("c")\ns.first.add(9)\ns.last.add(8)\ns.random.add(7)\nos.first.n = 5\no.d.values[0].add(1)\ndl[0].values[0].add(1)\nvera.table.values[0].add(9)\nfunction table {\n    return d\n}\ntable().values[0].add(1)\n';
  const table = VERA.replace("items: [1]\n", "items: [1]\n    table: dict{ a: [1] }\n");
  assert.deepEqual(diagnostics(`${table}${COLLECTIONS}${changes}exit`), [
    computedError("d.values", "d.values[0]"),
    computedError("d.values", "d.values[0]"),
    computedError("d.values", "d.values"),
    computedError("d.keys", "d.keys"),
    computedError("s.first", "s.first"),
    computedError("s.last", "s.last"),
    computedError("s.random", "s.random"),
    computedError("os.first", "os.first.n"),
    computedError("o.d.values", "o.d.values[0]"),
    computedError("dict.values", "dl[0].values[0]"),
    computedError("vera.table.values", "vera.table.values[0]"),
    // A value that no variable holds is named first, as the property's own copy is read from it.
    copyError("table()", "t", "t.values[0]", "table().values[0]"),
  ]);
});

test("a speaker between a computed property and the change takes the change", () => {
  const changes =
    'let ds = dict{ v: vera }\nds.values[0].mood = "cross"\nsay vera.mood\nlet ss = set[vera]\nss.first.mood = "sulky"\nsay vera.mood\n';
  assert.deepEqual(sayTexts(runValidSource(`${VERA}${changes}exit`)), ["cross", "sulky"]);
});

test("a list's first, last, and random elements and an object's properties keep a change through them", () => {
  const changes =
    'let xs = [[1], [2]]\nxs.first.add(9)\nxs.last.add(8)\nlet one = [[1]]\none.random.add(7)\nlet ol = [{ n: 1 }]\nol.first.n = 5\no.d["a"].add(2)\nlet values = d.values\nvalues[0].add(6)\nsay xs\nsay one\nsay ol\nsay o\nsay d\n';
  assert.deepEqual(sayTexts(runValidSource(`${COLLECTIONS}${changes}exit`)), [
    "[[1, 9], [2, 8]]",
    "[[1, 7]]",
    "[{ n: 5 }]",
    '{ d: dict{ "a": [1, 2] } }',
    'dict{ "a": [1], "b": [2] }',
  ]);
});
