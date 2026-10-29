export const cases = [
  [
    "original-1",
    "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = 2 * (3 + (n * 4))\nsay converted\nexit\n",
  ],
  [
    "original-2",
    "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = -(2 + -n)\nsay converted\nexit\n",
  ],
  [
    "original-3",
    "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = ({outer: {v: 2 * (n + 1)}}).outer.v\nsay converted\nexit\n",
  ],
  [
    "original-4",
    'let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = "${2 * (n + 1)}".length\nsay converted\nexit\n',
  ],
  [
    "original-5",
    "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = [1 .. (n + 1)].length\nsay converted\nexit\n",
  ],
  [
    "original-6",
    'let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = "${n is integer}".length\nsay converted\nexit\n',
  ],
  [
    "original-7",
    'let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = dict{["${n + 1}"]: 3}.keys.length\nsay converted\nexit\n',
  ],
  [
    "original-8",
    'let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = toInteger("${n + 1}", default: 1)\nsay converted\nexit\n',
  ],
  ["original-9", "let n = 2\nlet converted: duration = 2 * (3 + (n * 4))\nsay converted\nexit\n"],
  ["original-10", "let n = 2\nlet converted: duration = -(2 + -n)\nsay converted\nexit\n"],
  [
    "original-11",
    "let n = 2\nlet converted: duration = ({outer: {v: 2 * (n + 1)}}).outer.v\nsay converted\nexit\n",
  ],
  [
    "original-12",
    'let n = 2\nlet converted: duration = "${2 * (n + 1)}".length\nsay converted\nexit\n',
  ],
  [
    "original-13",
    "let n = 2\nlet converted: duration = [1 .. (n + 1)].length\nsay converted\nexit\n",
  ],
  [
    "original-14",
    'let n = 2\nlet converted: duration = "${n is integer}".length\nsay converted\nexit\n',
  ],
  [
    "original-15",
    'let n = 2\nlet converted: duration = dict{["${n + 1}"]: 3}.keys.length\nsay converted\nexit\n',
  ],
  [
    "original-16",
    'let n = 2\nlet converted: duration = toInteger("${n + 1}", default: 1)\nsay converted\nexit\n',
  ],
  ["original-17", "let ns = [2, null]\nlet n = ns[1]\nsay 2 * (3 + (n * 4))\nexit\n"],
  ["original-18", "let ns = [2, null]\nlet n = ns[1]\nsay -(2 + -n)\nexit\n"],
  [
    "original-19",
    "let ns = [2, null]\nlet n = ns[1]\nsay ({outer: {v: 2 * (n + 1)}}).outer.v\nexit\n",
  ],
  ["original-20", 'let ns = [2, null]\nlet n = ns[1]\nsay "${2 * (n + 1)}"\nexit\n'],
  ["original-21", "let ns = [2, null]\nlet n = ns[1]\nfor i in 1 .. (n + 1) { say i }\nexit\n"],
  ["original-22", "let ns = [2, null]\nlet n = ns[1]\nsay (n + 1) is integer\nexit\n"],
  [
    "original-23",
    'let ns = [2, null]\nlet n = ns[1]\nlet d = dict{["${n + 1}"]: 3}\nsay d.keys\nexit\n',
  ],
  [
    "original-24",
    "let ns = [2, null]\nlet n = ns[1]\nfunction f(x: integer) { say x }\nf(2 * (n + 1))\nexit\n",
  ],
  [
    "original-25",
    'let ns = [2, null]\nlet n = ns[1]\nsay toInteger("${n + 1}", default: 1)\nexit\n',
  ],
  [
    "original-26",
    "function f: duration { return 2 * (3 + ([2, null].random * 4)) }\nsay f()\nexit\n",
  ],
  ["original-27", "let n = [2, null].random\nlet d = 1 s\nd = 2 * (n + 1)\nsay d\nexit\n"],
  ["original-28", "let x: integer | number = 3\nsay x\nexit\n"],
  ["original-29", 'let xs = [1]\nsay xs + "x"\nexit\n'],
  ["original-30", 'let xs: integer set = set["wrong"]\nexit\n'],
  ["original-31", 'let v = dict{a: 1}.get(hostOther, default: "wrong")\nsay v\nexit\n'],
  ["original-32", 'let rows: integer[] = ["one", "two"]\nexit\n'],
  [
    "original-33",
    'let entries: integer[] dict = dict{a: [hostValue, "wrong"]}\nsay entries\nexit\n',
  ],
  [
    "original-34",
    'let input = {n: 4, words: "ok"}\nlet copy = input\ncopy = hostValue\nrepeat copy.n {}\nsay copy.words\nexit\n',
  ],
  [
    "original-35",
    "let box = {inner: {n: 3}}\nbox = hostValue\nsay box.inner.n\nrepeat box.inner.n {}\nexit\n",
  ],
  ["original-36", "let n = [2, null].random\nlet d: duration = 2 * (3 + (n * 4))\nsay d\nexit"],
  ["original-37", 'let x = "hi"\nsay x.size\nlet d: duration = 3\nsay [1].join\nexit'],
  ["original-38", 'let xs = [1]\nsay xs + "x"\nexit'],
  [
    "original-39",
    'let n = [2, null].random\nlet d: duration = dict{["${n + 1}"]: 3}.keys.length\nsay d\nexit',
  ],
  [
    "original-40",
    'let outer: duration = 2\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nlet inner: duration = 2\nsay "${hostValue}"\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\nexit',
  ],
  [
    "original-41",
    'let outer: duration = 2\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nif hostValue == 1 {\nlet inner: duration = 2\nsay "${hostValue}"\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\n}\nexit',
  ],
  [
    "original-42",
    "let v = hostValue\nsay v.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next\nexit",
  ],
  [
    "original-43",
    "let v = hostValue\nsay v.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next\nexit",
  ],
  [
    "original-44",
    "let n = [2, null].random\nlet d0: duration = 2 * (3 + (n * 4))\nsay d0\nlet d1: duration = 2 * (3 + (n * 4))\nsay d1\nlet d2: duration = 2 * (3 + (n * 4))\nsay d2\nlet d3: duration = 2 * (3 + (n * 4))\nsay d3\nlet d4: duration = 2 * (3 + (n * 4))\nsay d4\nlet d5: duration = 2 * (3 + (n * 4))\nsay d5\nlet d6: duration = 2 * (3 + (n * 4))\nsay d6\nlet d7: duration = 2 * (3 + (n * 4))\nsay d7\nlet d8: duration = 2 * (3 + (n * 4))\nsay d8\nlet d9: duration = 2 * (3 + (n * 4))\nsay d9\nlet d10: duration = 2 * (3 + (n * 4))\nsay d10\nlet d11: duration = 2 * (3 + (n * 4))\nsay d11\nlet d12: duration = 2 * (3 + (n * 4))\nsay d12\nlet d13: duration = 2 * (3 + (n * 4))\nsay d13\nlet d14: duration = 2 * (3 + (n * 4))\nsay d14\nlet d15: duration = 2 * (3 + (n * 4))\nsay d15\nlet d16: duration = 2 * (3 + (n * 4))\nsay d16\nlet d17: duration = 2 * (3 + (n * 4))\nsay d17\nlet d18: duration = 2 * (3 + (n * 4))\nsay d18\nlet d19: duration = 2 * (3 + (n * 4))\nsay d19\nlet d20: duration = 2 * (3 + (n * 4))\nsay d20\nlet d21: duration = 2 * (3 + (n * 4))\nsay d21\nlet d22: duration = 2 * (3 + (n * 4))\nsay d22\nlet d23: duration = 2 * (3 + (n * 4))\nsay d23\nlet d24: duration = 2 * (3 + (n * 4))\nsay d24\nlet d25: duration = 2 * (3 + (n * 4))\nsay d25\nlet d26: duration = 2 * (3 + (n * 4))\nsay d26\nlet d27: duration = 2 * (3 + (n * 4))\nsay d27\nlet d28: duration = 2 * (3 + (n * 4))\nsay d28\nlet d29: duration = 2 * (3 + (n * 4))\nsay d29\nlet d30: duration = 2 * (3 + (n * 4))\nsay d30\nlet d31: duration = 2 * (3 + (n * 4))\nsay d31\nlet d32: duration = 2 * (3 + (n * 4))\nsay d32\nlet d33: duration = 2 * (3 + (n * 4))\nsay d33\nlet d34: duration = 2 * (3 + (n * 4))\nsay d34\nlet d35: duration = 2 * (3 + (n * 4))\nsay d35\nlet d36: duration = 2 * (3 + (n * 4))\nsay d36\nlet d37: duration = 2 * (3 + (n * 4))\nsay d37\nlet d38: duration = 2 * (3 + (n * 4))\nsay d38\nlet d39: duration = 2 * (3 + (n * 4))\nsay d39\nlet d40: duration = 2 * (3 + (n * 4))\nsay d40\nlet d41: duration = 2 * (3 + (n * 4))\nsay d41\nlet d42: duration = 2 * (3 + (n * 4))\nsay d42\nlet d43: duration = 2 * (3 + (n * 4))\nsay d43\nlet d44: duration = 2 * (3 + (n * 4))\nsay d44\nlet d45: duration = 2 * (3 + (n * 4))\nsay d45\nlet d46: duration = 2 * (3 + (n * 4))\nsay d46\nlet d47: duration = 2 * (3 + (n * 4))\nsay d47\nlet d48: duration = 2 * (3 + (n * 4))\nsay d48\nlet d49: duration = 2 * (3 + (n * 4))\nsay d49\nlet d50: duration = 2 * (3 + (n * 4))\nsay d50\nlet d51: duration = 2 * (3 + (n * 4))\nsay d51\nlet d52: duration = 2 * (3 + (n * 4))\nsay d52\nlet d53: duration = 2 * (3 + (n * 4))\nsay d53\nlet d54: duration = 2 * (3 + (n * 4))\nsay d54\nlet d55: duration = 2 * (3 + (n * 4))\nsay d55\nlet d56: duration = 2 * (3 + (n * 4))\nsay d56\nlet d57: duration = 2 * (3 + (n * 4))\nsay d57\nlet d58: duration = 2 * (3 + (n * 4))\nsay d58\nlet d59: duration = 2 * (3 + (n * 4))\nsay d59\nlet d60: duration = 2 * (3 + (n * 4))\nsay d60\nlet d61: duration = 2 * (3 + (n * 4))\nsay d61\nlet d62: duration = 2 * (3 + (n * 4))\nsay d62\nlet d63: duration = 2 * (3 + (n * 4))\nsay d63\nexit",
  ],
  [
    "original-45",
    "let n = [2, null].random\nlet d0: duration = 2 * (3 + (n * 4))\nsay d0\nlet d1: duration = 2 * (3 + (n * 4))\nsay d1\nlet d2: duration = 2 * (3 + (n * 4))\nsay d2\nlet d3: duration = 2 * (3 + (n * 4))\nsay d3\nlet d4: duration = 2 * (3 + (n * 4))\nsay d4\nlet d5: duration = 2 * (3 + (n * 4))\nsay d5\nlet d6: duration = 2 * (3 + (n * 4))\nsay d6\nlet d7: duration = 2 * (3 + (n * 4))\nsay d7\nlet d8: duration = 2 * (3 + (n * 4))\nsay d8\nlet d9: duration = 2 * (3 + (n * 4))\nsay d9\nlet d10: duration = 2 * (3 + (n * 4))\nsay d10\nlet d11: duration = 2 * (3 + (n * 4))\nsay d11\nlet d12: duration = 2 * (3 + (n * 4))\nsay d12\nlet d13: duration = 2 * (3 + (n * 4))\nsay d13\nlet d14: duration = 2 * (3 + (n * 4))\nsay d14\nlet d15: duration = 2 * (3 + (n * 4))\nsay d15\nlet d16: duration = 2 * (3 + (n * 4))\nsay d16\nlet d17: duration = 2 * (3 + (n * 4))\nsay d17\nlet d18: duration = 2 * (3 + (n * 4))\nsay d18\nlet d19: duration = 2 * (3 + (n * 4))\nsay d19\nlet d20: duration = 2 * (3 + (n * 4))\nsay d20\nlet d21: duration = 2 * (3 + (n * 4))\nsay d21\nlet d22: duration = 2 * (3 + (n * 4))\nsay d22\nlet d23: duration = 2 * (3 + (n * 4))\nsay d23\nlet d24: duration = 2 * (3 + (n * 4))\nsay d24\nlet d25: duration = 2 * (3 + (n * 4))\nsay d25\nlet d26: duration = 2 * (3 + (n * 4))\nsay d26\nlet d27: duration = 2 * (3 + (n * 4))\nsay d27\nlet d28: duration = 2 * (3 + (n * 4))\nsay d28\nlet d29: duration = 2 * (3 + (n * 4))\nsay d29\nlet d30: duration = 2 * (3 + (n * 4))\nsay d30\nlet d31: duration = 2 * (3 + (n * 4))\nsay d31\nlet d32: duration = 2 * (3 + (n * 4))\nsay d32\nlet d33: duration = 2 * (3 + (n * 4))\nsay d33\nlet d34: duration = 2 * (3 + (n * 4))\nsay d34\nlet d35: duration = 2 * (3 + (n * 4))\nsay d35\nlet d36: duration = 2 * (3 + (n * 4))\nsay d36\nlet d37: duration = 2 * (3 + (n * 4))\nsay d37\nlet d38: duration = 2 * (3 + (n * 4))\nsay d38\nlet d39: duration = 2 * (3 + (n * 4))\nsay d39\nlet d40: duration = 2 * (3 + (n * 4))\nsay d40\nlet d41: duration = 2 * (3 + (n * 4))\nsay d41\nlet d42: duration = 2 * (3 + (n * 4))\nsay d42\nlet d43: duration = 2 * (3 + (n * 4))\nsay d43\nlet d44: duration = 2 * (3 + (n * 4))\nsay d44\nlet d45: duration = 2 * (3 + (n * 4))\nsay d45\nlet d46: duration = 2 * (3 + (n * 4))\nsay d46\nlet d47: duration = 2 * (3 + (n * 4))\nsay d47\nlet d48: duration = 2 * (3 + (n * 4))\nsay d48\nlet d49: duration = 2 * (3 + (n * 4))\nsay d49\nlet d50: duration = 2 * (3 + (n * 4))\nsay d50\nlet d51: duration = 2 * (3 + (n * 4))\nsay d51\nlet d52: duration = 2 * (3 + (n * 4))\nsay d52\nlet d53: duration = 2 * (3 + (n * 4))\nsay d53\nlet d54: duration = 2 * (3 + (n * 4))\nsay d54\nlet d55: duration = 2 * (3 + (n * 4))\nsay d55\nlet d56: duration = 2 * (3 + (n * 4))\nsay d56\nlet d57: duration = 2 * (3 + (n * 4))\nsay d57\nlet d58: duration = 2 * (3 + (n * 4))\nsay d58\nlet d59: duration = 2 * (3 + (n * 4))\nsay d59\nlet d60: duration = 2 * (3 + (n * 4))\nsay d60\nlet d61: duration = 2 * (3 + (n * 4))\nsay d61\nlet d62: duration = 2 * (3 + (n * 4))\nsay d62\nlet d63: duration = 2 * (3 + (n * 4))\nsay d63\nlet d64: duration = 2 * (3 + (n * 4))\nsay d64\nlet d65: duration = 2 * (3 + (n * 4))\nsay d65\nlet d66: duration = 2 * (3 + (n * 4))\nsay d66\nlet d67: duration = 2 * (3 + (n * 4))\nsay d67\nlet d68: duration = 2 * (3 + (n * 4))\nsay d68\nlet d69: duration = 2 * (3 + (n * 4))\nsay d69\nlet d70: duration = 2 * (3 + (n * 4))\nsay d70\nlet d71: duration = 2 * (3 + (n * 4))\nsay d71\nlet d72: duration = 2 * (3 + (n * 4))\nsay d72\nlet d73: duration = 2 * (3 + (n * 4))\nsay d73\nlet d74: duration = 2 * (3 + (n * 4))\nsay d74\nlet d75: duration = 2 * (3 + (n * 4))\nsay d75\nlet d76: duration = 2 * (3 + (n * 4))\nsay d76\nlet d77: duration = 2 * (3 + (n * 4))\nsay d77\nlet d78: duration = 2 * (3 + (n * 4))\nsay d78\nlet d79: duration = 2 * (3 + (n * 4))\nsay d79\nlet d80: duration = 2 * (3 + (n * 4))\nsay d80\nlet d81: duration = 2 * (3 + (n * 4))\nsay d81\nlet d82: duration = 2 * (3 + (n * 4))\nsay d82\nlet d83: duration = 2 * (3 + (n * 4))\nsay d83\nlet d84: duration = 2 * (3 + (n * 4))\nsay d84\nlet d85: duration = 2 * (3 + (n * 4))\nsay d85\nlet d86: duration = 2 * (3 + (n * 4))\nsay d86\nlet d87: duration = 2 * (3 + (n * 4))\nsay d87\nlet d88: duration = 2 * (3 + (n * 4))\nsay d88\nlet d89: duration = 2 * (3 + (n * 4))\nsay d89\nlet d90: duration = 2 * (3 + (n * 4))\nsay d90\nlet d91: duration = 2 * (3 + (n * 4))\nsay d91\nlet d92: duration = 2 * (3 + (n * 4))\nsay d92\nlet d93: duration = 2 * (3 + (n * 4))\nsay d93\nlet d94: duration = 2 * (3 + (n * 4))\nsay d94\nlet d95: duration = 2 * (3 + (n * 4))\nsay d95\nlet d96: duration = 2 * (3 + (n * 4))\nsay d96\nlet d97: duration = 2 * (3 + (n * 4))\nsay d97\nlet d98: duration = 2 * (3 + (n * 4))\nsay d98\nlet d99: duration = 2 * (3 + (n * 4))\nsay d99\nlet d100: duration = 2 * (3 + (n * 4))\nsay d100\nlet d101: duration = 2 * (3 + (n * 4))\nsay d101\nlet d102: duration = 2 * (3 + (n * 4))\nsay d102\nlet d103: duration = 2 * (3 + (n * 4))\nsay d103\nlet d104: duration = 2 * (3 + (n * 4))\nsay d104\nlet d105: duration = 2 * (3 + (n * 4))\nsay d105\nlet d106: duration = 2 * (3 + (n * 4))\nsay d106\nlet d107: duration = 2 * (3 + (n * 4))\nsay d107\nlet d108: duration = 2 * (3 + (n * 4))\nsay d108\nlet d109: duration = 2 * (3 + (n * 4))\nsay d109\nlet d110: duration = 2 * (3 + (n * 4))\nsay d110\nlet d111: duration = 2 * (3 + (n * 4))\nsay d111\nlet d112: duration = 2 * (3 + (n * 4))\nsay d112\nlet d113: duration = 2 * (3 + (n * 4))\nsay d113\nlet d114: duration = 2 * (3 + (n * 4))\nsay d114\nlet d115: duration = 2 * (3 + (n * 4))\nsay d115\nlet d116: duration = 2 * (3 + (n * 4))\nsay d116\nlet d117: duration = 2 * (3 + (n * 4))\nsay d117\nlet d118: duration = 2 * (3 + (n * 4))\nsay d118\nlet d119: duration = 2 * (3 + (n * 4))\nsay d119\nlet d120: duration = 2 * (3 + (n * 4))\nsay d120\nlet d121: duration = 2 * (3 + (n * 4))\nsay d121\nlet d122: duration = 2 * (3 + (n * 4))\nsay d122\nlet d123: duration = 2 * (3 + (n * 4))\nsay d123\nlet d124: duration = 2 * (3 + (n * 4))\nsay d124\nlet d125: duration = 2 * (3 + (n * 4))\nsay d125\nlet d126: duration = 2 * (3 + (n * 4))\nsay d126\nlet d127: duration = 2 * (3 + (n * 4))\nsay d127\nexit",
  ],
  [
    "original-46",
    "let n = 2\nlet d0: duration = 2 * (3 + (n * 4))\nsay d0\nlet d1: duration = 2 * (3 + (n * 4))\nsay d1\nlet d2: duration = 2 * (3 + (n * 4))\nsay d2\nlet d3: duration = 2 * (3 + (n * 4))\nsay d3\nlet d4: duration = 2 * (3 + (n * 4))\nsay d4\nlet d5: duration = 2 * (3 + (n * 4))\nsay d5\nlet d6: duration = 2 * (3 + (n * 4))\nsay d6\nlet d7: duration = 2 * (3 + (n * 4))\nsay d7\nlet d8: duration = 2 * (3 + (n * 4))\nsay d8\nlet d9: duration = 2 * (3 + (n * 4))\nsay d9\nlet d10: duration = 2 * (3 + (n * 4))\nsay d10\nlet d11: duration = 2 * (3 + (n * 4))\nsay d11\nlet d12: duration = 2 * (3 + (n * 4))\nsay d12\nlet d13: duration = 2 * (3 + (n * 4))\nsay d13\nlet d14: duration = 2 * (3 + (n * 4))\nsay d14\nlet d15: duration = 2 * (3 + (n * 4))\nsay d15\nlet d16: duration = 2 * (3 + (n * 4))\nsay d16\nlet d17: duration = 2 * (3 + (n * 4))\nsay d17\nlet d18: duration = 2 * (3 + (n * 4))\nsay d18\nlet d19: duration = 2 * (3 + (n * 4))\nsay d19\nlet d20: duration = 2 * (3 + (n * 4))\nsay d20\nlet d21: duration = 2 * (3 + (n * 4))\nsay d21\nlet d22: duration = 2 * (3 + (n * 4))\nsay d22\nlet d23: duration = 2 * (3 + (n * 4))\nsay d23\nlet d24: duration = 2 * (3 + (n * 4))\nsay d24\nlet d25: duration = 2 * (3 + (n * 4))\nsay d25\nlet d26: duration = 2 * (3 + (n * 4))\nsay d26\nlet d27: duration = 2 * (3 + (n * 4))\nsay d27\nlet d28: duration = 2 * (3 + (n * 4))\nsay d28\nlet d29: duration = 2 * (3 + (n * 4))\nsay d29\nlet d30: duration = 2 * (3 + (n * 4))\nsay d30\nlet d31: duration = 2 * (3 + (n * 4))\nsay d31\nlet d32: duration = 2 * (3 + (n * 4))\nsay d32\nlet d33: duration = 2 * (3 + (n * 4))\nsay d33\nlet d34: duration = 2 * (3 + (n * 4))\nsay d34\nlet d35: duration = 2 * (3 + (n * 4))\nsay d35\nlet d36: duration = 2 * (3 + (n * 4))\nsay d36\nlet d37: duration = 2 * (3 + (n * 4))\nsay d37\nlet d38: duration = 2 * (3 + (n * 4))\nsay d38\nlet d39: duration = 2 * (3 + (n * 4))\nsay d39\nlet d40: duration = 2 * (3 + (n * 4))\nsay d40\nlet d41: duration = 2 * (3 + (n * 4))\nsay d41\nlet d42: duration = 2 * (3 + (n * 4))\nsay d42\nlet d43: duration = 2 * (3 + (n * 4))\nsay d43\nlet d44: duration = 2 * (3 + (n * 4))\nsay d44\nlet d45: duration = 2 * (3 + (n * 4))\nsay d45\nlet d46: duration = 2 * (3 + (n * 4))\nsay d46\nlet d47: duration = 2 * (3 + (n * 4))\nsay d47\nlet d48: duration = 2 * (3 + (n * 4))\nsay d48\nlet d49: duration = 2 * (3 + (n * 4))\nsay d49\nlet d50: duration = 2 * (3 + (n * 4))\nsay d50\nlet d51: duration = 2 * (3 + (n * 4))\nsay d51\nlet d52: duration = 2 * (3 + (n * 4))\nsay d52\nlet d53: duration = 2 * (3 + (n * 4))\nsay d53\nlet d54: duration = 2 * (3 + (n * 4))\nsay d54\nlet d55: duration = 2 * (3 + (n * 4))\nsay d55\nlet d56: duration = 2 * (3 + (n * 4))\nsay d56\nlet d57: duration = 2 * (3 + (n * 4))\nsay d57\nlet d58: duration = 2 * (3 + (n * 4))\nsay d58\nlet d59: duration = 2 * (3 + (n * 4))\nsay d59\nlet d60: duration = 2 * (3 + (n * 4))\nsay d60\nlet d61: duration = 2 * (3 + (n * 4))\nsay d61\nlet d62: duration = 2 * (3 + (n * 4))\nsay d62\nlet d63: duration = 2 * (3 + (n * 4))\nsay d63\nexit",
  ],
  [
    "original-47",
    "let n = 2\nlet d0: duration = 2 * (3 + (n * 4))\nsay d0\nlet d1: duration = 2 * (3 + (n * 4))\nsay d1\nlet d2: duration = 2 * (3 + (n * 4))\nsay d2\nlet d3: duration = 2 * (3 + (n * 4))\nsay d3\nlet d4: duration = 2 * (3 + (n * 4))\nsay d4\nlet d5: duration = 2 * (3 + (n * 4))\nsay d5\nlet d6: duration = 2 * (3 + (n * 4))\nsay d6\nlet d7: duration = 2 * (3 + (n * 4))\nsay d7\nlet d8: duration = 2 * (3 + (n * 4))\nsay d8\nlet d9: duration = 2 * (3 + (n * 4))\nsay d9\nlet d10: duration = 2 * (3 + (n * 4))\nsay d10\nlet d11: duration = 2 * (3 + (n * 4))\nsay d11\nlet d12: duration = 2 * (3 + (n * 4))\nsay d12\nlet d13: duration = 2 * (3 + (n * 4))\nsay d13\nlet d14: duration = 2 * (3 + (n * 4))\nsay d14\nlet d15: duration = 2 * (3 + (n * 4))\nsay d15\nlet d16: duration = 2 * (3 + (n * 4))\nsay d16\nlet d17: duration = 2 * (3 + (n * 4))\nsay d17\nlet d18: duration = 2 * (3 + (n * 4))\nsay d18\nlet d19: duration = 2 * (3 + (n * 4))\nsay d19\nlet d20: duration = 2 * (3 + (n * 4))\nsay d20\nlet d21: duration = 2 * (3 + (n * 4))\nsay d21\nlet d22: duration = 2 * (3 + (n * 4))\nsay d22\nlet d23: duration = 2 * (3 + (n * 4))\nsay d23\nlet d24: duration = 2 * (3 + (n * 4))\nsay d24\nlet d25: duration = 2 * (3 + (n * 4))\nsay d25\nlet d26: duration = 2 * (3 + (n * 4))\nsay d26\nlet d27: duration = 2 * (3 + (n * 4))\nsay d27\nlet d28: duration = 2 * (3 + (n * 4))\nsay d28\nlet d29: duration = 2 * (3 + (n * 4))\nsay d29\nlet d30: duration = 2 * (3 + (n * 4))\nsay d30\nlet d31: duration = 2 * (3 + (n * 4))\nsay d31\nlet d32: duration = 2 * (3 + (n * 4))\nsay d32\nlet d33: duration = 2 * (3 + (n * 4))\nsay d33\nlet d34: duration = 2 * (3 + (n * 4))\nsay d34\nlet d35: duration = 2 * (3 + (n * 4))\nsay d35\nlet d36: duration = 2 * (3 + (n * 4))\nsay d36\nlet d37: duration = 2 * (3 + (n * 4))\nsay d37\nlet d38: duration = 2 * (3 + (n * 4))\nsay d38\nlet d39: duration = 2 * (3 + (n * 4))\nsay d39\nlet d40: duration = 2 * (3 + (n * 4))\nsay d40\nlet d41: duration = 2 * (3 + (n * 4))\nsay d41\nlet d42: duration = 2 * (3 + (n * 4))\nsay d42\nlet d43: duration = 2 * (3 + (n * 4))\nsay d43\nlet d44: duration = 2 * (3 + (n * 4))\nsay d44\nlet d45: duration = 2 * (3 + (n * 4))\nsay d45\nlet d46: duration = 2 * (3 + (n * 4))\nsay d46\nlet d47: duration = 2 * (3 + (n * 4))\nsay d47\nlet d48: duration = 2 * (3 + (n * 4))\nsay d48\nlet d49: duration = 2 * (3 + (n * 4))\nsay d49\nlet d50: duration = 2 * (3 + (n * 4))\nsay d50\nlet d51: duration = 2 * (3 + (n * 4))\nsay d51\nlet d52: duration = 2 * (3 + (n * 4))\nsay d52\nlet d53: duration = 2 * (3 + (n * 4))\nsay d53\nlet d54: duration = 2 * (3 + (n * 4))\nsay d54\nlet d55: duration = 2 * (3 + (n * 4))\nsay d55\nlet d56: duration = 2 * (3 + (n * 4))\nsay d56\nlet d57: duration = 2 * (3 + (n * 4))\nsay d57\nlet d58: duration = 2 * (3 + (n * 4))\nsay d58\nlet d59: duration = 2 * (3 + (n * 4))\nsay d59\nlet d60: duration = 2 * (3 + (n * 4))\nsay d60\nlet d61: duration = 2 * (3 + (n * 4))\nsay d61\nlet d62: duration = 2 * (3 + (n * 4))\nsay d62\nlet d63: duration = 2 * (3 + (n * 4))\nsay d63\nlet d64: duration = 2 * (3 + (n * 4))\nsay d64\nlet d65: duration = 2 * (3 + (n * 4))\nsay d65\nlet d66: duration = 2 * (3 + (n * 4))\nsay d66\nlet d67: duration = 2 * (3 + (n * 4))\nsay d67\nlet d68: duration = 2 * (3 + (n * 4))\nsay d68\nlet d69: duration = 2 * (3 + (n * 4))\nsay d69\nlet d70: duration = 2 * (3 + (n * 4))\nsay d70\nlet d71: duration = 2 * (3 + (n * 4))\nsay d71\nlet d72: duration = 2 * (3 + (n * 4))\nsay d72\nlet d73: duration = 2 * (3 + (n * 4))\nsay d73\nlet d74: duration = 2 * (3 + (n * 4))\nsay d74\nlet d75: duration = 2 * (3 + (n * 4))\nsay d75\nlet d76: duration = 2 * (3 + (n * 4))\nsay d76\nlet d77: duration = 2 * (3 + (n * 4))\nsay d77\nlet d78: duration = 2 * (3 + (n * 4))\nsay d78\nlet d79: duration = 2 * (3 + (n * 4))\nsay d79\nlet d80: duration = 2 * (3 + (n * 4))\nsay d80\nlet d81: duration = 2 * (3 + (n * 4))\nsay d81\nlet d82: duration = 2 * (3 + (n * 4))\nsay d82\nlet d83: duration = 2 * (3 + (n * 4))\nsay d83\nlet d84: duration = 2 * (3 + (n * 4))\nsay d84\nlet d85: duration = 2 * (3 + (n * 4))\nsay d85\nlet d86: duration = 2 * (3 + (n * 4))\nsay d86\nlet d87: duration = 2 * (3 + (n * 4))\nsay d87\nlet d88: duration = 2 * (3 + (n * 4))\nsay d88\nlet d89: duration = 2 * (3 + (n * 4))\nsay d89\nlet d90: duration = 2 * (3 + (n * 4))\nsay d90\nlet d91: duration = 2 * (3 + (n * 4))\nsay d91\nlet d92: duration = 2 * (3 + (n * 4))\nsay d92\nlet d93: duration = 2 * (3 + (n * 4))\nsay d93\nlet d94: duration = 2 * (3 + (n * 4))\nsay d94\nlet d95: duration = 2 * (3 + (n * 4))\nsay d95\nlet d96: duration = 2 * (3 + (n * 4))\nsay d96\nlet d97: duration = 2 * (3 + (n * 4))\nsay d97\nlet d98: duration = 2 * (3 + (n * 4))\nsay d98\nlet d99: duration = 2 * (3 + (n * 4))\nsay d99\nlet d100: duration = 2 * (3 + (n * 4))\nsay d100\nlet d101: duration = 2 * (3 + (n * 4))\nsay d101\nlet d102: duration = 2 * (3 + (n * 4))\nsay d102\nlet d103: duration = 2 * (3 + (n * 4))\nsay d103\nlet d104: duration = 2 * (3 + (n * 4))\nsay d104\nlet d105: duration = 2 * (3 + (n * 4))\nsay d105\nlet d106: duration = 2 * (3 + (n * 4))\nsay d106\nlet d107: duration = 2 * (3 + (n * 4))\nsay d107\nlet d108: duration = 2 * (3 + (n * 4))\nsay d108\nlet d109: duration = 2 * (3 + (n * 4))\nsay d109\nlet d110: duration = 2 * (3 + (n * 4))\nsay d110\nlet d111: duration = 2 * (3 + (n * 4))\nsay d111\nlet d112: duration = 2 * (3 + (n * 4))\nsay d112\nlet d113: duration = 2 * (3 + (n * 4))\nsay d113\nlet d114: duration = 2 * (3 + (n * 4))\nsay d114\nlet d115: duration = 2 * (3 + (n * 4))\nsay d115\nlet d116: duration = 2 * (3 + (n * 4))\nsay d116\nlet d117: duration = 2 * (3 + (n * 4))\nsay d117\nlet d118: duration = 2 * (3 + (n * 4))\nsay d118\nlet d119: duration = 2 * (3 + (n * 4))\nsay d119\nlet d120: duration = 2 * (3 + (n * 4))\nsay d120\nlet d121: duration = 2 * (3 + (n * 4))\nsay d121\nlet d122: duration = 2 * (3 + (n * 4))\nsay d122\nlet d123: duration = 2 * (3 + (n * 4))\nsay d123\nlet d124: duration = 2 * (3 + (n * 4))\nsay d124\nlet d125: duration = 2 * (3 + (n * 4))\nsay d125\nlet d126: duration = 2 * (3 + (n * 4))\nsay d126\nlet d127: duration = 2 * (3 + (n * 4))\nsay d127\nexit",
  ],
  [
    "original-48",
    "let n = 2\nsay ({n: 0}).missing + [1]\nsay ({n: 1}).missing + [1]\nsay ({n: 2}).missing + [1]\nsay ({n: 3}).missing + [1]\nsay ({n: 4}).missing + [1]\nsay ({n: 5}).missing + [1]\nsay ({n: 6}).missing + [1]\nsay ({n: 7}).missing + [1]\nsay ({n: 8}).missing + [1]\nsay ({n: 9}).missing + [1]\nsay ({n: 10}).missing + [1]\nsay ({n: 11}).missing + [1]\nsay ({n: 12}).missing + [1]\nsay ({n: 13}).missing + [1]\nsay ({n: 14}).missing + [1]\nsay ({n: 15}).missing + [1]\nsay ({n: 16}).missing + [1]\nsay ({n: 17}).missing + [1]\nsay ({n: 18}).missing + [1]\nsay ({n: 19}).missing + [1]\nsay ({n: 20}).missing + [1]\nsay ({n: 21}).missing + [1]\nsay ({n: 22}).missing + [1]\nsay ({n: 23}).missing + [1]\nsay ({n: 24}).missing + [1]\nsay ({n: 25}).missing + [1]\nsay ({n: 26}).missing + [1]\nsay ({n: 27}).missing + [1]\nsay ({n: 28}).missing + [1]\nsay ({n: 29}).missing + [1]\nsay ({n: 30}).missing + [1]\nsay ({n: 31}).missing + [1]\nsay ({n: 32}).missing + [1]\nsay ({n: 33}).missing + [1]\nsay ({n: 34}).missing + [1]\nsay ({n: 35}).missing + [1]\nsay ({n: 36}).missing + [1]\nsay ({n: 37}).missing + [1]\nsay ({n: 38}).missing + [1]\nsay ({n: 39}).missing + [1]\nsay ({n: 40}).missing + [1]\nsay ({n: 41}).missing + [1]\nsay ({n: 42}).missing + [1]\nsay ({n: 43}).missing + [1]\nsay ({n: 44}).missing + [1]\nsay ({n: 45}).missing + [1]\nsay ({n: 46}).missing + [1]\nsay ({n: 47}).missing + [1]\nsay ({n: 48}).missing + [1]\nsay ({n: 49}).missing + [1]\nsay ({n: 50}).missing + [1]\nsay ({n: 51}).missing + [1]\nsay ({n: 52}).missing + [1]\nsay ({n: 53}).missing + [1]\nsay ({n: 54}).missing + [1]\nsay ({n: 55}).missing + [1]\nsay ({n: 56}).missing + [1]\nsay ({n: 57}).missing + [1]\nsay ({n: 58}).missing + [1]\nsay ({n: 59}).missing + [1]\nsay ({n: 60}).missing + [1]\nsay ({n: 61}).missing + [1]\nsay ({n: 62}).missing + [1]\nsay ({n: 63}).missing + [1]\nexit",
  ],
  [
    "original-49",
    "let n = 2\nsay ({n: 0}).missing + [1]\nsay ({n: 1}).missing + [1]\nsay ({n: 2}).missing + [1]\nsay ({n: 3}).missing + [1]\nsay ({n: 4}).missing + [1]\nsay ({n: 5}).missing + [1]\nsay ({n: 6}).missing + [1]\nsay ({n: 7}).missing + [1]\nsay ({n: 8}).missing + [1]\nsay ({n: 9}).missing + [1]\nsay ({n: 10}).missing + [1]\nsay ({n: 11}).missing + [1]\nsay ({n: 12}).missing + [1]\nsay ({n: 13}).missing + [1]\nsay ({n: 14}).missing + [1]\nsay ({n: 15}).missing + [1]\nsay ({n: 16}).missing + [1]\nsay ({n: 17}).missing + [1]\nsay ({n: 18}).missing + [1]\nsay ({n: 19}).missing + [1]\nsay ({n: 20}).missing + [1]\nsay ({n: 21}).missing + [1]\nsay ({n: 22}).missing + [1]\nsay ({n: 23}).missing + [1]\nsay ({n: 24}).missing + [1]\nsay ({n: 25}).missing + [1]\nsay ({n: 26}).missing + [1]\nsay ({n: 27}).missing + [1]\nsay ({n: 28}).missing + [1]\nsay ({n: 29}).missing + [1]\nsay ({n: 30}).missing + [1]\nsay ({n: 31}).missing + [1]\nsay ({n: 32}).missing + [1]\nsay ({n: 33}).missing + [1]\nsay ({n: 34}).missing + [1]\nsay ({n: 35}).missing + [1]\nsay ({n: 36}).missing + [1]\nsay ({n: 37}).missing + [1]\nsay ({n: 38}).missing + [1]\nsay ({n: 39}).missing + [1]\nsay ({n: 40}).missing + [1]\nsay ({n: 41}).missing + [1]\nsay ({n: 42}).missing + [1]\nsay ({n: 43}).missing + [1]\nsay ({n: 44}).missing + [1]\nsay ({n: 45}).missing + [1]\nsay ({n: 46}).missing + [1]\nsay ({n: 47}).missing + [1]\nsay ({n: 48}).missing + [1]\nsay ({n: 49}).missing + [1]\nsay ({n: 50}).missing + [1]\nsay ({n: 51}).missing + [1]\nsay ({n: 52}).missing + [1]\nsay ({n: 53}).missing + [1]\nsay ({n: 54}).missing + [1]\nsay ({n: 55}).missing + [1]\nsay ({n: 56}).missing + [1]\nsay ({n: 57}).missing + [1]\nsay ({n: 58}).missing + [1]\nsay ({n: 59}).missing + [1]\nsay ({n: 60}).missing + [1]\nsay ({n: 61}).missing + [1]\nsay ({n: 62}).missing + [1]\nsay ({n: 63}).missing + [1]\nsay ({n: 64}).missing + [1]\nsay ({n: 65}).missing + [1]\nsay ({n: 66}).missing + [1]\nsay ({n: 67}).missing + [1]\nsay ({n: 68}).missing + [1]\nsay ({n: 69}).missing + [1]\nsay ({n: 70}).missing + [1]\nsay ({n: 71}).missing + [1]\nsay ({n: 72}).missing + [1]\nsay ({n: 73}).missing + [1]\nsay ({n: 74}).missing + [1]\nsay ({n: 75}).missing + [1]\nsay ({n: 76}).missing + [1]\nsay ({n: 77}).missing + [1]\nsay ({n: 78}).missing + [1]\nsay ({n: 79}).missing + [1]\nsay ({n: 80}).missing + [1]\nsay ({n: 81}).missing + [1]\nsay ({n: 82}).missing + [1]\nsay ({n: 83}).missing + [1]\nsay ({n: 84}).missing + [1]\nsay ({n: 85}).missing + [1]\nsay ({n: 86}).missing + [1]\nsay ({n: 87}).missing + [1]\nsay ({n: 88}).missing + [1]\nsay ({n: 89}).missing + [1]\nsay ({n: 90}).missing + [1]\nsay ({n: 91}).missing + [1]\nsay ({n: 92}).missing + [1]\nsay ({n: 93}).missing + [1]\nsay ({n: 94}).missing + [1]\nsay ({n: 95}).missing + [1]\nsay ({n: 96}).missing + [1]\nsay ({n: 97}).missing + [1]\nsay ({n: 98}).missing + [1]\nsay ({n: 99}).missing + [1]\nsay ({n: 100}).missing + [1]\nsay ({n: 101}).missing + [1]\nsay ({n: 102}).missing + [1]\nsay ({n: 103}).missing + [1]\nsay ({n: 104}).missing + [1]\nsay ({n: 105}).missing + [1]\nsay ({n: 106}).missing + [1]\nsay ({n: 107}).missing + [1]\nsay ({n: 108}).missing + [1]\nsay ({n: 109}).missing + [1]\nsay ({n: 110}).missing + [1]\nsay ({n: 111}).missing + [1]\nsay ({n: 112}).missing + [1]\nsay ({n: 113}).missing + [1]\nsay ({n: 114}).missing + [1]\nsay ({n: 115}).missing + [1]\nsay ({n: 116}).missing + [1]\nsay ({n: 117}).missing + [1]\nsay ({n: 118}).missing + [1]\nsay ({n: 119}).missing + [1]\nsay ({n: 120}).missing + [1]\nsay ({n: 121}).missing + [1]\nsay ({n: 122}).missing + [1]\nsay ({n: 123}).missing + [1]\nsay ({n: 124}).missing + [1]\nsay ({n: 125}).missing + [1]\nsay ({n: 126}).missing + [1]\nsay ({n: 127}).missing + [1]\nexit",
  ],
  [
    "archived paste/(n otherwise 0)",
    'let ns = [2, null]\nlet n = ns[1]\nsay toInteger("${(n otherwise 0) + 1}", default: 1)\nexit\n',
  ],
  [
    "archived paste/(n otherwise 0)",
    "let ns = [2, null]\nlet n = ns[1]\nsay 2 * (3 + ((n otherwise 0) * 4))\nexit\n",
  ],
  [
    "archived paste/(-(2 + -n)) s",
    "let n = 2\nlet converted: duration = (-(2 + -n)) s\nsay converted\nexit\n",
  ],
  [
    "archived paste/({outer: {v: 2 * (n + 1)}}).outer.v s",
    "let n = 2\nlet converted: duration = ({outer: {v: 2 * (n + 1)}}).outer.v s\nsay converted\nexit\n",
  ],
  [
    "archived paste/(n otherwise 0)",
    "let ns = [2, null]\nlet n = ns[1]\nsay ({outer: {v: 2 * ((n otherwise 0) + 1)}}).outer.v\nexit\n",
  ],
  [
    "archived paste/(n otherwise 0)",
    "let ns = [2, null]\nlet n = ns[1]\nfunction f(x: integer) { say x }\nf(2 * ((n otherwise 0) + 1))\nexit\n",
  ],
  [
    "archived paste/(n otherwise 0)",
    "let ns = [2, null]\nlet n = ns[1]\nfor i in 1 .. ((n otherwise 0) + 1) { say i }\nexit\n",
  ],
  [
    'archived paste/dict{["${n + 1}"]: 3}.keys.length s',
    'let n = 2\nlet converted: duration = dict{["${n + 1}"]: 3}.keys.length s\nsay converted\nexit\n',
  ],
  [
    "archived paste/(n otherwise 0)",
    "let ns = [2, null]\nlet n = ns[1]\nsay ((n otherwise 0) + 1) is integer\nexit\n",
  ],
  [
    "archived paste/(2 * (3 + (n * 4))) s",
    "let n = 2\nlet converted: duration = (2 * (3 + (n * 4))) s\nsay converted\nexit\n",
  ],
  [
    "archived paste/(n otherwise 0)",
    "let ns = [2, null]\nlet n = ns[1]\nsay -(2 + -(n otherwise 0))\nexit\n",
  ],
  [
    "archived paste/(n otherwise 0)",
    'let ns = [2, null]\nlet n = ns[1]\nsay "${2 * ((n otherwise 0) + 1)}"\nexit\n',
  ],
  [
    "archived paste/(n otherwise 0)",
    'let ns = [2, null]\nlet n = ns[1]\nlet d = dict{["${(n otherwise 0) + 1}"]: 3}\nsay d.keys\nexit\n',
  ],
  [
    "archived paste/[1 .. (n + 1)].length s",
    "let n = 2\nlet converted: duration = [1 .. (n + 1)].length s\nsay converted\nexit\n",
  ],
  [
    'archived paste/"${2 * (n + 1)}".length s',
    'let n = 2\nlet converted: duration = "${2 * (n + 1)}".length s\nsay converted\nexit\n',
  ],
  [
    'archived paste/"${n is integer}".length s',
    'let n = 2\nlet converted: duration = "${n is integer}".length s\nsay converted\nexit\n',
  ],
  ["spot.json/text size at say", 'let t = "hello"\nsay t.size\nexit\n'],
  ["spot.json/paste/t.length", 'let t = "hello"\nsay t.length\nexit\n'],
  [
    'spot.json/d["absent"] + element at receiver',
    'let d = dict{found: [1]}\nsay (d["absent"] + 2).length\nexit\n',
  ],
  [
    "spot.json/null element's items + element at nested product",
    'let boxes = [{n: 2, text: "hello", items: [1]}, null]\nsay 2 * (3 * (boxes[1].items + 2))\nexit\n',
  ],
  ["spot.json/dict of integer at logic", "let d = dict{k: 1}\nsay d.k and true\nexit\n"],
  [
    "spot.json/nested join of object at untyped returned argument",
    "let box = {items: [{n: 1}]}\nfunction id(p) {\n  return p\n}\nlet w: string = id(box.items.join)\nsay w\nexit\n",
  ],
  [
    "spot.json/list of text + number at text store",
    'let xs = ["a"]\nlet v = "x"\nv = xs + 1.5\nexit\n',
  ],
  [
    "spot.json/object + list of integer at untyped trim argument",
    'let xs = [1]\nfunction use(p) {\n  say p.trim()\n}\nuse({n: "x"} + xs)\nexit\n',
  ],
  [
    "spot.json/integer + list of boolean at string declaration",
    "let xs = [true]\nlet v: string = 1 + xs\nexit\n",
  ],
  ["spot.json/list of duration + object at wait", 'let xs = [1 s]\nwait xs + {n: "x"}\nexit\n'],
  [
    "spot.json/text + list of list at interpolated sum",
    'let xs = [[1]]\nsay "${("a" + xs) + 1}"\nexit\n',
  ],
  [
    "spot.json/number + list of set at integer argument",
    "let xs = [set[1]]\nfunction count(p: integer) {\n  say p\n}\ncount(1.5 + xs)\nexit\n",
  ],
  [
    "spot.json/ns[5] into string argument",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: string) {\n  say p\n}\nuse(ns[5])\nexit\n',
  ],
  [
    "spot.json/maybeN + 1 into duration declaration",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = maybeN + 1\nexit\n',
  ],
  [
    "spot.json/-maybeN into duration declaration",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = -maybeN\nexit\n',
  ],
  [
    "spot.json/2 * (maybeN * 3) into duration declaration",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = 2 * (maybeN * 3)\nexit\n',
  ],
  [
    "spot.json/({v: maybeN + 1}).v into duration declaration",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = ({v: maybeN + 1}).v\nexit\n',
  ],
  [
    'spot.json/"${maybeN}".length into duration declaration',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = "${maybeN}".length\nexit\n',
  ],
  [
    "spot.json/2 * (n * 3) into duration declaration",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = 2 * (n * 3)\nexit\n',
  ],
  [
    "spot.json/paste/(2 * (n * 3)) s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = (2 * (n * 3)) s\nexit\n',
  ],
  [
    "spot.json/({v: n + 1}).v into duration declaration",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = ({v: n + 1}).v\nexit\n',
  ],
  [
    "spot.json/paste/({v: n + 1}).v s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = ({v: n + 1}).v s\nexit\n',
  ],
  [
    'spot.json/"${n}".length into duration declaration',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = "${n}".length\nexit\n',
  ],
  [
    'spot.json/paste/"${n}".length s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = "${n}".length s\nexit\n',
  ],
];

export const checks = ["publication"];
