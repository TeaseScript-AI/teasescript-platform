// #1278; Astra review: size-dependent program source families.
export const sizes = [4, 8];
const corpus = (() => {
  function program(k) {
    return (
      Array.from({ length: k }, (_, i) => (i ? "p = " : "let p = ") + `{f: ${i + 1}}`).join("\n") +
      '\nlet options = [{text:"a",value:p},{text:"b",value:p}]\nlet picked = askChoice options\nrepeat picked.f {}\nexit'
    );
  }
  return { shapes: { program: (n) => program(n) } };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
