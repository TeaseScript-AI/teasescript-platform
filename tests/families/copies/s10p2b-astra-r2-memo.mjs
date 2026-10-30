// S10 part 2b's review r2 (Astra): k loaded fields of one payload, k choice options each holding it, and k integer
// reads of the choice, at k = 64 to 1,024 (R/astra-m4-s10p2b-review-r2/memo.mjs).
const source = (k) => {
  const ids = Array.from({ length: k }, (_, i) => i);
  return `let payload = {${ids.map((i) => `f${i}: load("field-${i}", default: ${i + 4})`).join(", ")}}\nlet selected = askChoice [${ids.map((i) => `{text: "button ${i}", value: payload}`).join(", ")}]\n${ids.map((i) => `let out${i}: integer = selected.f${i}`).join("\n")}\nexit\n`;
};
export const shapes = { memo: source };

export const sizes = [64, 128, 256, 512, 1024];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "sx-queue add --name a-u3r2-252 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-252 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-pre-memo-64-0 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 pre-memo 64 0",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:255",
    ],
    [
      "sx-queue add --name a-u3r2-253 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-253 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-pre-memo-64-1 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 pre-memo 64 1",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:256",
    ],
    [
      "sx-queue add --name a-u3r2-254 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-254 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-pre-memo-128-0 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 pre-memo 128 0",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:257",
    ],
    [
      "sx-queue add --name a-u3r2-255 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-255 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-pre-memo-128-1 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 pre-memo 128 1",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:258",
    ],
    [
      "sx-queue add --name a-u3r2-256 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-256 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-pre-memo-256-0 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 pre-memo 256 0",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:259",
    ],
    [
      "sx-queue add --name a-u3r2-257 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-257 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-pre-memo-256-1 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 pre-memo 256 1",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:260",
    ],
    [
      "sx-queue add --name a-u3r2-258 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-258 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-pre-memo-512-0 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 pre-memo 512 0",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:261",
    ],
    [
      "sx-queue add --name a-u3r2-259 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-259 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-pre-memo-512-1 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 pre-memo 512 1",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:262",
    ],
    [
      "sx-queue add --name a-u3r2-260 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-260 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-pre-memo-1024-0 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 pre-memo 1024 0",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:263",
    ],
    [
      "sx-queue add --name a-u3r2-261 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-261 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-pre-memo-1024-1 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 pre-memo 1024 1",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:264",
    ],
    [
      "sx-queue add --name a-u3r2-262 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-262 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-head-64-0 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 head 64 0",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:265",
    ],
    [
      "sx-queue add --name a-u3r2-263 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-263 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-head-64-1 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 head 64 1",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:266",
    ],
    [
      "sx-queue add --name a-u3r2-264 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-264 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-head-128-0 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 head 128 0",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:267",
    ],
    [
      "sx-queue add --name a-u3r2-265 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-265 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-head-128-1 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 head 128 1",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:268",
    ],
    [
      "sx-queue add --name a-u3r2-266 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-266 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-head-256-0 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 head 256 0",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:269",
    ],
    [
      "sx-queue add --name a-u3r2-267 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-267 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-head-256-1 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 head 256 1",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:270",
    ],
    [
      "sx-queue add --name a-u3r2-268 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-268 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-head-512-0 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 head 512 0",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:271",
    ],
    [
      "sx-queue add --name a-u3r2-269 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-269 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-head-512-1 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 head 512 1",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:272",
    ],
    [
      "sx-queue add --name a-u3r2-270 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-270 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-head-1024-0 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 head 1024 0",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:273",
    ],
    [
      "sx-queue add --name a-u3r2-271 --priority 0 --dir /home/peter/work/o4-3a-lead-astra-s10p2b-r2 -- systemd-run --user --scope --quiet --unit=a-u3r2-271 -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m bash /home/peter/work/o4-3a-lead-astra-s10p2b-r2/run-job.sh memo-head-1024-1 node /home/peter/work/o4-3a-lead-astra-s10p2b-r2/evidence/memo.mjs /home/peter/work/o4-3a-lead-astra-s10p2b-r2 head 1024 1",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:274",
    ],
    [
      "- `node evidence/memo.mjs ROOT VERSION K REVERSE`: VERSION=pre-memo/head. Intercepts only the written-option `every(element.object !== null)` predicate, counting its array identities, invocations and element visits. Full record hashes and ledger counts accompany the raw counts.",
      "R/astra-m4-s10p2b-review-r2/REPRODUCE.md:13",
    ],
  ],
  sources: 5,
  sha256: "9e9793f5e1395f56fd3f06405a310f6e3bcf71db4249e1fa7ae0bd3543087b25",
};
