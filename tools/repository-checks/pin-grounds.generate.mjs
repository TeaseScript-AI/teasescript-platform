import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Writes the fixture of `pin-grounds.test.mjs`, which is generated, not written:
//
//   node tools/repository-checks/pin-grounds.generate.mjs <evidence>
//
// `<evidence>` is the folder holding #2035's review evidence (on the LXC, `~/work/evidence`): each Codex round's
// `pin-suites-codex-r<n>/<head>/` with its probe results and diffs, and the builder's
// `pin-suites-f17-builder/<head>/` with its probe scripts. It freezes the seven read suite files of this checkout into
// `pin-grounds.frozen/` and writes `pin-grounds.cases.json`: each instance of the design round's witness matrix
// (`pin-suites-f17-design-sol/r1/witness-matrix.tsv`) as a case on the frozen text, its base and head as `-U0` diffs
// (the base against the frozen text, the head against the base; a new file's head against the frozen text), with its
// class (P pass, E exemption, G ground refusal, U unsupported-syntax refusal) and the instances it stands for; and Codex
// r3's independent expected-value ranges, from which the test derives the 358 positions. The suite files must be the
// ones the evidence was written against (unchanged since `8dcc678fb`): it stops otherwise. A class the design changed
// later (design-r6) is set in `RECLASSED`.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const SUITES = [
  "tests/type-core-candidate.test.ts",
  "tests/type-core-closure.test.ts",
  "tests/type-core-contract-capture.test.ts",
  "tests/type-core-f18.test.ts",
  "tests/type-core-work-a.test.ts",
  "tests/helpers/type-core-families.ts",
  "tests/type-core-work-c.test.ts",
];
const BUILDER = "pin-suites-f17-builder/8dcc678fbe3923742689ee29ecb32b3446a7b4df";
const CODEX = {
  r2: "pin-suites-codex-r2/8734b0b4f43b2abf06fc310cbc5c9d424c46852f",
  r6: "pin-suites-codex-r6/396d38945d1c4d5399c6f0acedefa18071875fca",
};
/** Instances whose class design-r6 changed: a second declared-form assertion for an owner is refused. */
const RECLASSED = { "control-multiset-duplicate": "U" };
/** Codex r3's expected-value ranges, reviewed apart from the readers: the lines holding each suite's expected values. */
const RANGES = {
  "tests/type-core-candidate.test.ts": [[1707, 1707]],
  "tests/type-core-closure.test.ts": [246, 250, 256, 262, 264, 270, 275, 280].map((line) => [
    line,
    line,
  ]),
  "tests/type-core-contract-capture.test.ts": [[575, 575]],
  "tests/type-core-f18.test.ts": [[345, 345]],
  "tests/type-core-work-a.test.ts": [[1559, 1574]],
  "tests/helpers/type-core-families.ts": [
    [6748, 6751],
    [6754, 6757],
    [6770, 6773],
    [6776, 6779],
    [6792, 6795],
    [6798, 6801],
    [6814, 6817],
    [6820, 6823],
  ],
  "tests/type-core-work-c.test.ts": [
    [112, 116],
    [119, 123],
    [125, 125],
    [140, 144],
    [147, 151],
    [153, 153],
    [535, 536],
    [543, 544],
    [585, 585],
  ],
};
/** The numbers in those ranges that are inputs: closure's `chain(16)`. */
const INPUTS = [["tests/type-core-closure.test.ts", 246, "16"]];

/** `text` with a `-U0` (or context) diff applied: each removed or context line must be the text's. */
function apply(text, diff) {
  const source = text.split(/(?<=\n)/u);
  const out = [];
  let cursor = 0;
  const lines = diff.split(/(?<=\n)/u);
  for (let at = 0; at < lines.length;) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/u.exec(lines[at]);
    at += 1;
    if (hunk === null) continue;
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const start = count === 0 ? Number(hunk[1]) : Number(hunk[1]) - 1;
    out.push(...source.slice(cursor, start));
    cursor = start;
    for (
      ;
      at < lines.length && !lines[at].startsWith("@@ ") && !lines[at].startsWith("diff --git ");
      at += 1
    ) {
      const line = lines[at];
      if (line.startsWith(" ") || line.startsWith("-")) {
        if (source[cursor] !== line.slice(1))
          throw new Error(`a diff line ${cursor + 1} does not match its text`);
        cursor += 1;
      }
      if (line.startsWith(" ") || line.startsWith("+")) out.push(line.slice(1));
    }
  }
  out.push(...source.slice(cursor));
  return out.join("");
}

