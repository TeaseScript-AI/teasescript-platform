// #1310; builder/review archive.
export const cases = (() => {
  const source =
    'let box = {first: {last: {random: {n: 1}}}}\nbox.first.last = hostValue\nbox.first.last.random.n = 2\nsay "AFTER"\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication", "stops"];
