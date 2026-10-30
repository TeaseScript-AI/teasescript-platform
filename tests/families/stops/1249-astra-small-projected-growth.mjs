// projected set/dict/store/alias cases at 4/64/128/256; #1249, astra-m4-i1249-review-evidence, archived Python/shell
// evidence, round unrecorded (R/astra-m4-i1249-review-evidence/make-growth.py).
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

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["python3 make-growth.py", "R/astra-m4-i1249-review-evidence/REPRODUCE.md:16"],
    [
      'node run.mjs "$review_tree" growth.json out/growth-new.jsonl',
      "R/astra-m4-i1249-review-evidence/REPRODUCE.md:18",
    ],
    [
      "node run.mjs /home/peter/work/astra1293/head growth-quick.json out/growth-quick.jsonl",
      "R/astra-m4-i1249-review-evidence/jobs.json#/home/peter/queue/done/5-20261028212728676889041-astra1293-growth-quick.job:4",
    ],
    [
      "node run.mjs /home/peter/work/astra1293/base growth.json out/growth-base.jsonl",
      "R/astra-m4-i1249-review-evidence/jobs.json#/home/peter/queue/done/5-20261028212806895422027-astra1293-growth-base.job:4",
    ],
    [
      "node run.mjs /home/peter/work/astra1293/head growth.json out/growth-head.jsonl",
      "R/astra-m4-i1249-review-evidence/jobs.json#/home/peter/queue/done/5-20261028212806889924098-astra1293-growth-head.job:4",
    ],
  ],
  sources: 32,
  sha256: "2d3419b4586a6b16ae29448680bf2e6370b41e51dbd43282de765cd585fc3c98",
};
