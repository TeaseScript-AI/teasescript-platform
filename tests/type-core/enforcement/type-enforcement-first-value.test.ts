// A type decided by the first value: a variable that starts as null, an empty list or set, an object's and a speaker's
// properties.

import assert from "node:assert/strict";
import test from "node:test";

import { compileProject } from "../../../src/compiler.js";
import { run } from "../../../src/runtime/engine.js";
import { createImmediatePacingRuntimeSnapshot } from "../../helpers/immediate-pacing-runtime.js";
import { runValidSource } from "../../helpers/run-valid-source.js";
import { mismatches, codes, sayTexts } from "../../helpers/type-core/type-enforcement-setup.js";

test("a variable that starts as null takes the type of its first non-null value and names both places", () => {
  assert.deepEqual(mismatches('let best = null\nbest = "Ada"\nbest = null\nbest = 5\nexit'), [
    [
      "TSV041",
      "'best' holds text (string) or null since line 2, so it cannot be set to a whole number (integer). To show it as text, write \"${5}\".",
      "5",
    ],
  ]);
  // A value the compiler cannot know decides nothing; the first known value does.
  assert.deepEqual(
    codes('let best = null\nbest = load "be" + "st", default: null\nbest = 2\nbest = "x"\nexit'),
    [["TSV041", '"x"']],
  );
  // The first value in checking order decides, also when it is assigned inside a function.
  assert.deepEqual(codes('let best = null\nfunction keep {\n    best = 5\n}\nbest = "x"\nexit'), [
    ["TSV041", "5"],
  ]);
  // A read before that value in checking order, here of an element in a function body, sees the decided type too.
  assert.deepEqual(
    sayTexts(
      'let marks = [null]\nfunction doubled {\n    let mark = marks[0]\n    if mark != null {\n        return mark * 2\n    }\n    return 0\n}\nsay "${doubled()}"\nmarks[0] = 4\nsay "${doubled()}"\nexit',
    ),
    ["0", "8"],
  );
  // The same store decides it, so a later store of another type is reported as without the read.
  const conflicting = (read: string) =>
    mismatches(`let box = { best: null }\n${read}\nbox.best = 5\nbox.best = "a"\nexit`);
  assert.deepEqual(conflicting("let seen = box.best"), [
    [
      "TSV041",
      "'box.best' holds a whole number (integer) or null since line 3, so it cannot be set to text (string). Use a separate property for a value of another type.",
      '"a"',
    ],
  ]);
  assert.deepEqual(conflicting("let seen = 0"), conflicting("let seen = box.best"));
  // A store of a place that is still undecided itself decides by that place, along a whole chain at once.
  assert.deepEqual(
    codes(
      'let o = { a: null, b: null, c: null }\nlet first = o.a\no.a = o.b\no.b = o.c\no.c = 5\no.a = "x"\nexit',
    ),
    [["TSV041", '"x"']],
  );
  // A decided part brings what later stores widen in it, also for a copy taken before.
  assert.deepEqual(
    codes(
      "let a = []\nfunction f {\n    let b = a\n    if b.length > 0 {\n        let k: integer = b[0].n\n        say k\n    }\n}\nf()\na.add({ n: 1 })\na[0].n = 0.5\nf()\nexit",
    ),
    [["TSV041", "b[0].n"]],
  );
  // A value the compiler cannot know, here an untyped parameter, decides nothing: a read before it is not narrowed to
  // null, and a known place checks it when the store runs.
  const unknownStore = (argument: string) =>
    `let box = { t: null }\nfunction setT(t) {\n    box.t = t\n}\nfunction show {\n    let v = box.t\n    let o = 0\n    if v != null {\n        o = v\n    }\n    say "\${o}"\n}\nshow()\nsetT(${argument})\nshow()\nexit`;
  assert.deepEqual(sayTexts(unknownStore("5")), ["0", "5"]);
  assert.equal(runValidSource(unknownStore('"high"')).snapshot.failure?.code, "TSR058");
  // Also when the unknown value replaces the whole object, or arrives through a function's result, alone or joined
  // with a known value.
  for (const [store, read] of [
    ["box = t", "box.t"],
    ["box.t = t", "get()"],
    ["box.t = t", "known(true)"],
    ["box.t = t", "[box.t, 9][0]"],
  ] as const) {
    const source = (argument: string) =>
      `let box = { t: null }\nfunction setT(t) {\n    ${store}\n}\nfunction get {\n    return box.t\n}\nfunction known(flag) {\n    if flag {\n        return box.t\n    }\n    return 9\n}\nfunction show {\n    let v = ${read}\n    let o: integer = 0\n    if v != null {\n        o = v\n    }\n    say o\n}\nshow()\nsetT(${argument})\nshow()\nexit`;
    const argument =
      store === "box = t" ? (value: string) => `{ t: ${value} }` : (value: string) => value;
    assert.deepEqual(sayTexts(source(argument("5"))), ["0", "5"], store);
    assert.equal(
      runValidSource(source(argument('"high"'))).snapshot.failure?.code,
      "TSR058",
      store,
    );
  }
  // A first value that still leaves a part undecided, such as a property that only took null, decides the place for an
  // earlier read too, so a null check there holds in either checking order: also after a value the compiler cannot
  // know, and for a copy of another variable.
  const profile = (calls: string) =>
    `let profile = null\nfunction stats {\n    if profile != null {\n        profile.images = []\n        let images = profile.images\n        if images != null {\n            say "\${images.length}"\n        }\n    }\n}\nfunction create {\n    profile = { images: null }\n}\n${calls}\nexit`;
  assert.deepEqual(sayTexts(profile("stats()\ncreate()\nstats()")), ["0"]);
  assert.deepEqual(sayTexts(profile("create()\nstats()")), ["0"]);
  const loaded = (calls: string) =>
    `let id = load "id", default: ""\nlet me = null\nfunction stats {\n    me = load "p-\${id}", default: null\n    if me != null {\n        me.images = []\n        let images = me.images\n    }\n}\nfunction create {\n    let map = { images: null, name: null }\n    me = map\n}\n${calls}\nexit`;
  assert.deepEqual(codes(loaded("stats()\ncreate()")), []);
  assert.deepEqual(codes(loaded("create()\nstats()")), []);
  // A place that holds itself is never decided further, also through another place, so the check ends.
  assert.deepEqual(
    codes(
      "let a = []\na.add(a)\nlet b = { n: null }\nlet c = b.n\nb.n = b\nlet p = []\nlet q = []\nlet x = p\nlet y = q\np.add(q)\nq.add(p)\nexit",
    ),
    [],
  );
});

