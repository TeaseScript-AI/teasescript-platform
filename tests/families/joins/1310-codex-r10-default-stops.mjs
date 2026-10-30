// #1310's Codex r10: default stops over deep copies, deep field copies and a joined scalar, the own value first or last,
// at k = 16, 32 and 64 (desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r10/default-stops.mjs).
export const cases = [
  [
    "52-r6/1",
    'let typed: integer[][][][][][][][][][][][][][][][] = []\nlet box = {first: {xs: typed}}\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/2",
    'let typed: integer[][][][][][][][][][][][][][][][] = []\nlet box = {first: {xs: typed, n: 1}}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first.n = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/3",
    'let w: integer[] = [1]\nlet box = {first: {xs: w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w}}\nbox.first.xs[0] = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/4",
    'let typed: integer[][][][][][][][][][][][][][][][] = []\nlet box = {last: {xs: typed}}\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/5",
    'let typed: integer[][][][][][][][][][][][][][][][] = []\nlet box = {last: {xs: typed, n: 1}}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last.n = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/6",
    'let w: integer[] = [1]\nlet box = {last: {xs: w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w}}\nbox.last.xs[0] = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/7",
    'let typed: integer[][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][] = []\nlet box = {first: {xs: typed}}\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/8",
    'let typed: integer[][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][] = []\nlet box = {first: {xs: typed, n: 1}}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first.n = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/9",
    'let w: integer[] = [1]\nlet box = {first: {xs: w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w}}\nbox.first.xs[0] = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/10",
    'let typed: integer[][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][] = []\nlet box = {last: {xs: typed}}\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/11",
    'let typed: integer[][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][] = []\nlet box = {last: {xs: typed, n: 1}}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last.n = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/12",
    'let w: integer[] = [1]\nlet box = {last: {xs: w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w}}\nbox.last.xs[0] = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/13",
    'let typed: integer[][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][] = []\nlet box = {first: {xs: typed}}\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = typed\nbox.first.xs = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/14",
    'let typed: integer[][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][] = []\nlet box = {first: {xs: typed, n: 1}}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first = {xs: typed, n: 1}\nbox.first.n = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/15",
    'let w: integer[] = [1]\nlet box = {first: {xs: w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w}}\nbox.first.xs[0] = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/16",
    'let typed: integer[][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][] = []\nlet box = {last: {xs: typed}}\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = typed\nbox.last.xs = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/17",
    'let typed: integer[][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][] = []\nlet box = {last: {xs: typed, n: 1}}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last = {xs: typed, n: 1}\nbox.last.n = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "52-r6/18",
    'let w: integer[] = [1]\nlet box = {last: {xs: w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w}}\nbox.last.xs[0] = "bad"\nsay "DONE"\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r6-r10" --dir $W/r10check -- bash -c "cd $W/r10check && timeout 90m node stops.mjs r6 > stops.log 2>&1; timeout 30m node default-stops.mjs r6 > default-stops.log 2>&1; timeout 30m node repro.mjs > repro.log 2>&1; echo done > done.txt"',
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue-r6.sh:35",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r6-r10" --dir $W/r10check -- bash -c "cd $W/r10check && timeout 90m node stops.mjs r6 > stops.log 2>&1; timeout 30m node default-stops.mjs r6 > default-stops.log 2>&1; timeout 30m node repro.mjs > repro.log 2>&1; echo done > done.txt"',
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue-r7.sh:35",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r6-r10" --dir $W/r10check -- bash -c "cd $W/r10check && timeout 90m node stops.mjs r6 > stops.log 2>&1; timeout 30m node default-stops.mjs r6 > default-stops.log 2>&1; timeout 30m node repro.mjs > repro.log 2>&1; echo done > done.txt"',
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue-r9.sh:35",
    ],
  ],
  sources: 18,
  sha256: "4d5413ee9ac7bc9d70de2997eabe24af7c3df94ea8701049767487c575682272",
};
