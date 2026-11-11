import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT, jobId, ran, standInQueue, tool, write } from "./compiler-replay/test-fixtures.mjs";

test("a step the tool does not have, or one missing its arguments, is a usage error", () => {
  for (const args of [[], ["replay"], ["submit", "b"], ["collect", "p"]]) {
    const run = spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
    assert.equal(run.status, 2, args.join(" "));
  }
});

/**
 * A built tree whose oracle's source `over` charges five times its program's allowance, on every tree: a stall of the
 * real `run.mjs` that `stalls.mjs` indexes.
 */
function stallingTree(folder) {
  const core = join(folder, "dist", "src", "type-inference", "core");
  mkdirSync(core, { recursive: true });
  mkdirSync(join(folder, "dist", "tests", "helpers"), { recursive: true });
  writeFileSync(join(folder, "package.json"), '{ "type": "module" }\n');
  writeFileSync(
    join(core, "budget.js"),
    "export class WorkLedger {\n  constructor(allowance) {\n    this.allowance = allowance;\n  }\n  charge() {}\n}\n",
  );
  writeFileSync(
    join(folder, "dist", "tests", "helpers", "type-core-oracles.js"),
    `import { WorkLedger } from "../../src/type-inference/core/budget.js";
export const MODES = [false, true].flatMap((reversed) => [false, true].map((unshared) => ({ reversed, unshared })));
export function publicationHashes(files) {
  new WorkLedger(1000).charge("frames", files[0].source === "over" ? 5000 : 10);
  return { parts: ["a", "b"], unanswered: 0 };
}
`,
  );
  return folder;
}

test("submit, rerun-stalls and aside each remove the temporary folder they made, also when they refuse or the queue does (#2433)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "compiler-replay-steps-"));
  try {
    // (the tool's TMPDIR, empty: what it leaves there is what it made)
    const temp = join(scratch, "tmp");
    const [bin, refusing] = [join(scratch, "bin"), join(scratch, "refusing")];
    for (const folder of [temp, bin, refusing]) mkdirSync(folder);
    const calls = standInQueue(bin);
    writeFileSync(join(refusing, "sx-job"), "#!/bin/sh\necho 'the queue refuses' >&2\nexit 1\n");
    chmodSync(join(refusing, "sx-job"), 0o755);
    const step = (queue, ...args) =>
      spawnSync(process.execPath, [tool, ...args], {
        encoding: "utf8",
        env: { ...process.env, TMPDIR: temp, PATH: `${queue}:${process.env.PATH}` },
      });
    const left = () => readdirSync(temp);
    // (an area's one shard, as its job leaves it: the real runner's work records of a stall, or none)
    const results = (name, work) => {
      const root = join(scratch, name);
      const job = join(root, "p-areas", jobId("a", 0));
      write(join(job, "meta.json"), [ran("rings-0of1")]);
      const out = join(job, "out");
      write(join(out, "rings.log"), [{ area: "rings", sources: 2, runs: 8, differences: 0 }]);
      if (work !== undefined) {
        const area = join(scratch, "rings");
        mkdirSync(area, { recursive: true });
        writeFileSync(
          join(area, "g.mjs"),
          'export const cases = [["over", "over"], ["fine", "fine"]];\n',
        );
        const tree = stallingTree(join(scratch, "tree"));
        const run = spawnSync(
          process.execPath,
          [join(ROOT, "tests/families/run.mjs"), area, tree, tree, "--shard", "0/1"].concat([
            "--work",
            join(out, "rings.work.jsonl"),
          ]),
          { encoding: "utf8" },
        );
        assert.equal(run.status, 1, run.stderr);
      }
      return root;
    };
    const [none, stalled] = [results("none"), results("stalled", true)];
    const declare = join(scratch, "declare.json");
    writeFileSync(declare, '[{"pattern": "a", "reason": "a stand-in"}]');
    const submit = ["submit", "b".repeat(40), "h".repeat(40), "--owner", "o", "--campaign", "p"];
    const stalls = (root) => ["rerun-stalls", "p", "b", "h", "--owner", "o", "--results", root];
    const aside = ["aside", "p", "b", "h", "--owner", "o", "--declare", declare, "--results", none];
    for (const [what, queue, args, status, out] of [
      ["submit", bin, submit, 0, /campaigns: p-set, p-areas/u],
      ["submit, the queue refusing", refusing, submit, 2, /the queue refuses/u],
      ["rerun-stalls, no stall", bin, stalls(none), 0, /^no stalled source$/mu],
      ["rerun-stalls", bin, stalls(stalled), 0, /^11111111111111$/mu],
      ["rerun-stalls, the queue refusing", refusing, stalls(stalled), 2, /the queue refuses/u],
      ["aside", bin, aside, 0, /^11111111111111$/mu],
      ["aside, the queue refusing", refusing, aside, 2, /the queue refuses/u],
    ]) {
      const run = step(queue, ...args);
      assert.equal(run.status, status, `${what}: ${run.stderr}`);
      assert.match(run.stdout + run.stderr, out, what);
      assert.deepEqual(left(), [], what);
    }
    // (the queue read each step's file before the step removed it: the stall's index and aside's rows, as written)
    const read = Object.assign({}, ...calls().map(({ inputs }) => inputs));
    assert.equal(JSON.parse(read["index.json"]).entries.length, 1);
    assert.equal(read["rows.jsonl"], "\n");
    // (each step handed the queue a file in its own folder under the TMPDIR it was given)
    const given = calls().map(({ args }) =>
      args[0] === "submit-batch" ? args[1] : args.find((arg) => /^(index|rows)\.json/u.test(arg)),
    );
    assert.equal(given.length, 3);
    for (const file of given)
      assert.match(
        file,
        new RegExp(`^(index\\.json=|rows\\.jsonl=)?${temp}/compiler-replay-\\w{6}/`, "u"),
      );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
