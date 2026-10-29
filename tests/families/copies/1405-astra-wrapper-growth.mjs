// Astra review: size-dependent growth-variants source families.
export const sizes = [40, 80];
const corpus = (() => {
  function growth(name, n) {
    const lines = [];
    const q = Array(n).fill("q").join(".");
    if (name === "wrapper" || name === "long-step-wrapper") {
      const step = name === "wrapper" ? "q" : "anUnusuallyLongPropertyName";
      lines.push("let seed: integer=1", "let root={f:seed}");
      for (let i = 0; i < n; i++)
        lines.push(`let box${i}={${step}:${i ? "box" + (i - 1) : "root"}}`);
      lines.push(`let out=box${n - 1}.${Array(n).fill(step).join(".")}.f`);
    } else if (name === "copied-properties") {
      lines.push(
        "let seed: integer=1",
        `let source={${Array.from({ length: n }, (_, i) => "p" + i + ":seed").join(",")}}`,
        "let copy=source",
      );
      for (let i = 0; i < n; i++) lines.push(`copy.p${i}=2`);
    } else if (name === "hot-candidates") {
      lines.push(`let source={${Array.from({ length: n }, (_, i) => "p" + i + ":1").join(",")}}`);
      for (let i = 0; i < n; i++) lines.push(`let box${i}=[source,{p${i}:2}]`);
    } else if (name === "typed-depth") {
      lines.push("let source:integer" + "[]".repeat(n) + "=[]", "let copy=source");
    } else if (name === "literal-depth") {
      lines.push("let source=" + "{q:".repeat(n) + "1" + "}".repeat(n), `let out=source.${q}`);
    } else if (name === "carrier-depth") {
      let value = "seed";
      for (let i = 0; i < n; i++) value = `[${value},"other"][0]`;
      lines.push('let seed="origin"', "let out=" + value);
    }
    return lines.join("\n") + "\nexit\n";
  }
  return {
    shapes: {
      wrapper: (n) => growth("wrapper", n),
      "long-step-wrapper": (n) => growth("long-step-wrapper", n),
      "copied-properties": (n) => growth("copied-properties", n),
      "hot-candidates": (n) => growth("hot-candidates", n),
      "typed-depth": (n) => growth("typed-depth", n),
      "literal-depth": (n) => growth("literal-depth", n),
      "carrier-depth": (n) => growth("carrier-depth", n),
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
