// astra-m4-i1249-review-evidence; archived Python/shell evidence.
export const cases = (() => {
  let cases;
  function* generate(k) {
    let a, b, elements, name, other, reverse, setup, value, wide;
    wide =
      "{" +
      Array.from({ length: k - 0 }, (_, i) => i + 0)
        .map((i) => `p${i}:1`)
        .join(",") +
      "}";
    other =
      "{" +
      Array.from({ length: k - 0 }, (_, i) => i + 0)
        .map((i) => `p${i}:` + (i === k - 1 ? '"bad"' : "1"))
        .join(",") +
      "}";
    setup = `let bundle={left:${wide},right:${other}}
`;
    for (reverse of [false, true]) {
      elements = Array.from({ length: k }, () => ["bundle.left"]).flat();
      elements.splice(reverse ? 0 : elements.length, 0, "bundle.right");
      for ([name, value] of [
        ["projected-set", "set[" + elements.join(",") + "]"],
        [
          "projected-dict",
          "dict{" +
            elements
              .map((value, i) => [i, value])
              .map(([i, e]) => `"k${i}":${e}`)
              .join(",") +
            "}",
        ],
      ]) {
        yield [name, reverse, setup + "let result=" + value + "\nexit\n"];
      }
      [a, b] = reverse ? ["bundle.right", "bundle.left"] : ["bundle.left", "bundle.right"];
      yield [
        "projected-destinations",
        reverse,
        setup +
          Array.from({ length: k - 0 }, (_, i) => i + 0)
            .map(
              (i) => `let dest${i}=${a}
dest${i}=${b}`,
            )
            .join("\n") +
          "\nexit\n",
      ];
      yield [
        "two-alias-literals",
        reverse,
        setup +
          Array.from({ length: k - 0 }, (_, i) => i + 0)
            .map(
              (i) => `let alias${i}=${a}
let relay${i}=alias${i}
let pair${i}=[relay${i},${b}]`,
            )
            .join("\n") +
          "\nexit\n",
      ];
    }
  }
  cases = [4, 64, 128, 256].flatMap((n) =>
    Array.from(generate(n), ([name, reverse, source]) => ({
      name: name + "/" + reverse + "/" + n,
      source,
    })),
  );

  return cases.map((c) => [c.name, c.source ?? c.files[0].source]);
})();
export const checks = ["publication", "stops"];
