// #1278; Astra review: size-dependent growth-variants source families.
export const sizes = [7, 14];
const corpus = (() => {
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
  return {
    shapes: {
      "sparse-overlap-deep": (n) => growth(n, "sparse-overlap-deep").files,
      "sparse-late-stores": (n) => growth(n, "sparse-late-stores").files,
      "sparse-open-gaps": (n) => growth(n, "sparse-open-gaps").files,
      "sparse-text-value": (n) => growth(n, "sparse-text-value").files,
      "shared-own-wrappers": (n) => growth(n, "shared-own-wrappers").files,
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
