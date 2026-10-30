// integer[] copy, list<integer> copy and related fixed cases; 3a model, builder
// (R/3a-newcore/checkpoint-9/spike8/parse-check.mjs).
export const cases = (() => {
  const snippets = {
    "integer[] copy": `let source = [1]\nlet local: integer[] = source`,
    "list<integer> copy": `let source = [1]\nlet local: list<integer> = source`,
    "nullable integer": `let n: integer? = null`,
    "number type": `let i: number = 1`,
    "is integer check": `let x = 1\nif x is integer { say "ok" }`,
    "union type": `let v: integer | string = 1`,
    "typed scalar copy": `let state = {n: 1}\nlet count: integer = state.n`,
  };
  return Object.entries(snippets);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node parse-check.mjs (no command recorded: its run without arguments)",
      "R/3a-newcore/checkpoint-9/spike8/parse-check.mjs",
    ],
  ],
  sources: 7,
  sha256: "f6cb0ec70ea6de69fb068021fc5fa6e11ba50d58e6a230c73f950a66e130665d",
};
