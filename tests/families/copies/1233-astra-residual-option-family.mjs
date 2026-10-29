// #1233; Astra review: size-dependent family source families.
export const sizes = [64, 128];
const corpus = (() => {
  const { family: family } = (() => {
    const wrappers = {
      direct: (x) => [x, ""],
      list: (x) => [`[${x}]`, ".first"],
      object: (x) => [`{inside:${x}}`, ".inside"],
      selected: (x) => [`{value:${x},text:null}`, ".value"],
      text: (x) => [`{text:${x}}`, ".text"],
      pair: (x) => [`[{value:${x},text:null},{value:${x},text:"two"}]`, ".first.value"],
      dict: (x) => [`dict {a:${x},b:${x}}`, ".values.first"],
    };
    const many = (k, fn, sep = "\n") => Array.from({ length: k }, (_, i) => fn(i)).join(sep);
    function family(
      k,
      { depth = 0, wrap = "direct", variant = "plain", inline = false, loop = false } = {},
    ) {
      const obj = (value) => `{${many(k, (i) => `f${i}:${value}`, ",")}}`;
      const lines = [`let source=${variant === "host-bound" ? "hostValue" : obj("1")}`];
      if (variant.startsWith("two"))
        lines.push(`let other=${obj(variant === "two-different" ? '"s"' : "2")}`);
      if (loop) lines.push("repeat 2 {", "source.f0=3");
      const alias = (i) =>
        depth === 0
          ? variant.startsWith("two") && i % 2
            ? "other"
            : variant === "host-direct"
              ? "hostValue"
              : "source"
          : `a${depth - 1}_${i}`;
      for (let d = 0; d < depth; d++)
        lines.push(
          many(
            k,
            (i) =>
              `let a${d}_${i}=${d === 0 ? (variant.startsWith("two") && i % 2 ? "other" : variant === "host-direct" ? "hostValue" : "source") : `a${d - 1}_${i}`}`,
          ),
        );
      if (variant === "store-leaf" && depth) lines.push(`${alias(0)}.f0="s"`);
      if (variant === "store-whole" && depth) lines.push(`${alias(0)}={f0:"s"}`);
      if (variant === "guard") lines.push(`if ${alias(0)}.f0 is integer {`);
      const options = `[${many(k, (i) => `{text:"${i}",value:${wrappers[wrap](alias(i))[0]}}`, ",")}]`;
      if (!inline) lines.push(`let options=${options}`);
      if (variant === "store-option" && !inline) lines.push('options[0].value={f0:"changed"}');
      lines.push(`let picked=askChoice ${inline ? options : "options"}`);
      const suffix = wrappers[wrap]("source")[1];
      lines.push(many(k, (i) => `repeat picked${suffix}.f${i} {}`));
      if (variant === "guard") lines.push("}");
      if (loop) lines.push("}");
      lines.push("exit");
      return lines.join("\n");
    }
    return { family };
  })();
  return { shapes: { family: (n) => family(n) } };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
