// #1188; Sol review.
export const cases = (() => {
  const source =
    'let typed: integer = 1\nlet word: string = "x"\nlet a = {n: typed}\nlet b = {n: word}\nlet c = a\nc = b\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication"];
