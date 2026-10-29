export const cases = [
  ["original-1", 'let box = {first: {n: 1}}\nbox.first.n = "bad"\nsay "DONE"\nexit\n'],
  ["original-2", 'let box = {first: {n: 1}}\nbox.first.n = 2\nsay "DONE"\nexit\n'],
  [
    "original-3",
    'let box = {first: {n: 1}}\nbox.first.n = hostValue\nrepeat box.first.n {}\nsay "DONE"\nexit\n',
  ],
  [
    "original-4",
    'let box = {first: {n: 1}}\nbox.first = hostValue\nbox.first.n = hostOther\nrepeat box.first.n {}\nsay "DONE"\nexit\n',
  ],
  [
    "original-5",
    'let box = {first: null}\nbox.first = {first: {n: 1}}\nbox.first.first.n = "bad"\nsay "DONE"\nexit\n',
  ],
  ["original-6", 'let box = {last: {n: 1}}\nbox.last.n = "bad"\nsay "DONE"\nexit\n'],
  ["original-7", 'let box = {last: {n: 1}}\nbox.last.n = 2\nsay "DONE"\nexit\n'],
  [
    "original-8",
    'let box = {last: {n: 1}}\nbox.last.n = hostValue\nrepeat box.last.n {}\nsay "DONE"\nexit\n',
  ],
  [
    "original-9",
    'let box = {last: {n: 1}}\nbox.last = hostValue\nbox.last.n = hostOther\nrepeat box.last.n {}\nsay "DONE"\nexit\n',
  ],
  [
    "original-10",
    'let box = {last: null}\nbox.last = {last: {n: 1}}\nbox.last.last.n = "bad"\nsay "DONE"\nexit\n',
  ],
  ["original-11", 'let box = {random: {n: 1}}\nbox.random.n = "bad"\nsay "DONE"\nexit\n'],
  ["original-12", 'let box = {random: {n: 1}}\nbox.random.n = 2\nsay "DONE"\nexit\n'],
  [
    "original-13",
    'let box = {random: {n: 1}}\nbox.random.n = hostValue\nrepeat box.random.n {}\nsay "DONE"\nexit\n',
  ],
  [
    "original-14",
    'let box = {random: {n: 1}}\nbox.random = hostValue\nbox.random.n = hostOther\nrepeat box.random.n {}\nsay "DONE"\nexit\n',
  ],
  [
    "original-15",
    'let box = {random: null}\nbox.random = {random: {n: 1}}\nbox.random.random.n = "bad"\nsay "DONE"\nexit\n',
  ],
  ["original-16", 'let box = {inner: {n: 1}}\nbox.inner.n = "bad"\nsay "DONE"\nexit\n'],
  ["original-17", 'let n = 1\nn = "bad"\nsay "DONE"\nexit\n'],
  ["original-18", 'let xs = [1]\nxs.add("bad")\nsay "DONE"\nexit\n'],
  [
    "original-19",
    'let w: integer[] = [1]\nlet box = {first: {xs: w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w}}\nbox.first.xs[0] = "bad"\nsay "DONE"\nexit\n',
  ],
  [
    "original-20",
    'let w: integer[] = [1]\nlet box = {last: {xs: w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w + w}}\nbox.last.xs[0] = "bad"\nsay "DONE"\nexit\n',
  ],
];

export const checks = ["publication", "stops"];
