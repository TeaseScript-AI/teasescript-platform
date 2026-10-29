// 3a review, Sol delta check 3 (R/pr-3a-delta-check-3-sol-files/varied-source.mjs): the profiler sweep's varied script,
// every construct the solver handles at n units, as varied.mjs ran it at n = 250, 500, 1,000 and 2,000.
export const sizes = [250, 500, 1000, 2000]; // the profiler sweep's recorded n
const corpus = (() => {
  const lines = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join("\n");
  function variedSource(n) {
    const parts = [];
    // scalars, stores of other kinds (conflicts kept rare: one in ten units restores the same kind)
    parts.push(
      lines(n, (i) => `let v${i} = ${i % 3 === 0 ? `"t${i}"` : i % 3 === 1 ? `${i}` : "true"}`),
    );
    parts.push(
      lines(n, (i) => `v${i} = ${i % 3 === 0 ? `"u${i}"` : i % 3 === 1 ? `${i + 1}` : "false"}`),
    );
    // lists: literal, appended in feedback at two sites, read, a nested list, a set and a dict
    parts.push(
      lines(
        n,
        (i) =>
          `let l${i} = [${i}]\nl${i} = l${i} + [${i + 1}]\nl${i}.add(${i + 2})\nlet lf${i} = l${i}.first\nlet nl${i} = [l${i}]\nlet s${i} = l${i}.toSet()\nlet d${i} = dict {"k${i}": l${i}}`,
      ),
    );
    // objects: a literal with two properties, a stored third, a read of each, a copy, a distinct-name object
    parts.push(
      lines(
        n,
        (i) =>
          `let o${i} = {a: ${i}, b: "s${i}"}\no${i}.c = l${i}\nlet oa${i} = o${i}.a\nlet oc${i} = o${i}.c\nlet oo${i} = o${i}\nlet p${i} = {q${i}: 0}\np${i}.r${i} = 1\nlet pr${i} = p${i}.r${i}`,
      ),
    );
    // written unions, get defaults, otherwise, conversions with defaults, text methods, min/max
    parts.push(
      lines(
        n,
        (i) =>
          `let w${i}: integer[] | string[] = [${i}]\nw${i} = w${i} + []\nlet g${i} = [[${i}]].get(0, default: [${i + 1}])\nlet ot${i} = l${i} otherwise [${i}]\nlet j${i} = fromJson("1", default: ${i})\nlet t${i} = toString(v${i}).length\nlet m${i} = min(${i}, ${i + 1})`,
      ),
    );
    // choices and a form over the objects, every tenth unit
    parts.push(
      lines(
        Math.ceil(n / 10),
        (i) =>
          `let ch${i} = askChoice o${(i * 10) % n}.a, o${(i * 10 + 1) % n}.a\nlet f${i} = askForm("Q${i}", fields: {q: {options: [${i}, ${i + 1}]}})\nlet fq${i} = f${i}.q`,
      ),
    );
    // mutual feedback between two lists, every twentieth unit
    parts.push(
      lines(
        Math.ceil(n / 20),
        (i) =>
          `let x${i} = [${i}]\nlet y${i} = [${i + 1}]\nx${i} = x${i} + y${i}\ny${i} = y${i} + x${i}`,
      ),
    );
    return `${parts.join("\n")}\nexit`;
  }
  return { shapes: { variedSource: (n) => variedSource(n) } };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node varied.mjs <dist> 250", "R/pr-3a-delta-check-3-sol-files/varied-250.json:1"],
    ["node varied.mjs <dist> 500", "R/pr-3a-delta-check-3-sol-files/varied-500.json:1"],
    ["node varied.mjs <dist> 1000", "R/pr-3a-delta-check-3-sol-files/varied-1000.json:1"],
    ["node varied.mjs <dist> 2000", "R/pr-3a-delta-check-3-sol-files/varied-2000.json:1"],
  ],
  sources: 4,
  sha256: "c4c8732107f58475c76095d68cfad2a366bffb4e3e4d13a7b21d1d4fa65aef24",
};
