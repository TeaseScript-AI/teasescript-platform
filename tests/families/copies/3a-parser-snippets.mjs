// 3a model builder.
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
