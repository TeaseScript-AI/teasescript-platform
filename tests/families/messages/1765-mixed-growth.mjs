// #1765's generated mixed-list family, its work (#1789, the lead's family rule; the owner's test-cost rule moved the
// second doubling out of CI): each carrier kind of `1765-mixed-family.mjs` deep (a nest of dicts and lists behind it,
// three quarters of the size deep, errors at ever longer paths) and wide (size wrapped elements before as many
// disagreeing ones). `tests/type-core-mixed-family.test.ts` runs the first doubling of each.
const CARRIERS = {
  take: (value) => `(${value}).take(9)`,
  index: (value) => `[${value}][0]`,
  get: (value) => `[].get(0, default: ${value})`,
  operand: (value) => `(${value} otherwise null)`,
  fallback: (value) => `(null otherwise ${value})`,
  property: (value) => `{p:${value}}.p`,
  join: (value) => `(${value})+[]`,
};
export const sizes = [16, 32, 64];
export const shapes = {};
for (const [kind, made] of Object.entries(CARRIERS)) {
  shapes[`deep:${kind}`] = (size) => {
    let first = "[1]";
    let second = '["x"]';
    for (let at = 0; at < (size * 3) / 4; at += 1) {
      first = `dict {k:[${first}]}`;
      second = `[dict {k:${second}}]`;
    }
    return `let xs=[${made(`[${first}]`)},${made(`[${second}]`)}]\nexit\n`;
  };
  shapes[`wide:${kind}`] = (size) =>
    `let xs=[[${Array.from({ length: size }, (_, at) => made(`[${at}]`)).join(",")}],${Array.from({ length: size }, (_, at) => `[["s${at}"]]`).join(",")}]\nexit\n`;
}
export const recorded = { commands: [], sources: 0, sha256: "" };
