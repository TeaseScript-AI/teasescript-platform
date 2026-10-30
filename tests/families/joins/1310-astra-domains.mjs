// captured astra domains input; #1310, 1310, review/builder evidence
// (desktop:~/work/evidence/1310/2eba4965c443bbf3a4b945560fd315d7cf736ae4/astra/domains.mjs).
export const cases = [
  ["original-1", "let nils: null[] = [null]\nlet result = nils + [1]\nexit\n"],
  ["original-2", "let nils: null[] = [null]\nlet result = [1] + nils\nexit\n"],
  ["original-3", "let nils: null[] = [null]\nlet copy = nils\nlet result = copy + [1]\nexit\n"],
  ["original-4", "let nils: null[] = [null]\nlet copy = nils\nlet result = [1] + copy\nexit\n"],
  [
    "original-5",
    "let nils: null[] = [null]\nfunction make: null[] { return nils }\nlet result = make() + [1]\nexit\n",
  ],
  [
    "original-6",
    "let nils: null[] = [null]\nfunction make: null[] { return nils }\nlet result = [1] + make()\nexit\n",
  ],
  [
    "original-7",
    "let nils: null[] = [null]\nfunction make { return nils }\nlet result = make() + [1]\nexit\n",
  ],
  [
    "original-8",
    "let nils: null[] = [null]\nfunction make { return nils }\nlet result = [1] + make()\nexit\n",
  ],
  ["original-9", "let nils: null[][] = [[null]]\nlet result = nils + [[1]]\nexit\n"],
  ["original-10", "let nils: null[][] = [[null]]\nlet result = [[1]] + nils\nexit\n"],
  [
    "original-11",
    "let nils: null[][] = [[null]]\nlet copy = nils\nlet result = copy + [[1]]\nexit\n",
  ],
  [
    "original-12",
    "let nils: null[][] = [[null]]\nlet copy = nils\nlet result = [[1]] + copy\nexit\n",
  ],
  [
    "original-13",
    "let nils: null[][] = [[null]]\nfunction make: null[][] { return nils }\nlet result = make() + [[1]]\nexit\n",
  ],
  [
    "original-14",
    "let nils: null[][] = [[null]]\nfunction make: null[][] { return nils }\nlet result = [[1]] + make()\nexit\n",
  ],
  [
    "original-15",
    "let nils: null[][] = [[null]]\nfunction make { return nils }\nlet result = make() + [[1]]\nexit\n",
  ],
  [
    "original-16",
    "let nils: null[][] = [[null]]\nfunction make { return nils }\nlet result = [[1]] + make()\nexit\n",
  ],
  [
    "original-17",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = (make() + [false]) + ["tail"]\nexit\n',
  ],
  [
    "original-18",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make() + [false]\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "original-19",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make()\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "original-20",
    'let u: (boolean | string)[] = [true]\nfunction make: (boolean | string)[] { return u }\nlet held = make() + [false]\nlet result = held + ["tail"]\nexit\n',
  ],
  ["original-21", 'let u: list = [1]\nlet result = ([2] + u) + ["tail"]\nexit\n'],
  ["original-22", 'let u: list = [1]\nlet held = [2] + u\nlet result = held + ["tail"]\nexit\n'],
  ["original-23", 'let u: list = [1]\nlet result = (u + [2]) + ["tail"]\nexit\n'],
  ["original-24", 'let u: list = [1]\nlet result = [2] + u\nresult += ["tail"]\nexit\n'],
  [
    "original-25",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make()\nheld.add("tail")\nexit\n',
  ],
];

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node domains.mjs desktop:~/work/evidence/1310/2eba4965c443bbf3a4b945560fd315d7cf736ae4/astra",
      "desktop:~/work/evidence/1310/2eba4965c443bbf3a4b945560fd315d7cf736ae4/README.md:6",
    ],
  ],
  sources: 25,
  sha256: "4bf967d7f4b574487cbbed61a9ff3c5074c0ceb6921cd1f6fd79482e815e1eaa",
};
