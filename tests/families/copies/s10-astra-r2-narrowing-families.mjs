// Astra review.
export const sizes = [4, 8];
export const shapes = (() => {
  const rows = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join("\n");
  const fields = (k, v) => "{" + Array.from({ length: k }, (_, i) => `p${i}: ${v}`).join(",") + "}";
  const families = {
    W27: (k) =>
      `let n = 2\nif gateA { n = null }\n${rows(k, () => "if n is not null { say n + 2 }")}`,
    W27leave: (k) =>
      `let n = 2\n${rows(k, () => "if gateA { n = null\nif gateA { exit } else { exit } }")}\n${rows(k, () => "say n + 2")}`,
    W28: (k) =>
      `let xs = [null,${Array(k).fill(3).join(",")}]\n${rows(k, (i) => `if xs[${i + 1}] is null { exit }`)}\n${rows(k, () => "say xs[1] + 2")}`,
    W29: (k) =>
      `let xs = [null,${Array(k).fill(3).join(",")}]\n${rows(k, (i) => `let ix${i} = ${i + 1}\nif xs[ix${i}] is null { exit }`)}\nwhile gateA { ${rows(k, (i) => `say xs[ix${i}] + 2\nxs[${i + 1}] = 4`)} }`,
    W29scalar: (k) =>
      `${rows(k, (i) => `let n${i} = 2\nif gateA { n${i} = null }\nif n${i} is null { exit }`)}\nwhile gateA { ${rows(k, (i) => `n${i} = n${i} * 2\nsay n${i}`)} }`,
    W30: (k) =>
      `let rec = ${fields(k, 2)}\nif gateA { rec = ${fields(k, "null")} }\nif ${Array.from({ length: k }, (_, i) => `rec.p${i} is integer`).join(" and ")} and [${Array.from({ length: k }, (_, i) => `rec.p${i}+2`).join(",")}].length > 0 { say 2 }`,
    W30or: (k) =>
      `let rec = ${fields(k, 2)}\nif gateA { rec = ${fields(k, "null")} }\nif ${Array.from({ length: k }, (_, i) => `rec.p${i} is not integer`).join(" or ")} or [${Array.from({ length: k }, (_, i) => `rec.p${i}+2`).join(",")}].length > 0 { say 2 }`,
    W31: (k) =>
      `let xs = [null,${Array(k).fill(3).join(",")}]\n${rows(k, (i) => `if xs[${i + 1}] == null { exit }`)}\n${rows(k, () => "if gateA { xs.reverse() }")}\n${rows(k, (i) => `say xs[${i + 1}] + 2`)}`,
    W32: (k) =>
      `let box = ${fields(k, 2)}\n${rows(k, (i) => `if hostValue == ${i} { box = ${fields(k, "null")} }`)}\n${rows(k, (i) => `say box.p${i} + 2`)}`,
    W33: (k) =>
      `${rows(k, (i) => `let n${i} = 2`)}\nfunction restore { ${rows(k, (i) => `n${i} = 7`)}\nreturn true }\nif gateA { ${rows(k, (i) => `n${i} = null`)} }\n${rows(k, () => "if gateA { restore() } else { exit }")}\n${rows(k, (i) => `say n${i} + 2`)}`,
    W34: (k) =>
      `let box0 = ${fields(k, 2)}\nif gateA { box0 = ${fields(k, "null")} }\n${rows(k, (i) => `let box${i + 1} = box${i}`)}\n${rows(k, (i) => `say box${k}.p${i} + 2`)}`,
    W34tested: (k) =>
      `let box0 = ${fields(k, 2)}\nif gateA { box0 = ${fields(k, "null")} }\n${rows(k, (i) => `if box${i}.p${i} is integer { say 2 }\nlet box${i + 1} = box${i}`)}\n${rows(k, (i) => `say box${k}.p${i} + 2`)}`,
    W34scalar: (k) =>
      `let n0 = 2\nif gateA { n0 = null }\n${rows(k, (i) => `let n${i + 1} = n${i}`)}\n${rows(k, (i) => `say n${i + 1} + 2`)}`,
    indexstores: (k) =>
      `let xs = [null,${Array(k).fill(3).join(",")}]\n${rows(k, (i) => `let ix${i} = ${i + 1}\nif xs[ix${i}] == null { exit }`)}\nrepeat 3 { ${rows(k, (i) => `xs[ix${i}] = 8\nsay xs[ix${i}] + 2`)} }`,
    callables: (k) =>
      `let n = 2\nif gateA { n = null }\n${rows(k, (i) => `function reader${i} { if n == null { return }\n${rows(k, () => "say n + 2")} }`)}\n${rows(k, (i) => `reader${i}()`)}`,
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
export const checks = ["publication", "stops"];
