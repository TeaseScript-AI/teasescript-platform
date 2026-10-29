// #1272; Astra review.
export const cases = (() => {
  const sources = [
    ["open", 'let u: list = [1]\nlet result = ([2] + u) + ["tail"]\nsay result.length\nexit\n'],
    ["null", "let nils: null[] = [null]\nlet result = [1] + nils\nsay result.length\nexit\n"],
    [
      "inferred",
      'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make() + [false]\nlet result = held + ["tail"]\nsay result.length\nexit\n',
    ],
  ];
  return sources.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];
