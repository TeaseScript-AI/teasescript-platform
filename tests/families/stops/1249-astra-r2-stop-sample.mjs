// #1249's review r2 (Astra): four of its cases with an integer read of `hostOther` added before the exit
// (R/astra-m4-i1249-review-r2-evidence/stop.mjs over its own cases.json).
export const cases = [
  ["084-0-1-job0", "let written: integer = 3\nlet firstCopy = written\nlet secondCopy = firstCopy\nlet a = {n: secondCopy}\nlet b = {n: \"other\"}\nlet xs = [a, b]\nsay xs[0].n\nlet boundary:integer=hostOther\nexit\n"],
  ["084-0-2-job0", "let written: string = \"written\"\nlet a = {outer: {inner: {n: written}}}\nlet b = {outer: {inner: {n: 7}}}\nlet c = b\nc = a\nsay c.outer.inner.n\nlet boundary:integer=hostOther\nexit\n"],
  ["084-0-3-job0", "let written: integer = 3\nlet box = {outer: {inner: {n: written}}}\nlet a = box.outer.inner\nlet b = {n: \"other\"}\nlet xs = [b, a]\nsay xs[0].n\nlet boundary:integer=hostOther\nexit\n"],
  ["084-0-4-job0", "let w:integer=1\nlet first=w\nlet alias=first\nlet a={left:{right:{n:alias}}}\nlet relay=a.left\na=relay.right\nlet b={n:\"text\"}\nlet c=a\nc=b\nsay c.n\nlet boundary:integer=hostOther\nexit\n"],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "node stop.mjs \"$review_tree\" stop-new.jsonl",
      "R/astra-m4-i1249-review-r2-evidence/REPRODUCE.md:29"
    ],
    [
      "systemd-run --user --scope --quiet --unit=astra1293r2-stop2 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m node /home/peter/work/astra1293r2/stop.mjs /home/peter/work/i1249-a2/final2 /home/peter/work/astra1293r2/stop.jsonl",
      "R/astra-m4-i1249-review-r2-evidence/jobs/done/2-20261029001055559266451-astra1293r2-stop2.job:4"
    ],
    [
      "systemd-run --user --scope --quiet --unit=astra1293r2-stop -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m node /home/peter/work/astra1293r2/stop.mjs /home/peter/work/i1249-a2/final2 /home/peter/work/astra1293r2/stop.jsonl",
      "R/astra-m4-i1249-review-r2-evidence/jobs/failed/2-20261029000913088986194-astra1293r2-stop.job:4"
    ]
  ],
  "sources": 4,
  "sha256": "a6c5d3d4955f17a7b6a18939885c50062b987686902cb0b8466ff498438477c0"
};
