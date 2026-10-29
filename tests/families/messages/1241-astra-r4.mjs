// Fixed compiler inputs from astra-m4-i1241-review-r4/review.mjs.
const fixedCases = [
  ["inline-1", 'let xs: integer set = set["wrong"]\nexit\n'],
  ["inline-2", 'let v = dict{a: 1}.get(hostOther, default: "wrong")\nsay v\nexit\n'],
  ["inline-3", 'let rows: integer[] = ["one", "two"]\nexit\n'],
  ["inline-4", 'let entries: integer[] dict = dict{a: [hostValue, "wrong"]}\nsay entries\nexit\n'],
  [
    "inline-5",
    'let input = {n: 4, words: "ok"}\nlet copy = input\ncopy = hostValue\nrepeat copy.n {}\nsay copy.words\nexit\n',
  ],
  [
    "inline-6",
    "let box = {inner: {n: 3}}\nbox = hostValue\nsay box.inner.n\nrepeat box.inner.n {}\nexit\n",
  ],
  ["inline-7", "let n = [2, null].random\nlet d: duration = 2 * (3 + (n * 4))\nsay d\nexit"],
  ["inline-8", 'let x = "hi"\nsay x.size\nlet d: duration = 3\nsay [1].join\nexit'],
  ["inline-9", 'let xs = [1]\nsay xs + "x"\nexit'],
  [
    "inline-10",
    'let n = [2, null].random\nlet d: duration = dict{["${n + 1}"]: 3}.keys.length\nsay d\nexit',
  ],
];
export const cases = fixedCases;
export const checks = ["publication"];
