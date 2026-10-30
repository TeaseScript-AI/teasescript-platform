// S8c's review r2 (Astra): the file geometry of a demand, a chain of 144 global seeds split over main, alpha and beta,
// read and stored in one of the three files, directly or in a global function main calls, with 20 unused functions in
// the next file or none (R/astra-m4-s8c-review-r2-evidence/worker/geometry.mjs, run with SECTION=files).
function files(where, callable, padding) {
  const k = 144;
  const files = ["main.tease", "alpha.tease", "beta.tease"].map((path) => ({ path, lines: [] }));
  files[0].lines.push("global seed0 = 1.5");
  for (let i = 1; i <= k; i++)
    files[Math.floor((i - 1) / 48)].lines.push(`global seed${i} = seed${i - 1}`);
  const read = `repeat seed${k} {}\nseed${k} = 2`;
  files[where].lines.push(callable ? `global function verify {\n${read}\n}` : read);
  for (let i = 0; i < padding; i++)
    files[(where + 1) % 3].lines.push(`function unused${i} { say ${i} }`);
  if (callable) files[0].lines.push("verify()");
  return files.map((f, i) => ({
    path: f.path,
    source: f.lines.join("\n") + (i === 0 ? "\nexit\n" : "\nend\n"),
  }));
}
export const cases = [0, 1, 2].flatMap((where) =>
  [false, true].flatMap((callable) =>
    [0, 20].map((padding) => [`${where}/${callable}/${padding}`, files(where, callable, padding)]),
  ),
);

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "SECTION=files timeout 180m node worker/geometry.mjs > results/geometry-files.jsonl 2> results/geometry-files.err",
      "R/astra-m4-s8c-review-r2-evidence/worker/run-geometry.sh:3",
    ],
  ],
  sources: 12,
  sha256: "d97d32e0ca3fb055493337c226972c86b1bfd5ef4450b5b93b01bd614b5ab896",
};
