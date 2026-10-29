// #1375 Astra review r1.
export const cases = (() => {
  const pre = Array.from({ length: 12 }, (_, i) => `let r${i} = {n: ${i}}`).join("\n");
  const source =
    pre +
    "\nlet box = {q: {deep: [" +
    Array.from({ length: 12 }, (_, i) => `r${i}`).join(",") +
    "]}}\nsay box.q.deep[0].n\nexit\n";
  return [["source", source]];
})();
export const checks = ["publication"];
