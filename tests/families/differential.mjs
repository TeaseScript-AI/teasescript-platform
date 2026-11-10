// node tests/families/differential.mjs <tree> <cases.jsonl> --out <records.jsonl>
// node tests/families/differential.mjs join --cases <cases.jsonl> --base <records>... [--head <records>...] --out <file>
// The differential record (#2298): each case of a cases file compiled on one built tree by the current checker
// (`compileProject`), analysed by the type core (`analyseCore`, its result as the compiler reads it, `checkedResult`)
// and compiled through the core's candidate route (`publishedRoute`), the core and the route in the four modes
// (`HELD_MODES`); one JSON line per case to `--out`, in the cases file's order, the same bytes for the same tree and
// cases. It judges nothing; its record and its cases are in tests/families/README.md, "Differential records".
//   A case is a JSON line: `{name, source | files, globals?, runs?}` or `{name, set, unit, key?, runs?}` (a unit of a
//   set as `stop-runs.mjs` names one, `unitResolver`); `runs` a list of host globals' values, each run on every plan.
//   The compiler's and the core's modules come from <tree>; the plan's check list (`planCheckList`) from this file's
//   own build, so a record's form does not depend on the tree's age.
// `join` checks the records of one or two trees against the whole cases file (each case recorded once on each side, no
// other record) and writes them in the cases' order: a side's record, or `{name, base, head}`.
// Exit 0: every case recorded and nothing threw; 1: a record holds `threw`, or `join` found a case missing, repeated
// or unknown (it then writes nothing); 2: a refused usage, cases file or tree, before any record is written.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { distOf, unitResolver } from "./units.mjs";

const refuse = (why) => {
  process.stderr.write(`differential.mjs: ${why}\n`);
  process.exit(2);
};
const CASE_KEYS = new Set(["name", "source", "files", "globals", "runs", "set", "unit", "key"]);
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isTexts = (value) => Array.isArray(value) && value.every((each) => typeof each === "string");

/** The cases of `file`, each checked whole; a refusal names its line. */
function readCases(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    refuse(`cannot read the cases file ${file}: ${error.message}`);
  }
  const cases = [];
  const names = new Set();
  for (const [at, line] of text.split("\n").entries()) {
    if (line === "") continue;
    const where = `${file}:${at + 1}`;
    let c;
    try {
      c = JSON.parse(line);
    } catch (error) {
      refuse(`${where}: no JSON: ${error.message}`);
    }
    if (!isObject(c)) refuse(`${where}: a case is a JSON object`);
    const unknown = Object.keys(c).filter((key) => !CASE_KEYS.has(key));
    if (unknown.length > 0) refuse(`${where}: unknown keys ${unknown.join(", ")}`);
    if (typeof c.name !== "string" || c.name === "") refuse(`${where}: no name`);
    if (names.has(c.name)) refuse(`${where}: the name ${JSON.stringify(c.name)} twice`);
    names.add(c.name);
    const given = ["source", "files", "set"].filter((key) => c[key] !== undefined);
    if (given.length !== 1) refuse(`${where}: exactly one of source, files and set`);
    if (c.source !== undefined && typeof c.source !== "string")
      refuse(`${where}: a source is text`);
    if (
      c.files !== undefined &&
      !(
        Array.isArray(c.files) &&
        c.files.length > 0 &&
        c.files.every(
          (f) => isObject(f) && typeof f.path === "string" && typeof f.source === "string",
        )
      )
    )
      refuse(`${where}: files are a list of {path, source}`);
    if (c.set !== undefined) {
      if (typeof c.set !== "string" || typeof c.unit !== "string")
        refuse(`${where}: a set's case names its set and unit as text`);
      if (c.key !== undefined && typeof c.key !== "string") refuse(`${where}: a key is text`);
      if (c.globals !== undefined) refuse(`${where}: a set's unit brings its own globals`);
    } else if (c.unit !== undefined || c.key !== undefined)
      refuse(`${where}: unit and key belong to a set's case`);
    if (c.globals !== undefined && !isTexts(c.globals))
      refuse(`${where}: globals are a list of names`);
    if (c.runs !== undefined && !(Array.isArray(c.runs) && c.runs.every(isObject)))
      refuse(`${where}: runs are a list of objects of the globals' values`);
    cases.push({ ...c, where });
  }
  return cases;
}