/** The `-U0` diff of two texts, its hunks only. */
function diffOf(before, after) {
  const directory = mkdtempSync(join(tmpdir(), "pin-grounds-generate-"));
  try {
    writeFileSync(join(directory, "a"), before);
    writeFileSync(join(directory, "b"), after);
    const { stdout } = spawnSync("git", ["diff", "--no-index", "-U0", "a", "b"], {
      cwd: directory,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    return stdout
      .split(/(?<=\n)/u)
      .filter((line) => /^(?:@@|[+\-\\])/u.test(line) && !/^(?:\+\+\+|---)/u.test(line))
      .join("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The builder's probe cases, `{ name: { file, base, head } }`, by rerunning its two probe scripts in a recording mode. */
async function builderCases(evidence) {
  const cases = {};
  globalThis.__pinGroundsRecord = (name, file, base, head) => (cases[name] = { file, base, head });
  const scratch = mkdtempSync(join(tmpdir(), "pin-grounds-generate-"));
  try {
    for (const [script, cut, replacement] of [
      [
        "r1-fix/probes.mjs",
        ["const probe = ", "\nconst C = "],
        'const probe = (name, file, expect, change) => {\n  const before = readFileSync(join(WT, file), "utf8");\n  globalThis.__pinGroundsRecord(name, file, before, change(before));\n};',
      ],
      [
        "r7-fix/cli-probes.mjs",
        ["const run = ", "\nconst id = "],
        'const run = (name, expected, file, baseline, change) => {\n  const base = baseline(readFileSync(join(WT, file), "utf8"));\n  globalThis.__pinGroundsRecord(name, file, base, change(base));\n};',
      ],
    ]) {
      let text = readFileSync(join(evidence, BUILDER, script), "utf8");
      const from = text.indexOf(cut[0]);
      const to = text.indexOf(cut[1], from);
      text = text.slice(0, from) + replacement + text.slice(to);
      text = text.slice(0, text.search(/^(?:rmSync\(tmp|writeFileSync\()/mu));
      text = text.replace(/^const \{ groundRefusals \}.*$/mu, "").replace(/^const tmp = .*$/mu, "");
      text = text.replace(/^const WT = .*$/mu, `const WT = ${JSON.stringify(ROOT)};`);
      const path = join(scratch, script.replace("/", "-"));
      writeFileSync(path, text);
      await import(path);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return cases;
}

/** A Codex witness's base and head: its baseline diff, if any, applied to the frozen text, then its diff. */
function codexCase(folder, name, rows) {
  const row = rows.find((each) => each.name === name);
  const file = row.file;
  const frozen = readFileSync(join(ROOT, file), "utf8");
  let base = frozen;
  try {
    base = apply(frozen, readFileSync(join(folder, `${name}.baseline.diff`), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { file, base, head: apply(base, readFileSync(join(folder, `${name}.diff`), "utf8")) };
}

async function main([evidence]) {
  if (evidence === undefined) {
    console.error("usage: node tools/repository-checks/pin-grounds.generate.mjs <evidence folder>");
    return 2;
  }
  for (const file of SUITES) {
    const now = execFileSync("git", ["-C", ROOT, "rev-parse", `HEAD:${file}`], {
      encoding: "utf8",
    }).trim();
    const then = execFileSync("git", ["-C", ROOT, "rev-parse", `8dcc678fb:${file}`], {
      encoding: "utf8",
    }).trim();
    if (now !== then) {
      console.error(
        `pin-grounds.generate: ${file} changed since 8dcc678fb: the evidence was written against that text`,
      );
      return 2;
    }
  }
  const builder = await builderCases(evidence);
  const rowsOf = (path) => {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data.rows ?? data.results ?? [];
  };
  const cases = new Map();
  const matrix = readFileSync(
    join(evidence, "pin-suites-f17-design-sol/r1/witness-matrix.tsv"),
    "utf8",
  );
  for (const line of matrix.trim().split("\n").slice(1)) {
    const [source, name, , , , matrixClass, changed] = line.split("\t");
    const reason = RECLASSED[name] ?? matrixClass;
    const [folder, head, round, results] = source.split("/");
    let found;
    let fresh = false;
    if (folder.startsWith("pin-suites-codex-r"))
      found = codexCase(join(evidence, folder, head), name, rowsOf(join(evidence, source)));
    else if (round === "r2-fix" && name === "untracked-declared-suite-empty-diff") {
      // (Codex r2: the suite removed at the base and written again at the head, its pin moved)
      const file = "tests/type-core-candidate.test.ts";
      found = {
        file,
        base: "",
        head: readFileSync(join(ROOT, file), "utf8").replace("[194, 17]", "[195, 17]"),
      };
      fresh = true;
    } else if (
      round === "r2-fix" &&
      /^closure-(?:unrelated-top-level-comment-grounds-pin|real-top-level-ground-after-helper)$/u.test(
        name,
      )
    ) {
      // (Codex r2's base: an unrelated top-level block inserted before closure's ground)
      const file = "tests/type-core-closure.test.ts";
      const helper =
        "/** A fixture count for a different top-level block. */\nconst REVIEW_FIXTURE_COUNT = 1;\n\n";
      const base = readFileSync(join(ROOT, file), "utf8").replace(
        "/**\n * Programs outside",
        `${helper}/**\n * Programs outside`,
      );
      found = {
        file,
        base,
        head: apply(base, readFileSync(join(evidence, CODEX.r2, `${name}.diff`), "utf8")),
      };
    } else if (round === "r2-fix")
      found = codexCase(join(evidence, CODEX.r2), name, rowsOf(join(evidence, source)));
    else if (round === "r7-fix" && results === "r6-cli-probes.json")
      found = codexCase(
        join(evidence, CODEX.r6),
        name,
        rowsOf(join(evidence, CODEX.r6, "r6-cli-probes.json")),
      );
    else found = builder[name];
    if (found === undefined) throw new Error(`no case for ${source} ${name}`);
    const frozen = readFileSync(join(ROOT, found.file), "utf8");
    const key = JSON.stringify([found.file, found.base, found.head, fresh]);
    if (!cases.has(key))
      cases.set(key, {
        file: found.file,
        base: fresh || found.base === frozen ? null : diffOf(frozen, found.base),
        head: fresh ? diffOf(frozen, found.head) : diffOf(found.base, found.head),
        newFile: fresh,
        class: reason,
        instances: [],
      });
    const entry = cases.get(key);
    if (entry.class !== reason) throw new Error(`${name}: one case of two classes`);
    entry.instances.push({
      evidence: source,
      witness: name,
      ...(changed ? { changed } : {}),
      ...(RECLASSED[name] ? { reclassed: "design-r6" } : {}),
    });
  }
  mkdirSync(join(HERE, "pin-grounds.frozen"), { recursive: true });
  for (const file of SUITES)
    writeFileSync(
      join(HERE, "pin-grounds.frozen", `${file.replaceAll("/", "__")}.txt`),
      readFileSync(join(ROOT, file), "utf8"),
    );
  const about =
    "Generated by pin-grounds.generate.mjs, not written: the r3–r7 witnesses of #2035's line-level ground check as cases on the frozen suite texts in pin-grounds.frozen/, and Codex r3's independent expected-value ranges. See the generator's header.";
  writeFileSync(
    join(HERE, "pin-grounds.cases.json"),
    `${JSON.stringify({ about, ranges: RANGES, inputs: INPUTS, cases: [...cases.values()] }, null, 1)}\n`,
  );
  console.log(
    `pin-grounds.generate: ${cases.size} cases of ${[...cases.values()].reduce((sum, each) => sum + each.instances.length, 0)} instances`,
  );
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
