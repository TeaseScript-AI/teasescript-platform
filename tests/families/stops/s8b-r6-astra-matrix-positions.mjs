// #1165 / S8; Astra review.
export const sizes = [4, 8];
export const shapes = (() => {
  const positions = {
    "store-inferred": (x) => `let v = ${x}\nsay v`,
    "store-written": (x) => `let v: (integer | string)[] = [1]\nv = ${x}\nsay v`,
    direct: (x) => `say ${x}`,
    "argument-single": (x) => `function f(p) { say p }\nf(${x})`,
    "argument-multi": (x) => `function f(p) { say p }\nf(${x})\nf(${x})`,
    return: (x) => `function make { return ${x} }\nsay make()`,
    condition: (x) => `if ${x} != null { say "set" }`,
    "selection-first": (x) => `say ${x}.first`,
    "selection-get": (x) => `say ${x}.get(0, default: 3)`,
  };
  const result = {};
  const leaf = (v) =>
    typeof v === "string" ||
    (Array.isArray(v) &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
  for (const [name, make] of Object.entries(positions)) {
    const sample = make(4);
    if (leaf(sample)) result[name] = make;
    else
      for (const [variant, source] of Object.entries(sample))
        if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
  }
  return result;
})();
export const checks = ["publication", "stops"];
