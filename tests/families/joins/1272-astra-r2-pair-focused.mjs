// #1272's review r2 (Astra): the focused pairs its `focused.sh` ran through `pair.mjs`
// (R/astra-m4-i1272-review-r2/focused/*.tease). Its runs over its builder's probe files are in no archive (README).
export const cases = [
  [
    "inferred-call-left-fit-left-inline.tease",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = (make() + [false]) + ["tail"]\nexit\n',
  ],
  [
    "inferred-call-left-fit-left-kept.tease",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make() + [false]\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "inferred-direct.tease",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make()\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "inferred-nested-return.tease",
    'let u: (boolean | string)[] = [true]\nfunction make { return u + [false] }\nlet result = make() + ["tail"]\nexit\n',
  ],
  [
    "inferred-written-result.tease",
    'let u: (boolean | string)[] = [true]\nfunction make: (boolean | string)[] { return u }\nlet held = make() + [false]\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "null-only-kept.tease",
    'let u: null[] = [null]\nlet held = [1] + u\nlet result = held + ["tail"]\nexit\n',
  ],
  ["null-only.tease", 'let u: null[] = [null]\nlet result = ([1] + u) + ["tail"]\nexit\n'],
  ["open-compound.tease", 'let u: list = [1]\nlet result = [2] + u\nresult += ["tail"]\nexit\n'],
  ["open-control-left.tease", 'let u: list = [1]\nlet result = (u + [2]) + ["tail"]\nexit\n'],
  ["open-direct.tease", 'let u: list = [1]\nlet result = [2] + u\nresult[0] = "tail"\nexit\n'],
  [
    "open-right-bad-left-inline.tease",
    'let u: list = [1]\nlet result = ([2] + u) + ["tail"]\nexit\n',
  ],
  [
    "open-right-bad-left-kept.tease",
    'let u: list = [1]\nlet held = [2] + u\nlet result = held + ["tail"]\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'node pair.mjs "$tree" focused/*.tease > "focused-$tree.txt" || exit $?',
      "R/astra-m4-i1272-review-r2/focused.sh:4",
    ],
  ],
  sources: 12,
  sha256: "cd64850f2e0c316d658c47d0b0a5f7bf126135c1f27c8528061c4c4cd57b7ec3",
};
