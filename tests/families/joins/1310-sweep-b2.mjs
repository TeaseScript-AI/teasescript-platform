// 5 fixed sweep b2 inputs; #1310, builder/review archive
// (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/sweep-b2.mjs).
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

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node sweep-b2.mjs <tree>",
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue-c2.sh:24",
    ],
  ],
  sources: 5,
  sha256: "9c4b92cf13c786b18385de0d377610de5ee468539c46461e2d9ea3d90d7bc4d6",
};
