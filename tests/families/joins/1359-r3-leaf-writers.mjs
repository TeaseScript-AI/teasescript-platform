// original wideMaxLeaves, reversedMaxPeers and related inputs; #1359, r3, reviewer unrecorded (retained in #1417)
// (desktop:~/work/evidence/1417/a0abf39f0/tools/r3/own-shapes.mjs).
const corpus = (() => {
  const many = (k, f, sep = ", ") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const chain = (k, seed = "hostValue") =>
    `${"max(".repeat(k)}${seed}${many(k, (i) => `, ${i})`, "")}`;
  const wide = (k) => `max(${many(k, (i) => `hostValue.f${i}`)})`;
  const pair = (expr) => `let left = ${expr}\nlet right = ${expr}\n`;
  const sites = (k, values = "left, right", read = "xs[i][hostValue.i]") =>
    many(
      k,
      (i) =>
        `let xs${i} = [${typeof values === "function" ? values(i) : values}]\nlet n${i}: integer = ${read.replaceAll("[i]", String(i))}`,
      "\n",
    ) + "\nexit";
  const shapes = {
    wideMaxLeaves: (k) => pair(wide(k)) + sites(k),
    reversedMaxPeers: (k) =>
      pair(chain(k)) + sites(k, (i) => (i % 2 ? "right, left" : "left, right")),
    interleavedMaxPeers: (k) => pair(chain(k)) + sites(k, 'false, left, "x", right'),
    aliasedMaxPeers: (k) => pair(chain(k)) + "let a = left\nlet b = right\n" + sites(k, "a, b"),
    projectedMaxPeers: (k) => pair(`{v: ${chain(k)}}`) + sites(k, "left.v, right.v"),
    wrappedMaxPeers: (k) => pair(chain(k)) + sites(k, "({v: left}).v, ({v: right}).v"),
    literalLeaves: (k) =>
      pair(`{v: [${many(k, (i) => `hostValue.f${i}`)}]}`) +
      sites(k, "left, right", "xs[i][hostValue.i].v[hostValue.j]"),
    listLeaves: (k) =>
      pair(`[${many(k, (i) => `hostValue.f${i}`)}]`) +
      sites(k, "left, right", "xs[i][hostValue.i][hostValue.j]"),
    loadDefaults: (k) => pair(`load("x", default: ${wide(k)})`) + sites(k),
    repeatChoices: (k) =>
      pair(chain(k)) +
      many(
        k,
        (i) =>
          `let n${i} = askChoice {text: "a", value: left}, {text: "b", value: right}\nsay n${i}`,
        "\n",
      ) +
      "\nexit",
    boundChoice: (k) =>
      `let left = askChoice ${many(k, (i) => `{text: "${i}", value: hostValue.f${i}}`)}\nlet right = askChoice ${many(k, (i) => `{text: "${i}", value: hostValue.f${i}}`)}\n` +
      sites(k),
    flatMaxPure: (k) => pair(`max(${many(k, (i) => i + 1)})`) + sites(k, "left, right", "xs[i][0]"),
  };
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
      "node growth.mjs <tree> desktop:~/work/evidence/1417/a0abf39f0/tools/r3/own-shapes.mjs all 64 src,rev,srcOff,revOff literalUnits,mergeItems,checks,invSteps",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:20",
    ],
    [
      "node answers.mjs <tree> <out> shapes desktop:~/work/evidence/1417/a0abf39f0/tools/r3/own-shapes.mjs 1,3,8",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:26",
    ],
    [
      "node oracle-run.mjs <base> <head> <out> desktop:~/work/evidence/1417/a0abf39f0/tools/r3/own-shapes.mjs",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:34",
    ],
  ],
  sources: 96,
  sha256: "1cf27a29c2d952fa342f094dbe56157ac4d826fa22d9f52bae5ac9436c899d30",
};
