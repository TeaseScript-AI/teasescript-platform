export const cases = [
  ["original-1", 'let u: list = [1]\nlet result = ([2] + u) + ["tail"]\nsay result.length\nexit\n'],
  ["original-2", "let nils: null[] = [null]\nlet result = [1] + nils\nsay result.length\nexit\n"],
  [
    "original-3",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make() + [false]\nlet result = held + ["tail"]\nsay result.length\nexit\n',
  ],
  [
    "original-4",
    'let box = {random: {first: {last: {n: 1}}}}\nbox.random.first = hostOther\nsay "BEFORE"\nbox.random.first.last.n = 2\nsay "AFTER"\nexit\n',
  ],
  [
    "original-5",
    'let box = {random: {first: {last: {n: 1}}}}\nbox.random.first = hostOther\nsay "BEFORE"\nbox.random.first.last.n = hostValue\nsay "AFTER"\nexit\n',
  ],
];

export const checks = ["publication", "stops"];
