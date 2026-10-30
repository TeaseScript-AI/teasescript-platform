// original peerJoinSeparateLists, peerJoinOneList and related inputs; #1359, r2, reviewer unrecorded (retained in
// #1417) (desktop:~/work/evidence/1417/a0abf39f0/tools/r2/peer-shapes.mjs).
const corpus = (() => {
  const many = (k, f, sep = ", ") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const join = (k) => `seed + ${many(k, (i) => `[${i}]`, " + ")} + ["s"]`;
  const pair = (k) =>
    `let seed: (integer | string)[] = [0]\nlet left = ${join(k)}\nlet right = ${join(k)}\n`;
  const shapes = {
    peerJoinSeparateLists: (k) =>
      pair(k) +
      many(
        k,
        (i) => `let xs${i} = [left, right]\nlet n${i}: integer = xs${i}[hostValue.i][0]`,
        "\n",
      ) +
      "\nexit",
    peerJoinOneList: (k) =>
      pair(k) +
      `let xs = [${many(k, (i) => (i % 2 ? "right" : "left"))}]\nlet n: integer = xs[hostValue.i][0]\nexit`,
    peerJoinChoiceOptions: (k) =>
      pair(k) +
      `let xs = askChoice ${many(k, (i) => `{text: "${i}", value: ${i % 2 ? "right" : "left"}}`)}\nsay xs[0]\nexit`,
    oneBoundChoiceOptions: (k) =>
      `let seed: (integer | string)[] = [0]\nlet root = ${join(k)}\nlet xs = askChoice ${many(k, (i) => `{text: "${i}", value: root}`)}\nsay xs[0]\nexit`,
    oneBoundPeerLists: (k) =>
      `let seed: (integer | string)[] = [0]\nlet root = ${join(k)}\n` +
      many(
        k,
        (i) => `let xs${i} = [root, root]\nlet n${i}: integer = xs${i}[hostValue.i][0]`,
        "\n",
      ) +
      "\nexit",
    peerScalarSeparateLists: (k) =>
      `let left = hostValue.n + ${many(k, (i) => i, " + ")}\nlet right = hostValue.n + ${many(k, (i) => i, " + ")}\n` +
      many(k, (i) => `let xs${i} = [left, right]\nsay xs${i}[hostValue.i]`, "\n") +
      "\nexit",
  };
  const hostJoin = (k) => `hostValue.items + ${many(k, (i) => `[${i}]`, " + ")} + ["s"]`;
  const hostPair = (k) => `let left = ${hostJoin(k)}\nlet right = ${hostJoin(k)}\n`;
  shapes.peerHostJoinSeparateLists = (k) =>
    hostPair(k) +
    many(
      k,
      (i) => `let xs${i} = [left, right]\nlet n${i}: integer = xs${i}[hostValue.i][0]`,
      "\n",
    ) +
    "\nexit";
  shapes.peerHostJoinOneList = (k) =>
    hostPair(k) +
    `let xs = [${many(k, (i) => (i % 2 ? "left" : "right"))}]\nlet n: integer = xs[hostValue.i][0]\nexit`;
  shapes.peerHostScalarLists = (k) =>
    `let left = hostValue.n + ${many(k, (i) => i, " + ")}\nlet right = hostValue.n + ${many(k, (i) => i, " + ")}\n` +
    many(k, (i) => `let xs${i} = [left, right]\nlet n${i}: integer = xs${i}[hostValue.i]`, "\n") +
    "\nexit";
  const freshJoin = (k) => `[hostValue] + ${many(k, (i) => `[${i}]`, " + ")} + ["s"]`;
  const freshPair = (k) => `let left = ${freshJoin(k)}\nlet right = ${freshJoin(k)}\n`;
  shapes.peerFreshJoinLists = (k) =>
    freshPair(k) +
    many(
      k,
      (i) => `let xs${i} = [left, right]\nlet n${i}: integer = xs${i}[hostValue.i][0]`,
      "\n",
    ) +
    "\nexit";
  shapes.peerFreshJoinOneList = (k) =>
    freshPair(k) +
    `let xs = [${many(k, (i) => (i % 2 ? "left" : "right"))}]\nlet n: integer = xs[hostValue.i][0]\nexit`;
  const max = (k) => `${"max(".repeat(k)}hostValue${many(k, (i) => `, ${i})`, "")}`;
  shapes.peerMaxLists = (k) =>
    `let left = ${max(k)}\nlet right = ${max(k)}\n` +
    many(k, (i) => `let xs${i} = [left, right]\nlet n${i}: integer = xs${i}[hostValue.i]`, "\n") +
    "\nexit";
  shapes.boundJoinTwicePerList = (k) =>
    `let root = hostValue + ${many(k, (i) => `[${i}]`, " + ")}\n` +
    many(k, (i) => `let xs${i} = [root, root]\nlet n${i}: integer = xs${i}[hostValue.i][0]`, "\n") +
    "\nexit";
  const constantMax = (k) => `${"max(".repeat(k)}0${many(k, (i) => `, ${i + 1})`, "")}`;
  shapes.constantMaxPeerLists = (k) =>
    `let left = ${constantMax(k)}\nlet right = ${constantMax(k)}\n` +
    many(k, (i) => `let xs${i} = [left, right]\nsay xs${i}[0]`, "\n") +
    "\nexit";
  shapes.constantMaxPeerOneList = (k) =>
    `let left = ${constantMax(k)}\nlet right = ${constantMax(k)}\nlet xs = [${many(k, (i) => (i % 2 ? "left" : "right"))}]\nsay xs[0]\nexit`;
  return { shapes: shapes };
})();
export const sizes = [1, 2, 3, 5, 8, 9, 64, 128]; // the recorded consumers' sizes
export const shapes = corpus.shapes;

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "otherHost"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node growth.mjs <tree> desktop:~/work/evidence/1417/a0abf39f0/tools/r2/peer-shapes.mjs all 64 src,rev,srcOff,revOff literalUnits,mergeItems,checks,invSteps",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:20",
    ],
    [
      "node answers.mjs <tree> <out> shapes desktop:~/work/evidence/1417/a0abf39f0/tools/r2/peer-shapes.mjs 1,3,8",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:26",
    ],
    [
      "node oracle-run.mjs <base> <head> <out> desktop:~/work/evidence/1417/a0abf39f0/tools/r2/peer-shapes.mjs",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:34",
    ],
    [
      "node differential-own.mjs",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:37",
    ],
  ],
  sources: 120,
  sha256: "2ef0c9e1e1dc7d733b8b15f21ac8d9efff7cb5ac66802e2f9b5481d36904cf79",
};
