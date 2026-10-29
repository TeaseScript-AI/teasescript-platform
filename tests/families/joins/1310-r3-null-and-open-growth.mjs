// #1310; builder/review archive.
export const sizes = [4, 8];
export const shapes = (() => {
  const terms = (k, term) => Array.from({ length: k }, (_, i) => term(i)).join(" + ");
  const nest = (k, wrap, end) => Array.from({ length: k }).reduce((e, _, i) => wrap(e, i), end);
  const FAMILIES = {
    // an open operand in each right operand, each element's property its own (the prefix check on every path)
    "open-right-fields": (k) =>
      `let u: list = [1]\nlet xs = ${nest(k, (e, i) => `[{p${i}: 1}] + (u + (${e}))`, "[{lastValue: 0}]")}\nsay xs.length\nexit\n`,
    // a run beside an empty \`list[]\` (the level walk at each read), text and whole numbers alternating
    "open-empty-run": (k) =>
      `let d: list[] = []\nlet xs = [[0]] + ${terms(k, (i) => (i % 2 ? `[["t${i}"]] + d` : `[[${i}]] + d`))}\nsay xs.length\nexit\n`,
    // a run with a null-only operand beside whole numbers
    "null-run": (k) =>
      `let n: null[] = [null]\nlet xs = [0] + ${terms(k, (i) => `[${i}] + n`)}\nsay xs.length\nexit\n`,
    // the same nested in right operands, two levels
    "null-right-nested": (k) =>
      `let n: null[][] = [[null]]\nlet xs = ${nest(k, (e, i) => `[[${i}]] + (n + (${e}))`, "[[0]]")}\nsay xs.length\nexit\n`,
    // k written lists joined into one variable, then text (Codex r9's B1: each written operand asked whatever came first)
    "written-run": (k) =>
      `${Array.from({ length: k }, (_, i) => `let a${i}: integer[] = [${i}]`).join("\n")}\nlet held = ${terms(k, (i) => `a${i}`)}\nlet r = held + [1]\nsay r.length\nexit\n`,
    // the same with an open operand last and a null-only one first
    "written-run-open-null": (k) =>
      `let n: null[] = [null]\nlet u: list = [1]\n${Array.from({ length: k }, (_, i) => `let a${i}: integer[] = [${i}]`).join("\n")}\nlet held = n + ${terms(k, (i) => `a${i}`)} + u\nheld.add("t")\nsay held.length\nexit\n`,
    // k calls with a written result joined
    "written-call-run": (k) =>
      `${Array.from({ length: k }, (_, i) => `function f${i}: integer[] {\n  return [${i}]\n}`).join("\n")}\nlet held = ${terms(k, (i) => `f${i}()`)}\nheld.add(1)\nsay held.length\nexit\n`,
    // k variables each holding a join with an open operand, each read once (#earliestDecider's open copy)
    "open-kept": (k) =>
      `let u: list = [1]\n${Array.from({ length: k }, (_, i) => `let h${i} = [${i}] + u\nlet r${i} = h${i} + ["t"]`).join("\n")}\nexit\n`,
  };
  const result = {};
  const leaf = (v) =>
    typeof v === "string" ||
    (Array.isArray(v) &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
  for (const [name, make] of Object.entries(FAMILIES)) {
    const sample = make(4);
    if (leaf(sample)) result[name] = make;
    else
      for (const [variant, source] of Object.entries(sample))
        if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
  }
  return result;
})();
export const checks = ["publication"];
