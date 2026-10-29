// #1375 Astra review r1.
export const cases = (() => {
  const pre = Array.from({ length: 12 }, (_, i) => `let r${i} = {n: ${i}}`).join("\n");
  return [["pre", pre]];
})();
export const checks = ["publication"];
