// #1375 Astra review r1.
export const cases = (() => {
  const source =
    'let root = {q: {n: 1}}\nroot.q.n = "bad"\nroot.q.n = 3\nlet copy = [root.q]\nsay copy[0].n\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication", "stops"];