test("an empty list or set takes its element type from the first element, and null elements make it optional", () => {
  assert.deepEqual(mismatches('let items = []\nitems.add(1)\nitems.add("x")\nexit'), [
    [
      "TSV041",
      "'items' holds integer values (integer[]) since line 2, so it cannot contain text (string). To allow both, declare it as 'let items: (integer | string)[] = ...'.",
      '"x"',
    ],
  ]);
  assert.deepEqual(codes('let items = []\nitems = ["a"]\nitems[0] = 2\nexit'), [["TSV041", "2"]]);
  assert.deepEqual(codes('let tags = set[]\ntags.add("a")\ntags.add(true)\nexit'), [
    ["TSV041", "true"],
  ]);
  assert.deepEqual(codes('let marks = [null, 1]\nmarks.add(null)\nmarks.add("x")\nexit'), [
    ["TSV041", '"x"'],
  ]);
  assert.deepEqual(
    codes("let marks = [null]\nmarks.add(1)\nmarks.add(null)\nmarks.add(true)\nexit"),
    [["TSV041", "true"]],
  );
  assert.deepEqual(codes("let groups = [[], [1]]\ngroups.add([2])\ngroups.add([true])\nexit"), [
    ["TSV041", "true"],
  ]);
});

test("an object property keeps the type of its first value, and assignment may add a property", () => {
  assert.deepEqual(
    mismatches(
      'let door = { locked: true }\ndoor.locked = "yes"\ndoor.color = "red"\ndoor.color = 5\nexit',
    ),
    [
      [
        "TSV041",
        "'door.locked' holds true or false (boolean), so it cannot be set to text (string). Use a separate property for a value of another type.",
        '"yes"',
      ],
      [
        "TSV041",
        "'door.color' holds text (string) since line 3, so it cannot be set to a whole number (integer). To show it as text, write \"${5}\".",
        "5",
      ],
    ],
  );
  assert.deepEqual(codes('let door = { owner: null }\ndoor.owner = "Ada"\ndoor.owner = 3\nexit'), [
    ["TSV041", "3"],
  ]);
  assert.deepEqual(
    mismatches('let door = {}\ndoor.owner = [null, 1][0]\ndoor.owner = "Ada"\nexit')[0]?.[1],
    "'door.owner' holds a whole number (integer) or null since line 2, so it cannot be set to text (string). Use a separate property for a value of another type.",
  );
  assert.deepEqual(codes('let door = { keys: [1] }\ndoor.keys.add("x")\nexit'), [
    ["TSV041", '"x"'],
  ]);
  assert.deepEqual(codes('let door = { locked: true }\ndoor = { locked: "no", open: 1 }\nexit'), [
    ["TSV041", '"no"'],
  ]);
  // Copies keep their own properties: a property added to one is not added to the other.
  assert.deepEqual(codes('let a = { x: 1 }\nlet b = a\nb.y = "b"\na.y = 2\nexit'), []);
  assert.deepEqual(
    mismatches('let kept = []\nkept.add({ name: "Ada" })\nkept.add({ name: 1 })\nexit')[0]?.[1],
    "Property 'name' of the elements of 'kept' holds text (string), so it cannot be set to a whole number (integer). To show it as text, write \"${1}\".",
  );
  assert.deepEqual(
    mismatches(
      'let kept = [{ name: "Ada" }]\nlet other = { name: 1 }\nkept.add(other)\nexit',
    )[0]?.[1],
    "'kept' holds object values (object[]), so its property 'name', which holds text (string), cannot be set to a whole number (integer). Use a separate property for a value of another type.",
  );
});

