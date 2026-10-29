// #1278; Astra review.
export const sizes = [4, 8];
export const shapes = (() => {
  const many = (n, f, by = "\n") => Array.from({ length: n }, (_, i) => f(i)).join(by);
  const SHAPES = {
    // #1278: k options, each its own object holding its own property
    own: (k) =>
      [
        many(k, (i) => `let p${i} = {f${i}: 1}`),
        `let options = [${many(k, (i) => `{text: "${i}", value: p${i}}`, ", ")}]`,
        "let picked = askChoice options",
        many(k, (i) => `repeat picked.f${i} {}`),
        "exit",
      ].join("\n"),
    // #1291: k options alternating between two shared objects whose properties differ in type
    twoShared: (k, other = "2.5") =>
      [
        `let payload = {${many(k, (i) => `f${i}: 1`, ", ")}}`,
        `let second = {${many(k, (i) => `f${i}: ${i % 2 ? "1" : other}`, ", ")}}`,
        `let options = [${many(k, (i) => `{text: "${i}", value: ${i % 2 ? "second" : "payload"}}`, ", ")}]`,
        "let picked = askChoice options",
        many(k, (i) => `repeat picked.f${i} {}`),
        "exit",
      ].join("\n"),
    twoSharedText: (k) => SHAPES.twoShared(k, '"bad"'),
    // #1278's members
    ownInline: (k) =>
      [
        `let options = [${many(k, (i) => `{text: "${i}", value: {f${i}: 1}}`, ", ")}]`,
        "let picked = askChoice options",
        many(k, (i) => `repeat picked.f${i} {}`),
        "exit",
      ].join("\n"),
    ownBound: (k) => `let n = 1\n${SHAPES.own(k).replace(/= \{f(\d+): 1\}/g, "= {f$1: n}")}`,
    ownBoundTested: (k) =>
      ["let z = {a: 1}", "if z.a != null {", "say 1", "}", SHAPES.ownBound(k)].join("\n"),
    ownBoundShared: (k) =>
      `${SHAPES.ownBound(k)}\n`.replace(
        "let options",
        `let other = {${many(k, (i) => `f${i}: n`, ", ")}}\nlet options`,
      ),
    ownGlobal: (k) => SHAPES.own(k).replace(/^let p(\d+) =/gm, "global p$1 ="),
    ownTestElsewhere: (k) =>
      ["let z = {a: 1}", "if z.a != null {", "say 1", "}", SHAPES.own(k)].join("\n"),
    guardNoChoice: (k) =>
      [
        many(k, (i) => `let p${i} = {f${i}: 1}`),
        "if p1.f0 != null {",
        many(k, (i) => `repeat p${i}.f${i} {}`),
        "}",
        "exit",
      ].join("\n"),
    ownFlag: (k) =>
      SHAPES.own(k)
        .replace("let picked", 'let flag = askBoolean "flag"\nif flag {\nlet picked')
        .replace("\nexit", "\n}\nexit"),
    ownStore: (k) => SHAPES.own(k).replace("let options", "p0.f1 = 2.5\nlet options"),
    ownStores: (k) =>
      SHAPES.own(k).replace("let options", `${many(k, (i) => `p${i}.g${i} = 2.5`)}\nlet options`),
    ownWhole: (k) => SHAPES.own(k).replace("let options", 'p1 = {f1: "x"}\nlet options'),
    ownGuard: (k) =>
      SHAPES.own(k)
        .replace("let picked", "if p1.f0 != null {\nlet picked")
        .replace("\nexit", "\n}\nexit"),
    ownGuards: (k) =>
      SHAPES.own(k)
        .replace("let picked", `${many(k, (i) => `if p${i} != null {`)}\nlet picked`)
        .replace("\nexit", `\n${many(k, () => "}")}\nexit`),
    ownText: (k) => SHAPES.own(k).replace(/\{text: "(\d+)", value: (p\d+)\}/g, "{text: $2}"),
    ownSay: (k) => SHAPES.own(k).replace(/repeat (picked\.f\d+) \{\}/g, "say $1"),
    ownDeep: (k) =>
      SHAPES.own(k)
        .replace(/let p(\d+) = \{f(\d+): 1\}/g, "let p$1 = {f$2: {g: 1}}")
        .replace(/repeat picked\.f(\d+) \{\}/g, "repeat picked.f$1.g {}"),
    ownCommon: (k) =>
      SHAPES.own(k).replace(/let p(\d+) = \{f(\d+): 1\}/g, "let p$1 = {f$2: 1, shared: 1}"),
    ownInlineChoice: (k) =>
      [
        many(k, (i) => `let p${i} = {f${i}: 1}`),
        `let picked = askChoice [${many(k, (i) => `{text: "${i}", value: p${i}}`, ", ")}]`,
        many(k, (i) => `repeat picked.f${i} {}`),
        "exit",
      ].join("\n"),
    // #1291's members and controls
    twoSharedInline: (k) =>
      SHAPES.twoShared(k)
        .replace("let options = ", "let picked = askChoice ")
        .replace("\nlet picked = askChoice options", ""),
    twoSharedAliases: (k) =>
      [
        `let payload = {${many(k, (i) => `f${i}: 1`, ", ")}}`,
        `let second = {${many(k, (i) => `f${i}: ${i % 2 ? "1" : "2.5"}`, ", ")}}`,
        many(k, (i) => `let a${i} = ${i % 2 ? "second" : "payload"}`),
        `let options = [${many(k, (i) => `{text: "${i}", value: a${i}}`, ", ")}]`,
        "let picked = askChoice options",
        many(k, (i) => `repeat picked.f${i} {}`),
        "exit",
      ].join("\n"),
    inlineBoundTested: (k) =>
      [
        "let n = 1",
        "let z = {a: 1}",
        "if z.a > 0 { say z }",
        `let options = [${many(k, (i) => `{text: "${i}", value: {f${i}: n}}`, ", ")}]`,
        "let picked = askChoice options",
        many(k, (i) => `repeat picked.f${i} {}`),
        "exit",
      ].join("\n"),
    inlineBound: (k) =>
      SHAPES.inlineBoundTested(k).replace("let z = {a: 1}\nif z.a > 0 { say z }\n", ""),
    aliasesNoChoice: (k) =>
      [
        `let payload = {${many(k, (i) => `f${i}: 1`, ", ")}}`,
        `let second = {${many(k, (i) => `f${i}: ${i % 2 ? "1" : "2.5"}`, ", ")}}`,
        many(k, (i) => `let a${i} = ${i % 2 ? "second" : "payload"}`),
        many(k, (i) => `repeat a${i}.f${i} {}`),
        "exit",
      ].join("\n"),
    twoSharedSame: (k) => SHAPES.twoShared(k, "2"),
    threeProps: (k) =>
      [
        "let payload = {f0: 1, f1: 1, f2: 1}",
        'let second = {f0: 2.5, f1: 1, f2: "x"}',
        `let options = [${many(k, (i) => `{text: "${i}", value: ${i % 2 ? "second" : "payload"}}`, ", ")}]`,
        "let picked = askChoice options",
        many(k, (i) => `repeat picked.f${i % 3} {}`),
        "exit",
      ].join("\n"),
    twoSharedGuard: (k) =>
      SHAPES.twoShared(k)
        .replace("let picked", "if second.f0 != null {\nlet picked")
        .replace("\nexit", "\n}\nexit"),
    twoSharedStore: (k) =>
      SHAPES.twoShared(k).replace("let options", 'second.f1 = "x"\nlet options'),
  };
  const result = {};
  const leaf = (v) =>
    typeof v === "string" ||
    (Array.isArray(v) &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
  for (const [name, make] of Object.entries(SHAPES)) {
    const sample = make(4);
    if (leaf(sample)) result[name] = make;
    else
      for (const [variant, source] of Object.entries(sample))
        if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
  }
  return result;
})();
export const checks = ["publication"];
