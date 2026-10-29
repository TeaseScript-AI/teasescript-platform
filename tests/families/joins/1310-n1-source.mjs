// #1310; builder/review archive.
export const cases = (() => {
  const source = 'let xs = [1]\nlet ys = xs + ([1] + ["a"])\nsay ys.length\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication", "stops"];
