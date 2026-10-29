// Fixed compiler inputs from astra-m4-s10p2-plan-review/probes.mjs.
const fixedCases = [
  [
    "inline-1",
    'let clear = askBoolean "clear?"\nlet n: integer? = 1\nif clear {n=null}\nif not clear {repeat n {}}\nexit\n',
  ],
  [
    "inline-2",
    'let n: integer? = load("n", default:null)\nlet answer = askInteger "how many?", prefill: n\nexit\n',
  ],
  ["inline-3", 'let n: integer? = load("n", default:null)\nfor v in 1..n {say v}\nexit\n'],
  [
    "inline-4",
    'let n: integer? = load("n", default:null)\nlet text = "hello"\nsay text.substring(n)\nexit\n',
  ],
  ["inline-5", 'let b: boolean? = load("b", default: null)\nif b {}\nexit\n'],
  ["inline-6", 'let b: boolean? = load("b", default: null)\nif (b otherwise 0) {}\nexit\n'],
  ["inline-7", 'let b: boolean? = load("b", default: null)\nif (b otherwise false) {}\nexit\n'],
  [
    "inline-8",
    'let key: string? = load("k", default: null)\nlet d = dict{a: 1}\nsay d[key]\nexit\n',
  ],
  [
    "inline-9",
    'let key: string? = load("k", default: null)\nlet d = dict{a: 1}\nsay d[key otherwise 0]\nexit\n',
  ],
  [
    "inline-10",
    'let x: integer | string = 1\nif askBoolean "text?" { x = "hello" }\nsay x.length\nexit\n',
  ],
  [
    "inline-11",
    'let x: integer | string = 1\nif askBoolean "text?" { x = "hello" }\nif x is integer { say x.length }\nexit\n',
  ],
  [
    "inline-12",
    'let x: integer | string = 1\nif askBoolean "text?" { x = "hello" }\nif x is string { say x.length }\nexit\n',
  ],
  ["inline-13", "let box = {n:null}\nif box != null { repeat box.n {} }\nexit\n"],
  ["inline-14", "let xs = [1, null]\nif xs[0] != null { xs.clear()\nrepeat xs[0] {} }\nexit\n"],
  ["inline-15", "let xs = [1, null]\nif xs[0] != null { repeat xs[0] {} }\nexit\n"],
  [
    "inline-16",
    'let xs = [1, null]\nif xs[0] != null { if askBoolean "clear?" {xs.clear()}\nrepeat xs[0] {} }\nexit\n',
  ],
  ["inline-17", "let xs = [1, null]\nif xs[0] != null { xs.removeAt(0)\nrepeat xs[0] {} }\nexit\n"],
  [
    "inline-18",
    'let xs: integer[]? = [1]\nif askBoolean "clear?" { xs = null }\nfor v in xs { say v }\nexit\n',
  ],
  [
    "inline-19",
    'let box = {n:1}\nif askBoolean "clear?" {box = null}\nif box != null {box.n = 2}\nexit\n',
  ],
  [
    "inline-20",
    'let n: integer? = load("n", default:null)\nif n != null { let copy: integer = n\nrepeat copy {} }\nexit\n',
  ],
  [
    "inline-21",
    'let n: integer | string | null = 1\nif askBoolean "word?" {n="bad"}\nif askBoolean "null?" {n=null}\nif n != null { if n is not string { repeat n {} } }\nexit\n',
  ],
];
export const cases = fixedCases;
export const checks = ["publication"];
