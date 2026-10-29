// #1165 / S8; Astra review: size-dependent forms source families.
export const sizes = [32, 64];
const corpus = (() => {
  const forms = {
    direct: (n) =>
      `function make {\nlet n0 = 1.5\n${Array.from({ length: n }, (_, i) => `let n${i + 1} = n${i}`).join("\n")}\nreturn n${n}\n}\nrepeat make() {}\nexit`,
    mutate: (n) =>
      `function make {\nlet n0 = 1.5\n${Array.from({ length: n }, (_, i) => `let n${i + 1} = n${i}`).join("\n")}\nlet saved = n${n}\nn${n} = 2\nreturn saved\n}\nrepeat make() {}\nexit`,
    returns: (n) =>
      `${Array.from({ length: n }, (_, i) => `function f${i} { return ${i ? "f" + (i - 1) + "()" : "1.5"} }`).join("\n")}\nrepeat f${n - 1}() {}\nexit`,
  };
  return {
    shapes: {
      direct: (n) => forms["direct"](n),
      mutate: (n) => forms["mutate"](n),
      returns: (n) => forms["returns"](n),
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication", "stops"];
