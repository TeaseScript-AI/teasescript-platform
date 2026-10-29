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
