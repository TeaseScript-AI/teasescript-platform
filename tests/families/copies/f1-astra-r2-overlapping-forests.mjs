// forest-disjoint-deep, forest-overlap-prefix and related fixed cases; Astra review, r2
// (R/astra-m4-f1-review-r2-evidence/overlap-cases.mjs).
export const cases = (() => {
  const { workShapes: workShapes } = (() => {
    const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
    const fields = (n, v, p = "f") =>
      rows(n, (i) => `${p}${i}:${typeof v === "function" ? v(i) : v}`).join(",");
    const workShapes = {
      "forest-disjoint-deep": (n) =>
        [
          "let t:integer=1",
          `let root={${fields(n, () => "{inner:{value:t}}", "f")},${fields(n, () => "{inner:{value:1}}", "g")}}`,
          "let a=root",
          "let b=a",
          ...rows(n, (i) => `b.g${i}.inner.value=2`),
          ...rows(n, (i) => `let r${i}=b.f${i}.inner.value`),
          "exit",
        ].join("\n"),
      "forest-overlap-prefix": (n) =>
        [
          "let t:integer=1",
          `let root={${fields(n, () => "{left:t,right:1}")}}`,
          "let a=root",
          "let b=a",
          ...rows(n, (i) => `b.f${i}.right=2`),
          ...rows(n, (i) => `let r${i}=b.f${i}.left`),
          "exit",
        ].join("\n"),
      "forest-overlap-ancestor": (n) =>
        [
          "let t:integer=1",
          `let root={${fields(n, () => "{left:t,right:1}")}}`,
          "let a=root",
          "let b=a",
          ...rows(n, (i) => `b.f${i}.right=2`),
          ...rows(n, (i) => `let r${i}=b.f${i}`),
          "exit",
        ].join("\n"),
      "forest-alternating-levels": (n) =>
        [
          "let t:integer=1",
          `let root={${fields(n, () => "{left:t,right:1}")}}`,
          "let a=root",
          ...rows(n, (i) => `a.f${i}.right=2`),
          "let b=a",
          ...rows(n, (i) => `b.f${i}.left=3`),
          ...rows(n, (i) => `let r${i}=b.f${i}.left`),
          "exit",
        ].join("\n"),
      "shared-literals-projected": (n) =>
        [
          "let t:integer=1",
          `let root={box:{${fields(n, "t")}}}`,
          `let other={box:{${fields(n, "1", "g")}}}`,
          ...rows(n, (i) => `let a${i}=[root.box,other.box]`),
          "exit",
        ].join("\n"),
      "shared-locals-under-wrap": (n) =>
        [
          "let t:integer=1",
          "let root={p:t}",
          "let c0=root",
          ...rows(n, (i) => `let c${i + 1}=c${i}\nc${i + 1}.g${i}=1`),
          ...rows(n, (i) => `let a${i}=[{v:c${n}},{v:{p:2}}]`),
          "exit",
        ].join("\n"),
    };
    return { workShapes };
  })();
  const cases = Object.entries(workShapes).map(([name, f]) => ({
    name,
    files: [{ path: "main.tease", source: f(8) + "\n" }],
  }));
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.files]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["node overlap-cases.mjs", "R/astra-m4-f1-review-r2-evidence/overlap-cases.json:1"]],
  sources: 6,
  sha256: "dd87924998c77655ccbee01b8a80738d6c93eab7ae4d79943a687d597e3fdc90",
};
