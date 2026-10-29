// #1310; builder/review archive: 5 fixed cases source cases.
const corpus = (() => {
  const cases = [];
  for (const own of ["first", "last", "random"])
    cases.push([`let box = {${own}: {n: 1}}\nbox.${own}.n = "bad"\nsay "AFTER"\nexit\n`, [], []]);
  cases.push([
    'let box = {first: {n: 1}}\nbox.first.n = 2\nsay "AFTER"\nexit\n',
    [{ hostValue: 1 }],
    [],
  ]);
  cases.push([
    'let box = {last: {n: 1}}\nbox.last.n = hostValue\nsay "AFTER"\nexit\n',
    [{ hostValue: 2 }],
    [{ hostValue: "x" }],
  ]);
  return {
    cases: [
      ["0", cases["0"]["0"]],
      ["0", cases["1"]["0"]],
      ["0", cases["2"]["0"]],
      ["0", cases["3"]["0"]],
      ["0", cases["4"]["0"]],
    ],
  };
})();
export const cases = corpus.cases;
export const checks = ["publication", "stops"];
