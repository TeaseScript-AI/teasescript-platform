// 3a model builder.
export const sizes = [4, 8];
export const shapes = (() => {
  const FAMILIES = {
    "independent-blocks": (k) =>
      Array.from(
        { length: k },
        (_, i) => `let x${i} = []\nx${i}.add(0)\nlet y${i} = [1]\ny${i} = y${i} + [2]`,
      ).join("\n"),
    "literal-appended": (k) =>
      `let xs = [1]\n` + Array.from({ length: k }, () => `xs = xs + [2]`).join("\n"),
    "get-default-appended": (k) =>
      `let xs = [[1]]\n` +
      Array.from({ length: k }, () => `xs = xs + [xs.get(0, default: [3])]`).join("\n"),
    "add-sites": (k) =>
      `let xs = []\n` + Array.from({ length: k }, (_, i) => `xs.add(${i})`).join("\n"),
    "copy-chain": (k) =>
      `let x0 = [1]\n` + Array.from({ length: k }, (_, i) => `let x${i + 1} = x${i}`).join("\n"),
    "fan-in": (k) => `let x = null\n` + Array.from({ length: k }, (_, i) => `x = ${i}`).join("\n"),
    "null-fan-in": (k) =>
      `let x = null\n` + Array.from({ length: k }, () => `x = null`).join("\n") + `\nx = 1`,
    "copy-cycle": (k) =>
      Array.from({ length: k }, (_, i) => `let a${i} = null`).join("\n") +
      "\n" +
      Array.from({ length: k }, (_, i) => `a${i} = a${(i + 1) % k}`).join("\n") +
      `\na0 = 1`,
    "json-feedback": (k) =>
      Array.from(
        { length: k },
        (_, i) =>
          `let d${i} = {next: fromJson("{}")}\nlet p${i} = fromJson("{}", default: d${i})\nd${i}.next = p${i}`,
      ).join("\n"),
    "json-mutual": (k) =>
      Array.from({ length: k }, (_, i) => `let d${i} = {next: fromJson("{}")}`).join("\n") +
      "\n" +
      Array.from(
        { length: k },
        (_, i) => `let p${i} = fromJson("{}", default: d${(i + 1) % k})\nd${i}.next = p${i}`,
      ).join("\n"),
    "objects-distinct-names": (k) =>
      `let rooms = [${Array.from({ length: k }, (_, i) => `{name: "r${i}", f${i}: ${i}}`).join(", ")}]\nlet n = rooms.first.name`,
    "objects-same-names": (k) =>
      `let rooms = [${Array.from({ length: k }, (_, i) => `{name: "r${i}", size: ${i}}`).join(", ")}]\nlet n = rooms.first.size`,
    "written-union-chain": (k) =>
      Array.from({ length: k }, (_, i) => `let l${i}: (integer | string)[] = [${i}]`).join("\n") +
      `\nlet all = ` +
      Array.from({ length: k }, (_, i) => `l${i}`).join(" + "),
    "independent-mistakes": (k) =>
      Array.from({ length: k }, (_, i) => `let x${i} = 1\nx${i} = "s"`).join("\n"),
    "dependent-mistakes": (k) =>
      `let x0 = 1\nx0 = "s"\n` +
      Array.from({ length: k }, (_, i) => `let x${i + 1} = x${i}\nx${i + 1} = "s"`).join("\n"),
    "cycle-mistakes": (k) =>
      Array.from({ length: k }, (_, i) => `let a${i} = 1`).join("\n") +
      "\n" +
      Array.from({ length: k }, (_, i) => `a${i} = a${(i + 1) % k}\na${i} = "bad"`).join("\n"),
    "deferred-functions": (k) =>
      Array.from(
        { length: k },
        (_, i) =>
          `function keep${i}(x) {\n  let saved = x\n  return saved\n}\nlet l${i} = keep${i}({value: 1})\nlet r${i} = keep${i}({value: "s"})`,
      ).join("\n"),
    "self-rebuild-chain": (k) =>
      `let s = ""\n` + Array.from({ length: k }, () => `s = s + "x"`).join("\n"),
    // width: one wide value read or written field by field
    "wide-object-reads": (k) =>
      `let box = {${Array.from({ length: k }, (_, i) => `p${i}: ${i}`).join(", ")}}\n` +
      Array.from({ length: k }, (_, i) => `let v${i} = box.p${i}`).join("\n"),
    "wide-object-updates": (k) =>
      `let box = {${Array.from({ length: k }, (_, i) => `p${i}: null`).join(", ")}}\n` +
      Array.from({ length: k }, (_, i) => `box.p${i} = ${i}`).join("\n"),
    "wide-object-updates-reads": (k) =>
      `let box = {${Array.from({ length: k }, (_, i) => `p${i}: null`).join(", ")}}\n` +
      Array.from({ length: k }, (_, i) => `box.p${i} = ${i}\nlet v${i} = box.p${i}`).join("\n"),
    "wide-nested-updates": (k) =>
      `let state = {rooms: {${Array.from({ length: k }, (_, i) => `r${i}: {locked: false}`).join(", ")}}}\n` +
      Array.from({ length: k }, (_, i) => `state.rooms.r${i}.locked = true`).join("\n"),
    "wide-list-reads": (k) =>
      `let xs = [${Array.from({ length: k }, (_, i) => `${i}`).join(", ")}]\n` +
      Array.from({ length: k }, (_, i) => `let v${i} = xs[${i}]`).join("\n"),
    "shapes-and-reads": (k) =>
      `let rows = [${Array.from({ length: k }, (_, i) => `{name: "r${i}", f${i}: ${i}}`).join(", ")}]\n` +
      Array.from({ length: k }, (_, i) => `let n${i} = rows.first.f${i}`).join("\n"),
    "wide-missing-stores": (k) =>
      `let box = {p0: 0}\n` + Array.from({ length: k }, (_, i) => `box.q${i} = ${i}`).join("\n"),
    "defaulted-calls": (k) =>
      `function count(n = 1) {\n  return n\n}\n` +
      Array.from({ length: k }, (_, i) => `let c${i} = count(${i % 2 === 0 ? i : "1.5"})`).join(
        "\n",
      ),
    "typed-literal-elements": (k) =>
      `let xs: (integer | string)[] = [${Array.from({ length: k }, (_, i) => (i % 2 === 0 ? `${i}` : `"s${i}"`)).join(", ")}]`,
    "nested-joins": (k) =>
      `let xs = [[0]]\n` +
      Array.from({ length: k }, (_, i) => `xs = xs + [[${i % 3 === 0 ? `"s"` : i}]]`).join("\n"),
    "json-open-defaults": (k) =>
      Array.from(
        { length: k },
        (_, i) =>
          `let j${i} = fromJson("[]", default: [])\nlet g${i} = [j${i}].get(0, default: [${i}])`,
      ).join("\n"),
    "cyclic-defaults": (k) =>
      `let a = 1\nlet b = 1\n` +
      Array.from({ length: k }, (_, i) => `b = [a].get(0, default: b)\nb = b / 2`).join("\n"),
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
