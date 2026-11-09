import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const runner = resolve(process.cwd(), "tests/families/run.mjs");
export const baselines = resolve(process.cwd(), "tests/families/baselines.mjs");
export const stalls = resolve(process.cwd(), "tests/families/stalls.mjs");
export const contract = resolve(process.cwd(), "tests/families/run-contract.mjs");

/**
 * A built tree's work ledger, which every unit of its analyses' work passes (the runner counts its charges and limits
 * them at its multiple of the ledger's `allowance`, #1647), its program's allowance 30,000,000 unless given.
 */
export const LEDGER = `export class WorkLedger {
  #total = 0;
  constructor(allowance = 30000000) {
    this.allowance = allowance;
  }
  charge(counter, units = 1) {
    this.#total += units;
  }
}
`;

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A stored source line's runs, each one tree's result with its units and allowance (#1647). */
export type Stored = { runs: Record<string, { work?: number; allowance?: number | null }> };
export const storedRuns = ({ runs }: Stored) => Object.values(runs);

/**
 * A built tree's library where the source `changed` publishes its fourth part differently on the head, `throws` throws
 * and `stopped` leaves two nodes unanswered on the base, `alike` two on both, and `ends` ends the process on both.
 */
export const storable = (head: boolean): string => `import { createHash } from "node:crypto";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
export function publicationHashes(files) {
  const source = files[0].source;
  if (!${head} && source === "throws") throw new TypeError("no publication");
  if (source === "ends") process.exit(3);
  const changed = ${head} && source === "changed";
  const parts = ['"A"', '"R"', '[1,"x"]', changed ? '[2,"z"]' : '[2,"y"]', '"T"'].map((text) =>
    createHash("sha256").update(text).digest("hex"),
  );
  return { parts, unanswered: (!${head} && source === "stopped") || source === "alike" ? 2 : 0 };
}
`;

/**
 * A tree's `src/` whose git tree id is `SRC` (`git write-tree` of the same files, then `<tree>:src`): a folder sorting
 * after a file its name begins, an executable, a link, and an empty folder, which git leaves out.
 */
export const SRC = "da445cc8e80d8e4082809c34579aaed8451b7efc";
export function writeSrc(tree: string, extra = ""): void {
  mkdirSync(join(tree, "src", "a"), { recursive: true });
  mkdirSync(join(tree, "src", "empty"));
  writeFileSync(join(tree, "src", "a.ts"), `a\n${extra}`);
  writeFileSync(join(tree, "src", "a", "b.ts"), "b\n");
  writeFileSync(join(tree, "src", "run.sh"), "x\n", { mode: 0o755 });
  symlinkSync("a.ts", join(tree, "src", "link.ts"));
}

/**
 * A preload that stops the process right after its first write (`<function> <path> <data or second path>`) on a path
 * under CRASH_ROOT that CRASH_AT matches, telling CRASH_READY, so that the test kills it there (#1542).
 */
export const CRASH = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const at = new RegExp(process.env.CRASH_AT);
const tell = fs.writeFileSync;
let stopped = false;
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "linkSync", "rmSync", "rmdirSync", "copyFileSync"]) {
  const original = fs[name];
  fs[name] = function (...args) {
    const result = original.apply(this, args);
    const done = name + " " + args.slice(0, 2).map(String).join(" ");
    if (!stopped && args.slice(0, 2).some((arg) => String(arg).startsWith(process.env.CRASH_ROOT)) && at.test(done)) {
      stopped = true;
      tell(process.env.CRASH_READY, done);
      for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    return result;
  };
}
syncBuiltinESMExports();
`;

/**
 * A built tree's library whose runs charge its ledger (allowance 1,000) 300 units, the source HEAVY names 3,500 (over 3
 * times its allowance, within 4 times it); where `ends` ends the process on every run, and `flaky` and `mixed` end it on
 * the runs FLAKY's characters say (`x`, one each, counted in TMPDIR, which a fill's stores share); `flaky` waits SLOW
 * ms in its first run.
 */
export const FILLABLE = `import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkLedger } from "../../src/type-inference/core/budget.js";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
export function publicationHashes(files) {
  const source = files[0].source;
  new WorkLedger(1000).charge("frames", source === process.env.HEAVY ? 3500 : 300);
  if (source === "ends") process.exit(3);
  if (source === "flaky" && process.env.SLOW !== undefined && !globalThis.slept) {
    globalThis.slept = true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.SLOW));
  }
  if ((source === "flaky" || source === "mixed") && process.env.FLAKY !== undefined) {
    const count = join(process.env.TMPDIR, "flaky");
    const left = existsSync(count) ? readFileSync(count, "utf8") : process.env.FLAKY;
    writeFileSync(count, left.slice(1));
    if (left[0] === "x") process.exit(4);
  }
  return { parts: [createHash("sha256").update(source).digest("hex")], unanswered: 0 };
}
`;

/**
 * A built tree's library whose analyses charge its ledger (allowance 1,000) 300 units a run: `over` 5,000 more on the
 * head, `both` on both trees, `budget` 1,500 more (past its allowance, within 4 times it); `ledgers` 7,001 more on three
 * ledgers of allowances 1,000, 2,000 and 1,000 (within 4 times the largest only); `noisy` on the head writes 1 MiB on
 * stderr, then charges 5,000; `slowall` waits 1.8 s each run on each tree, and `hang` 6 s in the head's first (#1850: under a 3 s safety net, a margin
 * of over a second either way). Where
 * `between`, the modes wait 1.5 s before the first: between the source's runs, in none; `grow` charges 90,000 on the
 * head on a ledger of allowance 100,000, within 4 times it; without a `ledger`, it charges
 * a ledger of its own, which no runner counts.
 */
export const unitsLibrary = (
  head: boolean,
  between = false,
  ledger = true,
): string => `${ledger ? 'import { WorkLedger } from "../../src/type-inference/core/budget.js";' : "class WorkLedger { charge() {} }"}
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const modes = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
export const MODES = ${between} ? { *[Symbol.iterator]() { wait(1500); yield* modes; } } : modes;
export function publicationHashes(files, mode) {
  const source = files[0].source;
  const ledger = new WorkLedger(1000);
  ledger.charge("frames", 300);
  if (source === "both" || (${head} && source === "over")) ledger.charge("frames", 5000);
  if (source === "budget") ledger.charge("frames", 1500);
  if (${head} && source === "grow") new WorkLedger(100000).charge("frames", 90000);
  if (source === "ledgers") {
    new WorkLedger(1000).charge("frames", 3500);
    new WorkLedger(2000).charge("frames", 3500);
    new WorkLedger(1000).charge("frames", 1);
  }
  if (${head} && source === "noisy") {
    process.stderr.write("x".repeat(1 << 20));
    ledger.charge("frames", 5000);
  }
  if (source === "slowall") wait(1800);
  if (${head} && source === "hang" && mode === modes[0]) wait(6000);
  return { parts: ["a", "b"], unanswered: 0 };
}
`;
