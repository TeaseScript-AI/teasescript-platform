// #1310; builder/review archive.
export const sizes = [4, 8];
export const shapes = (() => {
  const terms = (k, term) => Array.from({ length: k }, (_, i) => term(i)).join(" + ");
  const VARIANTS = {
    "left-fields-reads": (k) =>
      `let o = [{q: 1}]\nlet xs = o + ${terms(k, (i) => `[{p${i}: 1}] + o`)}\nsay xs.length\nexit\n`,
    "left-same-field-reads": (k) =>
      `let o = [{q: 1}]\nlet xs = o + ${terms(k, () => `[{q: 1}] + o`)}\nsay xs.length\nexit\n`,
    "left-fields-no-reads": (k) =>
      `let xs = [{q: 1}] + ${terms(k, (i) => `[{p${i}: 1}]`)}\nsay xs.length\nexit\n`,
    "left-numbers-reads": (k) =>
      `let o = [1]\nlet xs = o + ${terms(k, (i) => `[${i}] + o`)}\nsay xs.length\nexit\n`,
    "literal-fields-reads": (k) =>
      `let o = {q: 1}\nlet xs = [o, ${Array.from({ length: k }, (_, i) => `{p${i}: 1}, o`).join(", ")}]\nsay xs.length\nexit\n`,
  };
  const result = {};
  const leaf = (v) =>
    typeof v === "string" ||
    (Array.isArray(v) &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
  for (const [name, make] of Object.entries(VARIANTS)) {
    const sample = make(4);
    if (leaf(sample)) result[name] = make;
    else
      for (const [variant, source] of Object.entries(sample))
        if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
  }
  return result;
})();
export const checks = ["publication"];
