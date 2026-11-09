// Its id is its file name before its area was grouped, which keeps its sources' places in a stored baseline.
export const id = "1428-landing-reporter.mjs";
// The landing-walk families of #1428/#1547/#1670 for the charged-reporter prototype: PR #1669's seven cost families
// (its helper and Codex r1-r3's generators), r3 B3's repeated narrow takes (equal and, by width, alternating earlier
// paths), and #1670's cold chain (the control).
export const sizes = [16, 32, 64, 128];
export const checks = ["publication", "stops"];
const T = "let typed: integer | string = 1\n";
const fields = (w, f = "f") => Array.from({ length: w }, (_, i) => `${f}${i}: typed`).join(", ");
const chain = (k, w) => {
  let s = `${T}let c0 = {p: {${fields(w)}}}\n`;
  for (let i = 0; i < k; i++) s += `let c${i + 1} = [c${i}, {p: {${fields(w)}}}][0]\n`;
  return s;
};
// (later selections of the chain's last link, each read: k + 1 takes of the k records the first opened; width w
// makes w earlier paths per record, so w > 1 repeats them alternating, never as one run)
const repeat = (k, w, swap) => {
  let s = chain(k, w);
  for (let i = 0; i <= k; i++) {
    const a = `{q: c${k}.p}`,
      b = `{q: {${fields(w)}}}`;
    s += `let x${i} = [${swap ? b : a}, ${swap ? a : b}][0]\nsay "\${x${i}.q.f0}"\n`;
  }
  return s + "exit\n";
};
const skipCross = (k, skip) => {
  let s = `${T}let c0 = {p: {a: typed}, q: {b: typed}}\n`;
  for (let i = 1; i <= k; i++)
    s += `let c${i} = [{p: c${i - 1}.p}, {p: c${Math.max(0, i - skip)}.p}, {p: {f${i}: typed}}][0]\n`;
  return (
    s + `let x = [{r: c${k}.p}, {r: c${k - skip}.p}, {r: c${k - 1}.p}][0]\nsay "\${x.r}"\nexit\n`
  );
};
const diamond = (k, width, routes) => {
  let s = `${T}let c0 = {p: {${fields(width)}}}\n`;
  for (let i = 1; i <= k; i++) {
    for (let j = 0; j < routes; j++) s += `let r${i}n${j} = {v${j}: c${i - 1}.p}\n`;
    s += `let c${i} = [${Array.from({ length: routes }, (_, j) => `{p: r${i}n${j}.v${j}}`).join(", ")}][0]\n`;
  }
  return s + `say "\${c${k}.p.f0}"\nexit\n`;
};
const cold = (k, width) => {
  let s = `${T}let c0 = {${fields(width)}}\n`;
  for (let i = 1; i <= k; i++) s += `let c${i} = c${i - 1}\nc${i}.f${i % width} = typed\n`;
  for (let j = 0; j <= k; j++)
    s += `let a${j} = [{q: c${j}}, {q: {f0: typed}}][0]\nsay "\${a${j}.q.f0}"\n`;
  return s + "exit\n";
};
export const shapes = {
  "narrow-after-chain": (k) =>
    chain(k, 1).replaceAll("f0", "f") +
    `let x = [{q: c${k}.p}, {q: {f: typed}}][0]\nsay "\${x.q.f}"\nexit\n`,
  "skip-2": (k) => {
    let s = `${T}let c0 = {p: {${fields(k)}}}\n`;
    for (let i = 1; i <= k; i++)
      s += `let c${i} = [{p: c${i - 1}.p}, {p: c${Math.max(0, i - 2)}.p}][0]\n`;
    return s + `say "\${c${k}.p.f0}"\nexit\n`;
  },
  "skip-cross-3": (k) => skipCross(k, 3),
  "skip-cross-4": (k) => skipCross(k, 4),
  "diamond-2": (k) => diamond(k, k, 2),
  "join-reach-copy-left": (k) => {
    const body = ["let xs: (integer | string)[] = [0]", "let v0 = xs"];
    for (let i = 1; i <= k; i++) body.push(`let c${i} = v${i - 1}`, `let v${i} = c${i} + [${i}]`);
    return [...body, `let s = v${k} + ["x"]`, "say s.length", "exit"].join("\n");
  },
  "rejected-link": (k) => {
    let s = `${T}let c0 = {p: {f: 1, g: typed}}\n`;
    for (let i = 1; i <= k; i++)
      s +=
        i === 2
          ? `let c${i} = [{p: {f: "s"}}, c${i - 1}][0]\n`
          : `let c${i} = [c${i - 1}, {p: {f: 1}}][0]\n`;
    return s + `let out = c${k}\nsay "\${out.p.f}"\nexit\n`;
  },
  "narrow-repeat-1": (k) => repeat(k, 1, false).replaceAll("f0", "f"),
  "narrow-repeat-1-swap": (k) => repeat(k, 1, true).replaceAll("f0", "f"),
  "narrow-repeat-3": (k) => repeat(k, 3, false),
  "cold-chain-all": (k) => cold(k, 4),
};
export const recorded = {
  commands: [
    [
      "node tests/families/run.mjs <area> <main> <main> --sizes 16,32,64,128 --shard i/24 --work … --out … (job.sh, main e477f2645, 24 shards)",
      "~/work/evidence/i1428-reporter/e477f26456817c0dc483e7140da8d8b5244fec7a/inputs-vf0/job.sh",
    ],
  ],
  sources: 44,
  sha256: "afcf356b192e110c5b901a8c7262e424372d83502aa1c57f54ba15e2b55483fa",
};
