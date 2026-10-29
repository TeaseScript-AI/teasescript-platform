// #1240; Astra review.
export const cases = (() => {
  const sources = {
    nested: 'let a = {first: {n: 1}}\na.first.n = "bad"\nsay a.first.n\nexit\n',
    nestedFinal:
      'let a = {first: {last: {random: 1}}}\na.first.last.random = "bad"\nsay a.first.last.random\nexit\n',
    typedListFixed: "let xs = [1]\nlet ys: integer[] = xs + [2]\nsay ys\nexit\n",
    dateFixed: 'let day: date = toDate("2026-10-28")\nsay day\nexit\n',
    dictFixed: 'let d = dict{a: 1}\nd["b"] = 2\nsay d["b"]\nexit\n',
    substringFixed: 'let t = "hello"\nsay t.substring(0, 2)\nexit\n',
  };
  return Object.entries(sources);
})();
export const checks = ["publication"];
