import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { coreRequest } from "./helpers/type-core-analysis.js";

const runner = resolve(process.cwd(), "tests/families/run.mjs");
const baselines = resolve(process.cwd(), "tests/families/baselines.mjs");
const stalls = resolve(process.cwd(), "tests/families/stalls.mjs");
const contract = resolve(process.cwd(), "tests/families/run-contract.mjs");

/**
 * A built tree's work ledger, which every unit of its analyses' work passes (the runner counts its charges and limits
 * them at its multiple of the ledger's `allowance`, #1647), its program's allowance 30,000,000 unless given.
 */
const LEDGER = `export class WorkLedger {
  #total = 0;
  constructor(allowance = 30000000) {
    this.allowance = allowance;
  }
  charge(counter, units = 1) {
    this.#total += units;
  }
}
`;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A stored source line's runs, each one tree's result with its units and allowance (#1647). */
type Stored = { runs: Record<string, { work?: number; allowance?: number | null }> };
const storedRuns = ({ runs }: Stored) => Object.values(runs);

/**
 * The plan 2 baseline `dir` (`<folder>/<src tree>`) rewritten as one stored before #1647, a plan 1 one: each PLAN's
 * limits a time a source, its runs without units, a stall a time limit's without its cut run, no run named at the
 * safety net, and its MANIFEST's records and its shards' totals repaired, so that it counts as such a baseline did.
 */
const asPlanOne = (dir: string) => {
  let manifest = readFileSync(join(dir, "MANIFEST"), "utf8");
  for (const area of readdirSync(dir).filter((name) => existsSync(join(dir, name, "PLAN")))) {
    const was = readFileSync(join(dir, area, "PLAN"), "utf8");
    const plan = was
      .replace(/^plan 2$/m, "plan 1")
      .replace(/^limits .*$/m, "limits 180 s, 2048 MB");
    writeFileSync(join(dir, area, "PLAN"), plan);
    manifest = manifest.replace(sha256(was), sha256(plan));
    for (const name of readdirSync(join(dir, area)).filter((one) => one.endsWith(".runs.jsonl"))) {
      const lines = readFileSync(join(dir, area, name), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const { units: _units, uncharged: _uncharged, ...total } = lines.pop().total;
      const body = lines
        .map(
          ({ cut: _cut, uncharged: _named, runs, ...line }: Stored & Record<string, unknown>) => {
            // (each run's result without its units and allowance)
            const results = Object.entries(runs).map(
              ([run, { work: _work, allowance: _allowance, ...result }]) => [run, result],
            );
            // (its stall a time limit's, as a stall was then)
            const stall = line["stalled"] === undefined ? {} : { stalled: "timeout" };
            return `${JSON.stringify({ ...line, ...stall, runs: Object.fromEntries(results) })}\n`;
          },
        )
        .join("");
      const ended = { total: { ...total, plan: sha256(plan), lines: sha256(body) } };
      writeFileSync(join(dir, area, name), `${body}${JSON.stringify(ended)}\n`);
    }
  }
  writeFileSync(join(dir, "MANIFEST"), manifest);
};

/** A built tree's oracle library that throws in every mode where a source says `throw`, as #1439's stale caller did. */
const library = `export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
export function publication(files) {
  if (files[0].source.includes("throw"))
    throw new TypeError("Cannot read properties of undefined (reading 'map')");
  // (the four elements a publication's whole text has, as a library before \`publicationParts\` writes it)
  return '["published","",[],""]';
}
`;

test("the corpus runner fails four identical exceptions instead of counting them as agreement (#1439)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const tree = join(directory, "tree");
    mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
    writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
    writeFileSync(join(tree, "dist", "tests", "helpers", "type-core-oracles.js"), library);
    const area = join(directory, "area");
    mkdirSync(area);
    writeFileSync(
      join(area, "canary.mjs"),
      'export const cases = [["throws", "throw"], ["publishes", "exit"]];\n',
    );
    const out = join(directory, "out.jsonl");

    // the same tree as base and head: every run of `throws` throws the same exception on both
    const result = spawnSync(process.execPath, [runner, area, tree, tree, "--out", out], {
      encoding: "utf8",
    });

    assert.equal(result.status, 1, result.stderr);
    const total = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    assert.deepEqual(
      [total.sources, total.stalled, total.exceptions, total.runs, total.differences],
      [2, 0, 4, 8, 0],
    );
    const modes = ["src-on", "src-off", "rev-on", "rev-off"].map(
      (mode) => `throws ${mode} publication`,
    );
    const lines = (text: string) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    // each named on stderr with its source and mode, and kept with both trees' exceptions
    assert.deepEqual(
      lines(result.stderr).map(({ source, mode, check }) => `${source} ${mode} ${check}`),
      modes,
    );
    const kept = lines(readFileSync(out, "utf8"));
    assert.deepEqual(
      kept.map(({ source, mode, check }) => `${source} ${mode} ${check}`),
      modes,
    );
    for (const { thrown } of kept)
      for (const stack of [thrown.base, thrown.head])
        assert.match(
          stack,
          /^TypeError: Cannot read properties of undefined \(reading 'map'\)\n {4}at /,
        );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A built tree's library that publishes as one whole (`whole`) or only by its parts' hashes, where the whole throws:
 * the source `same` publishes the same on both, `changed` changes the second occurrence on the parts tree, `longer`
 * adds one.
 */
const publishing = (whole: boolean): string => `import { createHash } from "node:crypto";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
const occurrences = (source) =>
  ${whole} || source === "same"
    ? [[1, "x"], [2, "y"]]
    : source === "changed"
      ? [[1, "x"], [2, "z"]]
      : [[1, "x"], [2, "y"], [3, "w"]];
export function publication(files) {
  if (!${whole}) throw new Error("a tree with parts is compared by its parts, never joined");
  return JSON.stringify(["A", "R", occurrences(files[0].source), "T"]);
}
${
  whole
    ? ""
    : `export const publicationHashes = (files) =>
  ['"A"', '"R"', ...occurrences(files[0].source).map((occurrence) => JSON.stringify(occurrence)), '"T"'].map(
    (text) => createHash("sha256").update(text).digest("hex"),
  );`
}
`;

test("the corpus runner compares a publication by its parts, also against a library before them (#1503)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const trees = [true, false].map((whole) => {
      const tree = join(directory, whole ? "whole" : "parts");
      mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
      writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
      writeFileSync(
        join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
        publishing(whole),
      );
      return tree;
    });
    const area = join(directory, "area");
    mkdirSync(area);
    writeFileSync(
      join(area, "parts.mjs"),
      'export const cases = [["same", "same"], ["changed", "changed"], ["longer", "longer"]];\n',
    );
    // each direction: the first part that differs (answers 0, record 1, occurrences from 2, the route last) and each
    // tree's count of parts, in all four modes
    for (const [base, head, longer] of [
      [trees[0]!, trees[1]!, [5, 6]],
      [trees[1]!, trees[0]!, [6, 5]],
    ] as const) {
      const out = join(directory, "out.jsonl");
      const result = spawnSync(process.execPath, [runner, area, base, head, "--out", out], {
        encoding: "utf8",
      });
      assert.equal(result.status, 1, result.stderr);
      const total = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      assert.deepEqual([total.exceptions, total.runs, total.differences], [0, 12, 8]);
      const found = readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .map(({ source, part, parts }) => `${source} ${part} ${parts.join("/")}`);
      assert.deepEqual(new Set(found), new Set(["changed 3 5/5", `longer 4 ${longer.join("/")}`]));
      assert.equal(found.length, 8);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A built tree's library whose oracle stops its own questions on the source `stopped`, leaving two nodes unanswered:
 * counted apart from its parts' hashes (`counted`), in its joined publication's fifth element (`whole`), a library
 * before that count (`before`), which hashes the same parts and has none, counted with one node fewer unanswered
 * (`fewer`), or counted with the part before the stop answered otherwise (`other`).
 */
const stopping = (
  form: "before" | "counted" | "fewer" | "other" | "whole",
): string => `import { createHash } from "node:crypto";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
${
  form === "whole"
    ? `export const publication = (files) =>
  \`["A","R",[[1,"x"]],"T"\${files[0].source === "stopped" ? ',{"unanswered":2}' : ""}]\`;`
    : `export const publicationHashes = (files) => {
  const stopped = files[0].source === "stopped";
  const answered = ${form === "other"} && stopped ? '[1,"z"]' : '[1,"x"]';
  const parts = ['"A"', '"R"', answered, '"T"'].map((text) => createHash("sha256").update(text).digest("hex"));
  return ${form === "before"} ? parts : { parts, unanswered: stopped ? ${form === "fewer" ? 1 : 2} : 0 };
};`
}
`;

/**
 * A tree's oracle whose `stopped` source leaves `count` nodes unanswered for `reason` (none: a library before #1837), at
 * `at`: its first node left, or the binding where its answers' questions stopped.
 */
const reasoned = (
  count: number,
  reason: "questions" | "memory" | "read-depth" | "stopped" | null,
  at = "node: 7",
): string => `import { createHash } from "node:crypto";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
export const publicationHashes = (files) => {
  const stopped = files[0].source === "stopped";
  const parts = ['"A"', '"R"', '[1,"x"]', '"T"'].map((text) => createHash("sha256").update(text).digest("hex"));
  if (!stopped) return { parts, unanswered: 0 };
  return { parts, unanswered: ${count}${reason === null ? "" : `, unansweredBy: { reason: "${reason}", ${at} }`} };
};
`;

test("the corpus runner records why an oracle left a run unanswered, and the stall index counts each reason as a runner artefact apart from agreement (#1837)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const tree = (
      name: string,
      count: number,
      reason: "questions" | "memory" | "read-depth" | "stopped" | null,
      at = "node: 7",
    ) => {
      const folder = join(directory, name);
      mkdirSync(join(folder, "dist", "tests", "helpers"), { recursive: true });
      writeFileSync(join(folder, "package.json"), '{ "type": "module" }\n');
      writeFileSync(
        join(folder, "dist", "tests", "helpers", "type-core-oracles.js"),
        reasoned(count, reason, at),
      );
      return folder;
    };
    const [questions2, questions3, stopped2, stopped3, older3, questions101, stopped202] = [
      tree("questions2", 2, "questions"),
      tree("questions3", 3, "questions"),
      tree("stopped2", 2, "stopped"),
      tree("stopped3", 3, "stopped"),
      tree("older3", 3, null),
      tree("questions101", 2, "questions", "node: 101"),
      tree("stopped202", 3, "stopped", "node: 202"),
    ];
    const [depth2, depth3, memory2, memory3, binding2, binding3] = [
      tree("depth2", 2, "read-depth"),
      tree("depth3", 3, "read-depth"),
      tree("memory2", 2, "memory"),
      tree("memory3", 3, "memory"),
      tree("binding2", 2, "questions", "binding: 5"),
      tree("binding3", 3, "questions", "binding: 5"),
    ];
    const area = join(directory, "area");
    mkdirSync(area);
    writeFileSync(
      join(area, "stops.mjs"),
      'export const cases = [["stopped", "stopped"], ["answered", "answered"]];\n',
    );
    const lines = (text: string) =>
      text
        .trim()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));
    const groups = (base: string, head: string, name: string) => {
      const [out, work] = [join(directory, `${name}.jsonl`), join(directory, `${name}.work.jsonl`)];
      const ran = spawnSync(
        process.execPath,
        [runner, area, base, head, "--out", out, "--work", work],
        { encoding: "utf8" },
      );
      assert.equal(ran.status, base === head ? 0 : 1, ran.stderr);
      const judged = spawnSync(process.execPath, [stalls, work], { encoding: "utf8" });
      const said = lines(judged.stdout);
      const { artefacts } = said.find((line) => line.artefacts !== undefined);
      const total = said.at(-1);
      return {
        rows: Object.fromEntries(
          artefacts.map((r: { group: string; runs: number; sources: number }) => [
            r.group,
            [r.runs, r.sources],
          ]),
        ),
        artefacts,
        total,
        out: existsSync(out) ? lines(readFileSync(out, "utf8")) : [],
      };
    };
    // (the oracle's own question budget on both trees, at two counts: four runs of one source, its reason and node)
    const q = groups(questions2, questions3, "questions");
    // (every group of the one reason list, `run-contract.mjs`, and the alike group, each with its runs and sources)
    const reasonGroups: string[] = (await import(pathToFileURL(contract).href)).REASON_GROUPS;
    const rowsWith = (counted: Record<string, number[]>): Record<string, number[]> =>
      Object.fromEntries(
        [...reasonGroups, "unansweredAlike"].map((group) => [group, counted[group] ?? [0, 0]]),
      );
    assert.deepEqual(q.rows, rowsWith({ "unanswered: questions": [4, 1] }));
    const row = q.artefacts.find((r: { group: string }) => r.group === "unanswered: questions");
    assert.equal(row.issue, "#1941");
    assert.deepEqual([row.witness.source, row.witness.node], ["stopped", 7]);
    // (never agreement: the area does not close, and `answered` alone agrees)
    assert.deepEqual([q.total.agreed, q.total.closed], [1, false]);
    // (the --out record names why on each tree)
    assert.deepEqual(q.out[0].by, {
      base: { reason: "questions", node: 7 },
      head: { reason: "questions", node: 7 },
    });
    // (the analysis's own stop)
    assert.deepEqual(groups(stopped2, stopped3, "stopped").rows["unanswered: stopped"], [4, 1]);
    // (a question past the read-depth limit, its own group: #1837 ruling 3)
    const d = groups(depth2, depth3, "depth");
    assert.deepEqual(
      [d.rows["unanswered: read-depth"], d.rows["unanswered: questions"]],
      [
        [4, 1],
        [0, 0],
      ],
    );
    assert.deepEqual(d.out[0].by.head, { reason: "read-depth", node: 7 });
    // (the questions' room in the heap passed: its own group, never a crash, #1837)
    const h = groups(memory2, memory3, "memory");
    assert.deepEqual(
      [h.rows["unanswered: memory"], h.rows["unanswered: questions"]],
      [
        [4, 1],
        [0, 0],
      ],
    );
    // (the answers' own questions stopped at a binding: named so on the record and the witness)
    const b = groups(binding2, binding3, "binding");
    assert.deepEqual(b.out[0].by.head, { reason: "questions", binding: 5 });
    const witness = b.artefacts.find(
      (r: { group: string }) => r.group === "unanswered: questions",
    ).witness;
    assert.deepEqual([witness.node, witness.binding], [null, 5]);
    // (a library that names no reason: unknown, its node null, never dropped; the other tree's reason counted too)
    const u = groups(older3, questions2, "unknown");
    assert.deepEqual(
      [u.rows["unanswered: unknown"], u.rows["unanswered: questions"]],
      [
        [4, 1],
        [4, 1],
      ],
    );
    const unknown = u.artefacts.find((r: { group: string }) => r.group === "unanswered: unknown");
    assert.equal(unknown.witness.source, "stopped");
    assert.deepEqual(u.out[0].by.base, { reason: "unknown", node: null });
    // (two reasons on the two trees: each group counts the run, its witness the node of the tree that gave it, Codex r1)
    const m = groups(questions101, stopped202, "mixed");
    const node = (group: string) =>
      m.artefacts.find((r: { group: string }) => r.group === group).witness.node;
    assert.deepEqual(
      [
        m.rows["unanswered: questions"],
        m.rows["unanswered: stopped"],
        node("unanswered: questions"),
        node("unanswered: stopped"),
      ],
      [[4, 1], [4, 1], 101, 202],
    );
    // (an unknown reason's witness keeps that tree's null node, not the other tree's)
    const v = groups(older3, questions101, "unknown-node");
    assert.equal(
      v.artefacts.find((r: { group: string }) => r.group === "unanswered: unknown").witness.node,
      null,
    );
    // (repeats say the same only where they name the same reasons, in either order; a record that names none, from a
    // runner before #1837, says the same as one that names them, whose reasons stand)
    const work = join(directory, "mixed.work.jsonl");
    const rewritten = (name: string, edit: (left: unknown[]) => unknown[] | undefined) => {
      const file = join(directory, name);
      const text = readFileSync(work, "utf8")
        .split("\n")
        .map((line) => {
          if (line === "") return line;
          const record = JSON.parse(line);
          if (record.unanswered === undefined) return line;
          const left = edit(record.unanswered);
          if (left === undefined) delete record.unanswered;
          else record.unanswered = left;
          return JSON.stringify(record);
        })
        .join("\n");
      writeFileSync(file, text);
      return file;
    };
    const unknown2 = { reason: "unknown", node: null };
    const other = rewritten("other.work.jsonl", (left) =>
      left.map((run) => Object.assign({}, run, { by: { base: unknown2, head: unknown2 } })),
    );
    const none = rewritten("none.work.jsonl", () => undefined);
    const judge = (first: string, second: string) =>
      spawnSync(process.execPath, [stalls, work, "--rerun", first, "--rerun", second], {
        encoding: "utf8",
      });
    for (const [first, second] of [
      [work, other],
      [other, work],
    ] as const) {
      const judged = judge(first, second);
      assert.equal(judged.status, 2, judged.stdout);
      assert.match(
        judged.stderr,
        /a source an earlier rerun ran otherwise|another record holds otherwise/,
      );
    }
    for (const [first, second] of [
      [work, none],
      [none, work],
    ] as const) {
      const judged = judge(first, second);
      assert.equal(judged.status, 1, judged.stderr);
      const { artefacts } = lines(judged.stdout).find((line) => line.artefacts !== undefined);
      assert.deepEqual(
        artefacts.map((r: { group: string; runs: number }) => [r.group, r.runs]),
        Object.entries(rowsWith({ "unanswered: questions": [4], "unanswered: stopped": [4] })).map(
          ([group, [runs]]) => [group, runs],
        ),
      );
    }
    // (left alike on both trees: its own row, agreement named apart as before)
    const a = groups(questions2, questions2, "alike");
    assert.deepEqual(a.rows, rowsWith({ unansweredAlike: [4, 1] }));
    assert.equal(a.total.unansweredAlike, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the corpus runner and the stall index count a run left unanswered alike on both trees as agreement named apart, any other unanswered run never as agreement (#1499, #1592)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const [before, counted, fewer, other, whole] = (
      ["before", "counted", "fewer", "other", "whole"] as const
    ).map((form) => {
      const tree = join(directory, form);
      mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
      writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(tree, "dist", "tests", "helpers", "type-core-oracles.js"), stopping(form));
      return tree;
    });
    const area = join(directory, "area");
    mkdirSync(area);
    writeFileSync(
      join(area, "stops.mjs"),
      'export const cases = [["stopped", "stopped"], ["answered", "answered"]];\n',
    );
    const lines = (text: string) =>
      text
        .trim()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));
    // the same count and answered part on both trees (a joined publication's parts are a counted one's): agreement,
    // counted and named apart; another count, never agreement (`counts`, each tree's); another answer where both
    // answered, a difference (#1837's prefix compare); `answered` agrees in each
    for (const [name, base, head, counts] of [
      ["alike", counted!, counted!, undefined],
      ["alike-joined", whole!, counted!, undefined],
      ["counts", before!, whole!, [0, 2]],
      ["counts-positive", counted!, fewer!, [2, 1]],
      ["parts", counted!, other!, [2, 2]],
    ] as const) {
      const file = (suffix: string) => join(directory, `${name}.${suffix}`);
      const [out, work, index] = [file("jsonl"), file("work.jsonl"), file("index.json")];
      const result = spawnSync(
        process.execPath,
        [runner, area, base, head, "--out", out, "--work", work],
        { encoding: "utf8" },
      );
      const alike = counts === undefined;
      const differs = name === "parts";
      assert.equal(result.status, alike ? 0 : 1, result.stderr);
      const total = lines(result.stdout).at(-1);
      assert.deepEqual(
        [total.exceptions, total.unanswered, total.unansweredAlike, total.runs, total.differences],
        [0, alike || differs ? 0 : 4, alike ? 4 : 0, 8, differs ? 4 : 0],
        name,
      );
      assert.deepEqual(
        lines(readFileSync(out, "utf8")).map(({ source, unanswered }) => [
          source,
          unanswered.base,
          unanswered.head,
        ]),
        alike ? [] : Array.from({ length: 4 }, () => ["stopped", ...counts!]),
      );
      // the stall index on its record: closed where every run agrees or is unanswered alike, the source named apart
      // in the summary and the index, never one of the sources agreed
      const judged = spawnSync(process.execPath, [stalls, work, "--index", index], {
        encoding: "utf8",
      });
      assert.equal(judged.status, alike ? 0 : 1, judged.stderr);
      const printed = lines(judged.stdout);
      const { sources, agreed, unansweredAlike, unanswered, closed } = printed.at(-1);
      assert.deepEqual(
        [sources, agreed, unansweredAlike, unanswered, closed],
        [2, 1, alike ? 1 : 0, alike || differs ? 0 : 4, alike],
        name,
      );
      const named = { generator: "stops.mjs", source: "stopped", unansweredAlike: 4 };
      assert.deepEqual(
        printed.filter((line) => line.source !== undefined && line.unansweredAlike !== undefined),
        alike ? [{ area: "area", ...named }] : [],
      );
      const listed = JSON.parse(readFileSync(index, "utf8")).unansweredAlike;
      assert.deepEqual(
        listed.map(({ key, ...entry }: { key: string }) => [entry, /^[0-9a-f]{64}$/.test(key)]),
        alike ? [[{ area, ...named }, true]] : [],
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A built tree's library where the source `changed` publishes its fourth part differently on the head, `throws` throws
 * and `stopped` leaves two nodes unanswered on the base, `alike` two on both, and `ends` ends the process on both.
 */
const storable = (head: boolean): string => `import { createHash } from "node:crypto";
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
const SRC = "da445cc8e80d8e4082809c34579aaed8451b7efc";
function writeSrc(tree: string, extra = ""): void {
  mkdirSync(join(tree, "src", "a"), { recursive: true });
  mkdirSync(join(tree, "src", "empty"));
  writeFileSync(join(tree, "src", "a.ts"), `a\n${extra}`);
  writeFileSync(join(tree, "src", "a", "b.ts"), "b\n");
  writeFileSync(join(tree, "src", "run.sh"), "x\n", { mode: 0o755 });
  symlinkSync("a.ts", join(tree, "src", "link.ts"));
}

test("the corpus runner stores a tree in the baseline of its src/ tree, verified shard by shard, which judges a head as the base tree beside it does", async () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    // the base as two commits with one `src/` tree and built oracle library, one with another library, and the head
    const tree = (name: string, sha: string, library = "", extra = "") => {
      const folder = join(directory, name);
      mkdirSync(join(folder, "dist", "tests", "helpers"), { recursive: true });
      writeFileSync(join(folder, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(folder, "package-lock.json"), "{}\n");
      writeFileSync(
        join(folder, "dist", "tests", "helpers", "type-core-oracles.js"),
        storable(name === "head") + library,
      );
      writeFileSync(join(folder, ".sha"), `${sha.repeat(40)}\n`);
      writeSrc(folder, extra);
      mkdirSync(join(folder, "tests", "families", "area"), { recursive: true });
      writeFileSync(join(folder, "tests", "families", "area", "stored.mjs"), generator(names));
      return folder;
    };
    const names = ["same", "changed", "throws", "stopped", "ends", "alike"];
    const generator = (order: string[]) =>
      `export const cases = ${JSON.stringify(order.map((name) => [name, name]))};\n`;
    const base = tree("base", "1");
    const alias = tree("alias", "2");
    const other = tree("other", "3", "// another oracle library\n");
    const head = tree("head", "4");
    const area = join(base, "tests", "families", "area");
    const root = join(directory, "baselines");
    const baseline = join(root, SRC, "area");
    // a store runs as the hook's jobs run it where `sx-sandbox` is found (#1542): only its tree's baseline and its
    // scratch writable, every write elsewhere failing (EROFS); else as is
    const scratch = join(directory, "scratch");
    const sandboxed =
      spawnSync("sx-sandbox", ["--write", scratch, "--", "true"], { stdio: "ignore" }).status === 0;
    const { identityOf } = await import(pathToFileURL(baselines).href);
    const store = (from: string, ...args: string[]) => {
      const command = [runner, args[0]!, from, "--store", ...args.slice(1)];
      const writable = join(args[1]!, identityOf(from).src);
      return sandboxed
        ? spawnSync(
            "sx-sandbox",
            ["--write", writable, "--write", scratch, "--", process.execPath, ...command],
            { encoding: "utf8", env: { ...process.env, TMPDIR: scratch } },
          )
        : spawnSync(process.execPath, command, { encoding: "utf8" });
    };
    const into = (from: string, shard: string, ...more: string[]) =>
      store(from, area, root, "--shard", shard, ...more);
    const state = (from: string, folder = root) =>
      spawnSync(process.execPath, [baselines, "state", from, folder, "--read-only"], {
        encoding: "utf8",
      });
    const states = (result: { stdout: string }) =>
      result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter(({ area: name }) => name !== undefined)
        .map(({ area: name, state: what, verified: count }) => `${name} ${what} ${count}`);
    const out = join(directory, "out.jsonl");
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, [runner, area, ...args, "--out", out], {
        encoding: "utf8",
      });
      const total = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      const kept = readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .map(({ files, globals, ...line }) => line);
      return { status: result.status, total, kept };
    };
    const counts = ({ total }: { total: Record<string, number> }) =>
      [
        "sources",
        "stalled",
        "exceptions",
        "unanswered",
        "unansweredAlike",
        "uncompared",
        "runs",
        "differences",
      ].map((key) => total[key]);

    // one shard from one commit, the other from the other: while a running writer claims it, the second is left to
    // it; a writer that ended (another start time) claims it no longer, and its temporary file goes
    assert.equal(into(base, "0/2").status, 1);
    assert.deepEqual(readdirSync(baseline).sort(), ["0of2.runs.jsonl", "PLAN"]);
    const stat = readFileSync("/proc/self/stat", "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    writeFileSync(join(baseline, ".1of2.claim"), `${process.pid}-${started}\n`);
    assert.match(into(alias, "1/2").stdout, /"skipped":"being stored by another writer"/);
    writeFileSync(join(baseline, ".1of2.claim"), `${process.pid}-1\n`);
    writeFileSync(join(baseline, `1of2.runs.jsonl.${process.pid}-1.tmp`), "partial\n");
    assert.equal(into(alias, "1/2").status, 1);
    const files = ["0of2.runs.jsonl", "1of2.runs.jsonl", "PLAN"];
    assert.deepEqual(readdirSync(baseline).sort(), files);
    // one baseline, named by the `src/` tree, with what its runs depend on, both commits and the area's PLAN
    const again = into(alias, "0/2");
    assert.equal(again.status, 0);
    assert.match(again.stdout, /"skipped":"stored"/);
    assert.deepEqual(readdirSync(root), [SRC]);
    const manifest = readFileSync(join(root, SRC, "MANIFEST"), "utf8").split("\n");
    assert.deepEqual(manifest.slice(0, 2), ["baseline 3", `src ${SRC}`]);
    assert.match(
      manifest.slice(2, 5).join("\n"),
      /^oracles [0-9a-f]{64}\nlock [0-9a-f]{40}\nnode v/,
    );
    assert.deepEqual(manifest.slice(5), [
      `commit ${"1".repeat(40)} ${base}`,
      `area area 2 ${createHash("sha256")
        .update(readFileSync(join(baseline, "PLAN")))
        .digest("hex")}`,
      `commit ${"2".repeat(40)} ${alias}`,
      "",
    ]);
    const complete = state(alias);
    assert.equal(complete.status, 0);
    assert.deepEqual(states(complete), ["area complete 2"]);

    // refused, nothing written: another count of shards; the same sources in another order (#1542 r1: the second
    // writer's shard would hold the first's sources again) or with other checks; another oracle library; other than
    // the defaults; a folder this tool did not make
    assert.match(into(base, "0/3").stderr, /is planned otherwise/);
    const reordered = join(directory, "reordered", "area");
    mkdirSync(reordered, { recursive: true });
    writeFileSync(join(reordered, "stored.mjs"), generator([...names].reverse()));
    assert.equal(store(alias, reordered, root, "--shard", "1/2").status, 2);
    const checked = join(directory, "checked", "area");
    mkdirSync(checked, { recursive: true });
    writeFileSync(
      join(checked, "stored.mjs"),
      `${generator(names)}export const checks = ["stops"];\n`,
    );
    assert.match(store(alias, checked, root, "--shard", "1/2").stderr, /is planned otherwise/);
    assert.match(into(other, "0/2").stderr, /holds runs of another oracles than this tree's/);
    assert.equal(into(base, "0/2", "--timeout", "5").status, 2);
    assert.deepEqual(readdirSync(baseline).sort(), files);
    const elsewhere = join(directory, "elsewhere");
    mkdirSync(join(elsewhere, SRC, "data"), { recursive: true });
    writeFileSync(join(elsewhere, SRC, "data", "kept"), "x\n");
    assert.match(store(base, area, elsewhere).stderr, /is not this tool's/);
    // a baseline of this tool that holds a foreign path (#1542 r2: foreign-child): writers and `state` refuse it, naming
    // the path
    const gone = tree("gone", "5", "", "gone\n");
    const foreign = tree("foreign", "6", "", "foreign\n");
    assert.equal(store(gone, area, elsewhere).status, 1);
    assert.equal(store(foreign, area, elsewhere, "--shard", "0/2").status, 1);
    const last = (result: { stdout: string }) =>
      JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    const held = join(
      elsewhere,
      readdirSync(elsewhere).find((name) =>
        existsSync(join(elsewhere, name, "area", "0of2.runs.jsonl")),
      )!,
    );
    mkdirSync(join(held, "other-agent"));
    writeFileSync(join(held, "other-agent", "data"), "x\n");
    assert.match(
      store(foreign, area, elsewhere, "--shard", "1/2").stderr,
      /foreign contents, which this tool did not write: other-agent\//,
    );
    const seen = state(foreign, elsewhere);
    assert.equal(seen.status, 2);
    assert.match(last(seen).refused, /foreign contents/);

    // a shard cut short (#1542 r1) no longer verifies, and any writer replaces it
    const second = join(baseline, "1of2.runs.jsonl");
    writeFileSync(second, readFileSync(second, "utf8").split("\n").slice(0, -2).join("\n"));
    const damaged = state(base);
    assert.equal(damaged.status, 1);
    assert.deepEqual(states(damaged), ["area damaged 1"]);
    assert.equal(into(base, "1/2").status, 1);
    assert.deepEqual(states(state(base)), ["area complete 2"]);

    // the head against the stored base and against the base tree run beside it, `alike` unanswered alike on both
    const beside = run(base, head);
    const against = run(head, "--baseline", baseline);
    assert.deepEqual(counts(beside), [6, 1, 4, 4, 4, 0, 20, 4]);
    assert.deepEqual(counts(against), counts(beside));
    assert.equal(against.status, 1);
    // its record (#1564, #1647): the stored base's units first, then the head's, which these trees without a ledger
    // record as `null`, and each stall's trees, a stall of both trees inherited
    const record = join(directory, "against.work.jsonl");
    assert.equal(run(head, "--baseline", baseline, "--work", record).status, 1);
    const recorded = readFileSync(record, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .slice(1, -1);
    assert.deepEqual(
      recorded.map(({ source }) => source),
      names,
    );
    for (const { runs: ran } of recorded)
      for (const { work, ms } of ran)
        assert.deepEqual(
          [work, ms],
          [
            [null, null],
            [null, ms[1]],
          ],
        );
    assert.deepEqual(recorded.find(({ source }) => source === "ends").stalled, {
      base: "exit 3",
      head: "exit 3",
    });
    assert.match(
      spawnSync(process.execPath, [stalls, record], { encoding: "utf8" }).stdout,
      /"source":"ends".*"verdict":"inherited"/,
    );
    // its index rerun on both trees: a base of the MANIFEST's identity is the stored base, one of another oracle
    // library is not (#1564 r4)
    const index = join(directory, "index.json");
    spawnSync(process.execPath, [stalls, record, "--index", index]);
    const rerun = (from: string, folder: string) =>
      spawnSync(process.execPath, [stalls, "rerun", index, from, head, join(directory, folder)], {
        encoding: "utf8",
      });
    assert.match(rerun(other, "rerun-other").stderr, /is not the tree/);
    assert.equal(rerun(alias, "rerun-alias").status, 1);
    const merged = spawnSync(
      process.execPath,
      [stalls, record, "--rerun", join(directory, "rerun-alias", "area.work.jsonl")],
      { encoding: "utf8" },
    );
    assert.equal(merged.status, 1, merged.stderr);
    const runs = ({ kept }: { kept: Record<string, unknown>[] }) =>
      kept.filter(({ mode }) => mode !== undefined).map(({ thrown, ...line }) => line);
    assert.deepEqual(runs(against), runs(beside));
    assert.deepEqual(
      against.kept.filter(({ stalled }) => stalled !== undefined),
      [
        {
          generator: "stored.mjs",
          source: "ends",
          stalled: { base: "exit 3", head: "exit 3" },
          // (the run the head's stall cut, #1965)
          at: { tree: "head", mode: "src-on", check: "publication" },
        },
      ],
    );
    // a stored base result without its parts or its count (#1592), its shard's digest repaired: no store writes it, so
    // the comparison refuses it as every reader of a shard does (#1647, Codex r1), naming the line
    for (const [witness, dropped] of [
      ["no parts", "parts"],
      ["no count", "unanswered"],
    ] as const) {
      const copy = join(directory, "stripped", witness.replace(" ", "-"));
      cpSync(join(root, SRC), join(copy, SRC), { recursive: true });
      const file = join(copy, SRC, "area", "1of2.runs.jsonl");
      const [ended, ...sources] = readFileSync(file, "utf8").trim().split("\n").reverse();
      const body = sources
        .reverse()
        .map((line) => {
          const kept = JSON.parse(line);
          if (kept.source === "alike")
            for (const result of Object.values<{ value: Record<string, unknown> }>(kept.runs))
              delete result.value[dropped];
          return `${JSON.stringify(kept)}\n`;
        })
        .join("");
      const total = JSON.parse(ended!);
      total.total.lines = createHash("sha256").update(body).digest("hex");
      writeFileSync(file, `${body}${JSON.stringify(total)}\n`);
      const stripped = spawnSync(
        process.execPath,
        [runner, area, head, "--baseline", join(copy, SRC, "area")],
        { encoding: "utf8" },
      );
      assert.equal(stripped.status, 2, witness);
      assert.match(
        stripped.stderr,
        /stored\.mjs alike: its run "src-on publication" is not one a store writes/,
      );
    }

    // a source the baseline does not hold (one more of the head's): its runs uncompared, never agreement
    const more = join(directory, "more", "area");
    mkdirSync(more, { recursive: true });
    writeFileSync(join(more, "stored.mjs"), generator([...names, "added"]));
    const added = spawnSync(
      process.execPath,
      [runner, more, head, "--baseline", baseline, "--out", out],
      { encoding: "utf8" },
    );
    assert.equal(added.status, 1);
    assert.deepEqual(
      readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter(({ uncompared }) => uncompared !== undefined)
        .map(({ source, uncompared }) => [source, uncompared]),
      [["added", ["src-on", "src-off", "rev-on", "rev-off"].map((mode) => `${mode} publication`)]],
    );

    // the comparison reads a baseline only through the rule status shares (#1542, the owner's reviewer): a copy of the
    // complete baseline, damaged, or given a complete shard another tree stored, is refused by the comparison as by
    // status (exit 1: not complete; 2: not this tool's, or holding runs of other inputs or a foreign path), so that
    // no comparison ever judges against runs that are not this baseline's
    const another = tree("another", "7", "", "another\n");
    const anotherOracles = tree("another-oracles", "8", "// another oracle library\n", "oracles\n");
    const strangers = join(directory, "strangers");
    for (const stranger of [another, anotherOracles])
      for (const shard of ["0/2", "1/2"])
        assert.equal(store(stranger, area, strangers, "--shard", shard).status, 1);
    const strange = (from: string) =>
      join(strangers, identityOf(from).src, "area", "0of2.runs.jsonl");
    const shard = (dir: string) => join(dir, "area", "0of2.runs.jsonl");
    const witnesses: [string, number, (dir: string) => void][] = [
      [
        "a shard's footer removed",
        1,
        (dir) =>
          writeFileSync(
            shard(dir),
            readFileSync(shard(dir), "utf8").split("\n").slice(0, -2).join("\n") + "\n",
          ),
      ],
      [
        "a field its hash covers altered",
        1,
        (dir) =>
          writeFileSync(
            shard(dir),
            readFileSync(shard(dir), "utf8")
              .replace('"T"', '"U"')
              .replace(/"[0-9a-f]{64}"/, `"${"0".repeat(64)}"`),
          ),
      ],
      ["its PLAN removed", 1, (dir) => rmSync(join(dir, "area", "PLAN"))],
      ["its MANIFEST removed", 2, (dir) => rmSync(join(dir, "MANIFEST"))],
      [
        "its MANIFEST's header changed",
        2,
        (dir) =>
          writeFileSync(
            join(dir, "MANIFEST"),
            readFileSync(join(dir, "MANIFEST"), "utf8").replace(
              /^oracles \w+$/m,
              `oracles ${"0".repeat(64)}`,
            ),
          ),
      ],
      // (#1542 r6: a header accepted only as this tool writes one, by status and by the comparison alike)
      [
        "a token added to its MANIFEST's header",
        2,
        (dir) =>
          writeFileSync(
            join(dir, "MANIFEST"),
            readFileSync(join(dir, "MANIFEST"), "utf8").replace(/^(oracles \w+)$/m, "$1 extra"),
          ),
      ],
      [
        "its MANIFEST's header lines reordered",
        2,
        (dir) =>
          writeFileSync(
            join(dir, "MANIFEST"),
            readFileSync(join(dir, "MANIFEST"), "utf8").replace(
              /^(src \w+)\n(oracles \w+)$/m,
              "$2\n$1",
            ),
          ),
      ],
      ["a complete shard of another src/ tree", 2, (dir) => cpSync(strange(another), shard(dir))],
      [
        "a complete shard of another src/ tree and oracle library",
        2,
        (dir) => cpSync(strange(anotherOracles), shard(dir)),
      ],
      ["a foreign file", 2, (dir) => writeFileSync(join(dir, "area", "z.runs.jsonl"), "{}\n")],
    ];
    for (const [witness, expected, damage] of witnesses) {
      const copy = join(directory, "copies", witness.replaceAll(" ", "-"));
      cpSync(join(root, SRC), join(copy, SRC), { recursive: true });
      damage(join(copy, SRC));
      const status = state(base, copy).status;
      const compared = spawnSync(
        process.execPath,
        [runner, area, head, "--baseline", join(copy, SRC, "area")],
        { encoding: "utf8" },
      );
      assert.deepEqual([witness, status, compared.status], [witness, expected, expected]);
      assert.doesNotMatch(compared.stdout, /"differences"/, witness);
    }
    assert.equal(state(base).status, 0);
    // (and the next writer of the area replaces a PLAN that is not the recorded one, as it replaces a shard)
    writeFileSync(join(baseline, "PLAN"), "plan 1\n");
    assert.equal(state(base).status, 1);
    assert.match(into(alias, "0/2").stdout, /"skipped":"stored"/);
    assert.equal(state(base).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

type Site = {
  site: string;
  function: string;
  call?: string;
  code?: string;
  write?: string;
  kind?: string;
  allowed?: string;
};
type Inventory = {
  modules: string[];
  sites: Site[];
  escapes: Site[];
  processes: Site[];
  loads: Site[];
};

/** Every write of the stored baselines' tools in `checkout`, computed from their modules (`tests/families/writes.mjs`). */
const inventoryOf = async (checkout: string): Promise<Inventory> =>
  (await import(pathToFileURL(resolve(process.cwd(), "tests/families/writes.mjs")).href)).inventory(
    checkout,
  );

test("the stored baselines' tools show no plain write outside the gate in their source, an advisory check computed from their modules (#1542)", async () => {
  const { modules, sites, escapes, processes, loads } = await inventoryOf(process.cwd());
  assert.deepEqual(modules, [
    "tests/families/baselines.mjs",
    "tests/families/run-contract.mjs",
    "tests/families/run.mjs",
    "tests/families/sources.mjs",
  ]);
  // (advisory: the sandbox each store runs in enforces where it writes; this catches the plain forms of a write outside
  // the gate) each write is in the gate, makes a baseline's MANIFEST, or is of a path checked to lie outside every
  // baseline, and fs is used only by calls
  assert.deepEqual(
    sites.filter(({ kind }) => kind === "unproven"),
    [],
  );
  assert.deepEqual(escapes, []);
  assert.deepEqual(
    [...new Set(sites.filter(({ kind }) => kind === "creation").map((site) => site.function))],
    ["owned"],
  );
  // the child processes, each of a form the inventory proves creates and changes no path (any other is an unproven
  // site); the modules loaded by a computed name are a tree's oracle library and work ledger and an area's generators,
  // which are no tool's
  assert.deepEqual(
    processes.map((process) => process.allowed),
    // (the heap probe thrice: with a source's heap, with NODE_OPTIONS alone, and without it, #1956)
    [
      "the gate's lock holder",
      "the heap probe",
      "the heap probe",
      "the heap probe",
      "the runner's own child",
    ],
  );
  assert.deepEqual(
    loads.map((load) => load.function),
    ["oracles", "ledgerOf", "generatorsOf"],
  );
  // the hook writes nothing: no file command, no redirection (after a space, as the script writes them) but to /dev/null
  // or stderr, once its comments and then its single-quoted programs are set aside
  const hook = readFileSync(join("tools", "corpus", "baseline.sh"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/'[^']*'/g, "''");
  assert.deepEqual(
    [
      ...hook.matchAll(
        /(?:^|[;&|({]\s*|\b(?:then|do|else)\s+)(mkdir|mv|cp|rm|rmdir|ln|touch|truncate|install)\s/gm,
      ),
    ].map(([command]) => command),
    [],
  );
  assert.deepEqual(
    [...hook.matchAll(/(?:^|\s)\d*>>?\s*([^\s;&|)]+)/gm)]
      .map(([, target]) => target)
      .filter((target) => !["/dev/null", "/dev/stderr", "&1", "&2"].includes(target!)),
    [],
  );
  assert.deepEqual(
    [...hook.matchAll(/\btee\s+(\S+)/g)]
      .map(([, target]) => target)
      .filter((target) => target !== "/dev/stderr"),
    [],
  );

  // over a copy of the tools: a write added to an imported helper (#1542 r4: imported-helper-write) and writes
  // through each kind of binding are found, unproven, as are one that climbs out of a folder beside the baselines and
  // child processes of no allowed form (`flock` on a path, which creates it where it is absent); an fs binding passed
  // on, exported or destructured otherwise, a module loader and code from text are escapes
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    for (const file of [
      "tools/corpus/baseline.sh",
      "tests/families/baselines.mjs",
      "tests/families/run-contract.mjs",
      "tests/families/run.mjs",
      "tests/families/sources.mjs",
    ]) {
      mkdirSync(join(directory, file, ".."), { recursive: true });
      writeFileSync(join(directory, file), readFileSync(file, "utf8"));
    }
    const append = (file: string, text: string) =>
      writeFileSync(join(directory, file), readFileSync(join(directory, file), "utf8") + text);
    append(
      "tests/families/sources.mjs",
      `import * as everything from "node:fs";
import fs, { writeFileSync as written, promises } from "node:fs";
import { unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { execSync, spawn } from "node:child_process";
import { outside, pathOf } from "./baselines.mjs";
const { appendFileSync } = everything;
const renamed = promisify(fs.rename);
const truncated = fs.truncateSync;
export async function scribble(file, flag) {
  if (flag) written(file, "");
  everything.rmSync(file);
  fs["linkSync"](file, file);
  appendFileSync(file, "");
  await promises.mkdir(file);
  await unlink(file);
  await renamed(file, file);
  truncated(file);
  const { cpSync } = await import("node:fs");
  cpSync(file, file);
  fs.openSync(file, "w");
  fs.writeSync(3, "x");
  fs.readFileSync(file, { flag: "w" });
  fs.readFileSync(file);
  return [fs];
}
export { written };
export function climb(root) {
  const away = pathOf(outside(root, [], () => {}), "outside");
  everything.rmSync(path.join(away, "..", "y"));
  everything.rmSync(path.join(pathOf(root, "baseline"), "z"));
  process.getBuiltinModule("node:fs").rmdirSync(root);
  const { promises: { rm } } = fs;
  eval("0");
  spawn("flock", [root, "-c", "true"]);
  spawn("bash", ["-c", 'touch "$0"', root], { stdio: "ignore" });
  execSync("touch notes");
  return [rm, Worker];
}
export function owned(root) {
  everything.rmSync(path.join(pathOf(root, "baseline"), ".."));
}
const { "writeFileSync": quoted } = everything;
const options = { flag: "w" };
const load = process.getBuiltinModule;
export function r5(file = "notes") {
  quoted(file, "");
  fs.readFileSync(file, options);
  load("node:child_process").spawnSync("touch", [file]);
  written(file, "");
}
`,
    );
    append(
      "tests/families/run.mjs",
      `import nodeFs from "node:fs";
if (process.env.NEVER) nodeFs.writeFileSync(process.env.NEVER, "");
`,
    );
    // (and a write in the gate before it holds the lock)
    const state = join(directory, "tests/families/baselines.mjs");
    writeFileSync(
      state,
      readFileSync(state, "utf8").replace(
        '  const dir = pathOf(baseline, "baseline");\n',
        '  const dir = pathOf(baseline, "baseline");\n  rmSync(path.join(dir, "early"), { force: true });\n',
      ),
    );
    const copied = await inventoryOf(directory);
    assert.deepEqual(
      copied.sites
        .filter(({ kind }) => kind === "unproven")
        .map(({ site, write }) => `${site.split(":")[0]} ${write}`),
      [
        "tests/families/baselines.mjs rmSync",
        "tests/families/run.mjs writeFileSync",
        ...[
          "import node:worker_threads",
          "writeFileSync",
          "rmSync",
          "linkSync",
          "appendFileSync",
          "mkdir",
          "unlink",
          "rename",
          "truncateSync",
          "cpSync",
          "openSync",
          // (#1647: a write to a descriptor other than standard error's)
          "writeSync",
          "readFileSync",
          "rmSync",
          "rmSync",
          "rmdirSync",
          "eval",
          "spawn",
          "spawn",
          "execSync",
          // (a creation that climbs out of its baseline)
          "rmSync",
          // (#1542 r5: an aliased loader, options in a variable, a default parameter)
          "process.getBuiltinModule",
          "readFileSync",
          "writeFileSync",
        ].map((write) => `tests/families/sources.mjs ${write}`),
      ],
    );
    assert.deepEqual(
      copied.escapes.map(({ code }) => code),
      // (#1542 r5: a quoted key)
      ["fs", "written", "{ promises: { rm } } = fs", '{ "writeFileSync": quoted } = everything'],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A preload that stops the process right after its first write (`<function> <path> <data or second path>`) on a path
 * under CRASH_ROOT that CRASH_AT matches, telling CRASH_READY, so that the test kills it there (#1542).
 */
const CRASH = `import fs from "node:fs";
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

test("the stored baselines finish or clear what a writer killed at a write left, one write per entry point (#1542)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const tree = (name: string, sha: string, src = "a\n") => {
      const folder = join(directory, name);
      mkdirSync(join(folder, "dist", "tests", "helpers"), { recursive: true });
      mkdirSync(join(folder, "src"));
      mkdirSync(join(folder, "tests", "families", "area"), { recursive: true });
      writeFileSync(join(folder, "src", "a.ts"), src);
      writeFileSync(join(folder, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(folder, "package-lock.json"), "{}\n");
      writeFileSync(
        join(folder, "dist", "tests", "helpers", "type-core-oracles.js"),
        storable(false),
      );
      writeFileSync(join(folder, ".sha"), `${sha.repeat(40)}\n`);
      writeFileSync(
        join(folder, "tests", "families", "area", "stored.mjs"),
        'export const cases = [["same", "same"], ["changed", "changed"]];\n',
      );
      return folder;
    };
    const base = tree("base", "1");
    const alias = tree("alias", "2");
    const crash = join(directory, "crash.mjs");
    writeFileSync(crash, CRASH);
    let count = 0;
    const killedAt = async (at: string, ...args: string[]) => {
      const ready = join(directory, `ready-${(count += 1)}`);
      const env = { ...process.env, CRASH_ROOT: directory, CRASH_AT: at, CRASH_READY: ready };
      const child = spawn(process.execPath, ["--import", crash, ...args], { env, stdio: "ignore" });
      const closed = new Promise((done) => child.on("close", done));
      while (!existsSync(ready) && child.exitCode === null)
        await new Promise((done) => setTimeout(done, 5));
      assert.ok(existsSync(ready), `${args.join(" ")} ended before a write ${at}`);
      child.kill("SIGKILL");
      await closed;
    };
    const run = (...args: string[]) => spawnSync(process.execPath, args, { encoding: "utf8" });
    const last = (result: { stdout: string }) =>
      JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    const store = (from: string, root: string, shard: string) =>
      run(runner, join(from, "tests", "families", "area"), from, "--store", root, "--shard", shard);

    // a store killed right after it made its area's folder (#1542 r3: interrupted-area-creation; the area is recorded
    // before), then one killed before it published its shard: the next writer finishes the area and publishes, the dead
    // writer's temporary file cleared
    const first = join(directory, "first");
    await killedAt(
      "^mkdirSync .*/area ",
      runner,
      join(base, "tests", "families", "area"),
      base,
      "--store",
      first,
      "--shard",
      "0/2",
    );
    assert.equal(last(store(alias, first, "0/2")).verified, true);
    await killedAt(
      "^writeFileSync .*runs\\.jsonl\\.\\d+-\\d+\\.tmp ",
      runner,
      join(base, "tests", "families", "area"),
      base,
      "--store",
      first,
      "--shard",
      "1/2",
    );
    assert.equal(last(store(alias, first, "1/2")).verified, true);
    const stored = run(baselines, "state", base, first, "--read-only");
    assert.equal(stored.status, 0, stored.stdout);
    const made = last(stored).baseline;
    assert.deepEqual(readdirSync(join(made, "area")).sort(), [
      "0of2.runs.jsonl",
      "1of2.runs.jsonl",
      "PLAN",
    ]);

    // a join killed right after it wrote its MANIFEST's temporary file into the new baseline's folder: the next one makes
    // the baseline, and its gate clears the leftover
    const second = join(directory, "second");
    await killedAt(
      "^writeFileSync .*/MANIFEST\\.\\d+-\\d+\\.tmp ",
      baselines,
      "state",
      base,
      second,
    );
    assert.equal(run(baselines, "state", base, second).status, 1);
    // `start` killed before its marker's rename, `queue` before its copy's: the next call decides and copies
    const top = last(run(baselines, "state", base, second, "--read-only")).baseline;
    await killedAt(
      "^writeFileSync .*STARTED\\.\\d+-\\d+\\.tmp ",
      baselines,
      "start",
      top,
      top.split("/").at(-1)!,
    );
    assert.equal(last(run(baselines, "start", top, top.split("/").at(-1)!)).decision, "started");
    const hook = resolve(process.cwd(), "tools", "corpus", "baseline.sh");
    await killedAt("^copyFileSync ", baselines, "queue", top, hook);
    assert.equal(last(run(baselines, "queue", top, hook)).queued, top);
    assert.deepEqual(readdirSync(top).sort(), ["MANIFEST", "STARTED", "baseline.sh"]);
    // (#1590, reversing #1567) a fill that STARTED and stored a shard runs to its end once another src/ tree is current:
    // its jobs decide `started` and write nothing, its stored shard read as before, STARTED keeping the time it began;
    // a fill none of whose jobs started is SUPERSEDED (#1513), which `queue` undoes when its tree is current again
    assert.equal(store(alias, second, "0/2").status, 0);
    const began = readFileSync(join(top, "STARTED"), "utf8");
    const newer = "f".repeat(40);
    assert.deepEqual(last(run(baselines, "start", top, newer)), { decision: "started" });
    assert.deepEqual(readdirSync(top).sort(), ["MANIFEST", "STARTED", "area", "baseline.sh"]);
    assert.equal(readFileSync(join(top, "STARTED"), "utf8"), began);
    const started = run(baselines, "state", base, second, "--read-only");
    assert.equal(started.status, 1, started.stdout);
    const partial = JSON.parse(started.stdout.split("\n")[0]!);
    assert.deepEqual([partial.state, partial.verified, partial.store], ["partial", 1, [1]]);
    assert.deepEqual(last(run(baselines, "start", made, newer)), {
      decision: "superseded",
      by: newer,
    });
    assert.equal(readFileSync(join(made, "SUPERSEDED"), "utf8"), `${newer}\n`);
    assert.equal(run(baselines, "state", base, first, "--read-only").status, 0);
    assert.equal(last(run(baselines, "queue", made, hook)).queued, made);
    assert.deepEqual(readdirSync(made).sort(), ["MANIFEST", "area", "baseline.sh"]);
    // (#1542 r3: queued-job-foreign-contents) a job's decision in a baseline that holds a foreign path is refused,
    // nothing written
    writeFileSync(join(top, "foreign-late"), "x\n");
    const before = readdirSync(top).sort();
    assert.equal(run(baselines, "start", top, top.split("/").at(-1)!).status, 2);
    assert.deepEqual(readdirSync(top).sort(), before);

    // (#1542 r4: padded-temporary) names this tool never renders, a shard's or a temporary file's with a padded number,
    // are foreign as any other file is: status refuses the baseline naming each, each file untouched
    const fourth = join(directory, "fourth");
    const kept = tree("kept", "4", "kept\n");
    const keeper = tree("keeper", "5", "kept\n");
    assert.equal(store(kept, fourth, "0/1").status, 0);
    rmSync(kept, { recursive: true });
    const held = last(run(baselines, "state", keeper, fourth, "--read-only")).baseline;
    for (const name of [
      "00of1.runs.jsonl.999999999-1.tmp",
      "0of1.runs.jsonl.0999999999-1.tmp",
      "00of1.runs.jsonl",
      "notes.txt",
    ]) {
      writeFileSync(join(held, "area", name), "another agent's\n");
      const status = run(baselines, "state", keeper, fourth, "--read-only");
      assert.equal(status.status, 2);
      assert.ok(
        status.stdout.includes(`foreign contents, which this tool did not write: area/${name}`),
      );
      assert.equal(readFileSync(join(held, "area", name), "utf8"), "another agent's\n");
      rmSync(join(held, "area", name));
    }
    // (#1542 r4: out-in-baseline) the runner's `--out` in a baseline (also through a link) or beside the baselines,
    // and a folder of baselines in a baseline, are refused before anything is opened
    const notes = join(held, "private-notes.txt");
    writeFileSync(notes, "another agent's\n");
    const link = join(directory, "notes-link");
    symlinkSync(notes, link);
    // (a `..` after a link climbs from the link's target, as the system resolves it)
    symlinkSync(join(held, "area"), join(directory, "area-link"));
    const climbing = `${join(directory, "area-link")}/../private-notes.txt`;
    const outTo = (file: string) =>
      run(
        runner,
        join(keeper, "tests", "families", "area"),
        keeper,
        "--store",
        fourth,
        "--out",
        file,
      );
    for (const file of [notes, link, climbing]) {
      const inBaseline = outTo(file);
      assert.equal(inBaseline.status, 2);
      assert.match(inBaseline.stderr, /(private-notes\.txt|notes-link) lies in the baseline /);
    }
    assert.equal(readFileSync(notes, "utf8"), "another agent's\n");
    const nested = store(keeper, join(held, "nested"), "0/1");
    assert.equal(nested.status, 2);
    assert.match(nested.stderr, /nested lies in the baseline /);
    const inRoot = outTo(join(fourth, "differences.jsonl"));
    assert.equal(inRoot.status, 2);
    assert.match(inRoot.stderr, /differences\.jsonl lies in the baselines folder /);
    // (#1542 r5) `--out`, a hard link to a file in a baseline, is a new file, never that file truncated
    const hard = join(directory, "notes-hard.jsonl");
    linkSync(notes, hard);
    assert.equal(outTo(hard).status, 2);
    assert.equal(readFileSync(notes, "utf8"), "another agent's\n");
    rmSync(notes);
    const plan = join(held, "area", "PLAN");
    const planned = readFileSync(plan, "utf8");
    linkSync(plan, join(directory, "plan-hard.jsonl"));
    assert.equal(outTo(join(directory, "plan-hard.jsonl")).status, 0);
    assert.equal(readFileSync(plan, "utf8"), planned);
    // (#1542 r5) `--baseline` through a link is resolved before its folder of baselines is derived
    symlinkSync(join(held, "area"), join(directory, "area-alias"));
    const aliased = run(
      runner,
      join(keeper, "tests", "families", "area"),
      keeper,
      "--baseline",
      join(directory, "area-alias"),
      "--out",
      join(fourth, "notes.jsonl"),
    );
    assert.equal(aliased.status, 2);
    assert.match(aliased.stderr, /notes\.jsonl lies in the baselines folder /);
    assert.equal(existsSync(join(fourth, "notes.jsonl")), false);
    // (#1542 r5) a folder of baselines spelled through a link and `..` is written where the system resolves it, never
    // where its spelling collapses to: here into the baseline's own area
    mkdirSync(join(directory, "elsewhere", "child"), { recursive: true });
    symlinkSync(join(directory, "elsewhere", "child"), join(held, "escape"));
    const spelled = `${join(held, "escape")}/../area`;
    assert.equal(store(keeper, spelled, "0/1").status, 0);
    assert.equal(run(baselines, "state", keeper, `${join(held, "escape")}/../folder`).status, 1);
    assert.deepEqual(readdirSync(join(held, "area")).sort(), ["0of1.runs.jsonl", "PLAN"]);
    assert.equal(existsSync(join(held, "folder")), false);
    assert.deepEqual(readdirSync(join(directory, "elsewhere")).sort(), ["area", "child", "folder"]);
    rmSync(join(held, "escape"));
    // (and a writer given a path this tool did not check refuses it before any filesystem call)
    const state = await import(pathToFileURL(baselines).href);
    const fail = (why: string) => {
      throw new Error(why);
    };
    const raw = join(directory, "raw");
    for (const write of [
      () => state.owned(raw, { src: "1".repeat(40) }, "commit x y"),
      () => state.planned(raw, "area", "plan 1\n"),
      () => state.beginShard(raw, "area", 0),
      // (and a checked path of another kind: a folder of baselines given as a baseline)
      () => state.planned(state.outside(join(directory, "kinds"), [], fail), "area", "plan 1\n"),
    ])
      await assert.rejects(async () => write(), /is no \w+ path this tool checked/);
    assert.equal(existsSync(raw), false);
    assert.equal(existsSync(join(directory, "kinds")), false);
    // a shard's paths come from the claim the gate gave, never from the caller, and a claim publishes once; a baseline
    // path stands for the folder it was issued for: another one found at its path later is refused
    await assert.rejects(
      async () => state.endShard({ baseline: raw, file: notes }, [], {}),
      /is no claim this tool gave/,
    );
    const joined = await state.owned(
      state.outside(fourth, [], fail),
      state.identityOf(keeper),
      null,
    );
    const planText = readFileSync(join(held, "area", "PLAN"), "utf8");
    const plannedAgain = await state.planned(joined.baseline, "area", planText);
    // (#1647, Codex r4) a writer stores by its area as the gate rereads it: an issued area cannot be changed, an object
    // made otherwise (other places, another multiple) only names the area, whose stored shard still counts and is
    // skipped, and one of another PLAN is refused
    assert.throws(() => {
      plannedAgain.area.places[0] = sha256("");
    }, TypeError);
    for (const forged of [
      { ...plannedAgain.area, places: [sha256("")] },
      { ...plannedAgain.area, units: 8 },
    ])
      assert.equal((await state.beginShard(joined.baseline, forged, 0)).skipped, "stored");
    const otherPlan = { ...plannedAgain.area, text: `${planText}x\n` };
    assert.match(
      (await state.beginShard(joined.baseline, otherPlan, 0)).refused,
      /is not the area this writer planned/,
    );
    rmSync(join(held, "area", "0of1.runs.jsonl"));
    const begun = await state.beginShard(joined.baseline, plannedAgain.area, 0);
    assert.notEqual(begun.claim, undefined);
    await state.endShard(begun.claim, [], {});
    await assert.rejects(
      async () => state.endShard(begun.claim, [], {}),
      /is no claim this tool gave/,
    );
    renameSync(held, `${held}-moved`);
    cpSync(`${held}-moved`, held, { recursive: true });
    assert.match((await state.planned(joined.baseline, "area", planText)).refused, /was replaced/);
    // (and an area issued before its baseline was replaced, given with a new handle on the replacement: the writer
    // stores by the replacement's area as the gate reads it, and says what its readers say, Codex r4)
    const rejoined = await state.owned(
      state.outside(fourth, [], fail),
      state.identityOf(keeper),
      null,
    );
    const again = await state.beginShard(rejoined.baseline, plannedAgain.area, 0);
    const published = await state.endShard(again.claim, [], {});
    assert.equal(published.verified, state.storedRuns(join(held, "area")).lines !== undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A built tree's library whose runs charge its ledger (allowance 1,000) 300 units, the source HEAVY names 3,500 (over 3
 * times its allowance, within 4 times it); where `ends` ends the process on every run, and `flaky` and `mixed` end it on
 * the runs FLAKY's characters say (`x`, one each, counted in TMPDIR, which a fill's stores share); `flaky` waits SLOW
 * ms in its first run.
 */
const FILLABLE = `import { createHash } from "node:crypto";
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
const unitsLibrary = (
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

test("a run stalls where its charged units pass the unit limit, the same on every machine, and the wall clock is only a safety net, whose trigger is uncharged work; a baseline stores each run's units, so the stall index judges a head stall from the records, and says so where an older baseline stores none (#1647)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const built = (name: string, isHead: boolean, { ledger = true, between = false } = {}) => {
      const tree = join(directory, name);
      mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
      mkdirSync(join(tree, "dist", "src", "type-inference", "core"), { recursive: true });
      mkdirSync(join(tree, "src"));
      writeFileSync(join(tree, "src", "a.ts"), `${name}\n`);
      writeFileSync(join(tree, ".sha"), `${(isHead ? "2" : "1").repeat(40)}\n`);
      writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
      if (ledger)
        writeFileSync(join(tree, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
      writeFileSync(
        join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
        unitsLibrary(isHead, between, ledger),
      );
      return tree;
    };
    const [base, head] = [built("base", false), built("head", true)];
    const areaOf = (name: string, names: string[]) => {
      const folder = join(directory, name);
      mkdirSync(folder);
      writeFileSync(
        join(folder, "g.mjs"),
        `export const cases = ${JSON.stringify(names.map((source) => [source, source]))};\n`,
      );
      return folder;
    };
    const names = ["fast", "over", "both", "budget", "ledgers", "noisy", "slowall", "hang"];
    const folder = areaOf("units", names);
    const run = (tool: string, ...args: string[]) =>
      spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
    const lines = (text: string) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const sources = (file: string) =>
      new Map(
        lines(readFileSync(file, "utf8"))
          .slice(1, -1)
          .map((line) => [line.source, line]),
      );
    const charged = ({ runs }: { runs: Record<string, unknown>[] }) =>
      runs.map(({ work, allowance, running }) => ({ work, allowance, running }));
    const verdictsOf = (printed: Record<string, unknown>[]) =>
      printed.slice(1, -2).map(({ source, verdict, uncharged }) => [source, verdict ?? uncharged]);
    const MODES = ["src-on", "src-off", "rev-on", "rev-off"];

    // both trees in one process, a safety net of 3 s a run: `over` stalls in the head's first run at the charge that
    // passes 4 × 1,000 units, `both` in the base's (the head's not run), `noisy` too though its stderr is backed up;
    // `budget` ends past its allowance, `ledgers` within 4 times the largest allowance it charged; `slowall` ends, each
    // tree's run within the safety net, a run of both trees together past it; `hang` reaches it: uncharged work, no stall
    const paired = join(directory, "paired.work.jsonl");
    const ran = run(runner, folder, base, head, "--timeout", "3", "--work", paired);
    assert.equal(ran.status, 1, ran.stderr);
    const ended = lines(ran.stdout).at(-1);
    assert.deepEqual([ended.stalled, ended.uncharged, ended.units], [3, 1, 4]);
    assert.match(ran.stderr, /"source":"hang","uncharged":\{"head":"src-on publication"\}/);
    const record = sources(paired);
    // (judged from the record alone: the head's stalls on a run the base ended within the limit, `both` the base's)
    assert.deepEqual(verdictsOf(lines(run(stalls, paired).stdout)), [
      ["over", "candidate"],
      ["both", "inherited"],
      ["noisy", "candidate"],
      ["hang", { head: "src-on publication" }],
    ]);
    assert.deepEqual(
      ["over", "both", "noisy"].map((source) => [
        record.get(source).stalled,
        charged(record.get(source)),
      ]),
      [
        ["units", [{ work: [300, 5300], allowance: [1000, 1000], running: 1 }]],
        ["units", [{ work: [5300, null], allowance: [1000, null], running: 0 }]],
        ["units", [{ work: [300, 5300], allowance: [1000, 1000], running: 1 }]],
      ],
    );
    assert.deepEqual(
      ["budget", "ledgers"].map((source) => charged(record.get(source))),
      [
        MODES.map(() => ({ work: [1800, 1800], allowance: [1000, 1000], running: undefined })),
        MODES.map(() => ({ work: [7301, 7301], allowance: [2000, 2000], running: undefined })),
      ],
    );
    const slowest = record.get("slowall").runs.map(({ ms }: { ms: number[] }) => ms[0]! + ms[1]!);
    assert.ok(
      record.get("slowall").stalled === undefined && slowest.every((ms: number) => ms > 3000),
      String(slowest),
    );
    assert.deepEqual(
      [record.get("hang").stalled, record.get("hang").uncharged, record.get("hang").counts],
      [undefined, { head: "src-on publication" }, { uncharged: 1 }],
    );

    // a real analysis stopped by its budget (TSV076, at the nesting limit) ends, its finishing work counted in its units
    const realSource = `let k: integer = 1\n${"if hostValue == 1 {\n".repeat(257)}say "\${hostValue}"\n${"}\n".repeat(257)}exit`;
    const real = areaOf("real", ["nested"]);
    writeFileSync(
      join(real, "g.mjs"),
      `export const cases = ${JSON.stringify([["nested", realSource]])};\n`,
    );
    const stopped = join(directory, "real.work.jsonl");
    const checkout = process.cwd();
    assert.equal(run(runner, real, checkout, checkout, "--work", stopped).status, 0);
    const request = coreRequest([{ path: "main.tease", source: realSource }]);
    assert.ok(request !== null);
    const { budget } = analyseCore(request);
    const [first] = sources(stopped).get("nested").runs;
    assert.deepEqual([budget.exhausted, budget.finishing > 0], ["nesting", true]);
    assert.ok(
      first.work[1] >= budget.total + budget.finishing,
      JSON.stringify([first, budget.total]),
    );

    // the base stored (plan 2): each run with its units and allowance, a stall over the unit limit with the run it cut,
    // its certificate
    const store = join(directory, "store");
    mkdirSync(store);
    assert.equal(run(runner, folder, base, "--store", store).status, 1);
    const [src] = readdirSync(store);
    const area = join(store, src!, "units");
    assert.match(
      readFileSync(join(area, "PLAN"), "utf8"),
      /^plan 2\n(?:.*\n)*limits 4 x allowance units, \d+ s safety net, 2048 MB\n/,
    );
    const shard = lines(readFileSync(join(area, "0of1.runs.jsonl"), "utf8"));
    const storedOf = (source: string) => shard.find((line) => line.source === source);
    assert.deepEqual(
      [storedOf("both").stalled, storedOf("both").cut],
      ["units", { run: "src-on publication", work: 5300, allowance: 1000 }],
    );
    assert.deepEqual(
      storedRuns(storedOf("budget")).map(({ work, allowance }) => [work, allowance]),
      MODES.map(() => [1800, 1000]),
    );
    assert.deepEqual([shard.at(-1).total.units, shard.at(-1).total.uncharged], [4, 0]);

    // the head against it: the stall index judges each stall from the records, no rerun: a candidate where the base
    // ended the run within the limit, `both` inherited (the base stalled too), `hang` uncharged work, a defect
    const judged = (name: string, baseline: string) => {
      const file = join(directory, `${name}.work.jsonl`);
      const compared = run(
        runner,
        folder,
        head,
        "--baseline",
        baseline,
        "--timeout",
        "3",
        "--work",
        file,
      );
      assert.equal(compared.status, 1, compared.stderr);
      const verdicts = run(stalls, file);
      assert.equal(verdicts.status, 1, verdicts.stderr);
      return [lines(readFileSync(file, "utf8"))[0].work.stored, lines(verdicts.stdout)] as const;
    };
    const [stored, verdicts] = judged("against", area);
    assert.deepEqual(stored, { units: 4 });
    assert.deepEqual(verdictsOf(verdicts), [
      ["over", "candidate"],
      ["both", "inherited"],
      ["noisy", "candidate"],
      ["hang", { head: "src-on publication" }],
    ]);
    assert.equal(
      verdicts[1].why,
      "on src-on publication the head charged 5300 units, over 4 × its allowance 1000; the base 300 within it",
    );
    const unknown = (run: string) =>
      `the head stalled over the unit limit on ${run}, and no units of the base are recorded on it (a baseline before #1647, or a tree without a ledger)`;
    // (no units of the base on the cut run: a baseline before #1647, plan 1, its stalls at a time limit; a base tree
    // without a ledger: unknown, never a candidate)
    const old = join(directory, "old");
    cpSync(store, old, { recursive: true });
    asPlanOne(join(old, src!));
    const [none, before] = judged("before", join(old, src!, "units"));
    assert.deepEqual(none, { units: null });
    assert.deepEqual(
      before.slice(1, 3).map(({ source, verdict, why }) => [source, verdict, why]),
      [
        ["over", "unknown", unknown("src-on publication")],
        [
          "both",
          "unknown",
          "the head stalled (units), and the base at a time limit (a baseline before #1647)",
        ],
      ],
    );
    const bare = built("bare", false, { ledger: false });
    const unmeasured = join(directory, "unmeasured");
    mkdirSync(unmeasured);
    assert.equal(run(runner, folder, bare, "--store", unmeasured).status, 0);
    const [, bareVerdicts] = judged("bare", join(unmeasured, readdirSync(unmeasured)[0]!, "units"));
    assert.deepEqual(
      bareVerdicts.slice(1, 2).map(({ source, verdict, why }) => [source, verdict, why]),
      [["over", "unknown", unknown("src-on publication")]],
    );
    // (and beside it in one process: its run ended, its units none)
    const besideBare = join(directory, "beside-bare.work.jsonl");
    run(runner, areaOf("over", ["over"]), bare, head, "--work", besideBare);
    assert.deepEqual(
      lines(run(stalls, besideBare).stdout)
        .slice(1, 2)
        .map(({ source, verdict, why }) => [source, verdict, why]),
      [["over", "unknown", unknown("src-on publication")]],
    );

    // every reader of a plan 2 shard validates it alike (Codex r1): an ended run over the unit limit, its digest repaired,
    // is refused by the comparison, and a store does not skip it but stores the shard again
    const forged = join(directory, "forged");
    cpSync(store, forged, { recursive: true });
    const forgedShard = join(forged, src!, "units", "0of1.runs.jsonl");
    const [, ...rest] = readFileSync(forgedShard, "utf8").trim().split("\n");
    const forgedLines = readFileSync(forgedShard, "utf8")
      .trim()
      .split("\n")
      .slice(0, -1)
      .map((line) =>
        line.includes('"source":"budget"') ? line.replace('"work":1800', '"work":5000') : line,
      );
    const forgedEnd = JSON.parse(rest.at(-1)!);
    const forgedBody = forgedLines.map((line) => `${line}\n`).join("");
    forgedEnd.total.lines = sha256(forgedBody);
    writeFileSync(forgedShard, `${forgedBody}${JSON.stringify(forgedEnd)}\n`);
    const refusal = run(runner, folder, head, "--baseline", join(forged, src!, "units"));
    assert.equal(refusal.status, 2);
    assert.match(
      refusal.stderr,
      /g\.mjs budget: its run "src-on publication" is not one a store writes/,
    );
    // (and a MANIFEST holding one area's record twice, which status refuses, refused by the comparison too: Codex r4)
    const doubled = join(directory, "doubled");
    cpSync(store, doubled, { recursive: true });
    const doubledManifest = join(doubled, src!, "MANIFEST");
    const areaLine = readFileSync(doubledManifest, "utf8").match(/^area units .*\n/m)![0];
    writeFileSync(doubledManifest, `${readFileSync(doubledManifest, "utf8")}${areaLine}`);
    const twice = run(runner, folder, head, "--baseline", join(doubled, src!, "units"));
    assert.equal(twice.status, 2);
    assert.match(
      twice.stderr,
      /MANIFEST is not one this tool writes: its line \d+ is no line this tool writes/,
    );
    const restored = run(runner, folder, base, "--store", forged);
    assert.equal(lines(restored.stdout).at(-1).verified, true, restored.stdout);
    assert.equal(
      readFileSync(forgedShard, "utf8"),
      readFileSync(join(area, "0of1.runs.jsonl"), "utf8"),
    );

    // the safety net between a source's runs: one representation, which the store writes and every reader accepts
    const between = built("between", false, { between: true });
    const outsideStore = join(directory, "outside");
    mkdirSync(outsideStore);
    const quick = areaOf("quick", ["fast"]);
    const outsideRun = spawnSync(
      process.execPath,
      [runner, quick, between, "--store", outsideStore],
      { encoding: "utf8", env: { ...process.env, FAMILIES_TIMEOUT: "1" } },
    );
    assert.equal(outsideRun.status, 1, outsideRun.stderr);
    const outsideArea = join(outsideStore, readdirSync(outsideStore)[0]!, "quick");
    assert.equal(
      lines(readFileSync(join(outsideArea, "0of1.runs.jsonl"), "utf8"))[0].uncharged,
      "outside its runs",
    );
    const outsideRead = run(runner, quick, between, "--baseline", outsideArea, "--timeout", "1");
    assert.equal(outsideRead.status, 1, outsideRead.stderr);
    assert.match(
      outsideRead.stderr,
      /"uncharged":\{"base":"outside its runs","head":"outside its runs"\}/,
    );

    // a replay recorded before #1647 (its configuration without a unit limit, its stalls a time limit's) is rerun by
    // this runner and merged, the rerun's unit limit added, and judged by its own rule (the transition rule, Codex r1,
    // r2): `over` stalls again, a candidate; `grow`, whose head charged far more than the base before its old time
    // limit, ends in the rerun and stays a candidate, as that rule says a rerun that ends does not clear it
    const legacy = join(directory, "legacy.work.jsonl");
    run(runner, areaOf("legacy", ["fast", "over", "grow"]), base, head, "--work", legacy);
    const [header, ...body] = lines(readFileSync(legacy, "utf8"));
    delete header.work.units;
    delete header.work.configuration.units;
    const total = body.pop().total;
    const older = body.map(({ runs, stalled, counts, ...line }) => {
      const ran = runs.map(({ allowance: _allowance, ...one }: Record<string, unknown>) => one);
      // (`grow`'s first run cut at its old time limit, its units then the head's whole run's)
      return line.source === "grow"
        ? { ...line, runs: [{ ...ran[0], running: 1 }], counts: { stalled: 1 }, stalled: "timeout" }
        : { ...line, runs: ran, counts, ...(stalled === undefined ? {} : { stalled: "timeout" }) };
    });
    const { units: _units, uncharged: _uncharged, ...kept } = total;
    for (const key of ["runs", "stalled"])
      kept[key] = older.reduce((sum, { counts }) => sum + (counts[key] ?? 0), 0);
    writeFileSync(
      legacy,
      [header, ...older, { total: kept }].map((line) => `${JSON.stringify(line)}\n`).join(""),
    );
    const legacyIndex = join(directory, "legacy-index.json");
    assert.equal(run(stalls, legacy, "--index", legacyIndex).status, 1);
    const reran = join(directory, "legacy-rerun");
    assert.equal(run(stalls, "rerun", legacyIndex, base, head, reran).status, 1);
    const merged = run(stalls, legacy, "--rerun", join(reran, "legacy.work.jsonl"));
    assert.equal(merged.status, 1, merged.stderr);
    const after = lines(merged.stdout);
    assert.deepEqual(
      after
        .slice(1, 3)
        .map(({ source, verdict, rerun: { outcome, verdict: now } }) => [
          source,
          verdict,
          outcome,
          now,
        ]),
      [
        ["over", "candidate", "stalled", "candidate"],
        ["grow", "candidate", "agreed", "candidate"],
      ],
    );
    assert.deepEqual([after.at(-1).candidate, after.at(-1).closed], [2, false]);

    // and a plan 2 baseline is compared only at its own unit limit
    const elsewhere = run(runner, folder, head, "--baseline", area, "--units", "3");
    assert.equal(elsewhere.status, 2);
    assert.match(
      elsewhere.stderr,
      /is stored at 4 times the allowance: run the head there \(--units 4\)/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every reader of a stored shard accepts or refuses one line alike, none throwing, and a writer stores again what it refuses: a family over the line's PLAN, end, cut and run (#1647, Codex r2)", async () => {
  // Its readers: status, import, the comparison and, for plan 2, the stalls' listing, `state` and the store. The
  // family's whole product (FAMILIES_FORMAT=full: 3 PLANs × 3 bindings × 9 ends × 5 cuts × 4 runs) is queue evidence,
  // under agents.home.arpa:~/work/evidence/1650/<head>/format-family/; CI runs one variant per class and boundary of
  // each axis (the test-cost rule).
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const tree = join(directory, "tree");
    mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
    mkdirSync(join(tree, "dist", "src", "type-inference", "core"), { recursive: true });
    mkdirSync(join(tree, "src"));
    writeFileSync(join(tree, "src", "a.ts"), "a\n");
    writeFileSync(join(tree, ".sha"), `${"1".repeat(40)}\n`);
    writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
    writeFileSync(join(tree, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
    writeFileSync(
      join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
      unitsLibrary(false),
    );
    // (the area in the tree, where `state` finds it)
    const area = join(tree, "tests", "families", "units");
    mkdirSync(area, { recursive: true });
    writeFileSync(join(area, "g.mjs"), `export const cases = [["s", "s"]];\n`);
    const tool = (...args: string[]) =>
      spawnSync(process.execPath, [baselines, ...args], { encoding: "utf8" });
    const lines = (text: string) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    // the source stored once, its MANIFEST naming the tree's build (as a seed's does)
    const stored = join(directory, "stored");
    mkdirSync(stored);
    assert.equal(spawnSync(process.execPath, [runner, area, tree, "--store", stored]).status, 0);
    assert.equal(tool("compiled", tree, stored).status, 0);
    const [src] = readdirSync(stored);
    const { storedRuns: comparisonOf } = await import(pathToFileURL(baselines).href);

    type Variant = { plan: string; binding: string; end: string; cut: string; run: string };
    const PLANS = ["2", "1", "mismatched"];
    // (the PLAN as its MANIFEST records it, changed after it was recorded, or recorded with no shard: Codex r3)
    const BINDINGS = ["recorded", "other-hash", "zero-shards"];
    const ENDS = [
      "none",
      "units",
      "exit",
      "at-run",
      "at-ended",
      "outside",
      "thrown",
      "two",
      "stall-thrown",
    ];
    const CUTS = ["absent", "valid", "zero", "under", "ended"];
    const RUNS = ["valid", "null", "no-work", "over"];
    /** Whether a store writes the variant (the rule apart from the tools: #1647's format, plan 1 as before it). */
    const accepted = ({ plan, binding, end, cut, run }: Variant) => {
      if (plan === "mismatched" || binding !== "recorded" || run === "null") return false;
      if (["two", "at-ended", "stall-thrown"].includes(end)) return false;
      if (plan === "1") return cut === "absent" && !["at-run", "outside", "units"].includes(end);
      if (run !== "valid") return false;
      return end === "units" ? cut === "valid" : cut === "absent";
    };
    /** The variant's baseline: the stored line made so, its totals and digests repaired, and its stalls' listing. */
    const made = (name: string, { plan, binding, end, cut, run }: Variant) => {
      const root = join(directory, "variants", name);
      cpSync(stored, root, { recursive: true });
      const dir = join(root, src!);
      const file = join(dir, "units", "0of1.runs.jsonl");
      const [line, { total }] = lines(readFileSync(file, "utf8"));
      const names: string[] = Object.keys(line.runs);
      const [first, second] = [names[0]!, names[1]!];
      const result = (ran: Record<string, unknown>): Record<string, unknown> => {
        const { work: _work, allowance: _allowance, ...value } = ran;
        return plan === "2" ? ran : value;
      };
      const ended = result(line.runs[first]);
      // (a run's units, which only plan 2 stores, missing or over the limit)
      const firstRun =
        run === "null"
          ? null
          : run === "no-work" && plan === "2"
            ? Object.fromEntries(Object.entries(ended).filter(([name]) => name !== "work"))
            : run === "over" && plan === "2"
              ? { ...ended, work: 5000 }
              : ended;
      const runs =
        end === "none"
          ? {
              ...Object.fromEntries(names.map((at) => [at, result(line.runs[at])])),
              [first]: firstRun,
            }
          : { [first]: firstRun };
      const cutOf = (kind: string) =>
        kind === "valid"
          ? { run: second, work: 4001, allowance: 1000 }
          : kind === "zero"
            ? { run: second, work: 1, allowance: 0 }
            : kind === "under"
              ? { run: second, work: 4000, allowance: 1000 }
              : { run: first, work: 4001, allowance: 1000 };
      const { generator, source, key } = line;
      const stall =
        end === "units"
          ? "units"
          : ["exit", "two", "stall-thrown"].includes(end)
            ? "exit 3"
            : undefined;
      const written = {
        generator,
        source,
        key,
        ...(stall === undefined ? {} : { stalled: stall }),
        ...(end === "thrown" || end === "stall-thrown"
          ? { thrown: { runner: "Error: thrown" } }
          : {}),
        ...(end === "at-run" || end === "two" ? { uncharged: second } : {}),
        ...(end === "at-ended" ? { uncharged: first } : {}),
        ...(end === "outside" ? { uncharged: "outside its runs" } : {}),
        ...(cut === "absent" ? {} : { cut: cutOf(cut) }),
        runs,
      };
      const body = `${JSON.stringify(written)}\n`;
      let text = readFileSync(join(dir, "units", "PLAN"), "utf8");
      const was = sha256(text);
      if (plan === "1") text = text.replace(/^plan 2$/m, "plan 1");
      if (plan !== "2") text = text.replace(/^limits .*$/m, "limits 180 s, 2048 MB");
      // (the PLAN its MANIFEST and the shard's total name: another PLAN in its place, or one of no shard)
      let recorded = `area units 1 ${sha256(text)}`;
      if (binding === "zero-shards") {
        text = text.replace(/^shards 1$/m, "shards 0").replace(/^shard 0 .*\n/m, "");
        recorded = `area units 0 ${sha256(text)}`;
      }
      const named = sha256(text);
      if (binding === "other-hash")
        text = text.replace(/^limits 4 x/m, "limits 8 x").replace(/^limits 180 s/m, "limits 360 s");
      writeFileSync(join(dir, "units", "PLAN"), text);
      const manifest = join(dir, "MANIFEST");
      writeFileSync(
        manifest,
        readFileSync(manifest, "utf8").replace(`area units 1 ${was}`, recorded),
      );
      const { units: _units, uncharged: _uncharged, ...kept } = total;
      const counted = {
        ...kept,
        stalled: stall === undefined ? 0 : 1,
        ...(plan === "2"
          ? { units: binding === "other-hash" ? 8 : 4, uncharged: "uncharged" in written ? 1 : 0 }
          : {}),
        plan: named,
        lines: sha256(body),
      };
      writeFileSync(file, `${body}${JSON.stringify({ total: counted })}\n`);
      // (an area recorded with no shard holds none)
      if (binding === "zero-shards") rmSync(file);
      const entry = { area: "units", shard: "0/1", generator, source, key, stalled: stall };
      const listed =
        stall === undefined
          ? []
          : [
              plan === "1"
                ? { ...entry, alone: { generator, source, key, stalled: stall, runs: {} } }
                : { ...entry, ...(cut === "absent" ? {} : { cut: cutOf(cut) }) },
            ];
      writeFileSync(
        join(root, "stalls.json"),
        JSON.stringify({ area: "units", shard: "0/1", stalls: listed }),
      );
      return { root, dir, file };
    };
    /** Each reader's answer on the variant: accepted (true), refused (false); a throw fails the test. */
    const readers = (name: string, variant: Variant) => {
      const { root, dir, file } = made(name, variant);
      const answers: Record<string, boolean> = {};
      const status = tool("status", root, src!);
      assert.ok(
        [0, 1, 2].includes(status.status!),
        `${name} status: ${status.stdout}${status.stderr}`,
      );
      answers["status"] = status.status === 0;
      const central = join(directory, "central", name);
      const seed = tool("import", central, root);
      const shard = seed.status === 0 ? tool("import", central, root, "units", "0/1") : seed;
      assert.ok([0, 2].includes(shard.status!), `${name} import: ${shard.stdout}${shard.stderr}`);
      answers["import"] = shard.status === 0;
      const compared = comparisonOf(join(dir, "units"));
      answers["comparison"] = compared.lines !== undefined;
      if (variant.plan === "2") {
        // (the plan 2 writers: the stalls' listing, and a store, which skips only what it accepts and stores the rest
        // again; a plan 2 writer refuses a plan 1 area as another plan, and one recorded with no shard, and replaces
        // a PLAN that is not the recorded one, so that the area then reads complete)
        const listing = tool(
          "stalls",
          file,
          "units",
          "0/1",
          join(directory, `${name}.stalls.json`),
        );
        assert.ok([0, 2].includes(listing.status!), `${name} stalls: ${listing.stderr}`);
        answers["stalls"] = listing.status === 0;
        // (`state`, the hook's and `baseline.sh status`'s reader, of the tree whose area this is)
        const state = tool("state", tree, root, "--read-only");
        assert.ok(
          [0, 1, 2].includes(state.status!),
          `${name} state: ${state.stdout}${state.stderr}`,
        );
        answers["state"] = state.status === 0;
        const store = spawnSync(process.execPath, [runner, area, tree, "--store", root], {
          encoding: "utf8",
        });
        if (variant.binding === "zero-shards")
          assert.equal(store.status, 2, `${name} store: ${store.stdout}${store.stderr}`);
        else if (variant.binding === "other-hash")
          assert.equal(tool("status", root, src!).status, 0, `${name} repaired: ${store.stdout}`);
        else {
          const ended = lines(store.stdout).at(-1);
          answers["store"] = ended.skipped === "stored";
          if (!answers["store"])
            assert.equal(ended.verified, true, `${name} stored again: ${store.stdout}`);
        }
      }
      return answers;
    };
    const base: Variant = {
      plan: "2",
      binding: "recorded",
      end: "none",
      cut: "absent",
      run: "valid",
    };
    const variants: Variant[] =
      process.env.FAMILIES_FORMAT === "full"
        ? PLANS.flatMap((plan) =>
            BINDINGS.flatMap((binding) =>
              ENDS.flatMap((end) =>
                CUTS.flatMap((cut) => RUNS.map((run) => ({ plan, binding, end, cut, run }))),
              ),
            ),
          )
        : [
            base,
            ...PLANS.slice(1).map((plan) => ({ ...base, plan })),
            ...BINDINGS.slice(1).map((binding) => ({ ...base, binding })),
            { ...base, plan: "1", end: "units" },
            { ...base, plan: "1", end: "stall-thrown" },
            ...ENDS.slice(1).map((end) => ({
              ...base,
              end,
              cut: end === "units" ? "valid" : "absent",
            })),
            ...CUTS.filter((cut) => cut !== "valid").map((cut) => ({ ...base, end: "units", cut })),
            { ...base, cut: "valid" },
            ...RUNS.slice(1).map((run) => ({ ...base, run })),
            { ...base, plan: "1", end: "exit" },
          ];
    const disagreements = variants.flatMap((variant) => {
      const name = Object.values(variant).join("-");
      const answers = readers(name, variant);
      const expected = accepted(variant);
      return Object.entries(answers)
        .filter(([, answer]) => answer !== expected)
        .map(([reader, answer]) => `${name}: ${reader} ${answer ? "accepts" : "refuses"}`);
    });
    assert.deepEqual(disagreements, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A built tree's library whose analyses charge its ledger (allowance 30,000,000, so the runner's limit is 120,000,000
 * units a run) 3,000 units a run: `throws` throws on both trees, `ends` ends the process there, as each `once…` does
 * where `FIXTURE_ENDS` is set; `busy` waits 200 ms on the base; `lagging` waits 3 s on the head's first run; `slow`
 * charges a billion units more on the head at once and waits 150 ms there; `burst` charges 10,000 times 65,536 units on
 * the head, then waits; `changed` publishes its second part otherwise on the head. Its stop sets differ on the head at
 * demand allowance 1 and charge a billion units there at 2. Where `FIXTURE_TRACE` names a file, the head appends a
 * source's name to it in the source's first mode: once each time the source runs.
 */
const charging = (head: boolean): string => `import { appendFileSync } from "node:fs";
import { WorkLedger } from "../../src/type-inference/core/budget.js";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function publicationHashes(files, mode) {
  const source = files[0].source;
  const ledger = new WorkLedger();
  for (let unit = 0; unit < 1000; unit += 1) ledger.charge("frames", 3);
  if (source === "throws") throw new Error("independent exception witness");
  if (source === "ends" || (source.startsWith("once") && process.env.FIXTURE_ENDS)) process.exit(3);
  if (${head} && mode === MODES[0] && process.env.FIXTURE_TRACE)
    appendFileSync(process.env.FIXTURE_TRACE, source + "\\n");
  if (!${head} && source === "busy") wait(200);
  if (${head} && source === "lagging" && mode === MODES[0]) wait(3000);
  if (${head} && source === "slow") {
    ledger.charge("frames", 1e9);
    wait(150);
  }
  if (${head} && source === "burst") {
    for (let unit = 0; unit < 10000; unit += 1) ledger.charge("frames", 65536);
    wait(10000);
  }
  return { parts: ["a", ${head} && source === "changed" ? "c" : "b"], unanswered: 0 };
}
export function stopSet(files, mode, globals, allowance) {
  if (${head} && allowance === 1) return { stops: [[1, "x", "y", 1]] };
  if (${head} && allowance === 2) new WorkLedger().charge("frames", 1e9);
  return { stops: [] };
}
`;

test("the corpus runner records each source's units, allowance and time, a cut run's to the stall, and a rerun of the stall index on both trees, whole or in shards that rerun it once, closes a stall that ends but never a stall over the unit limit, a candidate or a difference (#1564, #1598, #1647)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const built = (isHead: boolean) => {
      const tree = join(directory, isHead ? "head" : "base");
      mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
      mkdirSync(join(tree, "dist", "src", "type-inference", "core"), { recursive: true });
      writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(tree, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
      writeFileSync(
        join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
        charging(isHead),
      );
      return tree;
    };
    const [base, head] = [built(false), built(true)];
    const area = (name: string, names: string[], checks = ["publication"]) => {
      const folder = join(directory, name);
      mkdirSync(folder);
      const cases = JSON.stringify(names.map((source) => [source, source]));
      writeFileSync(
        join(folder, "g.mjs"),
        `export const cases = ${cases};\nexport const checks = ${JSON.stringify(checks)};\n`,
      );
      return folder;
    };
    const lines = (text: string) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const run = (tool: string, ...args: string[]) =>
      spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
    const MODES = ["src-on", "src-off", "rev-on", "rev-off"];

    // sources that end or throw: the runner's output and `--out`, exceptions' stacks included, as without the record
    const ending = area("ending", ["fast", "changed", "throws"]);
    const plain = run(runner, ending, base, head, "--out", join(directory, "plain.jsonl"));
    const recorded = run(
      runner,
      ending,
      base,
      head,
      "--out",
      join(directory, "recorded.jsonl"),
      "--work",
      join(directory, "ending.work.jsonl"),
    );
    assert.equal(recorded.status, 1, recorded.stderr);
    assert.equal(recorded.stdout, plain.stdout);
    const kept = readFileSync(join(directory, "recorded.jsonl"), "utf8");
    assert.equal(kept, readFileSync(join(directory, "plain.jsonl"), "utf8"));
    assert.match(kept, /independent exception witness\\n {4}at /);
    // one tree given twice: one ledger, whose units go to the tree running; no shard but 0/N to N-1/N
    const twice = join(directory, "twice.work.jsonl");
    run(runner, ending, base, base, "--work", twice);
    assert.deepEqual(
      lines(readFileSync(twice, "utf8"))[1].runs.map(
        ({ work: units }: { work: number[] }) => units,
      ),
      MODES.map(() => [3000, 3000]),
    );
    assert.match(run(runner, ending, base, head, "--shard", "2/2").stderr, /no shard i\/N/);
    // `--out`, `--work` and its progress record name three files, as the system resolves them, or nothing is touched
    // (#1564 r2: a progress record that is `--out` or a link to `--work`)
    const collided = join(directory, "collided.work.jsonl");
    writeFileSync(`${collided}.progress`, "kept\n");
    const colliding = run(
      runner,
      ending,
      base,
      head,
      "--work",
      collided,
      "--out",
      `${collided}.progress`,
    );
    assert.equal(colliding.status, 2, colliding.stderr);
    assert.deepEqual(
      [readFileSync(`${collided}.progress`, "utf8"), existsSync(collided)],
      ["kept\n", false],
    );
    const linked = join(directory, "linked.work.jsonl");
    writeFileSync(linked, "kept\n");
    symlinkSync(linked, `${linked}.progress`);
    assert.equal(run(runner, ending, base, head, "--work", linked).status, 2);
    assert.equal(readFileSync(linked, "utf8"), "kept\n");
    // one plan (#1564 r2's mismatched-plan witness): shard 0/2 of an area of four sources and shard 1/2 of a copy of
    // three, each area named `planned`, compare otherwise and are refused together, never closed
    const planned = (copy: string, names: string[]) => {
      mkdirSync(join(directory, copy));
      return area(join(copy, "planned"), names);
    };
    const [four, three] = [join(directory, "four.work.jsonl"), join(directory, "three.work.jsonl")];
    run(
      runner,
      planned("four", ["a", "b", "c", "bad"]),
      base,
      head,
      "--shard",
      "0/2",
      "--work",
      four,
    );
    run(runner, planned("three", ["a", "b", "c"]), base, head, "--shard", "1/2", "--work", three);
    const mixed = run(stalls, four, three);
    assert.equal(mixed.status, 2, mixed.stdout);
    assert.match(mixed.stderr, /compares otherwise than the area's other shards \(plan\)/);
    // a source the plan lists twice (#1582): its repeats, run and counted in two shards, are one source
    const repeated = area("repeated", ["dup", "fast", "lone", "dup"]);
    const [half, other] = [join(directory, "half.work.jsonl"), join(directory, "other.work.jsonl")];
    run(runner, repeated, base, head, "--shard", "0/2", "--work", half);
    run(runner, repeated, base, head, "--shard", "1/2", "--work", other);
    const once = run(stalls, half, other);
    assert.equal(once.status, 0, once.stderr);
    const { sources, repeats, agreed, closed } = lines(once.stdout).at(-1);
    assert.deepEqual([sources, repeats, agreed, closed], [3, 1, 3, true]);
    const withEnv = (env: Record<string, string>, tool: string, ...args: string[]) =>
      spawnSync(process.execPath, [tool, ...args], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
    // one library (#1564 r3's mixed-dist witness): two heads given as their `dist/`, one compiled `src/` and two oracle
    // libraries, compare otherwise and are refused together; one head's `dist/` in both shards closes
    const twin = join(directory, "twin");
    cpSync(head, twin, { recursive: true });
    writeFileSync(
      join(twin, "dist", "tests", "helpers", "type-core-oracles.js"),
      `${charging(true)}// another library\n`,
    );
    const pair = area("pair", ["a", "b"]);
    const own = join(directory, "own.work.jsonl");
    const twinned = join(directory, "twinned.work.jsonl");
    const both = join(directory, "both.work.jsonl");
    run(runner, pair, base, join(head, "dist"), "--shard", "0/2", "--work", own);
    run(runner, pair, base, join(twin, "dist"), "--shard", "1/2", "--work", twinned);
    run(runner, pair, base, join(head, "dist"), "--shard", "1/2", "--work", both);
    const libraries = run(stalls, own, twinned);
    assert.equal(libraries.status, 2, libraries.stdout);
    assert.match(libraries.stderr, /compares otherwise than the area's other shards \(trees\)/);
    assert.equal(run(stalls, own, both).status, 0);
    // one compiler (#1564 r4's witnesses): two checkouts of one TypeScript `src/` and oracle library whose compiled
    // compilers differ compare otherwise, as shards and as a replay and its rerun; the same checkout merges and reruns
    const checkout = (name: string, compiler: string) => {
      const copy = join(directory, name);
      cpSync(head, copy, { recursive: true });
      mkdirSync(join(copy, "src"));
      writeFileSync(join(copy, "src", "a.ts"), "a\n");
      writeFileSync(join(copy, "dist", "src", "type-inference", "core", "budget.js"), compiler);
      return copy;
    };
    const [one, another] = [checkout("one", LEDGER), checkout("another", `${LEDGER}// another\n`)];
    const compiled = area("compiled", ["a", "ends"]);
    const [first, second, same] = [0, 1, 2].map((index) =>
      join(directory, `compiled-${index}.work.jsonl`),
    );
    run(runner, compiled, base, one, "--shard", "0/2", "--work", first!);
    run(runner, compiled, base, another, "--shard", "1/2", "--work", second!);
    run(runner, compiled, base, one, "--shard", "1/2", "--work", same!);
    const compilers = run(stalls, first!, second!);
    assert.equal(compilers.status, 2, compilers.stdout);
    assert.match(compilers.stderr, /compares otherwise than the area's other shards \(trees\)/);
    assert.equal(run(stalls, first!, same!).status, 1);
    const ended = join(directory, "ended.work.jsonl");
    const endedIndex = join(directory, "ended-index.json");
    run(runner, compiled, base, one, "--work", ended);
    run(stalls, ended, "--index", endedIndex);
    const wrong = run(stalls, "rerun", endedIndex, base, another, join(directory, "wrong"));
    assert.match(wrong.stderr, /is not the tree compiled's replay compared/);
    assert.equal(existsSync(join(directory, "wrong")), false);
    assert.equal(run(stalls, "rerun", endedIndex, base, one, join(directory, "right")).status, 1);
    assert.equal(
      run(stalls, ended, "--rerun", join(directory, "right", "compiled.work.jsonl")).status,
      1,
    );

    // charges far faster than the runner reads them, then a wait past the safety net: the run stalls at the charge that
    // passes the unit limit, 3,000 + 1,832 × 65,536 units, and the record holds it exactly, as the child wrote it over
    // there (#1564 r1's saturation witness, #1647)
    const burst = join(directory, "burst.work.jsonl");
    run(runner, area("burst", ["burst"]), base, head, "--timeout", "1.5", "--work", burst);
    const [, flooding] = lines(readFileSync(burst, "utf8"));
    const flooded = flooding.runs.at(-1);
    assert.deepEqual(
      [flooding.stalled, flooded.work, flooded.allowance, flooded.running],
      ["units", [3000, 3000 + 1832 * 65_536], [30_000_000, 30_000_000], 1],
    );

    // a replay at a two-second safety net: `slow` stalls in the head's first run over the unit limit, before its wait;
    // `busy` ends, its base's runs each within the safety net; `lagging` (3 s) reaches it in the head's first run,
    // uncharged work and no stall (#1842: a margin of seconds either way, which a loaded worker keeps, where a half-second
    // net and a 600 ms wait left 100-300 ms); each source's record holds each run's units, allowance and milliseconds on each tree, a cut
    // run's those it had when the runner ended it
    const replay = area("replay", ["fast", "slow", "busy", "lagging"]);
    const work = join(directory, "replay.work.jsonl");
    const ran = run(runner, replay, base, head, "--timeout", "2", "--work", work);
    assert.equal(ran.status, 1, ran.stderr);
    const [header, fast, slow, busy, lagging, total] = lines(readFileSync(work, "utf8"));
    assert.deepEqual(
      [
        header.work.area,
        header.work.shard,
        header.work.roots,
        header.work.configuration.allowances,
        header.work.configuration.units,
      ],
      [replay, "0/1", [base, head], [null, 16, 256], 4],
    );
    assert.deepEqual(total.total, JSON.parse(ran.stdout.trim().split("\n").at(-1)!));
    assert.deepEqual(
      fast.runs.map(({ mode, work: units }: { mode: string; work: number[] }) => [mode, ...units]),
      MODES.map((mode) => [mode, 3000, 3000]),
    );
    assert.deepEqual([fast.counts, fast.stalled], [{ runs: 4 }, undefined]);
    assert.deepEqual(
      [slow.stalled, busy.stalled, lagging.stalled, lagging.uncharged],
      ["units", undefined, undefined, { head: "src-on publication" }],
    );
    const cut = slow.runs.at(-1);
    assert.deepEqual([cut.work, cut.running], [[3000, 1e9 + 3000], 1]);
    assert.deepEqual([busy.counts, busy.runs.at(-1).running], [{ runs: 4 }, undefined]);
    assert.deepEqual([lagging.counts, lagging.runs.at(-1).running], [{ uncharged: 1 }, 1]);

    // the index: `slow` a candidate (the head alone over the unit limit, on a run the base ended within it), `lagging`
    // named as uncharged work; neither agreement
    const index = join(directory, "index.json");
    const indexed = run(stalls, work, "--index", index);
    assert.equal(indexed.status, 1, indexed.stderr);
    const printed = lines(indexed.stdout);
    assert.match(printed[0].rule, /^A run stalls where its charged units pass the unit limit/);
    assert.deepEqual(
      printed.slice(1, 3).map(({ source, verdict, uncharged }) => [source, verdict ?? uncharged]),
      [
        ["slow", "candidate"],
        ["lagging", { head: "src-on publication" }],
      ],
    );
    const counted = (row: Record<string, unknown>) =>
      [
        "sources",
        "agreed",
        "unavailable",
        "uncharged",
        "candidate",
        "inherited",
        "unknown",
        "rerun",
        "closed",
      ].map((key) => row[key]);
    assert.deepEqual(counted(printed[4]), [4, 2, 1, 1, 1, 0, 0, 0, false]);
    assert.deepEqual(
      JSON.parse(readFileSync(index, "utf8")).entries.map(
        ({ source }: { source: string }) => source,
      ),
      ["slow"],
    );

    // an index naming a source its area does not hold is refused before any runs
    mkdirSync(join(directory, "elsewhere"));
    const fewer = area(join("elsewhere", "replay"), ["fast"]);
    assert.match(run(runner, fewer, base, head, "--only", index).stderr, /does not hold/);

    // the rerun: each source alone, both trees in one process; `slow` stalls again, at the same units, as it does on
    // every machine, so the replay stays open
    const again = join(directory, "again");
    const rerun = run(stalls, "rerun", index, base, head, again, "--timeout", "5");
    assert.equal(rerun.status, 1, rerun.stderr);
    const merged = run(stalls, work, "--rerun", join(again, "replay.work.jsonl"));
    assert.equal(merged.status, 1, merged.stderr);
    const after = lines(merged.stdout);
    assert.deepEqual(
      after
        .slice(1, 2)
        .map(({ source, rerun: { outcome, verdict } }) => [source, outcome, verdict]),
      [["slow", "stalled", "candidate"]],
    );
    assert.deepEqual(counted(after.at(-1)), [4, 2, 1, 1, 1, 0, 0, 1, false]);

    // `rerun --shard i/N` (#1598): an index over two areas, one of them replayed at two paths in two shards (a replay
    // sharded across workers), its entry k rerun by shard k mod N alone, one runner per area whatever paths its entries
    // name, each shard's records beside its part of the index and none for an area that part does not hold; the
    // shards' records merge as the whole rerun's do
    const replayed = (folder: string, shard: string, name: string) => {
      const file = join(directory, `${name}.work.jsonl`);
      withEnv({ FIXTURE_ENDS: "1" }, runner, folder, base, head, "--shard", shard, "--work", file);
      return file;
    };
    const aliased = (at: number) => {
      mkdirSync(join(directory, `alias-${at}`));
      return area(join(`alias-${at}`, "sharded"), ["once-a", "once-b", "once-c"]);
    };
    const partedWork = [
      replayed(aliased(0), "0/2", "alias-0"),
      replayed(aliased(1), "1/2", "alias-1"),
      replayed(area("beside", ["once-d"]), "0/1", "beside"),
    ];
    const partedIndex = join(directory, "parted.json");
    assert.equal(run(stalls, ...partedWork, "--index", partedIndex).status, 1);
    const { entries } = JSON.parse(readFileSync(partedIndex, "utf8"));
    const named = entries.map(({ area: of, source }: { area: string; source: string }) => [
      basename(of),
      source,
    ]);
    assert.deepEqual(named, [
      ["sharded", "once-a"],
      ["sharded", "once-c"],
      ["sharded", "once-b"],
      ["beside", "once-d"],
    ]);
    assert.equal(new Set(entries.map(({ area: of }: { area: string }) => of)).size, 3);
    // each entry runs once, counted as it runs: an entry run twice, by two shards or by two runners of one area, is
    // caught here, not by the files left (a second runner of an area replaces the first's) nor by the merged summary,
    // which takes two ended records that say the same as one source by design (#1587)
    const traced = (folder: string, ...shard: string[]) => {
      const trace = `${folder}.trace`;
      const ran = withEnv(
        { FIXTURE_TRACE: trace },
        stalls,
        "rerun",
        partedIndex,
        base,
        head,
        folder,
        ...shard,
      );
      assert.equal(ran.status, 0, ran.stderr);
      return readFileSync(trace, "utf8").trim().split("\n").sort();
    };
    const whole = join(directory, "whole");
    assert.deepEqual(traced(whole), ["once-a", "once-b", "once-c", "once-d"]);
    const parts = [0, 1].map((shard) => join(directory, `part-${shard}`));
    parts.forEach((folder, shard) =>
      assert.deepEqual(
        traced(folder, "--shard", `${shard}/2`),
        named
          .filter((_: unknown, entry: number) => entry % 2 === shard)
          .map(([, source]: string[]) => source)
          .sort(),
      ),
    );
    assert.deepEqual(
      parts.map((folder) => readdirSync(folder).sort()),
      [
        ["index.0of2.json", "sharded.0of2.jsonl", "sharded.0of2.work.jsonl"],
        [
          "beside.1of2.jsonl",
          "beside.1of2.work.jsonl",
          "index.1of2.json",
          "sharded.1of2.jsonl",
          "sharded.1of2.work.jsonl",
        ],
      ],
    );
    const records = (folder: string) =>
      readdirSync(folder)
        .filter((file) => file.endsWith(".work.jsonl"))
        .map((file) => join(folder, file));
    const judged = (files: string[]) => {
      const { status, stdout, stderr } = run(stalls, ...partedWork, "--rerun", ...files);
      return { status, stdout, stderr };
    };
    const unsharded = judged(records(whole));
    assert.deepEqual(
      [unsharded.status, lines(unsharded.stdout).at(-1).rerun],
      [0, 4],
      unsharded.stderr,
    );
    assert.deepEqual(judged(parts.flatMap(records)), unsharded);
    // a shard that is none of 0/N to N-1/N is refused before any folder is made
    const refused = join(directory, "refused");
    for (const sharding of ["0/0", "2/2", "1.5/2", "/2"]) {
      const refusal = run(stalls, "rerun", partedIndex, base, head, refused, "--shard", sharding);
      assert.equal(refusal.status, 2, sharding);
      assert.match(refusal.stderr, /is no shard i\/N with 0 <= i < N/);
    }
    assert.equal(existsSync(refused), false);
    // `rerun --items` (#1612, the owner's job-size rule): an item pool's batches, each naming entries by number (one in
    // a file given, one in the file `$SX_ITEMS` names, as the central queue sets it, #1644), rerun the index once, each
    // batch's records beside its part of the index, named by its hash, and merge as the whole rerun's do; an entry named
    // twice, one out of range, a missing items file, or `--shard` beside it refused
    const batches = [join(directory, "items-0"), join(directory, "items-1")];
    const itemFile = join(directory, "items-0.txt");
    writeFileSync(itemFile, "2\n0\n");
    assert.deepEqual(traced(batches[0]!, "--items", itemFile), ["once-a", "once-b"]);
    const envFile = join(directory, "items-1.txt");
    writeFileSync(envFile, "1\n3\n");
    const fromEnv = withEnv(
      { SX_ITEMS: envFile },
      stalls,
      "rerun",
      partedIndex,
      base,
      head,
      batches[1]!,
      "--items-from-env",
    );
    assert.equal(fromEnv.status, 0, fromEnv.stderr);
    assert.deepEqual(
      batches.map(
        (folder) => readdirSync(folder).filter((file) => file.startsWith("index.items-")).length,
      ),
      [1, 1],
    );
    assert.deepEqual(judged(batches.flatMap(records)), unsharded);
    for (const [items, why] of [
      ["0\n0\n", /names an entry twice/],
      ["4\n", /names no entry of .* \(4 entries\): 4/],
      ["a\n", /names no entry of/],
    ] as const) {
      writeFileSync(itemFile, items);
      const refusal = run(stalls, "rerun", partedIndex, base, head, refused, "--items", itemFile);
      assert.equal(refusal.status, 2, items);
      assert.match(refusal.stderr, why);
    }
    const missing = join(directory, "no-items.txt");
    const unread = withEnv(
      { SX_ITEMS: missing },
      stalls,
      "rerun",
      partedIndex,
      base,
      head,
      refused,
      "--items-from-env",
    );
    assert.equal(unread.status, 2, unread.stderr);
    assert.ok(unread.stderr.includes(`the items file ${missing}: ENOENT`), unread.stderr);
    const shardAndItems = run(
      stalls,
      "rerun",
      partedIndex,
      base,
      head,
      refused,
      "--items",
      itemFile,
      "--shard",
      "0/2",
    );
    assert.match(shardAndItems.stderr, /--shard and --items each choose the entries/);
    assert.equal(existsSync(refused), false);

    // a replay of other stop allowances (#1564 r1's false-closure witness): its index keeps them, so its rerun runs
    // them again, keeps the difference at allowance 1 and stalls again at 2; a rerun record of other allowances is not
    // merged. The stall at 2 is by units (the head's `stopSet` charges 1e9 there), the same on every machine; the wall
    // clock is only the safety net, wide enough that no loaded worker reaches it (#1842: at 0.5 s and 1 s one did)
    const checks = area("checks", ["checked"], ["publication", "stops"]);
    const checked = join(directory, "checks.work.jsonl");
    run(runner, checks, base, head, "--allowances", "1,2", "--timeout", "30", "--work", checked);
    const checkIndex = join(directory, "checks-index.json");
    assert.equal(run(stalls, checked, "--index", checkIndex).status, 1);
    assert.match(
      run(stalls, "rerun", checkIndex, base, head, join(directory, "x"), "--allowances", "1")
        .stderr,
      /drop --allowances/,
    );
    const rechecked = join(directory, "rechecked");
    assert.equal(
      run(stalls, "rerun", checkIndex, base, head, rechecked, "--timeout", "30").status,
      1,
    );
    const reran = run(stalls, checked, "--rerun", join(rechecked, "checks.work.jsonl"));
    assert.equal(reran.status, 1, reran.stderr);
    assert.deepEqual(
      [lines(reran.stdout).at(-1).differences, lines(reran.stdout).at(-1).unavailable],
      [1, 1],
    );
    const defaults = join(directory, "defaults.work.jsonl");
    run(runner, checks, base, head, "--only", checkIndex, "--timeout", "30", "--work", defaults);
    const refusedMerge = run(stalls, checked, "--rerun", defaults);
    assert.equal(refusedMerge.status, 2);
    assert.match(refusedMerge.stderr, /compares otherwise than its replay \(allowances\)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the stall index decides each stalled source from its record by one rule: the head's work on each run, its time where both trees ran in one process, and which tree stalled and why (#1564)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const KEYS = [
      "unparsed",
      "stalled",
      "exceptions",
      "unanswered",
      "uncompared",
      "runs",
      "differences",
    ];
    type Entry = { source: string; counts: Record<string, number> } & Record<string, unknown>;
    const CONFIGURATION = {
      sizes: null,
      allowances: [null, 16, 256],
      checks: { "g.mjs": ["publication"] },
      trees: [{ src: null }, { src: null }],
    };
    /**
     * A shard's `--work` record (shard `at` of the area `name`, in the file `file`) of `trees` trees, its total the sum of
     * its sources' counts, cut before its total where `cut`; `unansweredAlike` only where a source counts one, as a runner
     * before #1592 wrote the others.
     */
    const shard = (
      name: string,
      trees: number,
      entries: Entry[],
      { cut = false, at = "0/1", file: called = name, configuration = CONFIGURATION } = {},
    ) => {
      const sum = (key: string) =>
        entries.reduce((total, { counts }) => total + (counts[key] ?? 0), 0);
      const total = {
        area: name,
        sources: entries.length,
        ...Object.fromEntries(KEYS.map((key) => [key, sum(key)])),
        ...(sum("unansweredAlike") > 0 ? { unansweredAlike: sum("unansweredAlike") } : {}),
      };
      const file = join(directory, `${called}.work.jsonl`);
      const roots = Array.from({ length: trees }, () => "tree");
      const header = { work: { area: name, shard: at, roots, configuration } };
      const lines = [
        header,
        ...entries.map((entry) => ({ generator: "g.mjs", key: "k", ...entry })),
      ];
      writeFileSync(
        file,
        [...lines, ...(cut ? [] : [{ total }])].map((line) => `${JSON.stringify(line)}\n`).join(""),
      );
      return file;
    };
    const publication = (work: (number | null)[], ms: (number | null)[], running?: number) => ({
      mode: "src-on",
      check: "publication",
      work,
      ms,
      ...(running === undefined ? {} : { running }),
    });
    const stalled = (source: string, why: unknown, runs: Record<string, unknown>[]): Entry => ({
      source,
      stalled: why,
      runs,
      counts: { stalled: 1 },
    });
    const heap =
      "SIGABRT: FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory";
    // both trees in one process: the tree that stalled is the one still running
    const paired = shard("paired", 2, [
      stalled("memory", heap, [publication([10, 5], [5, 3], 1)]),
      stalled("charged", "timeout", [
        publication([100, 100], [10, 10]),
        publication([100, 150], [10, 500], 1),
      ]),
      stalled("slower", "timeout", [
        publication([1000, 1000], [100, 100]),
        publication([1000, 500], [100, 10201], 1),
      ]),
      stalled("boundary", "timeout", [
        publication([1000, 1000], [100, 100]),
        publication([1000, 500], [100, 10200], 1),
      ]),
      stalled("based", "timeout", [
        publication([100, 100], [10, 10]),
        publication([50, null], [180000, null], 0),
      ]),
      stalled("unmeasured", "timeout", [publication([null, null], [10, 180000], 1)]),
      stalled("between", "exit 3", [publication([5, 5], [1, 1])]),
      { source: "agreed", runs: [publication([5, 5], [1, 1])], counts: { runs: 1 } },
      // a source that ended in the replay is judged by agreement alone: its work is the growth gates'
      { source: "costlier", runs: [publication([5, 9], [1, 30000])], counts: { runs: 1 } },
    ]);
    // the head against a stored base, which records no work
    const stored = shard("stored", 1, [
      stalled("timedout", { head: "timeout" }, [publication([500], [180000], 0)]),
      stalled("crashed", { head: heap }, [publication([500], [100], 0)]),
      stalled("inherited", { base: "timeout", head: "timeout" }, [publication([500], [180000], 0)]),
    ]);
    // a replay's `--out` file for a shard run without `--work`: its stalls alone
    const out = join(directory, "property-0of1.jsonl");
    const files = [{ path: "main.tease", source: "x" }];
    writeFileSync(
      out,
      `${JSON.stringify({ generator: "s8-stores.mjs", source: "x", stalled: { head: "timeout" }, files, globals: [] })}\n` +
        // (#1647, Codex r2: a source at the safety net, which the `--out` file names too)
        `${JSON.stringify({ generator: "s8-stores.mjs", source: "y", uncharged: { head: "src-on publication" }, files, globals: [] })}\n`,
    );
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [stalls, ...args], { encoding: "utf8" });
    const lines = (text: string) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const result = run(paired, stored, out);
    assert.equal(result.status, 1, result.stderr);
    const printed = lines(result.stdout);
    assert.deepEqual(
      printed
        .filter(({ verdict }) => verdict !== undefined)
        .map(({ source, verdict }) => `${source} ${verdict}`),
      [
        "memory candidate",
        "charged candidate",
        "slower candidate",
        "boundary unknown",
        "based load",
        "unmeasured unknown",
        "between unknown",
        "timedout unknown",
        "crashed candidate",
        "inherited unknown",
        "x unknown",
      ],
    );
    assert.match(
      printed.find(({ source }) => source === "based").why,
      /^the base alone stalled \(timeout\)/,
    );
    assert.deepEqual(
      printed
        .filter(({ area, complete }) => area !== undefined && complete !== undefined)
        .map(({ area, complete, agreed, unavailable, candidate }) => [
          area,
          complete,
          agreed,
          unavailable,
          candidate,
        ]),
      [
        ["paired", true, 2, 7, 3],
        ["property", false, 0, 1, 0],
        ["stored", true, 0, 3, 1],
      ],
    );
    // (the source at the safety net named as a defect and counted so, never agreement)
    assert.deepEqual(
      printed
        .filter(({ defect }) => defect !== undefined)
        .map(({ source, uncharged }) => [source, uncharged]),
      [["y", { head: "src-on publication" }]],
    );
    assert.equal(
      printed.find(({ area, complete }) => area === "property" && complete !== undefined).uncharged,
      1,
    );
    // closed where every source agrees; refused, a record cut short, one whose sources do not add up to its total, and
    // a rerun of a source the replay does not hold
    const agreed = shard("agreed", 2, [
      { source: "agreed", runs: [publication([5, 5], [1, 1])], counts: { runs: 1 } },
    ]);
    const closed = run(agreed);
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(lines(closed.stdout).at(-1).closed, true);
    // an area complete only with its shards 0/N to N-1/N, one N (#1564 r1's coverage witness), of one configuration
    const half = (at: string, file: string, configuration = CONFIGURATION) =>
      shard(
        "halves",
        2,
        [{ source: `s${at}`, runs: [publication([5, 5], [1, 1])], counts: { runs: 1 } }],
        { at, file, configuration },
      );
    const second = half("1/2", "second");
    const alone = lines(run(second).stdout);
    assert.deepEqual(
      [alone.at(-2).complete, alone.at(-2).missing, alone.at(-1).closed],
      [false, ["0/2"], false],
    );
    const beyond = lines(run(second, half("2/2", "beyond")).stdout);
    assert.deepEqual([beyond.at(-2).complete, beyond.at(-2).missing], [false, ["0/2"]]);
    const both = run(half("0/2", "first"), second);
    assert.equal(both.status, 0, both.stderr);
    assert.equal(lines(both.stdout).at(-2).shards, "2/2");
    // a source the plan lists twice (#1582): one source where its repeats record the same, milliseconds apart; refused,
    // naming the place, where they differ, in a replay and in a rerun
    const twice = (name: string, counts: Record<string, number>[], why?: string) =>
      shard(
        name,
        2,
        counts.map((second, index) => ({
          source: "dup",
          stalled: why,
          runs: [publication([5, 5], [1, index + 1])],
          counts: second,
        })),
      );
    const alike = lines(run(twice("alike", [{ runs: 1 }, { runs: 1 }])).stdout).at(-1);
    assert.deepEqual([alike.sources, alike.repeats, alike.closed], [1, 1, true]);
    const unlike = run(twice("unlike", [{ runs: 1 }, { runs: 1, differences: 1 }]));
    assert.equal(unlike.status, 2);
    assert.match(
      unlike.stderr,
      /holds a source another record holds otherwise: \["unlike","g.mjs","dup","k"\]/,
    );
    const stalledTwice = twice("rerunning", [{ stalled: 1 }, { stalled: 1 }], "timeout");
    const rerunTwice = join(directory, "rerun-twice.work.jsonl");
    writeFileSync(
      rerunTwice,
      readFileSync(
        twice("rerunning-again", [{ runs: 1 }, { runs: 1, differences: 1 }]),
        "utf8",
      ).replaceAll('"area":"rerunning-again"', '"area":"rerunning"'),
    );
    assert.equal(run(stalledTwice).status, 1);
    assert.match(
      run(stalledTwice, "--rerun", rerunTwice).stderr,
      /holds a source another record holds otherwise: \["rerunning","g.mjs","dup","k"\]/,
    );
    // rerun records are judgement attempts, in the order given (#1587): a later round's end replaces an earlier stall
    // (and a later stall an earlier end); two ends that differ are refused, naming the place; a replay's records are
    // never replaced, so a replay that records a source otherwise is refused whatever its order
    const late = (file: string, ended: boolean, counts: Record<string, number> = { runs: 1 }) =>
      shard(
        "late",
        2,
        [
          ended
            ? { source: "slow", runs: [publication([100, 100], [10, 10])], counts }
            : stalled("slow", "timeout", [publication([100, 50], [10, 180000], 1)]),
        ],
        { file },
      );
    const [lateReplay, lateStall, lateEnd] = [
      late("late", false),
      late("late-stall", false),
      late("late-end", true),
    ];
    const latest = run(lateReplay, "--rerun", lateStall, lateEnd);
    assert.equal(latest.status, 0, latest.stderr);
    assert.deepEqual(
      [lines(latest.stdout).at(-1).agreed, lines(latest.stdout).at(-1).closed],
      [1, true],
    );
    // (a rerun that ends with a run left unanswered alike, #1592: that outcome, counted and named apart, and listed in
    // the index apart from the sources still unavailable)
    const alikeIndex = join(directory, "late-alike.index.json");
    const lateAlike = late("late-alike", true, { runs: 1, unansweredAlike: 1 });
    const ended = run(lateReplay, "--rerun", lateStall, lateAlike, "--index", alikeIndex);
    assert.equal(ended.status, 0, ended.stderr);
    const endedLines = lines(ended.stdout);
    const named = { generator: "g.mjs", source: "slow", unansweredAlike: 1 };
    assert.deepEqual(
      [
        endedLines.find(({ stalled }) => stalled !== undefined).rerun.outcome,
        ...["agreed", "unansweredAlike", "closed"].map((key) => endedLines.at(-1)[key]),
      ],
      ["unansweredAlike", 0, 1, true],
    );
    assert.deepEqual(
      endedLines.filter(({ source, stalled }) => source !== undefined && stalled === undefined),
      [{ area: "late", ...named }],
    );
    const indexed = JSON.parse(readFileSync(alikeIndex, "utf8"));
    assert.deepEqual(
      [indexed.entries, indexed.unansweredAlike],
      [[], [{ area: "late", ...named, key: "k" }]],
    );
    assert.equal(
      lines(run(lateReplay, "--rerun", lateEnd, lateStall).stdout).at(-1).unavailable,
      1,
    );
    const differing = run(
      lateReplay,
      "--rerun",
      lateEnd,
      late("late-other", true, { differences: 1 }),
    );
    assert.equal(differing.status, 2);
    assert.match(
      differing.stderr,
      /holds a source another record holds otherwise: \["late","g.mjs","slow","k"\]/,
    );
    const halves = (at: string, ended: boolean) => {
      const file = late(`kept-${at[0]}`, ended);
      writeFileSync(file, readFileSync(file, "utf8").replace('"shard":"0/1"', `"shard":"${at}"`));
      return file;
    };
    const kept = run(halves("0/2", false), halves("1/2", true));
    assert.equal(kept.status, 2);
    assert.match(
      kept.stderr,
      /holds a source another record holds otherwise: \["late","g.mjs","slow","k"\]/,
    );
    // repeats whose times differ (#1583 r1): the one the time clause judges a candidate stands for them, in either
    // order, in one record or across shards, in a replay, its index and its rerun
    const timed = (ms: number, stall = true) => ({
      source: "dup",
      ...(stall ? { stalled: "timeout" } : {}),
      runs: [publication([100, 100], [1, ms])],
      counts: stall ? { stalled: 1 } : { runs: 1 },
    });
    for (const order of [
      [1, 30000],
      [30000, 1],
    ]) {
      const name = `timed-${order[0]}`;
      const index = join(directory, `${name}.json`);
      const together = lines(
        run(
          shard(
            name,
            2,
            order.map((ms) => timed(ms)),
          ),
          "--index",
          index,
        ).stdout,
      );
      assert.equal(together.at(-1).candidate, 1);
      const [entry] = JSON.parse(readFileSync(index, "utf8")).entries;
      assert.deepEqual([entry.verdict, entry.runs[0].head.ms], ["candidate", 30000]);
      const split = order.map((ms, at) =>
        shard(`${name}-split`, 2, [timed(ms)], { at: `${at}/2`, file: `${name}-${at}` }),
      );
      assert.equal(lines(run(...split).stdout).at(-1).candidate, 1);
      const replayed = shard(`${name}-rerun`, 2, [timed(1), timed(1)]);
      const reran = join(directory, `${name}-again.work.jsonl`);
      writeFileSync(
        reran,
        readFileSync(
          shard(
            `${name}-again`,
            2,
            order.map((ms) => timed(ms, false)),
          ),
          "utf8",
        ).replaceAll(`"area":"${name}-again"`, `"area":"${name}-rerun"`),
      );
      const closing = lines(run(replayed, "--rerun", reran).stdout).at(-1);
      assert.deepEqual([closing.agreed, closing.candidate, closing.closed], [1, 1, false]);
    }
    const otherwise = half("0/2", "otherwise", { ...CONFIGURATION, allowances: [1, 2] });
    assert.match(
      run(otherwise, second).stderr,
      /compares otherwise than the area's other shards \(allowances\)/,
    );
    assert.equal(run(shard("cut", 2, [], { cut: true })).status, 2);
    const uneven = shard("uneven", 2, [{ source: "a", runs: [], counts: { runs: 2 } }]);
    writeFileSync(uneven, readFileSync(uneven, "utf8").replace('"runs":2}}', '"runs":1}}'));
    assert.equal(run(uneven).status, 2);
    // (and its sources' runs unanswered alike against a total that counts none, #1592)
    const unevenAlike = shard("uneven-alike", 2, [
      { source: "a", runs: [], counts: { runs: 4, unansweredAlike: 4 } },
    ]);
    writeFileSync(
      unevenAlike,
      readFileSync(unevenAlike, "utf8").replace(
        /"unansweredAlike":4\}\}\n$/,
        '"unansweredAlike":0}}\n',
      ),
    );
    const refusedAlike = run(unevenAlike);
    assert.equal(refusedAlike.status, 2);
    assert.match(refusedAlike.stderr, /do not add up to its total \(unansweredAlike\)/);
    const other = join(directory, "other.work.jsonl");
    writeFileSync(
      other,
      readFileSync(agreed, "utf8")
        .replace('"shard":"0/1"', '"shard":"0/1","only":"index"')
        .replace('"source":"agreed"', '"source":"another"'),
    );
    assert.equal(run(agreed, "--rerun", other).status, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the corpus runner runs a pool's batch of sources by their places as its shards run them, and refuses a list it cannot run whole (#1826)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const built = (name: string) => {
      const folder = join(directory, name);
      mkdirSync(join(folder, "dist", "tests", "helpers"), { recursive: true });
      mkdirSync(join(folder, "dist", "src", "type-inference", "core"), { recursive: true });
      writeFileSync(join(folder, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(folder, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
      writeFileSync(join(folder, "dist", "tests", "helpers", "type-core-oracles.js"), FILLABLE);
      return folder;
    };
    const [base, head] = [built("base"), built("head")];
    const folder = join(directory, "pooled");
    mkdirSync(folder);
    const names = ["a", "b", "dup", "c", "dup"];
    writeFileSync(
      join(folder, "g.mjs"),
      `export const cases = ${JSON.stringify(names.map((name) => [name, name]))};\n`,
    );
    const run = (env: Record<string, string>, ...args: string[]) =>
      spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, ...env } });
    const items = resolve("tests/families/items.mjs");
    const write = (name: string, lines: string[]) => {
      const file = join(directory, name);
      writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
      return file;
    };
    // the area's sources, a repeated one once
    const listed = run({}, items, "sources", folder);
    assert.equal(listed.status, 0, listed.stderr);
    const places = listed.stdout.trim().split("\n");
    assert.equal(places.length, 4);
    // two batches in no shard's order, the second as the queue gives it ($SX_ITEMS, the flag before the trees), judge
    // as the area's two shards do
    const [first, second] = [
      write("first", [places[3]!, places[0]!]),
      write("second", places.slice(1, 3)),
    ];
    const byItems = [join(directory, "i0.work.jsonl"), join(directory, "i1.work.jsonl")];
    const one = run({}, runner, folder, base, head, "--items", first, "--work", byItems[0]!);
    assert.equal(one.status, 0, one.stderr);
    const two = run(
      { SX_ITEMS: second },
      runner,
      folder,
      "--items-from-env",
      base,
      head,
      "--work",
      byItems[1]!,
    );
    assert.equal(two.status, 0, two.stderr);
    const byShards = [join(directory, "s0.work.jsonl"), join(directory, "s1.work.jsonl")];
    for (const [shard, file] of byShards.entries())
      assert.equal(
        run({}, runner, folder, base, head, "--shard", `${shard}/2`, "--work", file).status,
        0,
      );
    const judged = (files: string[]) => {
      const result = run({}, stalls, ...files);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim().split("\n").at(-1);
    };
    assert.equal(judged(byItems), judged(byShards));
    // (a pool's batches close only together: one alone holds two of the area's four sources)
    const part = run({}, stalls, byItems[0]!);
    assert.equal(part.status, 1, part.stdout);
    assert.match(part.stdout, /"shards":"1 batches, 2 of 4 sources","complete":false/);
    // (each record names its batch, never a shard another holds)
    const batch = (file: string) =>
      JSON.parse(readFileSync(file, "utf8").split("\n")[0]!).work.shard;
    assert.match(batch(byItems[0]!), /^items [0-9a-f]{16}$/);
    assert.notEqual(batch(byItems[0]!), batch(byItems[1]!));
    // a list the runner cannot run whole is refused before any source runs
    const refusals: [string[], RegExp][] = [
      [["--items", first, "--shard", "0/2"], /drop --store, --shard and --only/],
      [["--items", first, "--items-from-env"], /give one/],
      [["--items", write("unknown", ['["g.mjs","z","0"]'])], /does not hold/],
      [["--items", write("twice", [places[0]!, places[0]!])], /twice/],
      [["--items", write("empty", [])], /lists no source/],
      [["--items", write("bad", ["g.mjs a"])], /no source's place/],
      [["--items-from-env"], /\$SX_ITEMS names no file/],
    ];
    for (const [more, why] of refusals) {
      const refused = run({ SX_ITEMS: "" }, runner, folder, base, head, ...more);
      assert.equal(refused.status, 2, `${more.join(" ")}: ${refused.stderr}`);
      assert.match(refused.stderr, why);
    }
    // `items.mjs check --area`: the area's every source once, no other
    assert.equal(run({}, items, "check", write("whole", places), "--area", folder).status, 0);
    assert.equal(run({}, items, "check", first, "--area", folder).status, 1);
    const extra = write("extra", [...places, '["g.mjs","z","0"]']);
    assert.equal(run({}, items, "check", extra, "--area", folder).status, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a baseline plans copies in 64 shards where it first plans it, keeps a count it recorded, and a head of any shard count compares with it (#1826)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const built = join(directory, "built");
    for (const part of [
      "dist/src",
      "dist/tests/helpers",
      "src",
      "tests/families/area",
      "tests/families/copies",
    ])
      mkdirSync(join(built, part), { recursive: true });
    writeFileSync(join(built, "src", "a.ts"), "a\n");
    writeFileSync(join(built, "dist", "src", "a.js"), "compiled\n");
    mkdirSync(join(built, "dist", "src", "type-inference", "core"), { recursive: true });
    writeFileSync(join(built, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
    writeFileSync(join(built, "dist", "tests", "helpers", "type-core-oracles.js"), FILLABLE);
    writeFileSync(join(built, "package.json"), '{ "type": "module" }\n');
    writeFileSync(join(built, "package-lock.json"), "{}\n");
    writeFileSync(join(built, ".sha"), `${"1".repeat(40)}\n`);
    for (const tool of ["baselines.mjs", "run-contract.mjs", "run.mjs", "sources.mjs"])
      cpSync(join("tests", "families", tool), join(built, "tests", "families", tool));
    const cases = (names: string[]) =>
      `export const cases = ${JSON.stringify(names.map((name) => [name, name]))};\n`;
    writeFileSync(
      join(built, "tests", "families", "area", "g.mjs"),
      cases(["p", "q", "r", "s", "t"]),
    );
    writeFileSync(join(built, "tests", "families", "copies", "g.mjs"), cases(["x", "y"]));
    const { identityOf, planOf } = await import(pathToFileURL(baselines).href);
    const { generatorsOf } = await import(
      pathToFileURL(resolve("tests/families/sources.mjs")).href
    );
    const src: string = identityOf(built).src;
    const at = (...parts: string[]) => join(directory, ...parts);
    const tool = (...args: string[]) =>
      spawnSync(process.execPath, [baselines, ...args], { encoding: "utf8" });
    const run = (...args: string[]) => spawnSync(process.execPath, args, { encoding: "utf8" });
    const store = (root: string, area: string, shard: string) =>
      run(runner, join(built, "tests", "families", area), built, "--store", root, "--shard", shard);
    const listed = (root: string) =>
      readFileSync(at(root, "shards.tsv"), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("\t"));

    // a seed plans copies in 64 shards, every other area in 16, and lists each shard to store
    assert.equal(tool("seed", built, at("seed")).status, 0);
    const manifest = readFileSync(at("seed", src, "MANIFEST"), "utf8");
    assert.match(manifest, /^area copies 64 [0-9a-f]{64}$/m);
    assert.match(manifest, /^area area 16 [0-9a-f]{64}$/m);
    const counts = (root: string) =>
      Object.fromEntries(
        ["area", "copies"].map((area) => {
          const lines = listed(root).filter(([name]) => name === area);
          return [area, [lines.length, new Set(lines.map(([, , n]) => n))]];
        }),
      );
    assert.deepEqual(counts("seed"), {
      area: [16, new Set(["16"])],
      copies: [64, new Set(["64"])],
    });
    // a first store of copies in another count is refused; any other area keeps the first writer's count
    mkdirSync(at("fresh"));
    const fresh = store(at("fresh"), "copies", "0/16");
    assert.equal(fresh.status, 2, fresh.stderr);
    assert.match(fresh.stderr, /planned in 64 shards where a baseline first plans it/);
    // a baseline that recorded copies in 16 shards (before #1826) keeps them: its seed lists 16, a store in 64 is
    // refused, one in 16 stores
    cpSync(at("seed"), at("old"), { recursive: true });
    const copies = await generatorsOf(join(built, "tests", "families", "copies"));
    const old = planOf("copies", copies, 16);
    const id = createHash("sha256").update(old).digest("hex");
    writeFileSync(at("old", src, "copies", "PLAN"), old);
    writeFileSync(
      at("old", src, "MANIFEST"),
      manifest.replace(/^area copies 64 [0-9a-f]{64}$/m, `area copies 16 ${id}`),
    );
    rmSync(at("old", "shards.tsv"));
    assert.equal(tool("seed", built, at("old")).status, 0);
    assert.deepEqual(counts("old"), { area: [16, new Set(["16"])], copies: [16, new Set(["16"])] });
    assert.match(store(at("old"), "copies", "0/64").stderr, /is planned otherwise/);
    assert.equal(store(at("old"), "copies", "0/16").status, 0);
    // a head compares with a baseline whatever the counts: `area` stored in 4 shards, run in 3 and by its sources
    mkdirSync(at("four"));
    for (const shard of [0, 1, 2, 3])
      assert.equal(store(at("four"), "area", `${shard}/4`).status, 0);
    const against = (...more: string[]) => {
      const result = run(
        runner,
        join(built, "tests", "families", "area"),
        built,
        "--baseline",
        at("four", src, "area"),
        ...more,
      );
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    };
    const totals = [0, 1, 2].map((shard) => against("--shard", `${shard}/3`));
    assert.deepEqual(
      [
        totals.reduce((sum, t) => sum + t.sources, 0),
        totals.reduce((sum, t) => sum + t.uncompared, 0),
      ],
      [5, 0],
    );
    const places = run(
      resolve("tests/families/items.mjs"),
      "sources",
      join(built, "tests", "families", "area"),
    );
    writeFileSync(at("area.items"), places.stdout);
    const byItems = against("--items", at("area.items"));
    assert.deepEqual([byItems.sources, byItems.uncompared, byItems.differences], [5, 0, 0]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the check and the baselines take one set of areas: each folder of tests/families that holds a generator, never one of data only, and the baselines the corpus fixture beside them (#1865)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "families-areas-"));
  try {
    const tree = join(directory, "tree");
    const families = join(tree, "tests", "families");
    const write = (file: string, text: string) => {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, text);
    };
    const generator = 'export const cases = [["one", "say 1"]];\n';
    write(join(tree, "src", "index.js"), "export {};\n");
    write(join(tree, ".sha"), `${"0".repeat(40)}\n`);
    write(join(families, "area", "one.mjs"), generator);
    write(join(families, "data", "table.json"), "{}\n");
    write(join(families, "loose.mjs"), "export {};\n");
    mkdirSync(join(families, "empty"));
    write(join(tree, "tools", "corpus", "fixture", "cells.mjs"), generator);
    const sources = resolve("tests/families/sources.mjs");
    const { generatorFolders, holdsGenerators } = await import(pathToFileURL(sources).href);
    assert.deepEqual(generatorFolders(families), [join(families, "area")]);
    assert.deepEqual(
      ["area", "data", "empty"].map((name) => holdsGenerators(join(families, name))),
      [true, false, false],
    );
    assert.deepEqual(generatorFolders(join(tree, "absent")), []);
    // (the check, copied beside those folders, lists the area's generator alone)
    cpSync(resolve("tests/families/check.mjs"), join(families, "check.mjs"));
    cpSync(sources, join(families, "sources.mjs"));
    const listed = spawnSync(process.execPath, [join(families, "check.mjs"), "--list"], {
      encoding: "utf8",
    });
    assert.equal(listed.stderr, "");
    const generators = listed.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).generator)
      .filter((name) => name !== undefined);
    assert.deepEqual(generators, ["area/one.mjs"]);
    // (the baselines' state of that tree: the same area, then the corpus fixture)
    const root = join(directory, "baselines");
    mkdirSync(root);
    const state = spawnSync(process.execPath, [baselines, "state", tree, root, "--read-only"], {
      encoding: "utf8",
    });
    assert.notEqual(state.stdout.trim(), "", state.stderr);
    const areas = state.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).area)
      .filter((name) => name !== undefined);
    assert.deepEqual(areas, ["area", "fixture"], state.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A built tree's library whose analyses charge its ledger (allowance 1,000) 300 units a run and report 100 cells
 * returned by its questions (`questionWork`, where `reports`) at `QUESTION_UNITS_PER_CELL` 64, a grant of 6,400 beyond
 * 4 × 1,000: `granted` charges 9,000 more in its publication (within the grant), `past` 11,000 (past it), `stops` 9,000
 * more in its stop runs alone, which no grant reaches.
 */
const grantLibrary = (
  reports: boolean,
): string => `import { WorkLedger } from "../../src/type-inference/core/budget.js";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
let cells = 0;
${reports ? "export const QUESTION_UNITS_PER_CELL = 64;\nexport const questionWork = () => ({ units: 0, cells });" : ""}
export function publicationHashes(files) {
  const source = files[0].source;
  cells = 0;
  const ledger = new WorkLedger(1000);
  ledger.charge("frames", 300);
  cells = 100;
  if (source === "granted") ledger.charge("frames", 9000);
  if (source === "past") ledger.charge("frames", 11000);
  return { parts: ["a", "b"], unanswered: 0 };
}
export function stopSet(files) {
  new WorkLedger(1000).charge("frames", files[0].source === "stops" ? 9300 : 300);
  return { stops: [] };
}
`;

test("a publication run's unit limit grants its oracle's units per cell its questions reported, and nothing where none are reported or in a stop run (#1837)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const built = (name: string, reports: boolean) => {
      const tree = join(directory, name);
      mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
      mkdirSync(join(tree, "dist", "src", "type-inference", "core"), { recursive: true });
      writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(tree, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
      writeFileSync(
        join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
        grantLibrary(reports),
      );
      return tree;
    };
    const folder = join(directory, "area");
    mkdirSync(folder);
    writeFileSync(
      join(folder, "g.mjs"),
      `export const cases = ${JSON.stringify(["granted", "past", "stops"].map((name) => [name, name]))};\n` +
        'export const checks = ["publication", "stops"];\n',
    );
    const stalled = (base: string, head = base) => {
      const work = join(directory, `${basename(base)}-${basename(head)}.work.jsonl`);
      const ran = spawnSync(
        process.execPath,
        [runner, folder, base, head, "--allowances", "natural", "--work", work],
        { encoding: "utf8" },
      );
      const lines = readFileSync(work, "utf8")
        .trim()
        .split("\n")
        .slice(1, -1)
        .map((line) => JSON.parse(line));
      return [
        ran.status,
        lines.filter((line) => line.stalled !== undefined).map((line) => line.source),
      ];
    };
    // (the grant: `granted` ends; `past` passes it, `stops` is no publication run)
    assert.deepEqual(stalled(built("reports", true)), [1, ["past", "stops"]]);
    // (no cells reported, no grant)
    const silent = built("silent", false);
    assert.deepEqual(stalled(silent), [1, ["granted", "past", "stops"]]);
    // (each tree's own report: the base's cells grant the head nothing)
    assert.deepEqual(stalled(join(directory, "reports"), silent), [
      1,
      ["granted", "past", "stops"],
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A built tree's library whose publication of `aborts`, `head-slow` and `head-dies` ends the process as V8's heap abort
 * does, in the sharing-off source-order mode, where `aborting`; else answers them, `aborts` leaving 2 nodes unanswered
 * (`memory`) in the reversed modes, `head-slow` waiting 6 s and `head-dies` aborting in the sharing-on reversed mode.
 */
const abortingLibrary = (aborting: boolean): string => `import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
export function publicationHashes(files, mode) {
  const source = files[0].source;
  const fatal = () => {
    writeSync(2, "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\\n");
    process.exit(134);
  };
  if (${aborting} && source !== "fine" && mode.unshared && !mode.reversed) fatal();
  if (!${aborting} && mode.reversed && !mode.unshared) {
    if (source === "head-slow") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
    if (source === "head-dies") fatal();
    if (source === "head-throws") throw new Error("head-throws: the head's own exception");
  }
  const parts = [createHash("sha256").update(source).digest("hex")];
  return !${aborting} && source === "aborts" && mode.reversed
    ? { parts, unanswered: 2, unansweredBy: { reason: "memory", node: 7 } }
    : { parts, unanswered: 0 };
}
`;

test("a base whose run ends its process leaves the head's runs from that one on to a fresh child of the head alone, each recorded as the head's own outcome beside the base's stall, its own safety net or abort named by its run (#1837, Codex r2)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const built = (name: string, aborting: boolean) => {
      const tree = join(directory, name);
      mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
      writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
      writeFileSync(
        join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
        abortingLibrary(aborting),
      );
      return tree;
    };
    const [base, head] = [built("base", true), built("head", false)];
    const folder = join(directory, "area");
    mkdirSync(folder);
    writeFileSync(
      join(folder, "g.mjs"),
      `export const cases = ${JSON.stringify(
        ["aborts", "head-slow", "head-dies", "head-throws", "fine"].map((name) => [name, name]),
      )};\n`,
    );
    const work = join(directory, "aborts.work.jsonl");
    const out = join(directory, "aborts.jsonl");
    const ran = spawnSync(
      process.execPath,
      [runner, folder, base, head, "--work", work, "--out", out, "--timeout", "3"],
      { encoding: "utf8" },
    );
    assert.equal(ran.status, 1, ran.stderr);
    const lines = readFileSync(work, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const aborted = lines.find((line) => line.source === "aborts");
    assert.match(aborted.stalled, /FATAL ERROR: .*heap out of memory/);
    // (the run the stall cut, named: its tree, mode and check, #1965; a crash of the base, counted, #1837's F24)
    assert.deepEqual(aborted.at, { tree: "base", mode: "src-off", check: "publication" });
    assert.deepEqual(aborted.crashed, { base: true, head: false });
    // (four base crashes, one of them with the head crashing alone after it: no head-only crash, so exit 1, not 3)
    assert.deepEqual(lines.at(-1).total.crashed, { base: 4, head: 1 });
    // (the source-order runs both trees ended; from the base's abort on, the head's own outcome per run)
    assert.deepEqual(aborted.afterBase, [
      { mode: "src-off", check: "publication", head: { answered: true } },
      {
        mode: "rev-on",
        check: "publication",
        head: { unanswered: 2, by: { reason: "memory", node: 7 } },
      },
      {
        mode: "rev-off",
        check: "publication",
        head: { unanswered: 2, by: { reason: "memory", node: 7 } },
      },
    ]);
    // (the head's own safety net in its rerun: named by its run, counted and reported as any uncharged run)
    const slow = lines.find((line) => line.source === "head-slow");
    assert.deepEqual(slow.afterBase, [
      { mode: "src-off", check: "publication", head: { answered: true } },
      { mode: "rev-on", check: "publication", head: { uncharged: true } },
    ]);
    assert.deepEqual(slow.uncharged, { head: "rev-on publication" });
    assert.match(ran.stderr, /"source":"head-slow","uncharged":\{"head":"rev-on publication"\}/);
    // (the head's own abort in its rerun: named by its run)
    const dies = lines.find((line) => line.source === "head-dies");
    assert.deepEqual(dies.afterBase.slice(0, 1), [
      { mode: "src-off", check: "publication", head: { answered: true } },
    ]);
    assert.deepEqual([dies.afterBase[1].mode, dies.afterBase[1].check], ["rev-on", "publication"]);
    assert.match(dies.afterBase[1].head.stalled, /FATAL ERROR: .*heap out of memory/);
    assert.equal(dies.afterBase.length, 2);
    // (the head's own exception in its rerun: named by its run there, and reported as any exception: counted, on stderr,
    // in --out with its stack, Codex r4)
    const throws = lines.find((line) => line.source === "head-throws");
    assert.deepEqual(throws.afterBase[1], {
      mode: "rev-on",
      check: "publication",
      head: { thrown: "Error: head-throws: the head's own exception" },
    });
    assert.equal(throws.counts.exceptions, 1);
    assert.match(ran.stderr, /"source":"head-throws","mode":"rev-on","check":"publication"/);
    const reported = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((line) => line.source === "head-throws" && line.thrown !== undefined);
    assert.match(reported.thrown.head, /^Error: head-throws: the head's own exception\n\s+at /);
    // (the other source runs on, both trees, in a child of both)
    const fine = lines.find((line) => line.source === "fine");
    assert.equal(fine.stalled, undefined);
    assert.equal(fine.runs.length, 4);
    // (the stall index still names the base's stall as inherited)
    const judged = spawnSync(process.execPath, [stalls, work], { encoding: "utf8" });
    const verdicts = judged.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((line) => line.verdict !== undefined && line.source !== undefined);
    assert.deepEqual(
      verdicts.map(({ source, verdict }) => [source, verdict]),
      [
        ["aborts", "inherited"],
        ["head-slow", "inherited"],
        ["head-dies", "inherited"],
        ["head-throws", "inherited"],
      ],
      judged.stdout,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("one list of stop reasons: every reason has its stall group, and a stored line holds every reason in every recorded form (#1837, the families' fourth hand-kept copy)", async () => {
  const { STOP_REASONS, UNKNOWN_REASON, REASON_GROUPS, groupOf } = await import(
    pathToFileURL(contract).href
  );
  const { sourceFault, DEFAULTS } = await import(pathToFileURL(baselines).href);
  assert.deepEqual(REASON_GROUPS, [...STOP_REASONS, UNKNOWN_REASON].map(groupOf));
  // (a stored line with one run left unanswered `by`)
  const key = "a".repeat(64);
  /** A recorded reason, as a stored run holds it or as a malformed one does. */
  type RecordedBy = {
    readonly reason: string;
    readonly node?: number | null;
    readonly binding?: number | null;
  };
  const stored = (by: RecordedBy) => ({
    generator: "g.mjs",
    source: "s",
    key,
    runs: {
      "src-on publication": {
        value: {
          hash: key,
          parts: ["0123456789abcdef"],
          unanswered: 2,
          unparsed: false,
          unansweredBy: by,
        },
        work: 10,
        allowance: 30_000_000,
      },
    },
  });
  const accepted: RecordedBy[] = [
    // (the four lines that a store refused before this list: the forms #1837's oracle records)
    { reason: "questions", node: 7 },
    { reason: "memory", node: 7 },
    { reason: "read-depth", node: 7 },
    { reason: "questions", binding: 5 },
    // (every reason in every recorded form, and the unknown one)
    ...STOP_REASONS.flatMap((reason: string) => [
      { reason, node: 7 },
      { reason, node: null },
      { reason, binding: 5 },
    ]),
    { reason: UNKNOWN_REASON, node: null },
  ];
  for (const by of accepted)
    assert.equal(sourceFault(stored(by), DEFAULTS.units), undefined, JSON.stringify(by));
  const refused: RecordedBy[] = [
    { reason: "elsewhere", node: 7 },
    { reason: UNKNOWN_REASON, node: 7 },
    { reason: UNKNOWN_REASON, binding: 5 },
    { reason: "questions", binding: null },
    { reason: "questions", node: 7, binding: 5 },
    { reason: "questions" },
  ];
  for (const by of refused)
    assert.notEqual(sourceFault(stored(by), DEFAULTS.units), undefined, JSON.stringify(by));
});

/**
 * A built tree's library whose publication charges its ledger (allowance 1,000) 300 units, its oracle then reporting 10
 * cells at 64 units each (a grant of 640 beyond 4 × 1,000), and then: `admitted` 4,339 more (4,639, one under the limit
 * with the grant), `over` 4,341 (one over it), `ungranted` 3,701 with no cells reported (one over the plain limit).
 */
const storedGrantLibrary = `import { WorkLedger } from "../../src/type-inference/core/budget.js";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
export const QUESTION_UNITS_PER_CELL = 64;
let cells = 0;
export const questionWork = () => ({ units: 0, cells });
export function publicationHashes(files) {
  const source = files[0].source;
  cells = 0;
  const ledger = new WorkLedger(1000);
  ledger.charge("frames", 300);
  cells = source === "ungranted" ? 0 : 10;
  ledger.charge("frames", { admitted: 4339, over: 4341, ungranted: 3701 }[source] ?? 0);
  return { parts: ["a", "b"], unanswered: 0 };
}
`;

test("a store writes and reads a publication run by the runner's own limit, its grant from the cells its oracle reported included, and still refuses a run over it (#1837, the final review's R1)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const tree = join(directory, "tree");
    mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
    mkdirSync(join(tree, "dist", "src", "type-inference", "core"), { recursive: true });
    mkdirSync(join(tree, "src"));
    writeFileSync(join(tree, "src", "a.ts"), "tree\n");
    writeFileSync(join(tree, ".sha"), `${"1".repeat(40)}\n`);
    writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
    writeFileSync(join(tree, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
    writeFileSync(
      join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
      storedGrantLibrary,
    );
    // (the area inside the tree, where `state` finds its areas)
    const folder = join(tree, "tests", "families", "grants");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "g.mjs"),
      `export const cases = ${JSON.stringify(["admitted", "over", "ungranted"].map((name) => [name, name]))};\n`,
    );
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [runner, folder, ...args], {
        encoding: "utf8",
        env: { ...process.env, FAMILIES_UNITS: "4" },
      });
    // (the runner admits `admitted` and stalls the other two; the store writes all three, its lines checked as written)
    const store = join(directory, "store");
    mkdirSync(store);
    const stored = run(tree, "--store", store);
    assert.equal(stored.status, 1, stored.stderr);
    assert.doesNotMatch(stored.stderr, /would be stored as/);
    const [src] = readdirSync(store);
    const area = join(store, src!, "grants");
    const shard = readFileSync(join(area, "0of1.runs.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const line = (source: string) => shard.find((entry) => entry.source === source);
    const questions = { perCell: 64, cells: 10 };
    /** A stored run, as far as its limit reads it. */
    type StoredRun = {
      readonly value?: unknown;
      readonly work: number;
      readonly allowance: number;
      readonly questions?: { readonly perCell: number; readonly cells: number };
    };
    const runsOf = (source: string): StoredRun[] => Object.values(line(source).runs);
    assert.deepEqual(
      runsOf("admitted").map(({ work, allowance, questions: reported }) => [
        work,
        allowance,
        reported,
      ]),
      Array.from({ length: 4 }, () => [4639, 1000, questions]),
    );
    assert.deepEqual(
      [line("over").stalled, line("over").cut],
      ["units", { run: "src-on publication", work: 4641, allowance: 1000, questions }],
    );
    assert.deepEqual(
      [line("ungranted").stalled, line("ungranted").cut],
      ["units", { run: "src-on publication", work: 4001, allowance: 1000 }],
    );
    // (a head as the tree but lighter on `over` and `ungranted`, and one whose process ends before any run, Codex r1)
    const variant = (name: string, library: string) => {
      const other = join(directory, name);
      mkdirSync(join(other, "dist", "tests", "helpers"), { recursive: true });
      mkdirSync(join(other, "dist", "src", "type-inference", "core"), { recursive: true });
      mkdirSync(join(other, "src"));
      writeFileSync(join(other, "src", "a.ts"), `${name}\n`);
      writeFileSync(join(other, ".sha"), `${"2".repeat(40)}\n`);
      writeFileSync(join(other, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(other, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
      writeFileSync(join(other, "dist", "tests", "helpers", "type-core-oracles.js"), library);
      mkdirSync(join(other, "tests", "families", "grants"), { recursive: true });
      return other;
    };
    const lighter = variant(
      "lighter",
      storedGrantLibrary.replace("over: 4341, ungranted: 3701", "over: 0, ungranted: 0"),
    );
    const crashing = variant(
      "crashing",
      storedGrantLibrary.replace(
        /export const MODES = [^;]*;/,
        "export const MODES = { *[Symbol.iterator]() { process.exit(5); } };",
      ),
    );
    const records = (args: string[], name: string) => {
      const work = join(directory, `${name}.work.jsonl`);
      const ran = run(...args, "--work", work);
      return {
        status: ran.status,
        stderr: ran.stderr,
        lines: readFileSync(work, "utf8")
          .trim()
          .split("\n")
          .map((text) => JSON.parse(text)),
      };
    };
    // (the stored base alone stalled: its stall's record names its tree and cut run, #1965)
    const light = records([lighter, "--baseline", area], "lighter");
    assert.equal(light.status, 1, light.stderr);
    const lightOf = (source: string) => light.lines.find((entry) => entry.source === source);
    assert.deepEqual(
      ["over", "ungranted"].map((source) => lightOf(source).at),
      Array.from({ length: 2 }, () => ({ tree: "base", mode: "src-on", check: "publication" })),
    );
    // (the stored base's cut run is no run it ended, beside the head's that did)
    const [cutRun] = lightOf("over").runs;
    assert.deepEqual(
      [cutRun.mode, cutRun.work, cutRun.allowance, cutRun.baseCut],
      ["src-on", [4641, 300], [1000, 1000], true],
    );
    // (a head whose process ends before any run: its tree known though its run is not, counted, exit 3; stored, a
    // base's crash, counted so, exit 1)
    const crashed = records([crashing, "--baseline", area], "crashing");
    assert.equal(crashed.status, 3, crashed.stderr);
    assert.deepEqual(crashed.lines.at(-1).total.crashed, { base: 0, head: 3 });
    assert.deepEqual(crashed.lines.find((entry) => entry.source === "admitted").at, {
      tree: "head",
      mode: null,
      check: null,
    });
    const crashStore = join(directory, "crash-store");
    mkdirSync(crashStore);
    const storedCrash = records([crashing, "--store", crashStore], "stored-crash");
    assert.equal(storedCrash.status, 1, storedCrash.stderr);
    assert.deepEqual(storedCrash.lines.at(-1).total.crashed, { base: 3, head: 0 });
    // (read back: the comparison against the stored shard reads every line through the same check, refusing none)
    const against = run(tree, "--baseline", area);
    assert.equal(against.status, 1, against.stderr);
    assert.doesNotMatch(against.stderr, /refused|is not one a store writes/);
    // (state reports what the verified shard stores: its runs, none left unanswered, four within their grant, and the
    // two stalls over the limit)
    const stated = spawnSync(process.execPath, [baselines, "state", tree, store, "--read-only"], {
      encoding: "utf8",
    });
    const grantsLine = stated.stdout
      .trim()
      .split("\n")
      .map((text) => JSON.parse(text))
      .find((entry) => entry.area === "grants");
    assert.deepEqual(
      grantsLine?.runs,
      { count: 4, reasons: {}, granted: 4, overLimit: 2 },
      stated.stdout,
    );
    // (the same check, row by row: one unit over the limit with its grant, a run with no cells reported over the plain
    // limit, a grant on a run that is no publication, and a cut within its limit are all refused)
    const { sourceFault } = await import(pathToFileURL(baselines).href);
    const admitted = line("admitted");
    const withRun = (run: StoredRun) => ({ ...admitted, runs: { "src-on publication": run } });
    const value = admitted.runs["src-on publication"].value;
    assert.equal(sourceFault(admitted, 4), undefined);
    assert.equal(sourceFault(line("over"), 4), undefined);
    assert.equal(sourceFault(line("ungranted"), 4), undefined);
    for (const [refused, why] of [
      [withRun({ value, work: 4641, allowance: 1000, questions }), "one unit over the limit"],
      [withRun({ value, work: 4001, allowance: 1000 }), "no cells reported, over the plain limit"],
      [
        {
          ...admitted,
          runs: { "src-on stops 16": { value, work: 300, allowance: 1000, questions } },
        },
        "a grant on a stop run",
      ],
      [
        withRun({ value, work: 4639, allowance: 1000, questions: { perCell: 0, cells: 10 } }),
        "no units per cell",
      ],
      [{ ...line("over"), cut: { ...line("over").cut, work: 4640 } }, "a cut within its limit"],
    ] as const)
      assert.notEqual(sourceFault(refused, 4), undefined, why);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A built tree's library whose publications answer with parts `A`, `R`, each occurrence's and `T`, as `kind` says:
 * the base and the head the same (`same`), or the head with its second occurrence's answer otherwise (`other`); and
 * each tree leaving nodes unanswered after the occurrences it answers, by source: `both-answered` none on either
 * tree, `one-unanswered` the base answering three occurrences and the head two (2 left), `both-unanswered` each two (1
 * left); a head that crashes alone where `crash` (its source-order sharing-on run of `head-crash`, the base's ended).
 */
const prefixLibrary = (
  head: boolean,
  kind: "same" | "other",
): string => `import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
const hash = (text) => createHash("sha256").update(text).digest("hex");
export function publicationHashes(files, mode) {
  const source = files[0].source;
  if (${head} && source === "head-crash" && !mode.reversed && !mode.unshared) {
    writeSync(2, "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n");
    process.exit(134);
  }
  const answered = { "both-answered": 3, "one-unanswered": ${head} ? 2 : 3, "both-unanswered": 2 }[source] ?? 3;
  const occurrences = ["o1", "o2", "o3"].slice(0, answered).map((text, index) =>
    ${head} && "${kind}" === "other" && index === 1 ? "changed" : text,
  );
  const parts = ["A", "R", ...occurrences, "T"].map(hash);
  const left = { "both-answered": 0, "one-unanswered": ${head} ? 2 : 0, "both-unanswered": 1 }[source] ?? 0;
  return left === 0
    ? { parts, unanswered: 0 }
    : { parts, unanswered: left, unansweredBy: { reason: "memory", node: 9 } };
}
`;

test("what both trees answered is compared where either left nodes unanswered, a differing answer a difference; a head crash where the base ran is named, counted and exits 3 (#1837, #1965, F24)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const built = (name: string, head: boolean, kind: "same" | "other") => {
      const tree = join(directory, name);
      mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
      writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
      writeFileSync(
        join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
        prefixLibrary(head, kind),
      );
      return tree;
    };
    const base = built("base", false, "same");
    const area = (name: string, sources: string[]) => {
      const folder = join(directory, name);
      mkdirSync(folder);
      writeFileSync(
        join(folder, "g.mjs"),
        `export const cases = ${JSON.stringify(sources.map((source) => [source, source]))};\n`,
      );
      return folder;
    };
    const rows = ["both-answered", "one-unanswered", "both-unanswered"];
    const outOf = (folder: string, head: string, name: string) => {
      const [out, work] = [join(directory, `${name}.jsonl`), join(directory, `${name}.work.jsonl`)];
      const ran = spawnSync(
        process.execPath,
        [runner, folder, base, head, "--out", out, "--work", work],
        { encoding: "utf8" },
      );
      const read = (file: string) =>
        existsSync(file)
          ? readFileSync(file, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          : [];
      return { status: ran.status, stderr: ran.stderr, out: read(out), work: read(work) };
    };
    const prefixes = area("prefixes", rows);
    // (the same answers: the answered one agrees; the unanswered ones agree on what both answered)
    const same = outOf(prefixes, built("same", true, "same"), "same");
    assert.equal(same.status, 1, same.stderr);
    const unanswered = (
      out: { source: string; prefix?: string; difference?: unknown }[],
      source: string,
    ) => out.filter((line) => line.source === source);
    assert.deepEqual(unanswered(same.out, "both-answered"), []);
    assert.deepEqual(
      unanswered(same.out, "one-unanswered").map(({ prefix }) => prefix),
      ["equal", "equal", "equal", "equal"],
    );
    assert.deepEqual(same.work.find((line) => line.source === "both-unanswered").counts, {
      runs: 4,
      unansweredAlike: 4,
    });
    // (the head's second answer otherwise: a difference in each row, at that part, never an unanswered run)
    const other = outOf(prefixes, built("other", true, "other"), "other");
    assert.equal(other.status, 1, other.stderr);
    for (const source of rows) {
      const counts = other.work.find((line) => line.source === source).counts;
      assert.deepEqual(counts, { runs: 4, differences: 4 }, source);
    }
    const differs = other.out.filter((line) => line.source === "one-unanswered");
    assert.deepEqual(
      differs.map(({ part, unanswered }) => [part, unanswered]),
      Array.from({ length: 4 }, () => [3, { base: 0, head: 2 }]),
    );
    // (a head crash where the base ran: the run it cut named, counted for the head alone, exit 3 ahead of 1)
    const crash = outOf(
      area("crashes", ["head-crash", "both-answered"]),
      built("crash", true, "same"),
      "crash",
    );
    assert.equal(crash.status, 3, crash.stderr);
    const cut = crash.work.find((line) => line.source === "head-crash");
    assert.deepEqual(
      [cut.at, cut.crashed],
      [
        { tree: "head", mode: "src-on", check: "publication" },
        { base: false, head: true },
      ],
    );
    assert.deepEqual(crash.work.at(-1).total.crashed, { base: 0, head: 1 });
    // (the stall index reads the named tree: the head's alone, a candidate; its saved index keeps `at`)
    const index = join(directory, "crash.index.json");
    const judged = spawnSync(
      process.execPath,
      [stalls, join(directory, "crash.work.jsonl"), "--index", index],
      { encoding: "utf8" },
    );
    assert.deepEqual(
      JSON.parse(readFileSync(index, "utf8")).entries.map(
        ({ source, at }: { source: string; at: unknown }) => [source, at],
      ),
      [["head-crash", { tree: "head", mode: "src-on", check: "publication" }]],
    );
    const stalled = judged.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((line) => line.source === "head-crash");
    assert.match(stalled.stalled.head, /FATAL ERROR: Reached heap limit/);
    assert.deepEqual(
      [stalled.at, stalled.verdict],
      [{ tree: "head", mode: "src-on", check: "publication" }, "candidate"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A built tree's library whose publication of `<shape> <size>` charges its ledger 100 units a size on the base; on the
 * head, `rises` 100 a size at 4 and 110 at 8 and 16, `flat` 100, `stops` 100 but leaving a node unanswered at 8,
 * and `differs` the same with another answer at 8 too.
 */
const growthLibrary = (
  head: boolean,
): string => `import { WorkLedger } from "../../src/type-inference/core/budget.js";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
export function publicationHashes(files) {
  const [shape, size] = files[0].source.split(" ");
  const n = Number(size);
  const each = ${head} && shape === "rises" && n > 4 ? 110 : 100;
  new WorkLedger(1000).charge("frames", each * n);
  if (${head} && shape === "differs" && n === 8)
    return { parts: ["b"], unanswered: 1, unansweredBy: { reason: "memory", node: 3 } };
  return ${head} && shape === "stops" && n === 8
    ? { parts: ["a"], unanswered: 1, unansweredBy: { reason: "memory", node: 3 } }
    : { parts: ["a"], unanswered: 0 };
}
`;

test("the stall index prints a growth line per area: a series whose head-over-base units rise 1 % or more a doubling flagged, a series with a stopped run left out as the residual; and a NODE_OPTIONS heap other than --memory is named beside it in the total (#1837's F22, #1956)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const built = (name: string, head: boolean, ledger = true) => {
      const tree = join(directory, name);
      mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
      mkdirSync(join(tree, "dist", "src", "type-inference", "core"), { recursive: true });
      writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
      // (without a ledger the runner reads: a `charge` of its own, on no prototype)
      writeFileSync(
        join(tree, "dist", "src", "type-inference", "core", "budget.js"),
        ledger
          ? LEDGER
          : "export class WorkLedger {\n  constructor() {\n    this.charge = () => {};\n  }\n}\n",
      );
      writeFileSync(
        join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
        growthLibrary(head),
      );
      return tree;
    };
    const folder = join(directory, "sized");
    mkdirSync(folder);
    writeFileSync(
      join(folder, "g.mjs"),
      'export const sizes = [4, 8, 16];\nexport const shapes = Object.fromEntries(["rises", "flat", "stops", "differs"].map((shape) => [shape, (n) => `${shape} ${n}`]));\n',
    );
    const work = join(directory, "sized.work.jsonl");
    const ran = spawnSync(
      process.execPath,
      [runner, folder, built("base", false), built("head", true), "--work", work],
      // (Node takes the last of two heaps, its options split as Node splits them, the quotes removed)
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: '--max-old-space-size=2048 --max_old_space_size="3000"',
        },
      },
    );
    assert.equal(ran.status, 1, ran.stderr);
    const ended = JSON.parse(ran.stdout.trim().split("\n").at(-1)!);
    // (V8's own heap limit for each NODE_OPTIONS, as Node reads it: the runner reads none of it itself)
    const limitOf = (options: string, ...args: string[]) =>
      Number(
        spawnSync(
          process.execPath,
          [
            ...args,
            "-p",
            "Math.round(require('node:v8').getHeapStatistics().heap_size_limit / 2 ** 20)",
          ],
          { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: options } },
        ).stdout.trim(),
      );
    const two = '--max-old-space-size=2048 --max_old_space_size="3000"';
    assert.deepEqual([ended.memory, ended.nodeOptions], [2048, { heapLimit: limitOf(two) }]);
    assert.ok(limitOf(two) > limitOf(two, "--max-old-space-size=2048"));
    // (each form Node takes: a quoted value, a signed one, one after quoted spaces, a quoted option; a tab is no
    // separator, so the heap after it is part of the title and the limit is 2,048's: none named)
    for (const [options, named] of [
      ["--max-old-space-size=2048 --max-old-space-size=+3000", true],
      ['--max-old-space-size=2048 --max-old-space-size=" 3000"', true],
      ['--max-old-space-size=2048 "--max-old-space-size=3000"', true],
      ["--max-old-space-size=2048 --title=x\t--max-old-space-size=3000", false],
      // (quotes inside the option's name, which Node drops, and a title that names the option but sets no heap)
      ['--max-old-""space-size=3000', true],
      ["--title=old-space-size", false],
      ["--max-old-space-size=2048", false],
    ] as const) {
      const said = spawnSync(
        process.execPath,
        [runner, folder, built("b1", false), built("h1", true)],
        { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: options } },
      );
      const total = JSON.parse(said.stdout.trim().split("\n").at(-1)!);
      assert.deepEqual(
        total.nodeOptions,
        named ? { heapLimit: limitOf(options) } : undefined,
        options,
      );
    }
    // (the work record's last line the same total, and nothing of it on stderr, whose lines are JSON records)
    assert.deepEqual(
      JSON.parse(readFileSync(work, "utf8").trim().split("\n").at(-1)!).total,
      ended,
    );
    assert.doesNotMatch(ran.stderr, /NODE_OPTIONS|nodeOptions/);
    const judged = spawnSync(process.execPath, [stalls, work], { encoding: "utf8" });
    const growth = judged.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((line) => line.growth !== undefined);
    // (four modes: `rises` and `flat` measured in each, `rises` flagged at its 10 % step; `stops` and `differs` the
    // residual)
    assert.deepEqual([growth.measured, growth.flagged], [8, 4]);
    assert.deepEqual(
      growth.worst[0].ratios.map((ratio: number) => Math.round(ratio * 100) / 100),
      [1, 1.1, 1.1],
    );
    assert.match(growth.worst[0].series, /^g\.mjs rises /);
    // (`differs` answered otherwise at 8 as well as leaving a node there: a difference, and its series in the residual)
    const named = (shape: string) =>
      ["rev-off", "rev-on", "src-off", "src-on"].map(
        (mode) => `g.mjs ${shape} ${mode} publication`,
      );
    assert.deepEqual(growth.residual, {
      series: 8,
      named: [...named("differs"), ...named("stops")],
    });
    assert.deepEqual(growth.unmeasured, { series: 0, named: [] });
    const total = judged.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);
    assert.deepEqual([total.differences, total.unanswered], [4, 4]);
    // (a base without a work ledger: no series measured, each named as unmeasured)
    const bare = join(directory, "bare.work.jsonl");
    spawnSync(
      process.execPath,
      [runner, folder, built("bare", false, false), built("head2", true), "--work", bare],
      { encoding: "utf8" },
    );
    const unmeasured = spawnSync(process.execPath, [stalls, bare], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((line) => line.growth !== undefined);
    assert.deepEqual([unmeasured.measured, unmeasured.unmeasured.series], [0, 16]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
