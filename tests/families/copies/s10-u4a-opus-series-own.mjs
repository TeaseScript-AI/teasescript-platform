// S10 U4a, Opus builder (R/opus-m4-s10-u4a/series.mjs): the seven families the series defines itself, as its quick run
// (quick-families.txt, at 8, 16 and 32) and its long run (long-families.txt, 64 to 1,024) compiled them. The runs also
// compiled the repository's exported work families (tests/helpers/type-core-families), which the corpus does not copy.
const rows = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
const sel = (i) => ["first", "last", "random"][i % 3];
const balancedSum = (lo, hi) =>
  hi - lo === 1
    ? `a${lo}`
    : `(${balancedSum(lo, (lo + hi) >> 1)} + ${balancedSum((lo + hi) >> 1, hi)})`;
const head = 'let choice = askBoolean "change?"';
const own = {
  // one tested list of k elements, k stored selections of it: no read may scan its elements
  "U4a-selection-width": (k) =>
    `${head}\nlet xs = [${rows(k, () => "1", ", ")}, null]\nif choice { xs = [2] }\nif xs is integer[] {\n${rows(k, (i) => `let s${i}: integer = xs.${sel(i)}`)}\n}`,
  "U4a-selection-width-declared": (k) =>
    `${head}\nlet xs: integer?[] = [${rows(k, () => "1", ", ")}]\nif choice { xs = [null] }\nif xs is integer[] {\n${rows(k, (i) => `let s${i}: integer = xs.${sel(i)}`)}\n}`,
  // k tested lists, one stored selection each
  "U4a-selection-reads": (k) =>
    `${head}\n${rows(k, (i) => `let x${i}: integer?[] = [1]\nif choice { x${i} = [null] }`)}\n${rows(k, (i) => `if x${i} is integer[] { let s${i}: integer = x${i}.${sel(i)} }`)}`,
  // k rows under one root test, each read through its own index variable
  "U4a-selection-rows": (k) =>
    `${head}\nlet rows = [${rows(k, () => "[1]", ", ")}, [null]]\nif choice { rows = [[2]] }\n${rows(k, (i) => `let r${i} = ${i}`)}\nif rows is integer[][] {\n${rows(k, (i) => `let s${i}: integer = rows[r${i}].${sel(i)}`)}\n}`,
  // k mutations each before a stored selection: G fails at each read (N2's invalidation list)
  "U4a-selection-failed": (k) =>
    `${head}\nlet xs: integer?[] = [1]\nif choice { xs = [null] }\nif xs is integer[] {\n${rows(k, (i) => `xs.reverse()\nlet s${i}: integer = xs.${sel(i)}`)}\n}`,
  // W29-wide-ring read through a selection of a wide tested literal (and the plain selection without a test)
  "W29-wide-selection": (k) =>
    `let flagHost = askBoolean "flag"\nlet i = 0\n${rows(k, (i) => `let a${i}: integer? = 1\nif flagHost { a${i} = null }`)}\nlet total: integer? = 0\nif total != null and ${rows(k, (i) => `a${i} != null`, " and ")} {\nwhile flagHost {\nlet xs = [${rows(k, (i) => `a${i}`, ", ")}]\nif xs is integer[] { total = xs.random }\n${rows(k - 1, (i) => `a${i} = a${i + 1}`)}\na${k - 1} = total otherwise null\n}\n}`,
  "W29-wide-selection-plain": (k) =>
    `let flagHost = askBoolean "flag"\nlet i = 0\n${rows(k, (i) => `let a${i}: integer? = 1\nif flagHost { a${i} = null }`)}\nlet total: integer? = 0\nif total != null and ${rows(k, (i) => `a${i} != null`, " and ")} {\nwhile flagHost {\nlet xs = [${rows(k, (i) => `a${i}`, ", ")}]\ntotal = xs.first otherwise 0\n${rows(k - 1, (i) => `a${i} = a${i + 1}`)}\na${k - 1} = total otherwise null\n}\n}`,
};

export const shapes = Object.fromEntries(
  Object.entries(own).map(([name, make]) => [name, (k) => `${make(k)}\nexit\n`]),
);
export const sizes = [8, 16, 32, 64, 128, 256, 512, 1024];
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node evidence/series.mjs ROOT PIN REVERSE OUT.jsonl SIZES FAMILIES",
      "R/opus-m4-s10-u4a/REPRODUCE.md:7",
    ],
    ["node evidence/gate.mjs FILES...", "R/opus-m4-s10-u4a/REPRODUCE.md:7"],
  ],
  sources: 56,
  sha256: "bdebdf55c369f222dac696c8783cef2b6c650b0660752f4eb338334e587f2c02",
};
