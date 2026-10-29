// #1357, Astra's permutation review (retained in #1359/#1417): rotated role and choice-leaf peers (desktop:~/work/evidence/1417/a0abf39f0/tools/astra-permutations.mjs).

const many = (n, f, sep = "\n") => Array.from({ length: n }, (_, i) => f(i)).join(sep);
export const shapes = {
  rotatedWideRolePeers: (n) => {
    const peers = Math.max(2, Math.floor(n / 8));
    const expr = `${"max(".repeat(n)}hostValue.n${many(n, (i) => `, ${i})`, "")}`;
    return [
      many(peers, (i) => `let p${i} = ${expr}`),
      many(
        n,
        (i) =>
          `let xs${i} = [${many(peers, (j) => `p${(i + j) % peers}`, ", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
      ),
      "exit",
    ].join("\n");
  },
  rotatedWideLeafPeers: (n) => {
    const peers = Math.max(2, Math.floor(n / 8));
    const expr = `askChoice ${many(n, (i) => `{text:"${i}", value:hostValue.p${i}}`, ", ")}`;
    return [
      many(peers, (i) => `let p${i} = ${expr}`),
      many(
        n,
        (i) =>
          `let xs${i} = [${many(peers, (j) => `p${(i + j) % peers}`, ", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
      ),
      "exit",
    ].join("\n");
  },
};

export const sizes = [2, 3, 5, 8, 9, 16, 24, 64, 128]; // the recorded consumers' sizes
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "otherHost"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node growth.mjs <tree> desktop:~/work/evidence/1417/a0abf39f0/tools/astra-permutations.mjs all 64 src,rev,srcOff,revOff literalUnits,mergeItems,checks,invSteps",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:20",
    ],
    [
      "node answers.mjs <tree> <out> shapes desktop:~/work/evidence/1417/a0abf39f0/tools/astra-permutations.mjs 8,16,24",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:26",
    ],
    [
      "node oracle-run.mjs <base> <head> <out> desktop:~/work/evidence/1417/a0abf39f0/tools/astra-permutations.mjs",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:34",
    ],
  ],
  sources: 18,
  sha256: "05e9031599605a0933379e3e44bfb544076ea7a1e5f1f0e9ac84a1c77e207321",
};
