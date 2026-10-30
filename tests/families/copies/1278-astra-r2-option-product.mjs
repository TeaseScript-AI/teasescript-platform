// option form, event, reader and binding product; #1278, Astra review, r2
// (R/astra-m4-i1278-review-r2-evidence/builder-evidence/generators/fam1278.mjs).
export const sizes = [3, 6];
export const shapes = (() => {
  const many = (n, f, by = "\n") => Array.from({ length: n }, (_, i) => f(i)).join(by);
  const FORMS = {
    bound: (k) => ({ lets: many(k, (i) => `let p${i} = {f${i}: 1}`), value: (i) => `p${i}` }),
    global: (k) => ({ lets: many(k, (i) => `global p${i} = {f${i}: 1}`), value: (i) => `p${i}` }),
    inline: (k) => ({ lets: many(k, (i) => `let p${i} = {f${i}: 1}`), value: (i) => `{f${i}: 1}` }),
    alias: (k) => ({
      lets: many(k, (i) => `let q${i} = {f${i}: 1}\nlet p${i} = q${i}`),
      value: (i) => `p${i}`,
    }),
    shared: (k) => ({
      lets: [
        `let p0 = {${many(k, (i) => `f${i}: 1`, ", ")}}`,
        `let p1 = {${many(k, (i) => `f${i}: ${i % 2 ? "1" : "2.5"}`, ", ")}}`,
      ].join("\n"),
      value: (i) => `p${i % 2}`,
    }),
    sharedText: (k) => ({
      lets: [
        `let p0 = {${many(k, (i) => `f${i}: 1`, ", ")}}`,
        `let p1 = {${many(k, (i) => `f${i}: ${i % 2 ? "1" : '"bad"'}`, ", ")}}`,
      ].join("\n"),
      value: (i) => `p${i % 2}`,
    }),
    sharedSame: (k) => ({
      lets: [
        `let p0 = {${many(k, (i) => `f${i}: 1`, ", ")}}`,
        `let p1 = {${many(k, (i) => `f${i}: 2`, ", ")}}`,
      ].join("\n"),
      value: (i) => `p${i % 2}`,
    }),
    overlap: (k) => ({
      lets: many(k, (i) => `let p${i} = {f${i}: 1, f${(i + 1) % k}: "x"}`),
      value: (i) => `p${i}`,
    }),
    deep: (k) => ({
      lets: many(k, (i) => `let p${i} = {f${i}: {g: ${i}}}`),
      value: (i) => `p${i}`,
    }),
    common: (k) => ({
      lets: many(k, (i) => `let p${i} = {f${i}: 1, shared: {h: ${i}}}`),
      value: (i) => `p${i}`,
    }),
    dup: (k) => ({
      lets: many(k, (i) => `let p${i} = {f${i}: 1}`),
      value: (i) => `p${i === k - 1 ? 0 : i}`,
    }),
    empty: (k) => ({
      lets: many(k, (i) => (i === 0 ? "let p0 = {}" : `let p${i} = {f${i}: 1}`)),
      value: (i) => `p${i}`,
    }),
    written: (k) => ({
      lets: many(k, (i) => (i === 0 ? "let p0: object = {f0: 1}" : `let p${i} = {f${i}: 1}`)),
      value: (i) => `p${i}`,
    }),
    quoted: (k) => ({
      lets: many(k, (i) => `let p${i} = {f${i}: 1, element: ${i}}`),
      value: (i) => `p${i}`,
    }),
  };
  const BETWEEN = {
    none: () => ({ before: "", open: "", close: "" }),
    storeBelow: () => ({ before: "p0.f1 = 2.5", open: "", close: "" }),
    storeDeep: () => ({ before: "p0.f1 = {g: 2.5}", open: "", close: "" }),
    storeWhole: () => ({ before: 'p1 = {f0: "x"}', open: "", close: "" }),
    storeAfter: () => ({ before: "", open: "", close: "p0.f2 = 2.5" }),
    guardAbsent: () => ({ before: "", open: "if p1.f0 != null {", close: "}" }),
    guardHeld: () => ({ before: "", open: "if p0.f0 != null {", close: "}" }),
    guardWhole: () => ({ before: "", open: "if p1 != null {", close: "}" }),
    guardCopy: () => ({ before: "let c = p1", open: "if c.f0 != null {", close: "}" }),
    typeTest: () => ({ before: "", open: "if p1.f0 is integer {", close: "}" }),
    ingress: () => ({ before: "p0 = hostValue", open: "", close: "" }),
    written: () => ({ before: "let w: object = {f0: 1}\np0 = w", open: "", close: "" }),
    loop: () => ({
      before: 'let flag = askBoolean "flag"\nwhile flag {',
      open: "",
      close: "p0.f1 = 2.5\n}",
    }),
    call: () => ({ before: "function touch { p0.f2 = 2.5 }\ntouch()", open: "", close: "" }),
  };
  const READS = {
    each: (k) => many(k, (i) => `repeat picked.f${i} {}`),
    say: (k) => many(k, (i) => `say picked.f${i}`),
    absent: (k) => [many(k, (i) => `repeat picked.f${i} {}`), "say picked.zz"].join("\n"),
    members: (k) =>
      [
        many(k, (i) => `repeat picked.f${i} {}`),
        "say picked.length",
        "say picked.year",
        "say picked.values",
        "say picked.first",
      ].join("\n"),
    deeper: (k) => many(k, (i) => `say picked.f${i}.g`),
    quotedRead: (k) =>
      [many(k, (i) => `repeat picked.f${i} {}`), "say picked.element", "say picked.shared.h"].join(
        "\n",
      ),
  };
  const OPTIONS = {
    bound: (k, value) =>
      `let options = [${many(k, (i) => `{text: "${i}", value: ${value(i)}}`, ", ")}]\nlet picked = askChoice options`,
    inline: (k, value) =>
      `let picked = askChoice [${many(k, (i) => `{text: "${i}", value: ${value(i)}}`, ", ")}]`,
    textOnly: (k, value) =>
      `let options = [${many(k, (i) => `{text: ${value(i)}}`, ", ")}]\nlet picked = askChoice options`,
    mixed: (k, value) =>
      `let options = [${many(k, (i) => `{text: "${i}", value: ${value(i)}}`, ", ")}, {text: "s", value: 5}, {text: "t"}]\nlet picked = askChoice options`,
  };
  function program(k, a) {
    const form = FORMS[a.form](k);
    const between = BETWEEN[a.between]();
    // a global's store from a function needs the global; `call` only with globals
    return [
      form.lets,
      between.before,
      OPTIONS[a.options](k, form.value),
      between.open,
      READS[a.reads](k),
      between.close,
      "exit",
    ]
      .filter((line) => line !== "")
      .join("\n");
  }
  const shapes = {};
  for (const form of Object.keys(FORMS))
    for (const between of Object.keys(BETWEEN))
      for (const reads of Object.keys(READS))
        for (const options of Object.keys(OPTIONS)) {
          if (between !== "none" && (reads !== "each" || options !== "bound")) continue;
          if (between === "call" && form !== "global") continue;
          shapes[form + "-" + between + "-" + reads + "-" + options] = (n) =>
            program(n, { form, between, reads, options });
        }
  return shapes;
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node bin/fam1278.mjs sem base3/dist $tree/dist out/$label/fam1278-$i.jsonl $i 2",
      "R/astra-m4-i1278-review-r2-evidence/builder-evidence/generators/queue-sem3.sh:10",
    ],
  ],
  sources: 1010,
  sha256: "b475daaaa46b55aedd9060b59e27cc46ec6695613c57cd9eb948b0f854a74883",
};
