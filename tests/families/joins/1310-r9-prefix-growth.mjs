// #1310; builder/review archive: size-dependent families source families.
export const sizes = [4, 8];
const corpus = (() => {
  const wrap = (n, inner) => "{p: ".repeat(n) + inner + "}".repeat(n);
  const families = {
    // Open in a sibling property: every long non-open query must examine all prefixes.
    "prefix-sibling-depth": (n) =>
      `let u: list = []\nlet r = [{opened: u, branch: ${wrap(n, "1")}}] + [{branch: ${wrap(n, "2")}}]\nsay r.length\nexit\n`,
    // Many independently named open descendants; prefix lookup must not scan every unrelated opener.
    "prefix-distinct-width": (n) =>
      `let u: list = []\nlet r = [${"{" + Array.from({ length: n }, (_, i) => `o${i}: u`).join(",") + "}"}] + [${"{" + Array.from({ length: n }, (_, i) => `o${i}: [${i}], q${i}: {v: ${i}}`).join(",") + "}"}]\nsay r.length\nexit\n`,
    // Written empty nested lists force the new walk below all actual value structure.
    "empty-list-depth": (n) =>
      `let u: ${"list" + "[]".repeat(n)} = []\nlet r = u + ${"[".repeat(n + 1) + "1" + "]".repeat(n + 1)}\nsay r.length\nexit\n`,
    // Repeated reads of moderately deep types exercise the level walk's lifecycle frequency.
    "empty-list-read-width": (n) =>
      `let u: list[][][][] = []\n${Array.from({ length: n }, (_, i) => `let r${i} = [[[[[${i}]]]]] + u\nsay r${i}.length`).join("\n")}\nexit\n`,
  };
  return {
    shapes: {
      "prefix-sibling-depth": (n) => families["prefix-sibling-depth"](n),
      "prefix-distinct-width": (n) => families["prefix-distinct-width"](n),
      "empty-list-depth": (n) => families["empty-list-depth"](n),
      "empty-list-read-width": (n) => families["empty-list-read-width"](n),
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