test("a speaker's custom property keeps the type of its first value like an object property (V30 §37)", () => {
  assert.deepEqual(
    mismatches(
      'speaker vera { level: 0 }\nvera.level = "high"\nvera.mood = "calm"\nvera.mood = 5\nexit',
    ),
    [
      [
        "TSV041",
        "'vera.level' holds a whole number (integer) since line 1, so it cannot be set to text (string). Use a separate property for a value of another type.",
        '"high"',
      ],
      [
        "TSV041",
        "'vera.mood' holds text (string) since line 3, so it cannot be set to a whole number (integer). To show it as text, write \"${5}\".",
        "5",
      ],
    ],
  );
  // Inside a property, through its elements, by a compound assignment, a value of type object, and in a read.
  assert.deepEqual(
    codes(
      [
        "speaker vera {",
        "    data: { v: 0 }",
        "    items: [0]",
        "    scores: dict{ a: 0 }",
        "    level: 0",
        "}",
        "let b: object = { v: 1 }",
        'vera.data.v = "x"',
        'vera.items[0] = "x"',
        'vera.items.add("x")',
        'vera.scores["a"] = "x"',
        'vera.level += "x"',
        "vera.level = b",
        "let shown: string = vera.level",
        "exit",
      ].join("\n"),
    ),
    [
      ["TSV041", '"x"'],
      ["TSV041", '"x"'],
      ["TSV041", '"x"'],
      ["TSV041", '"x"'],
      ["TSV041", '"x"'],
      ["TSV041", "b"],
      ["TSV041", "vera.level"],
    ],
  );
  // A number widens a property that took whole numbers, two speakers keep their own types, and built-in properties keep
  // their own rules, such as null for a presentation default.
  assert.deepEqual(
    mismatches(
      [
        "speaker vera {",
        "    level: 0",
        '    bubble: { background: "#334455" }',
        "}",
        'speaker cora { level: "high" }',
        "vera.level = 2.5",
        "vera.bubble = null",
        'cora.level = "low"',
        "exit",
      ].join("\n"),
    ),
    [],
  );
  // A store through a speaker that the compiler cannot tell apart leaves only that property without a type.
  assert.deepEqual(
    codes(
      [
        "speaker vera {",
        "    level: 0",
        "    mood: 0",
        "}",
        "function calm(s: speaker) {",
        '    s.mood = "calm"',
        "}",
        "calm(vera)",
        'vera.level = "high"',
        "exit",
      ].join("\n"),
    ),
    [["TSV041", '"high"']],
  );
});

