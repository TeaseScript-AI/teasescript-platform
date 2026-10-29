// 3a model builder: size-dependent NARROW source families.
export const sizes = [4, 8];
const corpus = (() => {
  const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const NARROW = [
    [
      "one key's tests",
      (k) =>
        `let n = 1\nif hostFlag { n = null }\n${many(k, () => "if n != null { repeat n {} }")}\nexit`,
    ],
    [
      "sibling tests then reads",
      (k) =>
        `let n = 1\nif hostFlag { n = null }\n${many(k, () => "if n != null { say 1 }")}\n${many(k, () => "repeat n {}")}\nexit`,
    ],
    [
      "an and chain",
      (k) =>
        `let r = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { r = {${many(k, (i) => `f${i}: null`, ", ")}} }\nif ${many(k, (i) => `r.f${i} != null`, " and ")} and ${many(k, (i) => `r.f${i}`, " + ")} > 0 { say "ok" }\nexit`,
    ],
    [
      "an or chain read after",
      (k) =>
        `let r = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { r = {${many(k, (i) => `f${i}: null`, ", ")}} }\nif ${many(k, (i) => `r.f${i} == null`, " or ")} { exit }\n${many(k, (i) => `repeat r.f${i} {}`)}\nexit`,
    ],
    [
      "invalidations",
      (k) =>
        `let xs = [1, null]\n${many(k, (i) => `if xs[${i}] == null { exit }`)}\n${many(k, () => "xs.reverse()")}\n${many(k, (i) => `repeat xs[${i}] {}`)}\nexit`,
    ],
    // round 14 (N5): one subset of preserving stores per (location, kind set), its entries counted, never walked
    [
      "one key's preserving loops",
      (k) =>
        `let v = 1\nif hostFlag { v = null }\n${many(k, () => "if v != null { repeat 2 { repeat v {}\nv = v + 1 } }")}\nexit`,
    ],
    [
      "a loop of preserving stores",
      (k) =>
        `let v = 1\nif hostFlag { v = null }\nif v != null { repeat 2 {\n${many(k, () => "repeat v {}")}\n${many(k, () => "v = v + 1")}\n} }\nexit`,
    ],
    [
      "k scalars preserved in one loop",
      (k) =>
        `${many(k, (i) => `let v${i} = 1\nif hostFlag { v${i} = null }`)}\n${many(k, (i) => `if v${i} == null { exit }`)}\nrepeat 2 {\n${many(k, (i) => `v${i} = v${i} + 1`)}\n${many(k, (i) => `repeat v${i} {}`)}\n}\nexit`,
    ],
  ];
  return {
    shapes: {
      "one key's tests/1": (n) => NARROW[0][1](n),
      "sibling tests then reads/1": (n) => NARROW[1][1](n),
      "an and chain/1": (n) => NARROW[2][1](n),
      "an or chain read after/1": (n) => NARROW[3][1](n),
      "invalidations/1": (n) => NARROW[4][1](n),
      "one key's preserving loops/1": (n) => NARROW[5][1](n),
      "a loop of preserving stores/1": (n) => NARROW[6][1](n),
      "k scalars preserved in one loop/1": (n) => NARROW[7][1](n),
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
