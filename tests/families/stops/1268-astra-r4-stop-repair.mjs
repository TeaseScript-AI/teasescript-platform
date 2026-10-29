// #1268, Astra r4 (R/astra-m4-i1268-review-r4-evidence/stop-repair.mjs): the three cases its stop repair checked, and
// the fixed programs it compiled from their saved pastes.
const all = (() => {
  const cases = [
    [
      "set-hidden",
      'function identity(v) { return v }\nlet checked: integer = hostValue\nlet amount: integer? = identity(null)\nlet bag: integer set = set["x", amount * 3]\nexit\n',
    ],
    [
      "list-hidden",
      'function nothing { return null }\nlet checked: integer = hostValue\nlet bag: integer[] = ["x", nothing() * 3]\nexit\n',
    ],
    [
      "dict-hidden",
      'function identity(v) { return v }\nlet checked: integer = hostValue\nlet amount: integer? = identity(null)\nlet bag: integer dict = dict{a:"x", b:amount * 3}\nexit\n',
    ],
    [
      "function-region",
      'function show(v) {\n  let data: integer[] = ["x"]\n  say v + 2\n  return data\n}\nlet outsideData: integer[] = ["x"]\nsay show(hostValue)\nexit\n',
    ],
    [
      "function-check",
      "function show(v) {\n  let data = [5,null]\n  say data[1] * 2\n  say v + 2\n  return 3\n}\nlet outsideData = [5,null]\nsay outsideData[1] * 2\nsay show(hostValue)\nexit\n",
    ],
    [
      "nested-check",
      "function show(v) {\n if true {\n  let data = [5,null]\n  say data[1] * 2\n  say v + 2\n }\n return 3\n}\nsay show(hostValue)\nexit\n",
    ],
    [
      "member-warning",
      'let caption = " Ab "\nsay caption.toUpperCase()\nsay hostValue + 2\nexit\n',
    ],
    ["own-site", "let delayValue = 2 s\nsay 7 / delayValue.seconds\nsay hostValue + 2\nexit\n"],
  ];
  return cases.map(([name, source]) => [name, source]);
})();
// stop-repair.mjs:67
const generated = all.filter(([name]) =>
  ["function-region", "function-check", "own-site"].includes(name),
);
export const checks = ["publication", "stops"];

// The fixed programs of its saved pastes (R/astra-m4-i1268-review-r4-evidence/stop-repair-pastes.json).
const captured = [
  [
    "stop-repair-pastes.json/0/fixed",
    'function show(v) {\n  let data: (integer | string)[] = ["x"]\n  say v + 2\n  return data\n}\nlet outsideData: integer[] = ["x"]\nsay show(hostValue)\nexit\n',
  ],
  [
    "stop-repair-pastes.json/1/fixed",
    'function show(v) {\n  let data: integer[] = ["x"]\n  if v is number { say v + 2 }\n  return data\n}\nlet outsideData: integer[] = ["x"]\nsay show(hostValue)\nexit\n',
  ],
  [
    "stop-repair-pastes.json/2/fixed",
    'function show(v) {\n  let data: integer[] = ["x"]\n  say v + 2\n  return data\n}\nlet outsideData: (integer | string)[] = ["x"]\nsay show(hostValue)\nexit\n',
  ],
  [
    "stop-repair-pastes.json/3/fixed",
    "function show(v) {\n  let data = [5,null]\n  let value = data[1]\nif value != null { say value * 2 }\n  say v + 2\n  return 3\n}\nlet outsideData = [5,null]\nsay outsideData[1] * 2\nsay show(hostValue)\nexit\n",
  ],
  [
    "stop-repair-pastes.json/4/fixed",
    "function show(v) {\n  let data = [5,null]\n  say (data[1] otherwise 0) * 2\n  say v + 2\n  return 3\n}\nlet outsideData = [5,null]\nsay outsideData[1] * 2\nsay show(hostValue)\nexit\n",
  ],
  [
    "stop-repair-pastes.json/5/fixed",
    "function show(v) {\n  let data = [5,null]\n  say data[1] * 2\n  if v is number { say v + 2 }\n  return 3\n}\nlet outsideData = [5,null]\nsay outsideData[1] * 2\nsay show(hostValue)\nexit\n",
  ],
  [
    "stop-repair-pastes.json/6/fixed",
    "function show(v) {\n  let data = [5,null]\n  say data[1] * 2\n  say v + 2\n  return 3\n}\nlet outsideData = [5,null]\nlet value = outsideData[1]\nif value != null { say value * 2 }\nsay show(hostValue)\nexit\n",
  ],
  [
    "stop-repair-pastes.json/7/fixed",
    "function show(v) {\n  let data = [5,null]\n  say data[1] * 2\n  say v + 2\n  return 3\n}\nlet outsideData = [5,null]\nsay (outsideData[1] otherwise 0) * 2\nsay show(hostValue)\nexit\n",
  ],
  [
    "stop-repair-pastes.json/8/fixed",
    "let delayValue = 2 s\nsay 7 / (delayValue / 1 second)\nsay hostValue + 2\nexit\n",
  ],
  [
    "stop-repair-pastes.json/9/fixed",
    "let delayValue = 2 s\nsay 7 / delayValue.seconds\nif hostValue is number { say hostValue + 2 }\nexit\n",
  ],
];
export const cases = [...generated, ...captured];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "/home/peter/opt/node-24.18/bin/node stop-repair.mjs",
      "R/astra-m4-i1268-review-r4-evidence/COMMANDS.txt:32",
    ],
    ["python3 provenance.py", "R/astra-m4-i1268-review-r4.md:47"],
    ["python3 provenance-remote.py", "R/astra-m4-i1268-review-r4.md:47"],
    ["python3 summarize.py", "R/astra-m4-i1268-review-r4.md:47"],
  ],
  sources: 13,
  sha256: "dbb2ab367736af59b58050320e137072a27a337c200d44f6eac5be2ac0d6c290",
};
