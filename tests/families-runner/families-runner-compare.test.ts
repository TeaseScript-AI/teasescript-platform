import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runner, stalls, contract } from "../helpers/families-runner/families-runner-stand-ins.js";

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
    // (the source-order runs both trees ended; from the base's abort on, the head's own outcome per run, each run it
    // ended with its peak heap, #2068)
    const withoutPeaks = (after: { peak?: number }[]) => after.map(({ peak, ...run }) => run);
    for (const run of aborted.afterBase)
      assert.equal(typeof run.peak, "number", JSON.stringify(run));
    assert.deepEqual(withoutPeaks(aborted.afterBase), [
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
    // (a run at the safety net ended nothing: no peak)
    assert.equal(slow.afterBase[1].peak, undefined);
    assert.deepEqual(withoutPeaks(slow.afterBase), [
      { mode: "src-off", check: "publication", head: { answered: true } },
      { mode: "rev-on", check: "publication", head: { uncharged: true } },
    ]);
    assert.deepEqual(slow.uncharged, { head: "rev-on publication" });
    assert.match(ran.stderr, /"source":"head-slow","uncharged":\{"head":"rev-on publication"\}/);
    // (the head's own abort in its rerun: named by its run)
    const dies = lines.find((line) => line.source === "head-dies");
    assert.deepEqual(withoutPeaks(dies.afterBase.slice(0, 1)), [
      { mode: "src-off", check: "publication", head: { answered: true } },
    ]);
    assert.deepEqual([dies.afterBase[1].mode, dies.afterBase[1].check], ["rev-on", "publication"]);
    assert.match(dies.afterBase[1].head.stalled, /FATAL ERROR: .*heap out of memory/);
    assert.equal(dies.afterBase.length, 2);
    // (the head's own exception in its rerun: named by its run there, and reported as any exception: counted, on stderr,
    // in --out with its stack, Codex r4)
    const throws = lines.find((line) => line.source === "head-throws");
    assert.deepEqual(withoutPeaks(throws.afterBase.slice(1, 2))[0], {
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
