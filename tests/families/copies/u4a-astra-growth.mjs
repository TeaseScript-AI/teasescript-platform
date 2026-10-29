// complete width/independent/computed/invalidated programs at 16/32; Astra review, round unrecorded
// (R/astra-m4-u4a-review/growth.mjs).
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
export const sizes = [16, 32, 256, 512]; // the recorded growth runs' k
export const shapes = corpus.shapes;

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      '/home/peter/opt/node-24.18/bin/node "$root/evidence/growth.mjs" "$root" "$reverse" 256,512 "$root/evidence/growth-$reverse.jsonl"',
      "R/astra-m4-u4a-review/queue-final.sh:6",
    ],
    [
      "node ROOT/evidence/growth.mjs ROOT 0 16,32 ROOT/evidence/quick-0.jsonl",
      "R/astra-m4-u4a-review/REPRODUCE.md:9",
    ],
    [
      "node ROOT/evidence/growth.mjs ROOT 1 16,32 ROOT/evidence/quick-1.jsonl",
      "R/astra-m4-u4a-review/REPRODUCE.md:10",
    ],
    [
      "node ROOT/evidence/growth.mjs ROOT 0 256,512 ROOT/evidence/growth-0.jsonl",
      "R/astra-m4-u4a-review/REPRODUCE.md:11",
    ],
    [
      "node ROOT/evidence/growth.mjs ROOT 1 256,512 ROOT/evidence/growth-1.jsonl",
      "R/astra-m4-u4a-review/REPRODUCE.md:12",
    ],
    [
      '/home/peter/opt/node-24.18/bin/node "$root/evidence/growth.mjs" "$root" "$reverse" 16,32 "$root/evidence/quick-$reverse.jsonl"',
      "R/astra-m4-u4a-review/queue-quick.sh:7",
    ],
  ],
  sources: 16,
  sha256: "c953d123937e528e41cdf81b1dd458d610214724683a165721b3bc1d622c2994",
};
