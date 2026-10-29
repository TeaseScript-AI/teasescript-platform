// #1241; Astra review.
export const sizes = [4, 8];
export const shapes = (() => {
  const lines = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join("\n");
  const families = {
    independent: (k) => 'let txt = "hello"\n' + lines(k, (i) => `let v${i}: integer = txt.size`),
    errorChain: (k) =>
      'let txt = "hello"\nlet combined: integer = ' + Array(k).fill("txt.size").join(" + "),
    joined: (k) => "let xs = [1]\n" + lines(k, () => "say xs + 2"),
    joins: (k) => 'let xs = ["one"]\n' + lines(k, () => "say xs.join"),
    nulls: (k) => 'let xs = ["a", null]\nsay ' + Array(k).fill("1 / xs[1].length").join(" + "),
    copies: (k) =>
      'let txt = "hello"\nlet v0 = txt.size\n' +
      lines(k, (i) => `let v${i + 1} = v${i}`) +
      `\nsay v${k}.trim()`,
    untyped: (k) =>
      'function take(p) { say p.trim() }\nlet txt = "hello"\n' + lines(k, () => "take(txt.size)"),
    iterations: (k) =>
      "let xs = [1]\n" + lines(k, (i) => `for item${i} in xs + 2 { say item${i} }`),
    widePresent: (k) => `let converted: duration = [${Array(k).fill("1").join(",")}].length`,
    wideAbsent: (k) =>
      `let ns=[2]\nlet converted: duration = [${Array(k).fill("ns[7]").join(",")}].length`,
    deepPresent: (k) => `let n=2\nlet converted: duration = ${"(".repeat(k)}n${")".repeat(k)}`,
    interpolation: (k) =>
      `let ns=[2]\nlet converted: duration = "${Array(k).fill("${ns[7]}").join("")}".length`,
    asks: (k) =>
      "let d=dict{ok:2}\n" +
      lines(k, (i) => `let v${i}: duration = askInteger("${"${"}d["gone"]}")`),
    buttons: (k) =>
      "let ns=[2]\n" +
      lines(k, (i) => `let v${i}: duration = [(showButton "${"${"}ns[7]}")].length`),
    nestedProperties: (k) =>
      "let box={n:2}\n" +
      lines(k, (i) => `let v${i}: duration = ({inner: {value: box.n}}).inner.value`),
  };
  const result = {};
  const leaf = (v) =>
    typeof v === "string" ||
    (Array.isArray(v) &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
  for (const [name, make] of Object.entries(families)) {
    const sample = make(4);
    if (leaf(sample)) result[name] = make;
    else
      for (const [variant, source] of Object.entries(sample))
        if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
  }
  return result;
})();
export const checks = ["publication"];
