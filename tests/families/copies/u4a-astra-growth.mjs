const corpus = (() => {
  const lines = (n, f, sep = "\n") => Array.from({ length: n }, (_, i) => f(i)).join(sep);
  const select = (i) => ["first", "last", "random"][i % 3];
  const pre = 'let c = askBoolean "change?"';
  const families = {
    width: (k) =>
      `${pre}\nlet xs: integer?[] = [${lines(k, () => "7", ",")}]\nif c { xs = [null] }\nif xs is integer[] {\n${lines(k, (i) => `let take${i}: integer = xs.${select(i)}`)}\n}\nexit\n`,
    independent: (k) =>
      `${pre}\n${lines(k, (i) => `let xs${i}: integer?[] = [1]\nif c { xs${i} = [null] }\nif xs${i} is integer[] { let take${i}: integer = xs${i}.${select(i)} }`)}\nexit\n`,
    computed: (k) =>
      `${pre}\nlet rows: integer?[][] = [${lines(k, () => "[7]", ",")}]\nif c { rows = [[null]] }\nif rows is integer[][] {\n${lines(k, (i) => `let index${i} = ${i}\nlet take${i}: integer = rows[index${i} + 1].${select(i)}`)}\n}\nexit\n`,
    invalidated: (k) =>
      `${pre}\nlet xs: integer?[] = [1]\nif c { xs = [null] }\nif xs is integer[] {\n${lines(k, (i) => `xs.reverse()\nlet take${i}: integer = xs.${select(i)}`)}\n}\nexit\n`,
  };
  return { shapes: families };
})();
export const sizes = [16, 32];
export const shapes = corpus.shapes;

export const checks = ["publication"];
