// S10 part 1's review r2 (Astra): the six case lists its probe ran (R/astra-m4-s10-part1-review-r2/probe.mjs and its
// case files). The two r1 multi-file cases it read unchanged are r1's; the two `const` attempts, which no tree
// parses, are dropped: the review counted them out itself.
export const cases = [
  [
    "form/value != null/control",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value != null { say value }\nexit\n',
  ],
  [
    "form/value != null/changed",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value != null { value = "changed"\nsay value }\nexit\n',
  ],
  [
    "form/value == null/control",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value == null { say "skip" } else { say value }\nexit\n',
  ],
  [
    "form/value == null/changed",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value == null { say "skip" } else { value = "changed"\nsay value }\nexit\n',
  ],
  [
    "form/value is not null/control",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value is not null { say value }\nexit\n',
  ],
  [
    "form/value is not null/changed",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value is not null { value = "changed"\nsay value }\nexit\n',
  ],
  [
    "form/value is null/control",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value is null { say "skip" } else { say value }\nexit\n',
  ],
  [
    "form/value is null/changed",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value is null { say "skip" } else { value = "changed"\nsay value }\nexit\n',
  ],
  [
    "form/not (value == null)/control",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif not (value == null) { say value }\nexit\n',
  ],
  [
    "form/not (value == null)/changed",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif not (value == null) { value = "changed"\nsay value }\nexit\n',
  ],
  [
    "form/not (value != null)/control",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif not (value != null) { say "skip" } else { say value }\nexit\n',
  ],
  [
    "form/not (value != null)/changed",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif not (value != null) { say "skip" } else { value = "changed"\nsay value }\nexit\n',
  ],
  [
    "form/value is integer/control",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value is integer { say value }\nexit\n',
  ],
  [
    "form/value is integer/changed",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value is integer { value = "changed"\nsay value }\nexit\n',
  ],
  [
    "form/value is not integer/control",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value is not integer { say "skip" } else { say value }\nexit\n',
  ],
  [
    "form/value is not integer/changed",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value is not integer { say "skip" } else { value = "changed"\nsay value }\nexit\n',
  ],
  [
    "and",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value != null and value is integer and value > 2 { say value }\nexit\n',
  ],
  [
    "or",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value == null or value is not integer or value < 2 { say "skip" } else { say value }\nexit\n',
  ],
  [
    "while",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nwhile value != null { say value\n break }\nexit\n',
  ],
  [
    "while-outside",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nwhile value != null { value = null }\nsay value\nexit\n',
  ],
  [
    "leave",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value == null { if gateA { exit } else { exit } }\nsay value\nexit\n',
  ],
  [
    "nonleave",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value == null { if gateA { exit } }\nsay value\nexit\n',
  ],
  [
    "false-condition",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif false { if value != null { say value } }\nexit\n',
  ],
  [
    "loop-preserving",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value != null { repeat 3 { value = value * 2\nsay value } }\nexit\n',
  ],
  [
    "loop-breaking",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value != null { repeat 3 { say value\nvalue = null } }\nexit\n',
  ],
  [
    "loop-null-preserving",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value == null { repeat 3 { value = null\nsay value } }\nexit\n',
  ],
  [
    "loop-fraction",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value is integer { repeat 3 { value = value / 2\nsay value } }\nexit\n',
  ],
  [
    "save",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value != null { save value as "elsewhere"\nsay value }\nexit\n',
  ],
  [
    "untaken-owner",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nfunction edit { value = null }\nif value != null { say value }\nexit\n',
  ],
  [
    "call-control",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nfunction observe { return 1 }\nif value != null { observe()\nsay value }\nexit\n',
  ],
  [
    "call-changing",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nfunction edit { value = null }\nif value != null { edit()\nsay value }\nexit\n',
  ],
  [
    "call-argument-control",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nfunction edit(x) { value = null }\nif value != null { edit(value) }\nexit\n',
  ],
  [
    "call-argument-changed",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nfunction edit { value = null\nreturn 1 }\nfunction observe(a,b) { return 1 }\nif value != null { observe(edit(), value) }\nexit\n',
  ],
  [
    "handler",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\ntimer(duration: 1 s, async: true) { value = null }\nif value != null { say value }\nexit\n',
  ],
  [
    "handler-unrelated",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nlet other = 1\ntimer(duration: 1 s, async: true) { other = null }\nif value != null { say value }\nexit\n',
  ],
  [
    "handler-inside",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value != null { timer(duration: 1 s, async: true) { say value } }\nexit\n',
  ],
  [
    "entered-label",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value == null { exit }\nlabel again\nsay value\nif gateA { goto again }\nexit\n',
  ],
  [
    "unentered-label",
    'let gateA = askBoolean "gateA"\nlet value = 6\nif gateA { value = null }\nif value == null { exit }\nlabel again\nsay value\nexit\n',
  ],
  [
    "path/box.n/control",
    "let box = { n: null, other: 2 }\nif box.n != null { \nsay box.n }\nexit\n",
  ],
  [
    "path/box.n/changed",
    "let box = { n: null, other: 2 }\nif box.n != null { box.n = 3\nsay box.n }\nexit\n",
  ],
  [
    "path/box.n/sibling",
    "let box = { n: null, other: 2 }\nif box.n != null { box.other = 3\nsay box.n }\nexit\n",
  ],
  ["path/xs[1]/control", "let xs = [null, 3]\nif xs[1] != null { \nsay xs[1] }\nexit\n"],
  ["path/xs[1]/changed", "let xs = [null, 3]\nif xs[1] != null { xs[0] = 5\nsay xs[1] }\nexit\n"],
  [
    "path/xs[index]/control",
    "let xs = [null, 3]\nlet index = 1\nif xs[index] != null { \nsay xs[index] }\nexit\n",
  ],
  [
    "path/xs[index]/changed",
    "let xs = [null, 3]\nlet index = 1\nif xs[index] != null { index = 0\nsay xs[index] }\nexit\n",
  ],
  [
    "path/xs[index].n/control",
    "let xs = [{ n: null }, { n: 3 }]\nlet index = 1\nif xs[index].n != null { \nsay xs[index].n }\nexit\n",
  ],
  [
    "path/xs[index].n/changed",
    "let xs = [{ n: null }, { n: 3 }]\nlet index = 1\nif xs[index].n != null { index = 0\nsay xs[index].n }\nexit\n",
  ],
  [
    "path/xs[index + 0]/control",
    "let xs = [null, 3]\nlet index = 1\nif xs[index + 0] != null { \nsay xs[index + 0] }\nexit\n",
  ],
  [
    "path/xs.random/control",
    "let xs = [null, 3]\nif xs.random != null { \nsay xs.random }\nexit\n",
  ],
  ["mutator/add(4)", "let xs = [null, 3]\nif xs[1] != null { xs.add(4)\nsay xs[1] }\nexit\n"],
  ["mutator/clear()", "let xs = [null, 3]\nif xs[1] != null { xs.clear()\nsay xs[1] }\nexit\n"],
  ["mutator/reverse()", "let xs = [null, 3]\nif xs[1] != null { xs.reverse()\nsay xs[1] }\nexit\n"],
  ["mutator/sort()", "let xs = [null, 3]\nif xs[1] != null { xs.sort()\nsay xs[1] }\nexit\n"],
  ["mutator/shuffle()", "let xs = [null, 3]\nif xs[1] != null { xs.shuffle()\nsay xs[1] }\nexit\n"],
  [
    "mutator/removeAt(0)",
    "let xs = [null, 3]\nif xs[1] != null { xs.removeAt(0)\nsay xs[1] }\nexit\n",
  ],
  [
    "mutator/addAll([4])",
    "let xs = [null, 3]\nif xs[1] != null { xs.addAll([4])\nsay xs[1] }\nexit\n",
  ],
  ["collection", "let xs = [null, 2]\nif xs is integer[] { say xs[0] }\nexit\n"],
  ["collection-negative", "let xs = [null, 2]\nif xs is not integer[] { say xs[0] }\nexit\n"],
  ["nested", "let xs = [[null, 1], [null, 2]]\nif xs[0] is integer[] { say xs[0][0] }\nexit\n"],
  [
    "nested-sibling",
    "let xs = [[null, 1], [null, 2]]\nif xs[0] is integer[] { say xs[1][0] }\nexit\n",
  ],
  ["collection-union", "let xs = [null, 2]\nif xs is integer[] | string[] { say xs[0] }\nexit\n"],
  ["case/null", "let value = hostValue\nswitch value { case null { say value } }\nexit\n"],
  ["case/2", "let value = hostValue\nswitch value { case 2 { say value } }\nexit\n"],
  ["case/2.0", "let value = hostValue\nswitch value { case 2.0 { say value } }\nexit\n"],
  ["case/2.5", "let value = hostValue\nswitch value { case 2.5 { say value } }\nexit\n"],
  ['case/"fine"', 'let value = hostValue\nswitch value { case "fine" { say value } }\nexit\n'],
  ["case/true", "let value = hostValue\nswitch value { case true { say value } }\nexit\n"],
  ["case/false", "let value = hostValue\nswitch value { case false { say value } }\nexit\n"],
  ["case-type", "let value = hostValue\nswitch value { case is integer { say value } }\nexit\n"],
  ["case-list", "let value = hostValue\nswitch value { case null, 2 { say value } }\nexit\n"],
  [
    "case-default",
    "let value = hostValue\nswitch value { case null { say 1 }\ndefault { say value } }\nexit\n",
  ],
  [
    "route/seed",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nif gateA { value = null }\nsay value\nexit\n',
  ],
  [
    "route/kill",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nif gateA { value = null\nvalue = 8 }\nsay value\nexit\n',
  ],
  [
    "route/writer-leaves",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nif gateA { value = null\nexit }\nsay value\nexit\n',
  ],
  [
    "route/middle-open",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nif gateA { value = null }\nif gateB { value = 8 }\nsay value\nexit\n',
  ],
  [
    "route/middle-closed",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nif gateA { value = null }\nif gateB { value = 8 } else { value = 9 }\nsay value\nexit\n',
  ],
  [
    "route/test-open",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nif gateA { value = null }\nif value != null { say "ready" }\nsay value\nexit\n',
  ],
  [
    "route/test-closed",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nif gateA { value = null }\nif value == null { exit }\nsay value\nexit\n',
  ],
  [
    "route/consumer-kill",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nif gateA { value = null }\nif gateB { value = 7\nsay value }\nexit\n',
  ],
  [
    "route/consumer-call",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nfunction restore { value = 9\nreturn true }\nif gateA { value = null }\nif restore() { say value }\nexit\n',
  ],
  [
    "route/consumer-noncall",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nfunction restore { value = 9\nreturn true }\nif gateA { value = null }\nif gateB { say value }\nrestore()\nexit\n',
  ],
  [
    "route/mixed-call-leave",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nfunction restore { value = 9 }\nif gateA { value = null }\nif gateB { restore() } else { exit }\nsay value\nexit\n',
  ],
  [
    "route/mixed-call-kill",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nfunction restore { value = 9 }\nif gateA { value = null }\nif gateB { restore() } else { value = 8 }\nsay value\nexit\n',
  ],
  [
    "route/call-conditional",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nfunction restore { value = 9 }\nif gateA { value = null }\nif gateB { restore() }\nsay value\nexit\n',
  ],
  [
    "route/loop-header-exit",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nif gateA { repeat 2 { value = null } }\nsay value\nexit\n',
  ],
  [
    "route/loop-only-break",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nif gateA { while true { value = null\nbreak } }\nsay value\nexit\n',
  ],
  [
    "route/handler-flat",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\ntimer(duration: 1 s, async: true) { value = 9 }\nif gateA { value = null }\nsay value\nexit\n',
  ],
  [
    "route/handler-other",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nlet other = 4\ntimer(duration: 1 s, async: true) { other = 9 }\nif gateA { value = null }\nsay value\nexit\n',
  ],
  [
    "route/scalar-copy",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nif gateA { value = null }\nlet saved = value\nsay saved\nexit\n',
  ],
  [
    "route/scalar-killed-copy",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nif gateA { value = null\nvalue = 9 }\nlet saved = value\nsay saved\nexit\n',
  ],
  [
    "route/sibling-consumer",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nif gateA { value = null } else { say value }\nexit\n',
  ],
  [
    "route/predecessor-read",
    'let gateA = askBoolean "gateA"\nlet gateB = askBoolean "gateB"\nlet value = 4\nsay value\nif gateA { value = null }\nexit\n',
  ],
  ["route/producer-load", 'let value = load("rev", default: null)\nsay value\nexit\n'],
  ["route/producer-parse", 'let value = fromJson("4", default: null)\nsay value\nexit\n'],
  ["route/producer-fallback-live", "let value = null otherwise null\nsay value\nexit\n"],
  ["route/producer-fallback-dead", "let value = 4 otherwise null\nsay value\nexit\n"],
  ["route/default-omitted", "function read(value = null) { say value }\nread()\nexit\n"],
  ["route/default-supplied", "function read(value = null) { say value }\nread(4)\nexit\n"],
  [
    "route/prefix-store",
    'let gateA = askBoolean "gateA"\nlet box = { n: 2, other: 4 }\nif gateA { box = { n: null, other: 4 } }\nsay box.n\nexit\n',
  ],
  [
    "route/prefix-then-leaf",
    'let gateA = askBoolean "gateA"\nlet box = { n: 2, other: 4 }\nif gateA { box = { n: null, other: 4 }\nbox.n = 9 }\nsay box.n\nexit\n',
  ],
  [
    "route/leaf-then-prefix",
    'let gateA = askBoolean "gateA"\nlet box = { n: 2, other: 4 }\nif gateA { box.n = null\nbox = { n: 9, other: 4 } }\nsay box.n\nexit\n',
  ],
  [
    "call-before-body",
    "let value = 7\nfunction clearValue { value = null\nreturn true }\nif value != null and clearValue() { say value }\nexit\n",
  ],
  [
    "call-before-else",
    "let value = 7\nfunction clearValue { value = null\nreturn true }\nif value == null or not clearValue() { exit } else { say value }\nexit\n",
  ],
  [
    "call-before-leave",
    "let value = 7\nfunction clearValue { value = null\nreturn true }\nif value == null or not clearValue() { exit }\nsay value\nexit\n",
  ],
  [
    "call-before-while",
    "let value = 7\nfunction clearValue { value = null\nreturn true }\nwhile value != null and clearValue() { say value\nbreak }\nexit\n",
  ],
  [
    "call-before-test-control",
    "let value = 7\nfunction clearValue { value = null\nreturn true }\nif clearValue() and value != null { say value }\nexit\n",
  ],
  [
    "mutator-before-body",
    "let xs = [2, null]\nif xs[0] != null and xs.reverse().length > 0 { say xs[0] }\nexit\n",
  ],
  [
    "condition-call",
    "let value = 7\nfunction clearValue { value = null\nreturn true }\nif value != null and clearValue() { repeat value {} }\nexit\n",
  ],
  [
    "body-call-control",
    "let value = 7\nfunction clearValue { value = null\nreturn true }\nif value != null { clearValue()\nrepeat value {} }\nexit\n",
  ],
  [
    "operand-call-control",
    "let value = 7\nfunction clearValue { value = null\nreturn true }\nif value != null and clearValue() and value > 1 { exit }\nexit\n",
  ],
  [
    "condition-or",
    "let value = 7\nfunction clearValue { value = null\nreturn true }\nif value == null or not clearValue() { exit } else { repeat value {} }\nexit\n",
  ],
  [
    "condition-continuation",
    "let value = 7\nfunction clearValue { value = null\nreturn true }\nif value == null or not clearValue() { exit }\nrepeat value {}\nexit\n",
  ],
  [
    "condition-while",
    "let value = 7\nfunction clearValue { value = null\nreturn true }\nwhile value != null and clearValue() { repeat value {}\nbreak }\nexit\n",
  ],
  [
    "condition-clean-control",
    "let value = 7\nfunction observe { return true }\nif value != null and observe() { repeat value {} }\nexit\n",
  ],
  [
    "condition-fraction-after",
    "let value: number = 7\nfunction fraction { value = 1.5\nreturn true }\nif value is integer and fraction() { repeat value {} }\nexit\n",
  ],
  [
    "condition-fraction-before",
    "let value: number = 7\nfunction fraction { value = 1.5\nreturn true }\nif fraction() and value is integer { repeat value {} }\nexit\n",
  ],
  [
    "dict-fixed-control",
    'let d = dict { "x": 2, "y": null }\nlet key = "x"\nif d["x"] != null { \nrepeat d["x"] {} }\nexit\n',
  ],
  [
    "dict-fixed-edited",
    'let d = dict { "x": 2, "y": null }\nlet key = "x"\nif d["x"] != null { d["y"] = 8\nrepeat d["x"] {} }\nexit\n',
  ],
  [
    "dict-key-control",
    'let d = dict { "x": 2, "y": null }\nlet key = "x"\nif d[key] != null { \nrepeat d[key] {} }\nexit\n',
  ],
  [
    "dict-key-edited",
    'let d = dict { "x": 2, "y": null }\nlet key = "x"\nif d[key] != null { key = "y"\nrepeat d[key] {} }\nexit\n',
  ],
  [
    "saved-independent",
    "let xs = [2, null]\nlet offset = 0\nlet value = xs[offset+0]\nif value != null { xs.clear()\noffset = 1\nrepeat value {} }\nexit\n",
  ],
  [
    "reference",
    "speaker person { rounds: 2 }\nlet alias = person\nif alias.rounds is integer { person.rounds = null\nrepeat alias.rounds {} }\nexit\n",
  ],
  [
    "collection-union-positive",
    'let xs = [null, 2, "s"]\nif xs is integer[] | string[] { say xs[0] }\nexit\n',
  ],
  [
    "boolean-literal",
    'let value: boolean | null = load("rev", default: null)\nswitch value { case true { if value { say "ok" } } }\nexit\n',
  ],
  ["time-literal", "let value = hostValue\nswitch value { case 2 s { say value } }\nexit\n"],
  [
    "fallback-literal",
    'let flagA = askBoolean "gate"\nlet value = 5\nif flagA { value = null otherwise null }\nrepeat value {}\nexit\n',
  ],
  [
    "leave-break-control",
    'let gateA = askBoolean "gate"\nlet value = 3\nif gateA { value = null }\nrepeat 2 { if value == null { break }\nrepeat value {} }\nexit\n',
  ],
  [
    "leave-break-changed",
    'let gateA = askBoolean "gate"\nlet value = 3\nif gateA { value = null }\nrepeat 2 { if value == null { break }\nvalue = null\nrepeat value {} }\nexit\n',
  ],
  [
    "leave-continue-control",
    'let gateA = askBoolean "gate"\nlet value = 3\nif gateA { value = null }\nrepeat 2 { if value == null { continue }\nrepeat value {} }\nexit\n',
  ],
  [
    "leave-continue-changed",
    'let gateA = askBoolean "gate"\nlet value = 3\nif gateA { value = null }\nrepeat 2 { if value == null { continue }\nvalue = null\nrepeat value {} }\nexit\n',
  ],
  [
    "leave-return-control",
    "function use(value: integer?) { if value == null { return }\nrepeat value {} }\nuse(3)\nexit\n",
  ],
  [
    "leave-goto-control",
    "let value = hostValue\nif value is not integer { goto done }\nrepeat value {}\nlabel done\nexit\nexit\n",
  ],
  [
    "leave-end-control",
    "function use(value: integer?) { if value == null { end }\nrepeat value {} }\nuse(3)\nexit\n",
  ],
  [
    "leave-return-changed",
    "function use(value: integer?) { if value == null { return }\nvalue = null\nrepeat value {} }\nuse(3)\nexit\n",
  ],
  [
    "leave-goto-changed",
    "let value = hostValue\nif value is not integer { goto done }\nvalue = null\nrepeat value {}\nlabel done\nexit\nexit\n",
  ],
  [
    "leave-end-changed",
    "function use(value: integer?) { if value == null { end }\nvalue = null\nrepeat value {} }\nuse(3)\nexit\n",
  ],
  [
    "callee-no-inheritance",
    "let value = hostValue\nfunction use { repeat value {} }\nif value is integer { use() }\nexit\n",
  ],
  [
    "written-union-null",
    'let gateA = askBoolean "gate"\nlet value: integer | string | null = 3\nif gateA { value = null }\nrepeat value {}\nexit\n',
  ],
  [
    "written-union-text",
    'let gateA = askBoolean "gate"\nlet value: integer | string | null = 3\nif gateA { value = "missing" }\nrepeat value {}\nexit\n',
  ],
  [
    "and-nested-changes",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif ((value != null) and (quietCall() and resetValue())) { say value }\nexit\n',
  ],
  [
    "and-nested-quiet",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif ((value != null) and (quietCall() and quietCall())) { say value }\nexit\n',
  ],
  [
    "and-right-tree-changes",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif quietCall() and ((value != null) and resetValue()) { say value }\nexit\n',
  ],
  [
    "and-right-tree-quiet",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif quietCall() and ((value != null) and quietCall()) { say value }\nexit\n',
  ],
  [
    "and-mixed-tail-changes",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif value != null and (guardFlag or resetValue()) { say value }\nexit\n',
  ],
  [
    "and-mixed-tail-quiet",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif value != null and (guardFlag or quietCall()) { say value }\nexit\n',
  ],
  [
    "or-nested-changes",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif (value == null) or (quietCall() or resetValue()) {} else { say value }\nexit\n',
  ],
  [
    "or-nested-quiet",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif (value == null) or (quietCall() or quietCall()) {} else { say value }\nexit\n',
  ],
  [
    "or-right-tree-changes",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif guardFlag or ((value == null) or resetValue()) {} else { say value }\nexit\n',
  ],
  [
    "or-right-tree-quiet",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif guardFlag or ((value == null) or quietCall()) {} else { say value }\nexit\n',
  ],
  [
    "leave-or-changes",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif value == null or (guardFlag or resetValue()) { exit }\nsay value\nexit\n',
  ],
  [
    "leave-or-quiet",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif value == null or (guardFlag or quietCall()) { exit }\nsay value\nexit\n',
  ],
  [
    "leave-and-changes",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif value != null and (quietCall() and resetValue()) {} else { exit }\nsay value\nexit\n',
  ],
  [
    "leave-and-quiet",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif value != null and (quietCall() and quietCall()) {} else { exit }\nsay value\nexit\n',
  ],
  [
    "while-nested-changes",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nwhile quietCall() and ((value != null) and resetValue()) { say value\nbreak }\nexit\n',
  ],
  [
    "while-nested-quiet",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nwhile quietCall() and ((value != null) and quietCall()) { say value\nbreak }\nexit\n',
  ],
  [
    "not-null-nested-changes",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif not ((value == null)) and (resetValue() and guardFlag) { say value }\nexit\n',
  ],
  [
    "not-null-nested-quiet",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif not ((value == null)) and (quietCall() and guardFlag) { say value }\nexit\n',
  ],
  [
    "is-type-nested-changes",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif (value is integer) and (resetValue() and quietCall()) { say value }\nexit\n',
  ],
  [
    "is-type-nested-quiet",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif (value is integer) and (quietCall() and quietCall()) { say value }\nexit\n',
  ],
  [
    "not-is-type-else-changes",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif (value is not integer) or (guardFlag or resetValue()) {} else { say value }\nexit\n',
  ],
  [
    "not-is-type-else-quiet",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif (value is not integer) or (guardFlag or quietCall()) {} else { say value }\nexit\n',
  ],
  [
    "call-before-fresh-test",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif resetValue() and (value != null) { say value }\nexit\n',
  ],
  [
    "nested-call-tail",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nfunction echoValue(a) { return a }\nif value != null and echoValue(resetValue()) { say value }\nexit\n',
  ],
  [
    "earlier-argument-read",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nfunction inspectArgs(a,b) { return true }\nif value != null and inspectArgs(value, resetValue()) { say 1 }\nexit\n',
  ],
  [
    "later-argument-read",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nfunction inspectArgs(a,b) { return true }\nif value != null and inspectArgs(resetValue(), value) { say 1 }\nexit\n',
  ],
  [
    "if-mutator-add(12)",
    "let basket = [4, null]\nif basket[0] != null and (basket.add(12) == null) { say basket[0]\n }\nexit\n",
  ],
  [
    "while-mutator-add(12)",
    "let basket = [4, null]\nwhile basket[0] != null and (basket.add(12) == null) { say basket[0]\nbreak }\nexit\n",
  ],
  [
    "if-mutator-removeAt(0)",
    "let basket = [4, null]\nif basket[0] != null and (basket.removeAt(0) == null) { say basket[0]\n }\nexit\n",
  ],
  [
    "while-mutator-removeAt(0)",
    "let basket = [4, null]\nwhile basket[0] != null and (basket.removeAt(0) == null) { say basket[0]\nbreak }\nexit\n",
  ],
  [
    "if-mutator-reverse()",
    "let basket = [4, null]\nif basket[0] != null and (basket.reverse() == null) { say basket[0]\n }\nexit\n",
  ],
  [
    "while-mutator-reverse()",
    "let basket = [4, null]\nwhile basket[0] != null and (basket.reverse() == null) { say basket[0]\nbreak }\nexit\n",
  ],
  [
    "if-mutator-clear()",
    "let basket = [4, null]\nif basket[0] != null and (basket.clear() == null) { say basket[0]\n }\nexit\n",
  ],
  [
    "while-mutator-clear()",
    "let basket = [4, null]\nwhile basket[0] != null and (basket.clear() == null) { say basket[0]\nbreak }\nexit\n",
  ],
  [
    "mutator-before-test",
    "let basket = [4,null]\nif basket.reverse() == null and basket[0] != null { say basket[0] }\nexit\n",
  ],
  [
    "path-call-slot = 1",
    "let slot = 0\nlet racks = [{n:7},{n:null}]\nfunction shiftPath { slot = 1\nreturn true }\nif racks[slot].n != null and (true and shiftPath()) { say racks[slot].n }\nexit\n",
  ],
  [
    "path-fresh-slot = 1",
    "let slot = 0\nlet racks = [{n:7},{n:null}]\nfunction shiftPath { slot = 1\nreturn true }\nif shiftPath() and racks[slot].n != null { say racks[slot].n }\nexit\n",
  ],
  [
    "path-call-racks[0].n = null",
    "let slot = 0\nlet racks = [{n:7},{n:null}]\nfunction shiftPath { racks[0].n = null\nreturn true }\nif racks[slot].n != null and (true and shiftPath()) { say racks[slot].n }\nexit\n",
  ],
  [
    "path-fresh-racks[0].n = null",
    "let slot = 0\nlet racks = [{n:7},{n:null}]\nfunction shiftPath { racks[0].n = null\nreturn true }\nif shiftPath() and racks[slot].n != null { say racks[slot].n }\nexit\n",
  ],
  [
    "path-call-racks = [{n:null}]",
    "let slot = 0\nlet racks = [{n:7},{n:null}]\nfunction shiftPath { racks = [{n:null}]\nreturn true }\nif racks[slot].n != null and (true and shiftPath()) { say racks[slot].n }\nexit\n",
  ],
  [
    "path-fresh-racks = [{n:null}]",
    "let slot = 0\nlet racks = [{n:7},{n:null}]\nfunction shiftPath { racks = [{n:null}]\nreturn true }\nif shiftPath() and racks[slot].n != null { say racks[slot].n }\nexit\n",
  ],
  [
    "handler-handler",
    'let value = 3\ntimer(duration: 1 s, async: true) { value = null }\nif value != null and askBoolean "continue" { say value }\nexit\n',
  ],
  [
    "handler-control",
    'let value = 3\ntimer(duration: 1 s, async: true) { say "tick" }\nif value != null and askBoolean "continue" { say value }\nexit\n',
  ],
  [
    "handler-mutation-handler",
    'let basket = [4,null]\ntimer(duration: 1 s, async: true) { basket.reverse() }\nwhile basket[0] != null and askBoolean "continue" { say basket[0]\nbreak }\nexit\n',
  ],
  [
    "handler-mutation-None",
    'let basket = [4,null]\ntimer(duration: 1 s, async: true) { say "tick" }\nwhile basket[0] != null and askBoolean "continue" { say basket[0]\nbreak }\nexit\n',
  ],
  [
    "nested-shadow-test",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif value != null and resetValue() { if value != null { say value } }\nexit\n',
  ],
  [
    "register-after-value = null",
    "let value = 6\nfunction beginTimer { timer(duration: 1 s, async: true) { value = null }\nreturn true }\nif value != null and beginTimer() { say value }\nexit\n",
  ],
  [
    "register-before-value = null",
    "let value = 6\nfunction beginTimer { timer(duration: 1 s, async: true) { value = null }\nreturn true }\nif beginTimer() and value != null { say value }\nexit\n",
  ],
  [
    'register-after-say "tick"',
    'let value = 6\nfunction beginTimer { timer(duration: 1 s, async: true) { say "tick" }\nreturn true }\nif value != null and beginTimer() { say value }\nexit\n',
  ],
  [
    'register-before-say "tick"',
    'let value = 6\nfunction beginTimer { timer(duration: 1 s, async: true) { say "tick" }\nreturn true }\nif beginTimer() and value != null { say value }\nexit\n',
  ],
  [
    "examine(true)",
    "function examine(flagArg, n = null) { if flagArg { n = 3 }\nrepeat n {}\n}\nexamine(true)\nexit\n",
  ],
  [
    "examine(true, 4)",
    "function examine(flagArg, n = null) { if flagArg { n = 3 }\nrepeat n {}\n}\nexamine(true, 4)\nexit\n",
  ],
  [
    "examine(flagArg: true)",
    "function examine(flagArg, n = null) { if flagArg { n = 3 }\nrepeat n {}\n}\nexamine(flagArg: true)\nexit\n",
  ],
  [
    "examine(n: 4, flagArg: true)",
    "function examine(flagArg, n = null) { if flagArg { n = 3 }\nrepeat n {}\n}\nexamine(n: 4, flagArg: true)\nexit\n",
  ],
  [
    "and-nested-changes",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif ((value != null) and (quietCall() and resetValue())) { repeat value {} }\nexit\n',
  ],
  [
    "call-before-fresh-test",
    'let value = 9\nlet guardFlag = askBoolean "gate"\nfunction resetValue { value = null\nreturn true }\nfunction quietCall { return true }\nif resetValue() and (value != null) { repeat value {} }\nexit\n',
  ],
  [
    "register-after-value = null",
    "let value = 6\nfunction beginTimer { timer(duration: 1 s, async: true) { value = null }\nreturn true }\nif value != null and beginTimer() { repeat value {} }\nexit\n",
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node probe.mjs head <cases.json> (its six case lists)",
      "R/astra-m4-s10-part1-review-r2.md:66, :19, :21",
    ],
  ],
  sources: 198,
  sha256: "16da02296aaf7a316d08f3787a39c42460218f8bab1af6b3ae971f45a27130b1",
  dropped: [
    [
      "66405dbb3af2d849163946ac799643e1ef32554fe3ce3ac4d2ba74a62c14f7c7",
      "a `const` declaration, which no tree parses: an attempt the review itself counted out",
    ],
    [
      "7599d7b29913bb693433dfbfcc2d5afe92f7e259e20e998cc5440d95c4fc1ea2",
      "a `const` declaration, which no tree parses: an attempt the review itself counted out",
    ],
  ],
};
