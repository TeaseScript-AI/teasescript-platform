const corpus = (() => {
  const each = (k, f) => Array.from({ length: k }, (_, i) => f(i));
  const typed = (k) =>
    `${each(k, (i) => `let w${i}: integer = ${i}\nlet s${i}: string = "x"`).join("\n")}\n` +
    `let good = {${each(k, (i) => `f${i}: w${i}`).join(", ")}}\nlet bad = {${each(k, (i) => `f${i}: s${i}`).join(", ")}}\n`;
  const other = (k) =>
    `let other = {${each(k, (i) => (i === 0 ? "f0: s0" : `f${i}: w${i}`)).join(", ")}}\n`;
  const reads = (k, read) => each(k, (i) => `say "\${${read}.f${i}}"`).join("\n");
  const copies = (k, copy) => each(k, () => copy).join(", ");
  const shapes = [
    [
      "elements of written fields",
      (k) => `${typed(k)}let xs = [${copies(k, "good")}]\nxs.add(bad)\n${reads(k, "xs[0]")}\nexit`,
      (k) => k,
    ],
    [
      "stores of written fields",
      (k) =>
        `${typed(k)}let c = good\n${each(k, () => "c = good").join("\n")}\nc = bad\n${reads(k, "c")}\nexit`,
      (k) => k,
    ],
    [
      "places of written fields",
      (k) =>
        `${typed(k)}${other(k)}${each(k, (i) => `let c${i} = good\nc${i} = other`).join("\n")}\nexit`,
      (k) => k,
    ],
    [
      "places of written fields, the other first",
      (k) =>
        `${typed(k)}${other(k)}${each(k, (i) => `let c${i} = other\nc${i} = good`).join("\n")}\nexit`,
      (k) => k,
    ],
    [
      "a list of written fields",
      (k) => `${typed(k)}${other(k)}let xs = [${copies(k, "good")}, other]\nexit`,
      () => 1,
    ],
    [
      "a list of written fields, the other first",
      (k) => `${typed(k)}${other(k)}let xs = [other, ${copies(k, "good")}]\nexit`,
      () => 1,
    ],
    [
      "a ring fed two objects of k written fields",
      (k) =>
        `${typed(k)}let a0 = good\n${each(k - 1, (i) => `let a${i + 1} = a${i}`).join("\n")}\na0 = a${k - 1}\na${k - 1} = bad\nexit`,
      (k) => k,
    ],
  ];
  return { shapes: Object.fromEntries(shapes.map((row) => [row[0], row[1]])) };
})();
export const sizes = [64, 128];
export const shapes = corpus.shapes;

export const checks = ["publication"];