test("reading a custom property that no declaration or assignment gives a speaker is a compile error (V30 §37)", () => {
  // Through the speaker's name, also by a compound assignment and before a method; a misspelling names the property.
  assert.deepEqual(
    mismatches(
      [
        "speaker vera { level: 0 }",
        "say vera.mood",
        "vera.score += 1",
        "vera.items.add(1)",
        "say vera.levle",
        "say vera.firstname",
        "exit",
      ].join("\n"),
    ),
    [
      [
        "TSV043",
        "Speaker 'vera' has no property 'mood'. Its only custom property is 'level'. Give it a start value, as in 'speaker vera { mood: ... }', or assign it before this line.",
        "mood",
      ],
      [
        "TSV043",
        "Speaker 'vera' has no property 'score'. Its only custom property is 'level'. Give it a start value, as in 'speaker vera { score: ... }', or assign it before this line.",
        "score",
      ],
      [
        "TSV043",
        "Speaker 'vera' has no property 'items'. Its only custom property is 'level'. Give it a start value, as in 'speaker vera { items: ... }', or assign it before this line.",
        "items",
      ],
      [
        "TSV043",
        "Speaker 'vera' has no property 'levle'. Its only custom property is 'level'. Did you mean 'level'?",
        "levle",
      ],
      [
        "TSV043",
        "Speaker 'vera' has no property 'firstname'. Its only custom property is 'level'. Did you mean 'firstName'?",
        "firstname",
      ],
    ],
  );
  assert.deepEqual(mismatches("speaker vera {}\nsay vera.mood\nexit"), [
    [
      "TSV043",
      "Speaker 'vera' has no custom properties, so it has no 'mood'. Give it a start value, as in 'speaker vera { mood: ... }', or assign it before this line.",
      "mood",
    ],
  ]);
  // A property that a store through an alias may give it counts as one it can have.
  assert.deepEqual(mismatches("speaker vera {}\nlet s = vera\ns.mood = 1\nsay vera.mod\nexit"), [
    [
      "TSV043",
      "Speaker 'vera' has no property 'mod'. Its only custom property is 'mood'. Did you mean 'mood'?",
      "mod",
    ],
  ]);
  // As `speaker` where `as` or the speaker's own properties name the speaker, also when another speaker has it.
  assert.deepEqual(
    codes(
      [
        "speaker vera {",
        "    a: 1",
        "    b: speaker.c",
        "}",
        "speaker anna { mood: 1 }",
        'say as vera "${speaker.mood}"',
        "exit",
      ].join("\n"),
    ),
    [
      ["TSV043", "c"],
      ["TSV043", "mood"],
    ],
  );
  // Through a speaker the compiler cannot tell apart: an alias, a parameter, an element, or the default speaker, when
  // no speaker has the property.
  const none =
    "No speaker has a property 'mood'. The custom property of speakers is 'level'. Give it a start value, as in 'speaker vera { mood: ... }', or assign it before this line.";
  assert.deepEqual(
    mismatches(
      [
        "speaker vera { level: 0 }",
        "speaker vera",
        "function show(s: speaker) {",
        "    say s.mood",
        "}",
        "show(vera)",
        "let alias = vera",
        "say alias.mood",
        "say [vera][0].mood",
        'say "${speaker.mood}"',
        "exit",
      ].join("\n"),
    ),
    [
      ["TSV043", none, "mood"],
      ["TSV043", none, "mood"],
      ["TSV043", none, "mood"],
      ["TSV043", none, "mood"],
    ],
  );
  // In another file, also in a function the read calls first.
  const files = (read: string) =>
    compileProject([
      { path: "main.tease", source: `calm()\nsay ${read}\nexit` },
      {
        path: "people.tease",
        source: 'speaker vera {}\nglobal function calm {\n    vera.mood = "calm"\n}',
      },
    ]);
  assert.deepEqual(
    files("vera.moood").diagnostics.map((diagnostic) => [diagnostic.path, diagnostic.code]),
    [["main.tease", "TSV043"]],
  );
  const calm = files("vera.mood");
  assert.deepEqual(calm.diagnostics, []);
  const result = run(calm.plan!, createImmediatePacingRuntimeSnapshot(calm.plan!));
  assert.deepEqual(
    result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["calm"],
  );
});

