// #1188's design review (Astra): the three premise cases of `probe/premise-cases.json`, compared by
// `probe/differential.mjs` (R/astra-m4-i1188-design-review-evidence/).
export const cases = [
  [
    "small::premise-cases::rejected-child-through-copy",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet copy=rejected\nlet clean={f:"y"}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::premise-cases::rejected-child-direct",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet clean={f:"y"}\nlet outer=[rejected.first,clean]\nexit\n',
  ],
  [
    "small::premise-cases::rejected-store-through-copy",
    'let t:integer=1\nlet a={f:t}\nlet copy=a\ncopy.f="bad"\nlet box={inner:copy}\nlet again=box.inner\nlet other={f:2}\nlet outer=[again,other]\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node probe/differential.mjs base prototype probe/premise-cases.json out/mini-diff.json",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:32",
    ],
  ],
  sources: 3,
  sha256: "0ca2d97e9e2c8b74b17d8bfeec4390e421c9b82a38c2a931b70e9926f1381670",
};
