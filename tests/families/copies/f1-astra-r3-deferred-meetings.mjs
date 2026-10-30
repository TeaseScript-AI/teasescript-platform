// F1, Astra r3 (R/astra-m4-f1-review-r3-evidence/deferred.mjs): the deferred meetings, prefixes and their one-literal
// control at 4, 8, 64 and 128, and the meetings and prefixes also at 16 and 32, as its runs compiled them.

const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const fields = (n, f, p = "f") =>
  rows(n, (i) => `${p}${i}:${typeof f === "function" ? f(i) : f}`).join(",");
const tease = (...xs) => xs.flat(Infinity).join("\n") + "\nexit\n";
export function meeting(n, literals = 2) {
  return tease(
    "let t:integer=1",
    `let plain={${fields(n, "{left:1,right:1}")}}`,
    rows(n, (i) => `let w${i}={q:t}`),
    rows(
      literals,
      (j) =>
        `let p${j}={${fields(n, (i) => `w${i}`, "y")},${fields(n, (i) => `plain.f${i}`, "x")}}`,
    ),
  );
}
export function prefixes(n) {
  return tease(
    "let t:integer=1",
    "let w={q:t,r:1}",
    `let root={${fields(n, () => "{a:{b:{c:w,d:w},e:w},z:w}")}}`,
    "let a=root",
    "let b=a",
    rows(n, (i) => [
      `b.f${i}.a.b.c=w`,
      `b.f${i}.z=w`,
      `b.f${i}.a.b.d.r=2`,
      `let r${i}=b.f${i}.a.b`,
      `let s${i}=b.f${i}.a.b.c`,
      `let u${i}=b.f${i}.a.b.c.q`,
    ]),
  );
}
export const deferred = {
  "meet-reads-groups-shared": meeting,
  "valid-copy-prefixes": prefixes,
  "one-literal-control": (n) => meeting(n, 1),
};

export const sizes = [4, 8, 64, 128];
export const shapes = deferred;
export const cases = ["meet-reads-groups-shared", "valid-copy-prefixes"].flatMap((name) =>
  [16, 32].map((n) => [`${name}@${n}`, deferred[name](n)]),
);
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node charge-series.mjs --sizes=4,8 --out=charge-quick.jsonl",
      "R/astra-m4-f1-review-r3-evidence/reproduce.sh:34",
    ],
    [
      "node charge-series.mjs --out=deferred.jsonl",
      "R/astra-m4-f1-review-r3-evidence/reproduce.sh:35",
    ],
    [
      "node instrument.mjs --sizes=4 --out=instrument-quick.jsonl",
      "R/astra-m4-f1-review-r3-evidence/reproduce.sh:36",
    ],
    ["node instrument.mjs --sizes=8,16,32,64", "R/astra-m4-f1-review-r3-evidence/reproduce.sh:37"],
  ],
  sources: 16,
  sha256: "cc30830a2a1b51d69a281648e24263bea784898ad2a5cc86dd211c4a1ea399f5",
};
