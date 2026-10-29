// Astra review.
export const sizes = [8, 16];
export const shapes = (() => {
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
  const result = {};
  const leaf = (v) =>
    typeof v === "string" ||
    (Array.isArray(v) &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
  for (const [name, make] of Object.entries(workShapes)) {
    const sample = make(8);
    if (leaf(sample)) result[name] = make;
    else
      for (const [variant, source] of Object.entries(sample))
        if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
  }
  return result;
})();
export const checks = ["publication"];
