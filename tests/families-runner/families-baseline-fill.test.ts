import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  runner,
  baselines,
  LEDGER,
  storedRuns,
  CRASH,
  FILLABLE,
} from "../helpers/families-runner/families-runner-stand-ins.js";

test("a fill on any worker: a seed, its shards computed and imported into a central store, which refuses or compares what differs, and its status without a tree (#1590)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    // built trees with the tools: `alias` the same build at another path and commit, `rebuilt` another build of the
    // compiler (its dist/src/) from the same src/
    const tree = (name: string, sha: string, compiled = "compiled\n") => {
      const folder = join(directory, name);
      for (const part of ["dist/src", "dist/tests/helpers", "src", "tests/families/area"])
        mkdirSync(join(folder, part), { recursive: true });
      writeFileSync(join(folder, "src", "a.ts"), "a\n");
      writeFileSync(join(folder, "dist", "src", "a.js"), compiled);
      mkdirSync(join(folder, "dist", "src", "type-inference", "core"), { recursive: true });
      writeFileSync(join(folder, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
      writeFileSync(join(folder, "dist", "tests", "helpers", "type-core-oracles.js"), FILLABLE);
      writeFileSync(join(folder, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(folder, "package-lock.json"), "{}\n");
      writeFileSync(join(folder, ".sha"), `${sha.repeat(40)}\n`);
      for (const tool of ["baselines.mjs", "run-contract.mjs", "run.mjs", "sources.mjs"])
        cpSync(join("tests", "families", tool), join(folder, "tests", "families", tool));
      writeFileSync(
        join(folder, "tests", "families", "area", "stored.mjs"),
        // (shard i of 16 holds the sources i and i + 16: shard 1 `ends` and `mixed`)
        `export const cases = ${JSON.stringify(
          [
            "same",
            "ends",
            "flaky",
            ...[...Array(14).keys()].map((index) => `s${index + 3}`),
            "mixed",
          ].map((name) => [name, name]),
        )};\n`,
      );
      return folder;
    };
    const built = tree("built", "1");
    const alias = tree("alias", "2");
    const rebuilt = tree("rebuilt", "1", "compiled otherwise\n");
    const sha = "1".repeat(40);
    const { identityOf, comparedOf, planOf } = await import(pathToFileURL(baselines).href);
    const src: string = identityOf(built).src;
    const script = resolve("tools", "corpus", "baseline.sh");
    const scratch = join(directory, "scratch");
    mkdirSync(scratch);
    const env = { ...process.env, TMPDIR: scratch, SX_SCRATCH: "" };
    const sh = (more: Record<string, string>, ...args: string[]) =>
      spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...env, ...more } });
    const tool = (...args: string[]) =>
      spawnSync(process.execPath, [baselines, ...args], { encoding: "utf8" });
    const said = (result: { stdout: string }) =>
      JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    const at = (...parts: string[]) => join(directory, ...parts);
    const shard = (root: string, index: number) => at(root, src, "area", `${index}of16.runs.jsonl`);
    const listed = (root: string) =>
      JSON.parse(readFileSync(at(root, "stalls.json"), "utf8")).stalls;
    const runsIn = (lines: string[]) =>
      lines.slice(0, -1).reduce((sum, line) => sum + Object.keys(JSON.parse(line).runs).length, 0);

    // the seed: a baseline with what its runs depend on, the commit, the build and the area's PLAN, no shard, and the
    // shards to store as the hook queues them; the fill's jobs as #1590 submits them (each command inside `bash -c`,
    // which sx-job runs without a shell)
    assert.equal(sh({}, "seed", built, sha, at("seed")).status, 0);
    const manifest = readFileSync(at("seed", src, "MANIFEST"), "utf8").split("\n");
    assert.equal(manifest[5], `commit ${sha} ${built}`);
    assert.match(manifest[6]!, /^area area 16 [0-9a-f]{64}$/);
    assert.deepEqual(manifest.slice(7), [`compiled ${comparedOf(built).compiled}`, ""]);
    assert.deepEqual(readdirSync(at("seed", src, "area")), ["PLAN"]);
    const shards = [...Array(16).keys()].map((index) => `area\t${index}\t16\n`).join("");
    assert.equal(readFileSync(at("seed", "shards.tsv"), "utf8"), shards);
    const fill = `fill-${src.slice(0, 9)}`;
    assert.equal(
      sh({}, "submit", sha, src, "--dry").stdout,
      `sx-job submit --owner baseline --name ${fill}-seed --priority background --commit ${sha} -- bash -c 'bash "$SX_TREE/tools/corpus/baseline.sh" seed "$SX_TREE" ${sha} "$SX_OUT"'\n`,
    );
    const lines = sh({}, "submit", sha, src, "11020125", at("seed", "shards.tsv"), "--dry").stdout;
    assert.deepEqual(lines.split("\n").slice(1, 2), [
      `sx-job submit --owner baseline --name ${fill}-area-1 --priority background --campaign ${fill} --commit ${sha} --in-result seed=11020125 -- bash -c 'bash "$SX_TREE/tools/corpus/baseline.sh" compute "$SX_TREE" "$SX_IN/seed/out/${src}" area 1/16 "$SX_OUT"'`,
    ]);
    assert.equal(lines.split("\n").length, 17);

    // shards computed from the seed: a stall (`ends`, which ends the process) stored once and listed in stalls.json with
    // its reason, no run alone (#1647: a stall is the same on every machine); the store's record of each source beside
    // (each into a new folder, as the queue's $SX_OUT is)
    const compute = (out: string, index: number, more = {}, from = built) => {
      mkdirSync(at(out), { recursive: true });
      return sh(more, "compute", from, at("seed", src), "area", `${index}/16`, at(out));
    };
    for (const [out, index] of [
      ["zero", 0],
      ["one", 1],
      ["two", 2],
    ] as const) {
      const computed = compute(out, index);
      assert.equal(computed.status, 0, computed.stderr);
      assert.ok(existsSync(at(out, `area.${index}of16.work.jsonl`)), out);
    }
    assert.deepEqual(listed("zero"), []);
    assert.deepEqual(listed("one"), [
      {
        area: "area",
        shard: "1/16",
        generator: "stored.mjs",
        source: "ends",
        key: JSON.parse(readFileSync(shard("one", 1), "utf8").split("\n")[0]!).key,
        stalled: "exit 3",
      },
    ]);
    assert.deepEqual(listed("two"), []);
    // the seed's limits (#1647), at which its shards are stored: a run over its unit limit stalls whatever its time,
    // listed with the run it cut (`mixed`, 3,500 units, at 3 times its allowance), and ends within 4 times it; a run
    // that reaches its safety net (`flaky`, which waits 2.6 s once at 2 s) is uncharged work, stored so, no stall
    assert.equal(
      sh({ FAMILIES_UNITS: "3", FAMILIES_TIMEOUT: "2" }, "seed", built, sha, at("seed-short"))
        .status,
      0,
    );
    assert.match(
      readFileSync(at("seed-short", src, "area", "PLAN"), "utf8"),
      /^limits 3 x allowance units, 2 s safety net, 2048 MB$/m,
    );
    const short = (out: string, index: number, more = {}) => {
      mkdirSync(at(out), { recursive: true });
      return sh(more, "compute", built, at("seed-short", src), "area", `${index}/16`, at(out));
    };
    const heavy = short("heavy", 1, { HEAVY: "mixed" });
    assert.equal(heavy.status, 0, heavy.stderr);
    assert.deepEqual(
      listed("heavy").map(({ source, stalled, cut }: Record<string, unknown>) => [
        source,
        stalled,
        cut,
      ]),
      [
        ["ends", "exit 3", undefined],
        ["mixed", "units", { run: "src-on publication", work: 3500, allowance: 1000 }],
      ],
    );
    const within = compute("within", 1, { HEAVY: "mixed" });
    assert.equal(within.status, 0, within.stderr);
    assert.deepEqual(
      storedRuns(JSON.parse(readFileSync(shard("within", 1), "utf8").split("\n")[1]!)).map(
        ({ work }) => work,
      ),
      [3500, 3500, 3500, 3500],
    );
    const slow = short("slow", 2, { SLOW: "2600" });
    assert.equal(slow.status, 0, slow.stderr);
    assert.deepEqual(listed("slow"), []);
    const [reached, slowEnd] = readFileSync(shard("slow", 2), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      [reached.stalled, reached.uncharged, slowEnd.total.uncharged, slowEnd.total.timeout],
      [undefined, "src-on publication", 1, 2],
    );

    // the central store: the seed adopted, then equal; status reads the tree's own folder without a tree, another
    // tree's absent
    const central = at("central");
    assert.deepEqual(said(tool("import", central, at("seed"))).seed, "adopted");
    assert.deepEqual(said(tool("import", central, at("seed"))).seed, "equal");
    const status = (of = src) => tool("status", central, of);
    assert.deepEqual(
      [status().status, status().stdout],
      [1, `baseline ${src}: ${join(central, src)}: incomplete: area partial 0/16\n`],
    );
    const other = "e".repeat(40);
    assert.deepEqual(
      [status(other).status, status(other).stdout],
      [1, `baseline ${other}: ${join(central, other)}: absent\n`],
    );
    // each shard imported, the empty ones from one copy of the seed; then complete
    const imported = (root: string, index: number) =>
      tool("import", central, at(root), "area", `${index}/16`);
    for (const [root, index] of [
      ["zero", 0],
      ["one", 1],
      ["two", 2],
    ] as const)
      assert.equal(said(imported(root, index)).verified, true);
    assert.equal(tool("import", at("rest"), at("seed")).status, 0);
    for (let index = 3; index < 16; index += 1) {
      const run = spawnSync(process.execPath, [
        runner,
        join(built, "tests", "families", "area"),
        built,
        "--store",
        at("rest"),
        "--shard",
        `${index}/16`,
      ]);
      assert.equal(run.status, 0);
      // (shard 3's total as a runner before #1592 wrote it, without `unansweredAlike`: imported, and read by status and
      // the comparison, beside shards whose total has it)
      if (index === 3) {
        const stored = join(at("rest"), src, "area", "3of16.runs.jsonl");
        const text = readFileSync(stored, "utf8");
        assert.match(text, /,"unansweredAlike":0,[^\n]*\n$/);
        writeFileSync(stored, text.replace(/,"unansweredAlike":0(,[^\n]*\n)$/, "$1"));
      }
      assert.equal(imported("rest", index).status, 0);
    }
    assert.doesNotMatch(
      readFileSync(join(central, src, "area", "3of16.runs.jsonl"), "utf8"),
      /unansweredAlike/,
    );
    assert.deepEqual(
      [status().status, status().stdout],
      [0, `baseline ${src}: ${join(central, src)}: complete: area\n`],
    );
    // the complete central baseline serves its consumer: the built tree compared against it, every run compared and
    // agreeing, the one stall its own (`ends`, stored stalled)
    const served = spawnSync(
      process.execPath,
      [
        runner,
        join(built, "tests", "families", "area"),
        built,
        "--baseline",
        join(central, src, "area"),
      ],
      { encoding: "utf8" },
    );
    const { sources, differences, exceptions, uncompared, unanswered, stalled } = said(served);
    assert.deepEqual(
      [served.status, sources, differences, exceptions, uncompared, unanswered, stalled],
      [1, 18, 0, 0, 0, 0, 1],
      served.stderr,
    );

    // refused (exit 2) and nothing written: another build of the compiler (computed from `rebuilt`), another MANIFEST
    // line (a commit and tree), another PLAN, another Node, a stall stalls.json does not list so, a stall over the unit
    // limit whose cut run is not over it, no baseline
    const contents = () =>
      readdirSync(join(central, src, "area"))
        .sort()
        .map((name) => [name, readFileSync(join(central, src, "area", name), "utf8")]);
    const before = contents();
    const recomputed = compute("rebuilt", 0, {}, rebuilt);
    assert.equal(recomputed.status, 0, recomputed.stderr);
    const copied = (from: string, name: string, change: (dir: string) => void) => {
      cpSync(at(from), at(name), { recursive: true });
      change(at(name, src));
      return name;
    };
    const edit = (file: string, from: RegExp | string, to: string) =>
      writeFileSync(file, readFileSync(file, "utf8").replace(from, to));
    const plan = (dir: string) => {
      // (a PLAN this tool writes, of other checks)
      const text = readFileSync(join(dir, "area", "PLAN"), "utf8").replace(
        /^(allowances .*)$/m,
        "$1\nchecks other.mjs publication",
      );
      writeFileSync(join(dir, "area", "PLAN"), text);
      edit(
        join(dir, "MANIFEST"),
        /^area area 16 \w+$/m,
        `area area 16 ${createHash("sha256").update(text).digest("hex")}`,
      );
    };
    // (a copy of shard 1 whose `mixed` stalled over the unit limit with the run it cut, `charged`, listed with it or not)
    const cutCopy = (
      name: string,
      charged: { work: number; allowance: number },
      withCut: boolean,
    ) =>
      copied("one", name, (dir) => {
        const file = join(dir, "area", "1of16.runs.jsonl");
        const lines = readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const ended = lines.pop();
        const cut = { run: "src-on publication", ...charged };
        Object.assign(lines[1], { stalled: "units", cut, runs: {} });
        const body = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
        ended.total.lines = createHash("sha256").update(body).digest("hex");
        ended.total.stalled = 2;
        writeFileSync(file, `${body}${JSON.stringify(ended)}\n`);
        const listing = JSON.parse(readFileSync(at(name, "stalls.json"), "utf8"));
        const [own] = listing.stalls;
        const entry = { ...own, source: "mixed", key: lines[1].key, stalled: "units" };
        listing.stalls.push(withCut ? { ...entry, cut } : entry);
        writeFileSync(at(name, "stalls.json"), JSON.stringify(listing));
      });
    for (const [root, index, refusal] of [
      ["rebuilt", 0, /names "compiled \w+" \(a build of the compiler, dist\/src\/\)/],
      [
        copied("zero", "commit", (dir) =>
          edit(join(dir, "MANIFEST"), /$/, `commit ${"2".repeat(40)} ${alias}\n`),
        ),
        0,
        /names "commit 2{40} .*alias" \(a commit and tree/,
      ],
      [copied("zero", "plan", plan), 0, /names "area area 16 \w+" \(an area's PLAN\)/],
      [
        copied("zero", "node", (dir) => edit(join(dir, "MANIFEST"), /^node v.*$/m, "node v0.0.0")),
        0,
        /names "node v0\.0\.0" \(what its runs depend on\)/,
      ],
      [
        copied("one", "unlisted", () => rmSync(at("unlisted", "stalls.json"))),
        1,
        /stored\.mjs ends stalled \(exit 3\), and stalls\.json does not list it so/,
      ],
      [
        copied("zero", "damaged", (dir) =>
          edit(join(dir, "area", "0of16.runs.jsonl"), /\{"total".*\n$/, ""),
        ),
        0,
        /0of16\.runs\.jsonl is no shard that counts/,
      ],
      [
        // (a listing of another reason than the shard's stalled line)
        copied("one", "reason", () =>
          edit(at("reason", "stalls.json"), '"stalled":"exit 3"}', '"stalled":"timeout"}'),
        ),
        1,
        /stored\.mjs ends stalled \(exit 3\), and stalls\.json does not list it so/,
      ],
      [
        copied("one", "twice-listed", () =>
          edit(at("twice-listed", "stalls.json"), /\[(.*)\]/, "[$1,$1]"),
        ),
        1,
        /stalls\.json lists 2 stalled sources, the shard has 1/,
      ],
      [
        copied("one", "forged", (dir) =>
          edit(join(dir, "area", "1of16.runs.jsonl"), '"stalled":1,', '"stalled":0,'),
        ),
        1,
        /total counts 2 sources and 0 stalled, its lines 2 and 1/,
      ],
      // (#1647: a stall over the unit limit is certified by the run it cut, a charged ledger's, over the PLAN's 4 times
      // its allowance, and listed with it)
      ...(
        [
          [
            "uncertified",
            { work: 4000, allowance: 1000 },
            true,
            /stored\.mjs mixed: its stall is not a run cut over 4 times its allowance/,
          ],
          [
            "uncharged-cut",
            { work: 1, allowance: 0 },
            true,
            /stored\.mjs mixed: its stall is not a run cut over 4 times its allowance/,
          ],
          [
            "uncut",
            { work: 4001, allowance: 1000 },
            false,
            /stored\.mjs mixed stalled \(units\), and stalls\.json does not list it so/,
          ],
        ] as const
      ).map(
        ([name, charged, withCut, refusal]) =>
          [cutCopy(name, charged, withCut), 1, refusal] as const,
      ),
      [
        copied("one", "elsewhere", () =>
          edit(
            at("elsewhere", "stalls.json"),
            '"shard":"1/16","generator"',
            '"shard":"2/16","generator"',
          ),
        ),
        1,
        /lists a stall of another shard than area 1\/16: stored\.mjs ends/,
      ],
      // (each source line one a store writes, as the comparison reads it: Codex r2's `runs: null`, and a result whose
      // `unparsed` is no boolean; each with its digest repaired, so that it counts)
      ...(
        [
          [
            "no-runs",
            (line: string) => line.replace(/"runs":\{.*\}\}$/, '"runs":null}'),
            /its runs are no object/,
          ],
          [
            "unparsed-text",
            (line: string) => line.replace('"unparsed":false', '"unparsed":"no"'),
            /its run "src-on publication" is not one a store writes/,
          ],
          // (#1647: a plan 2 run without its units, and one that ended over the unit limit)
          [
            "no-units",
            (line: string) => line.replace(/,"work":\d+/, ""),
            /stored\.mjs same: its run "src-on publication" is not one a store writes/,
          ],
          [
            "ended-over",
            (line: string) => line.replace(/"work":\d+/, '"work":4001'),
            /stored\.mjs same: its run "src-on publication" is not one a store writes/,
          ],
          // (Codex r3: a hash proved a string before its pattern, which an array or object would pass by coercion)
          [
            "array-hash",
            (line: string) => line.replace(/"hash":("[0-9a-f]{64}")/, '"hash":[$1]'),
            /stored\.mjs same: its run "src-on publication" is not one a store writes/,
          ],
          [
            "object-hash",
            (line: string) => line.replace(/"hash":"[0-9a-f]{64}"/, '"hash":{"toString":false}'),
            /stored\.mjs same: its run "src-on publication" is not one a store writes/,
          ],
        ] as const
      ).map(
        ([name, change, refusal]) =>
          [
            copied("zero", name, (dir) => {
              const file = join(dir, "area", "0of16.runs.jsonl");
              const [line, ...rest] = readFileSync(file, "utf8").trim().split("\n");
              const ended = JSON.parse(rest.pop()!);
              const body = [change(line!), ...rest].map((one) => `${one}\n`).join("");
              ended.total.lines = createHash("sha256").update(body).digest("hex");
              writeFileSync(file, `${body}${JSON.stringify(ended)}\n`);
            }),
            0,
            refusal,
          ] as const,
      ),
      ["empty", 0, /holds no baseline of this tool/],
    ] as const) {
      const refused = imported(root, index);
      assert.deepEqual([root, refused.status], [root, 2]);
      assert.match(said(refused).refused, refusal);
    }
    // (and a seed that names no build of the compiler, and a central baseline whose PLAN its seed's adoption did not
    // make yet)
    copied("seed", "unnamed", (dir) => edit(join(dir, "MANIFEST"), /^compiled \w+\n/m, ""));
    assert.match(
      said(tool("import", at("unnamed-central"), at("unnamed"))).refused,
      /names no build of the compiler/,
    );
    // (its areas known only with its tree, such a baseline is never complete without one)
    const unseeded = tool("status", at("unnamed"), src);
    assert.equal(unseeded.status, 1);
    assert.match(unseeded.stdout, /incomplete: no seed recorded its areas/);
    // a seed is checked as data received from elsewhere: a PLAN of no shard (which would read complete with no run in
    // it), refused by `import` and by `status`, and a seed that records no area
    copied("seed", "shardless", (dir) => {
      const text = `${readFileSync(join(dir, "area", "PLAN"), "utf8")
        .split("\n")
        .filter((line) => !line.startsWith("shard "))
        .join("\n")
        .replace(/^shards 16$/m, "shards 0")}`;
      writeFileSync(join(dir, "area", "PLAN"), text);
      edit(
        join(dir, "MANIFEST"),
        /^area area 16 \w+$/m,
        `area area 0 ${createHash("sha256").update(text).digest("hex")}`,
      );
    });
    assert.match(
      said(tool("import", at("shardless-central"), at("shardless"))).refused,
      /MANIFEST is not one this tool writes: its line 7 is no line this tool writes: "area area 0 /,
    );
    const shardless = tool("status", at("shardless"), src);
    assert.equal(shardless.status, 2);
    assert.match(shardless.stdout, /is not one this tool writes/);
    // (a MANIFEST record by record, refused before anything is written: Codex r2's `..` area with its PLAN beside the
    // baseline, and an area record of a negative count; `status` refuses such a record too)
    const dotdot = planOf("..", [], 1);
    copied("seed", "dotdot", (dir) => {
      edit(
        join(dir, "MANIFEST"),
        /$/,
        `area .. 1 ${createHash("sha256").update(dotdot).digest("hex")}\n`,
      );
      writeFileSync(join(dir, "..", "PLAN"), dotdot);
    });
    copied("seed", "negative", (dir) =>
      edit(join(dir, "MANIFEST"), /$/, `area missing -1 ${"0".repeat(64)}\n`),
    );
    for (const [root, line] of [
      ["dotdot", /its line 9 is no line this tool writes: "area \.\. 1 /],
      ["negative", /its line 9 is no line this tool writes: "area missing -1 /],
    ] as const) {
      const refused = tool("import", at(`${root}-central`), at(root));
      assert.deepEqual([root, refused.status], [root, 2]);
      assert.match(said(refused).refused, line);
      assert.equal(existsSync(at(`${root}-central`)), false);
    }
    cpSync(central, at("misrecorded"), { recursive: true });
    edit(at("misrecorded", src, "MANIFEST"), /$/, `area missing -1 ${"0".repeat(64)}\n`);
    const misrecorded = tool("status", at("misrecorded"), src);
    assert.equal(misrecorded.status, 2);
    assert.match(misrecorded.stdout, /its line 9 is no line this tool writes: "area missing -1 /);
    // (a PLAN of its record's count without its last shard's entry, the record's hash repaired: refused by `import` and by
    // `status`; and a stored shard of the central store whose lines are not a store's, its digest repaired, which
    // `status` refuses)
    copied("seed", "entryless", (dir) => {
      const text = readFileSync(join(dir, "area", "PLAN"), "utf8").replace(/^shard 15 .*\n/m, "");
      writeFileSync(join(dir, "area", "PLAN"), text);
      edit(
        join(dir, "MANIFEST"),
        /^area area 16 \w+$/m,
        `area area 16 ${createHash("sha256").update(text).digest("hex")}`,
      );
    });
    assert.match(
      said(tool("import", at("entryless-central"), at("entryless"))).refused,
      /area's PLAN is not one this tool writes: its entry of shard 15 is missing or out of order/,
    );
    const entryless = tool("status", at("entryless"), src);
    assert.equal(entryless.status, 2);
    assert.match(entryless.stdout, /its entry of shard 15 is missing or out of order/);
    cpSync(central, at("malformed-store"), { recursive: true });
    cpSync(
      at("no-runs", src, "area", "0of16.runs.jsonl"),
      at("malformed-store", src, "area", "0of16.runs.jsonl"),
    );
    const malformed = tool("status", at("malformed-store"), src);
    assert.equal(malformed.status, 2);
    assert.match(malformed.stdout, /0of16\.runs\.jsonl: stored\.mjs same: its runs are no object/);
    copied("seed", "arealess", (dir) => {
      rmSync(join(dir, "area"), { recursive: true });
      edit(join(dir, "MANIFEST"), /^area area .*\n/m, "");
    });
    assert.match(
      said(tool("import", at("arealess-central"), at("arealess"))).refused,
      /MANIFEST records no area/,
    );
    cpSync(central, at("unplanned"), { recursive: true });
    rmSync(at("unplanned", src, "area", "PLAN"));
    assert.match(
      said(tool("import", at("unplanned"), at("zero"), "area", "0/16")).refused,
      /holds no PLAN or another one: import its seed first/,
    );
    // an import killed after it wrote its shard's temporary file: the next one clears it and publishes
    assert.equal(tool("import", at("crashed"), at("seed")).status, 0);
    const crash = at("crash.mjs");
    writeFileSync(crash, CRASH);
    const ready = at("ready");
    const killed = spawn(
      process.execPath,
      ["--import", crash, baselines, "import", at("crashed"), at("zero"), "area", "0/16"],
      {
        env: {
          ...process.env,
          CRASH_ROOT: at("crashed"),
          CRASH_AT: "^writeFileSync .*runs\\.jsonl\\.\\d+-\\d+\\.tmp ",
          CRASH_READY: ready,
        },
        stdio: "ignore",
      },
    );
    const closed = new Promise((done) => killed.on("close", done));
    while (!existsSync(ready) && killed.exitCode === null)
      await new Promise((done) => setTimeout(done, 5));
    assert.ok(existsSync(ready), "the import ended before its temporary file");
    killed.kill("SIGKILL");
    await closed;
    assert.equal(readdirSync(at("crashed", src, "area")).length, 2);
    assert.equal(said(tool("import", at("crashed"), at("zero"), "area", "0/16")).verified, true);
    assert.deepEqual(readdirSync(at("crashed", src, "area")).sort(), ["0of16.runs.jsonl", "PLAN"]);
    // compared, never replaced: a shard imported again says the same (exit 0), one that says otherwise differs (exit 3)
    assert.deepEqual(Object.keys(said(imported("zero", 0))), ["equal"]);
    const differs = copied("zero", "differs", (dir) => {
      const file = join(dir, "area", "0of16.runs.jsonl");
      const [line, ...rest] = readFileSync(file, "utf8").trim().split("\n");
      const ended = JSON.parse(rest.pop()!);
      const changed = [
        line!.replace(/"hash":"(\w)/, (_, digit) => `"hash":"${digit === "0" ? "1" : "0"}`),
        ...rest,
      ]
        .map((one) => `${one}\n`)
        .join("");
      ended.total.lines = createHash("sha256").update(changed).digest("hex");
      writeFileSync(file, `${changed}${JSON.stringify(ended)}\n`);
    });
    const compared = imported(differs, 0);
    assert.equal(compared.status, 3);
    assert.match(said(compared).differs, /says otherwise than .* of stored\.mjs same/);
    // (#1612) a stall-only disagreement is no value difference: the complete result stands, kept (central's) or put in
    // the stalled line's place (another store's), the source named (`stallOnly`, exit 0); a stalled line whose ended run
    // says otherwise than the complete one is a value difference (exit 3)
    const stalledCopy = (name: string, otherwise = false) =>
      copied("zero", name, (dir) => {
        const file = join(dir, "area", "0of16.runs.jsonl");
        const [line, ...rest] = readFileSync(file, "utf8").trim().split("\n");
        const ended = JSON.parse(rest.pop()!);
        const { generator, source, key, runs } = JSON.parse(line!);
        const [first] = Object.keys(runs);
        const value = runs[first!].value;
        const kept = otherwise
          ? {
              ...runs[first!],
              value: {
                ...value,
                hash: `${value.hash[0] === "0" ? "1" : "0"}${value.hash.slice(1)}`,
              },
            }
          : runs[first!];
        const stalled = { generator, source, key, stalled: "exit 4", runs: { [first!]: kept } };
        const body = [JSON.stringify(stalled), ...rest].map((one) => `${one}\n`).join("");
        ended.total.stalled += 1;
        ended.total.runs -= Object.keys(runs).length - 1;
        ended.total.lines = createHash("sha256").update(body).digest("hex");
        writeFileSync(file, `${body}${JSON.stringify(ended)}\n`);
        const entry = { area: "area", shard: "0/16", generator, source, key, stalled: "exit 4" };
        writeFileSync(
          join(dir, "..", "stalls.json"),
          `${JSON.stringify({ area: "area", shard: "0/16", stalls: [entry] })}\n`,
        );
      });
    const sameKey = JSON.parse(readFileSync(shard("zero", 0), "utf8").split("\n")[0]!).key;
    const stallOnly = imported(stalledCopy("stall-zero"), 0);
    assert.equal(stallOnly.status, 0, stallOnly.stdout);
    assert.deepEqual(said(stallOnly), {
      equal: join(central, src, "area", "0of16.runs.jsonl"),
      stallOnly: [
        {
          generator: "stored.mjs",
          source: "same",
          key: sameKey,
          stalled: "exit 4",
          complete: "stored",
        },
      ],
    });
    const second = at("central-stalled");
    assert.equal(tool("import", second, at("seed")).status, 0);
    assert.equal(said(tool("import", second, at("stall-zero"), "area", "0/16")).verified, true);
    const completed = tool("import", second, at("zero"), "area", "0/16");
    assert.equal(completed.status, 0, completed.stdout);
    assert.deepEqual(said(completed).stallOnly, [
      {
        generator: "stored.mjs",
        source: "same",
        key: sameKey,
        stalled: "exit 4",
        complete: "computed",
      },
    ]);
    assert.equal(said(completed).verified, true);
    const merged = readFileSync(join(second, src, "area", "0of16.runs.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.deepEqual(
      merged.slice(0, -1),
      readFileSync(shard("zero", 0), "utf8").trim().split("\n").slice(0, -1),
    );
    assert.equal(JSON.parse(merged.at(-1)!).total.stalled, 0);
    const zeroLines = readFileSync(shard("zero", 0), "utf8").trim().split("\n");
    assert.equal(JSON.parse(merged.at(-1)!).total.runs, JSON.parse(zeroLines.at(-1)!).total.runs);
    assert.equal(JSON.parse(merged.at(-1)!).total.runs, runsIn(merged));
    const otherwise = imported(stalledCopy("stall-otherwise", true), 0);
    assert.equal(otherwise.status, 3, otherwise.stdout);
    assert.match(said(otherwise).differs, /says otherwise than .* of stored\.mjs same/);
    // (#1647) a stall over the unit limit is the same on every machine: imported over a line that ended its cut run, it
    // is a value difference (exit 3), not a stall-only one
    const byUnits = imported(cutCopy("unit-stall", { work: 4001, allowance: 1000 }, true), 1);
    assert.equal(byUnits.status, 3, byUnits.stdout);
    assert.match(said(byUnits).differs, /says otherwise than .* of stored\.mjs mixed/);
    // (#1647, Codex r1) a line that reached the safety net is no complete result: imported over a stalled one, it is a
    // value difference (exit 3), and the stored shard stays as it was
    const third = at("central-uncharged");
    assert.equal(tool("import", third, at("seed")).status, 0);
    assert.equal(said(tool("import", third, at("stall-zero"), "area", "0/16")).verified, true);
    const thirdShard = join(third, src, "area", "0of16.runs.jsonl");
    const kept = readFileSync(thirdShard, "utf8");
    copied("zero", "uncharged-zero", (dir) => {
      const file = join(dir, "area", "0of16.runs.jsonl");
      const [line, ...rest] = readFileSync(file, "utf8").trim().split("\n");
      const ended = JSON.parse(rest.pop()!);
      // (it ended the run the stalled line ended, and reached the safety net in the next)
      const { generator, source, key, runs } = JSON.parse(line!);
      const [first, next] = Object.keys(runs);
      const reached = { generator, source, key, uncharged: next, runs: { [first!]: runs[first!] } };
      const body = [JSON.stringify(reached), ...rest].map((one) => `${one}\n`).join("");
      ended.total.uncharged = 1;
      ended.total.lines = createHash("sha256").update(body).digest("hex");
      writeFileSync(file, `${body}${JSON.stringify(ended)}\n`);
    });
    const reaching = tool("import", third, at("uncharged-zero"), "area", "0/16");
    assert.equal(reaching.status, 3, reaching.stdout);
    assert.match(said(reaching).differs, /says otherwise than .* of stored\.mjs same/);
    assert.equal(readFileSync(thirdShard, "utf8"), kept);
    // a seed into the complete baseline: equal, nothing written; one from another commit's tree differs (exit 3)
    assert.equal(sh({}, "seed", alias, "2".repeat(40), at("alias-seed")).status, 0);
    const reseeded = tool("import", central, at("alias-seed"));
    assert.equal(reseeded.status, 3);
    assert.match(said(reseeded).differs, /names "commit 2{40} .*alias"/);
    assert.equal(said(tool("import", central, at("seed"))).seed, "equal");
    assert.deepEqual(contents(), before);
    assert.deepEqual(readdirSync(central), [src]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
