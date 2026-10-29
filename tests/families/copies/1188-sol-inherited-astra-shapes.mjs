// #1188, Sol r1 (R/sol-m4-i1188-held-nodes-r1-evidence/astra-shapes.mjs): the shapes inherited from Astra's review, at its
// runs' 64, 128 and 256.
const shapes = (() => {
  const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const fields = (n, value = "t", prefix = "f") =>
    rows(n, (i) => `${prefix}${i}:${value}`).join(",");
  const source = (...s) => s.flat(Infinity).join("\n") + "\nexit\n";
  const T = "let t:integer=1";
  const shapes = {
    "nested-diamonds": (n) =>
      source(
        T,
        `let root={${fields(n)}}`,
        `let peer={${fields(n, "t", "g")}}`,
        rows(n, (i) => [
          `let x${i}={left:{cell:root},right:{cell:root}}`,
          `let y${i}=x${i}`,
          `y${i}.left.cell={h${i}:t}`,
          `let z${i}=[y${i}.left.cell,peer]`,
          `let w${i}=[y${i}.right.cell,peer]`,
        ]),
      ),
    "rejected-projections": (n) =>
      source(
        T,
        `let root={${fields(n)}}`,
        `let peer={${fields(n, "1")}}`,
        rows(n, (i) => [
          `let x${i}=root`,
          `x${i}.f0="bad"`,
          `let box${i}={cell:x${i}}`,
          `let copy${i}=box${i}.cell`,
          `let again${i}=copy${i}`,
          `let pair${i}=[again${i},peer]`,
        ]),
      ),
    "guarded-mixed-fan": (n) =>
      source(
        T,
        `let root={${fields(n)}}`,
        `let peer={${fields(n, "1")}}`,
        rows(n, (i) => [
          `let x${i}=root`,
          `if hostValue { x${i}={extra${i}:t} }`,
          `let y${i}={slot:x${i},direct:{own${i}:t}}`,
          `let z${i}=y${i}.slot`,
        ]),
        `let bag=[peer,${rows(n, (i) => `z${i}`).join(",")}]`,
      ),
    "fed-cycle-fan": (n) =>
      source(
        T,
        `let root={${fields(n)}}`,
        `let peer={${fields(n, "t", "g")}}`,
        rows(n, (i) => [
          `let a${i}=root`,
          `let b${i}=a${i}`,
          `a${i}=b${i}`,
          `b${i}.extra${i}=t`,
          `let c${i}={nest:b${i}}`,
          `let pair${i}=[c${i}.nest,peer]`,
        ]),
      ),
    "opaque-bag": (n) =>
      source(
        "function make(x) { return hostValue }",
        rows(n, (i) => `let u${i}=make(${i})`),
        `let bag=[${rows(n, (i) => `u${i}`).join(",")}]`,
      ),
    "opaque-projected-bag": (n) =>
      source(
        T,
        "function make(x) { return hostValue }",
        rows(n, (i) => `let u${i}={cell:make(${i})}`),
        `let bag=[${rows(n, (i) => `u${i}.cell`).join(",")},{x:t}]`,
      ),
    "sparse-pairs": (n) =>
      source(
        T,
        rows(n, (i) => `let r${i}={${fields(n, "t", `p${i}k`)}}`),
        rows(n, (i) => rows(n, (j) => (i < j ? `let pair${i}x${j}=[r${i},r${j}]` : []))),
      ),
    "equal-pairs": (n) =>
      source(
        T,
        rows(n, (i) => `let r${i}={${fields(n)}}`),
        rows(n, (i) => rows(n, (j) => (i < j ? `let pair${i}x${j}=[r${i},r${j}]` : []))),
      ),
  };
  shapes["opaque-distinct-functions"] = (n) =>
    source(
      T,
      rows(n, (i) => [`function make${i}(x) { return hostValue }`, `let u${i}=make${i}(0)`]),
      `let bag=[${rows(n, (i) => `u${i}`).join(",")},{x:t}]`,
    );
  shapes["opaque-cyclic-elements"] = (n) =>
    source(
      T,
      rows(n, (i) => [`let u${i}=hostValue`, `u${i}=u${i}`]),
      `let bag=[${rows(n, (i) => `u${i}`).join(",")},{x:t}]`,
    );
  shapes["fed-cycle-plain"] = (n) =>
    source(
      T,
      `let root={${fields(n)}}`,
      `let peer={${fields(n, "t", "g")}}`,
      rows(n, (i) => [
        `let a${i}=root`,
        `let b${i}=a${i}`,
        `a${i}=b${i}`,
        `let c${i}={nest:b${i}}`,
        `let pair${i}=[c${i}.nest,peer]`,
      ]),
    );
  shapes["acyclic-plain"] = (n) =>
    source(
      T,
      `let root={${fields(n)}}`,
      `let peer={${fields(n, "t", "g")}}`,
      rows(n, (i) => [
        `let a${i}=root`,
        `let b${i}=a${i}`,
        `let c${i}={nest:b${i}}`,
        `let pair${i}=[c${i}.nest,peer]`,
      ]),
    );
  shapes["fed-cycle-store"] = (n) =>
    source(
      T,
      `let root={${fields(n)}}`,
      `let peer={${fields(n, "t", "g")}}`,
      rows(n, (i) => [
        `let a${i}=root`,
        `let b${i}=a${i}`,
        `a${i}=b${i}`,
        `b${i}.f0=t`,
        `let c${i}={nest:b${i}}`,
        `let pair${i}=[c${i}.nest,peer]`,
      ]),
    );
  shapes["acyclic-store"] = (n) =>
    source(
      T,
      `let root={${fields(n)}}`,
      `let peer={${fields(n, "t", "g")}}`,
      rows(n, (i) => [
        `let a${i}=root`,
        `let b${i}=a${i}`,
        `b${i}.f0=t`,
        `let c${i}={nest:b${i}}`,
        `let pair${i}=[c${i}.nest,peer]`,
      ]),
    );
  shapes["opaque-cycle-place"] = (n) =>
    source(
      T,
      rows(n, (i) => [`let u${i}=hostValue`, `u${i}=u${i}`]),
      "let bag={x:t}",
      rows(n, (i) => `bag=u${i}`),
    );
  shapes["opaque-written-cycle-place"] = (n) =>
    source(
      rows(n, (i) => [`let u${i}:object=hostValue`, `u${i}=u${i}`]),
      "let bag=u0",
      rows(n, (i) => (i === 0 ? [] : `bag=u${i}`)),
    );
  const result = {};
  const leaf = (v) =>
    typeof v === "string" ||
    (Array.isArray(v) &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
  for (const [name, make] of Object.entries(shapes)) {
    const sample = make(3);
    if (leaf(sample)) result[name] = make;
    else
      for (const [variant, source] of Object.entries(sample))
        if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
  }
  return result;
})();
// the shapes no recorded run compiled are left out
const unrun = new Set([
  "opaque-bag",
  "opaque-projected-bag",
  "sparse-pairs",
  "equal-pairs",
  "opaque-distinct-functions",
  "acyclic-plain",
]);
export const cases = Object.entries(shapes)
  .filter(([name]) => !unrun.has(name))
  .flatMap(([name, make]) => [64, 128, 256].map((n) => [`${name}@${n}`, make(n)]));
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node probe/series-extra.mjs <tree> <shapes> 64,128,256 <out> <mode>, the scale runs",
      "R/sol-m4-i1188-held-nodes-r1-evidence/scale-*.sh and their results' headers",
    ],
  ],
  sources: 30,
  sha256: "b63f47a3ce0605da389a97339207319eebd30eecf896f8d86a92ae2a1b4d3ed3",
};