const args = process.argv.slice(2);
/** The values after `name` up to the next option. */
const values = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return [];
  const end = args.findIndex((arg, i) => i > at && arg.startsWith("--"));
  return args.slice(at + 1, end < 0 ? args.length : end);
};
const option = (name) => values(name)[0];

if (args[0] === "join") join();
else await record();

async function record() {
  const [root, casesFile] = args;
  const out = option("--out");
  if (root === undefined || casesFile === undefined || out === undefined || root.startsWith("--"))
    refuse("usage: differential.mjs <tree> <cases.jsonl> --out <records.jsonl>");
  const cases = readCases(casesFile);
  const ownRoot = fileURLToPath(new URL("../..", import.meta.url));
  const own = async (file) => {
    const at = path.join(ownRoot, "dist", file);
    if (!existsSync(at))
      refuse(`this tool's own tree ${ownRoot} has no dist/${file} (npm run build:typescript)`);
    return import(pathToFileURL(at).href);
  };
  const dist = distOf(root);
  const load = async (file, names) => {
    const at = path.join(dist, file);
    if (!existsSync(at)) refuse(`the tree ${root} has no ${file}`);
    const module = await import(pathToFileURL(at).href);
    for (const name of names)
      if (module[name] === undefined) refuse(`${file} of ${root} has no ${name}`);
    return module;
  };
  const { compileProject } = await load("src/compiler.js", ["compileProject"]);
  const { analyseCore } = await load("src/type-inference/core/answers.js", ["analyseCore"]);
  const { checkedResult } = await load("src/type-inference/core/check-result/check-result.js", [
    "checkedResult",
  ]);
  const { coreRecord } = await load("src/type-inference/core/result.js", ["coreRecord"]);
  const { coreMessage, messageSource } = await load("src/type-inference/core/messages.js", [
    "coreMessage",
    "messageSource",
  ]);
  const { coreRequest } = await load("tests/helpers/type-core-analysis.js", ["coreRequest"]);
  const { HELD_MODES } = await load("tests/helpers/type-core-held-host.js", ["HELD_MODES"]);
  const { publishedRoute, jsonText } = await load("tests/helpers/type-core-oracles.js", [
    "publishedRoute",
    "jsonText",
  ]);
  const { runGlobals } = await load("tests/helpers/type-core-route.js", ["runGlobals"]);
  const { planCheckList } = await own("tests/helpers/plan-checks.js");

  // (the cases resolved before anything runs: a set's unit missing or ambiguous refuses the file)
  const unitOf = unitResolver(root);
  for (const c of cases) {
    if (c.set === undefined) {
      c.files = c.files ?? [{ path: "main.tease", source: c.source }];
      c.globals = c.globals ?? ["hostValue"];
      continue;
    }
    const { unit, keys } = await unitOf({ set: c.set, name: c.unit, key: c.key });
    if (keys !== undefined) refuse(`${c.where}: ${c.unit} names units of keys ${keys.join(", ")}`);
    if (unit === undefined) refuse(`${c.where}: ${c.set} has no unit ${c.unit}`);
    Object.assign(c, { files: unit.files, globals: unit.globals, key: unit.key });
  }

  let threw = 0;
  const thrown = (error) => {
    threw += 1;
    return `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
  };
  const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;
  const diagnostic = (d) => ({
    severity: d.severity,
    code: d.code,
    path: d.path,
    line: d.span.start.line + 1,
    column: d.span.start.column + 1,
    offset: d.span.start.offset,
    end: d.span.end.offset,
    message: d.message,
  });
  const runs = (plan, c) =>
    c.runs?.map((globals) => {
      try {
        return { globals, ...runGlobals(plan, globals) };
      } catch (error) {
        return { globals, threw: thrown(error) };
      }
    });
  /** A compile's diagnostics, its plan's hash and checks, and where the case names them, its runs. */
  const compiled = (plan, diagnostics, c) => ({
    diagnostics: diagnostics.map(diagnostic),
    plan:
      plan === null
        ? null
        : {
            hash: createHash("sha256").update(jsonText(plan)).digest("hex").slice(0, 32),
            checks: planCheckList(plan),
          },
    ...(plan === null || c.runs === undefined ? {} : { runs: runs(plan, c) }),
  });
  /** The four modes' entries, each named by its mode, and whether they agree but for that name. */
  const modes = (entry) => {
    const list = HELD_MODES.map((mode) => {
      try {
        return { mode: mode.name, ...entry(mode) };
      } catch (error) {
        return { mode: mode.name, threw: thrown(error) };
      }
    });
    const bare = list.map(({ mode: _, ...rest }) => JSON.stringify(rest));
    return { agree: bare.every((each) => each === bare[0]), modes: list };
  };

  try {
    writeFileSync(out, "");
  } catch (error) {
    refuse(`cannot write ${out}: ${error.message}`);
  }
  for (const c of cases) {
    const { files, globals } = c;
    const row = {
      name: c.name,
      case: {
        ...(c.set === undefined ? {} : { set: c.set, unit: c.unit, key: c.key }),
        files,
        globals,
        ...(c.runs === undefined ? {} : { runs: c.runs }),
      },
    };
    try {
      const result = compileProject(files, { globals });
      row.checker = compiled(result.plan, result.diagnostics, c);
    } catch (error) {
      row.checker = { threw: thrown(error) };
    }
    // (a request of its own in each mode, as each analysis is made)
    row.core =
      coreRequest(files, globals) === null
        ? { unparsed: true }
        : modes((mode) =>
            mode.run(() => {
              const request = coreRequest(files, globals);
              const result = checkedResult(analyseCore(request), request);
              const paths = request.files.map((file) => file.path);
              const sources = request.files.map((file) => file.source);
              const shown = messageSource(sources, result.diagnostics);
              const site = (file, offset, end) => ({
                path: paths[file],
                line: lineOf(sources[file], offset),
                offset,
                end,
                text: sources[file].slice(offset, end),
              });
              return {
                outcome: result.outcome,
                diagnostics: result.diagnostics.map((d) => ({
                  class: d.class,
                  kind: d.kind,
                  code: d.code,
                  ...site(d.site.file, d.site.start, d.site.end),
                  message: coreMessage(d, shown),
                })),
                checks: coreRecord(result, paths).runtimeChecks.map((check) => ({
                  kind: check.kind,
                  target: check.target,
                  against: check.against,
                  boundary: check.boundary === true,
                  ...site(paths.indexOf(check.site.file), check.site.offset, check.site.end),
                })),
              };
            }),
          );
    row.candidate = modes((mode) => {
      const route = mode.run(() => publishedRoute(files, globals));
      if (route.plan === "outside") return { outside: JSON.parse(route.text).outside };
      return compiled(route.plan, JSON.parse(route.text).diagnostics, c);
    });
    appendFileSync(out, `${JSON.stringify(row)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ cases: cases.length, threw })}\n`);
  process.exitCode = threw === 0 ? 0 : 1;
}

function join() {
  const casesFile = option("--cases");
  const out = option("--out");
  const sides = [
    ["base", values("--base")],
    ["head", values("--head")],
  ].filter(([, files]) => files.length > 0);
  if (casesFile === undefined || out === undefined || values("--base").length === 0)
    refuse(
      "usage: differential.mjs join --cases <cases.jsonl> --base <records>... [--head <records>...] --out <file>",
    );
  const cases = readCases(casesFile);
  const wanted = new Set(cases.map((c) => c.name));
  const problems = [];
  const read = sides.map(([side, files]) => {
    const records = new Map();
    for (const file of files) {
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        refuse(`cannot read ${file}: ${error.message}`);
      }
      for (const [at, line] of text.split("\n").entries()) {
        if (line === "") continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch (error) {
          refuse(`${file}:${at + 1}: no JSON: ${error.message}`);
        }
        if (!wanted.has(row?.name))
          problems.push(`${side}: ${JSON.stringify(row?.name)} is no case`);
        else if (records.has(row.name))
          problems.push(`${side}: ${JSON.stringify(row.name)} recorded twice`);
        else records.set(row.name, line);
      }
    }
    for (const c of cases)
      if (!records.has(c.name)) problems.push(`${side}: ${JSON.stringify(c.name)} missing`);
    return records;
  });
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
  writeFileSync(
    out,
    cases
      .map((c) =>
        read.length === 1
          ? `${read[0].get(c.name)}\n`
          : `{"name":${JSON.stringify(c.name)},"base":${read[0].get(c.name)},"head":${read[1].get(c.name)}}\n`,
      )
      .join(""),
  );
  process.stdout.write(`${JSON.stringify({ cases: cases.length, sides: read.length })}\n`);
}
