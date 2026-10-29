// #1310; builder/review archive.
export const sizes = [4, 8];
export const shapes = (() => {
  const terms = (k, term) => Array.from({ length: k }, (_, i) => term(i)).join(" + ");
  const FAMILIES = {
    // Codex r7's B3 on #1310: k joins each holding the next in its right operand, each element's property its own
    "right-fields": (k) =>
      `let xs = ${Array.from({ length: k }).reduce((e, _, i) => `[{p${i}: 1}] + (${e})`, "[{lastValue: 0}]")}\nsay xs.length\nexit\n`,
    // the same along the left operands, and with a read of a variable of objects before each, the head asked
    "left-fields": (k) =>
      `let xs = [{lastValue: 0}] + ${terms(k, (i) => `[{p${i}: 1}]`)}\nsay xs.length\nexit\n`,
    "right-fields-reads": (k) =>
      `let o = [{q: 1}]\nlet xs = ${Array.from({ length: k }).reduce((e, _, i) => `[{p${i}: 1}] + (o + (${e}))`, "[{lastValue: 0}]")}\nsay xs.length\nexit\n`,
    "left-fields-reads": (k) =>
      `let o = [{q: 1}]\nlet xs = o + ${terms(k, (i) => `[{p${i}: 1}] + o`)}\nsay xs.length\nexit\n`,
    // balanced: joins of joins, each of two
    "balanced-fields": (k) => {
      let parts = Array.from({ length: 2 * k }, (_, i) => `[{p${i}: 1}]`);
      while (parts.length > 1) {
        const next = [];
        for (let i = 0; i < parts.length; i += 2)
          next.push(i + 1 < parts.length ? `(${parts[i]} + ${parts[i + 1]})` : parts[i]);
        parts = next;
      }
      return `let xs = ${parts[0]}\nsay xs.length\nexit\n`;
    },
    // declared unions, alike and overlapping, joined in a run with a truth value at its end
    "overlap-run": (k) =>
      `let a: (integer | string)[] = [1]\nlet b: (integer | boolean)[] = [1]\nlet s = (a + b) + ${terms(k, (i) => `[${i}]`)} + [true]\nsay s.length\nexit\n`,
    "overlap-right": (k) =>
      `let a: (integer | string)[] = [1]\nlet s = ${Array.from({ length: k }).reduce((e, _, i) => `[${i}] + (a + (${e}))`, "[true]")}\nsay s.length\nexit\n`,
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