test("a speaker's custom property that some store may give it is read when the script runs", () => {
  // Stores in a function, through a speaker parameter, an untyped parameter, or an object's property, and a read through
  // a parameter of a speaker that has the property while another does not, compile, and run where the property is set.
  assert.deepEqual(
    sayTexts(
      [
        "speaker vera {}",
        'speaker anna { mood: "calm" }',
        "function later {",
        '    vera.mood = "later"',
        "}",
        "function name(s: speaker, x) {",
        '    s.nick = "nick"',
        '    x.pet = "pet"',
        "}",
        "function show(s: speaker) {",
        "    say s.mood",
        "}",
        "later()",
        "name(vera, vera)",
        "let holder = { s: vera }",
        'holder.s.tag = "tag"',
        'say "${vera.mood} ${vera.nick} ${vera.pet} ${vera.tag}"',
        "show(anna)",
        "exit",
      ].join("\n"),
    ),
    ["later nick pet tag", "calm"],
  );
  // A term that V30 gives every speaker is not a custom property; the runtime checks a read of one.
  assert.deepEqual(mismatches('speaker vera { gender: "female" }\nsay vera.heShe\nexit'), []);
});

test("a first null is remembered wherever a first value decides a type", () => {
  assert.deepEqual(
    codes("let door = {}\ndoor.owner = null\ndoor.owner = 1\ndoor.owner = null\nexit"),
    [],
  );
  assert.deepEqual(codes("let x = null\nx = [null]\nx[0] = 1\nexit"), []);
  assert.deepEqual(
    codes("let items = []\nitems.add(null)\nitems.add(1)\nitems.add(null)\nitems.add(true)\nexit"),
    [["TSV041", "true"]],
  );
  // A join keeps a first null from either side; an empty collection that never took null adds nothing.
  for (const [empty, other] of [
    ["[]", "[1]"],
    ["set[]", "set[1]"],
  ] as const) {
    const seen = `let a = ${empty}\na.add(null)\n`;
    assert.deepEqual(codes(`${seen}let b = [a, ${other}]\nb[0].add(null)\nexit`), [], empty);
    assert.deepEqual(codes(`${seen}let b = [${other}, a]\nb[1].add(null)\nexit`), [], empty);
  }
  assert.deepEqual(codes("let a = [null]\nlet b = [[1], a]\nb[1].add(null)\nexit"), []);
  assert.deepEqual(
    codes(
      "let a = []\na.add(null)\nfunction f(flag) {\n    if flag {\n        return a\n    }\n    return [1]\n}\nlet r = f(true)\nr.add(null)\nexit",
    ),
    [],
  );
  assert.deepEqual(codes("let a = []\nlet b = [a, [1]]\nb[0].add(null)\nexit"), [
    ["TSV041", "null"],
  ]);
});
