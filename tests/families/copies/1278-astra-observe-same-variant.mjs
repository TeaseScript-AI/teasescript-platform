// #1278; Astra review: size-dependent variant-variants source families.
export const sizes = [64, 128];
const corpus = (() => {
  const { growth: growth } = (() => {
    const many = (k, f, by = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(by);
    const record = (name, source) => ({
      name,
      files: [{ path: "main.tease", source: source + "\nexit" }],
    });
    function growth(k, shape) {
      const lines = ["let n = 1"];
      let value = (i) => `p${i}`,
        read = (i) => `picked.f${i}`;
      if (shape === "sparse-overlap-deep") {
        lines.push(many(k, (i) => `let p${i} = {f${i}: {leaf: n}, f${(i + 1) % k}: {leaf: 2.5}}`));
        read = (i) => `picked.f${i}.leaf`;
      } else if (shape === "sparse-late-stores") {
        lines.push(
          many(k, (i) => `let p${i} = {anchor: n}`),
          many(k, (i) => `p${i}.f${i} = n`),
        );
      } else if (shape === "sparse-open-gaps") {
        lines.push(
          "let ingressA = hostValue",
          "let ingressB = hostValue",
          many(k, (i) => `let p${i} = {f${i}: n}`),
        );
      } else if (shape === "sparse-text-value") {
        lines.push(many(k, (i) => `let p${i} = {f${i}: n}`));
      } else {
        lines.push(
          `let a = {${many(k, (i) => `f${i}: {leaf: 1}`, ", ")}}`,
          `let b = {${many(k, (i) => `f${i}: {leaf: ${i % 3 ? "1" : "2.5"}}`, ", ")}}`,
        );
        value = (i) => (i % 2 ? "a" : "b");
        read = (i) => `picked.f${i}.leaf`;
        if (shape === "shared-own-wrappers") {
          value = (i) => `{box: ${i % 2 ? "a" : "b"}, own: {tag: ${i}}}`;
          read = (i) => `picked.box.f${i}.leaf`;
        }
      }
      const options = Array.from({ length: k }, (_, i) =>
        shape === "sparse-text-value" && i % 2
          ? `{text: ${value(i)}}`
          : `{text: "${i}", value: ${value(i)}}`,
      );
      if (shape === "sparse-open-gaps") {
        options.splice(Math.floor(k / 3), 0, '{text:"A",value:ingressA}');
        options.splice(Math.floor((2 * k) / 3), 0, '{text:"B",value:ingressB}');
      }
      lines.push(
        `let options = [${options.join(", ")}]`,
        "let picked = askChoice options",
        many(k, (i) => `repeat ${read(i)} {}`),
      );
      return record(shape + "@" + k, lines.join("\n"));
    }
    return { growth };
  })();
  function variant(k, name) {
    if (name === "guarded-overlap") {
      const c = growth(k, "sparse-overlap-deep");
      c.files[0].source = "let z = {a: 1}\nif z.a != null {}\n" + c.files[0].source;
      return c;
    }
    const stores = Array.from(
      { length: k },
      (_, i) => (i === 0 ? "let p = " : "p = ") + `{f: 1}`,
    ).join("\n");
    return {
      files: [
        {
          path: "main.tease",
          source:
            stores +
            '\nlet options = [{text:"a",value:p},{text:"b",value:p}]\nlet picked = askChoice options\nrepeat picked.f {}\nexit',
        },
      ],
    };
  }
  return { shapes: { "guarded-overlap": (n) => variant(n, "guarded-overlap").files } };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
