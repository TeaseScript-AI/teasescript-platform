// #1375 Astra review r2.
export const cases = (() => {
  const cases = [
    ["index step", "let box = [{n: 1}]\nsay box[0].n\nexit\n", "box[0].n", "box", ["element"]],
    ["property", "let box = {q: {n: 1}}\nsay box.q.n\nexit\n", "box.q.n", "box", ["q"]],
    [
      "selection",
      "let box = [[{n: 1}]]\nsay box.first.first.n\nexit\n",
      "box.first.first",
      "box",
      ["element"],
    ],
    [
      "selection then property",
      "let box = [{n: 1}]\nsay box.first.n\nexit\n",
      "box.first.n",
      "box",
      ["element"],
    ],
  ];
  return cases.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];
