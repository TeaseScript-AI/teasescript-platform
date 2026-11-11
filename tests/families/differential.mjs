// node tests/families/differential.mjs <tree> <cases.jsonl> --out <records.jsonl>
// node tests/families/differential.mjs join --cases <cases.jsonl> --base <records>... [--head <records>...] --out <file>
//   [--ignore <field>...]...
// The differential record (#2298): each case of a cases file compiled on one built tree by the current checker
// (`compileProject`), analysed by the type core (`analyseCore`, its result as the compiler reads it, `checkedResult`)
// and compiled through the core's candidate route (`publishedRoute`), the core and the route in the four modes
// (`HELD_MODES`); one JSON line per case to `--out`, in the cases file's order, the same bytes for the same tree and
// cases. It judges nothing; its record and its cases are in tests/families/README.md, "Differential records".
//   A case is a JSON line: `{name, source | files, globals?, runs?, storage?}` or `{name, set, unit, key?, runs?,
//   storage?}` (a unit of a set as `stop-runs.mjs` names one, `unitResolver`); `runs` a list of host globals' values,
//   each run on every plan; `storage` the script storage each run starts with, by key (#2338).
//   The compiler's and the core's modules come from <tree>; the plan's check list (`planCheckList`) from this file's
//   own build, so a record's form does not depend on the tree's age.
// `join` checks the records of one or two trees against the whole cases file (each case recorded once on each side, no
// other record) and writes them in the cases' order: a side's record, or `{name, base, head}`. With `--ignore` (#2316)
// it also compares each case's base and head as JSON values with those fields removed at any depth, and names the
// cases that still differ and those whose records it cannot read as JSON.
// Exit 0: every case recorded and nothing threw; 1: a record holds `threw`, or `join` found a case missing, repeated
// or unknown (it then writes nothing), or with `--ignore` a case differs or is unread; 2: a refused usage, cases file
// or tree, before any record is written.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { distOf, unitResolver } from "./units.mjs";

const refuse = (why) => {
  process.stderr.write(`differential.mjs: ${why}\n`);
  process.exit(2);
};
/** The start of a record's line: the tool writes each record with its name first. */
const NAME_FIELD = Buffer.from('{"name":"');

const CASE_KEYS = new Set([
  "name",
  "source",
  "files",
  "globals",
  "runs",
  "storage",
  "set",
  "unit",
  "key",
]);
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
    if (c.storage !== undefined && !isObject(c.storage))
      refuse(`${where}: storage is an object of the stored values by key`);
    if (c.storage !== undefined && c.runs === undefined) refuse(`${where}: storage is for runs`);
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
/** The values after every `name`; an occurrence with none refuses the usage. */
const allValues = (name) =>
  args.flatMap((arg, at) => {
    if (arg !== name) return [];
    const end = args.findIndex((each, i) => i > at && each.startsWith("--"));
    const given = args.slice(at + 1, end < 0 ? args.length : end);
    if (given.length === 0) refuse(`${name} names no field`);
    return given;
  });

if (args[0] === "join") join();
else await record();

/** The modules a record reads: the compiler's and the core's from the tree at `root`, the plan's check list from this
 * tool's own build. A module or export missing refuses the tree. */
async function loadTree(root) {
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
  const { validateScriptStorageEntries } = await load("src/runtime/host-data/script-storage.js", [
    "validateScriptStorageEntries",
  ]);
  const { planCheckList } = await own("tests/helpers/plan-checks.js");
  return {
    compileProject,
    analyseCore,
    checkedResult,
    coreRecord,
    coreMessage,
    messageSource,
    coreRequest,
    HELD_MODES,
    publishedRoute,
    jsonText,
    runGlobals,
    validateScriptStorageEntries,
    planCheckList,
  };
}

/** A case's `storage` as script storage entries, a copy of its own for each run, or `undefined` where it has none. */
function entriesOf(storage) {
  return (
    storage &&
    Object.entries(storage).map(([key, value]) => ({ key, value: structuredClone(value) }))
  );
}

/** Refuses a case whose storage cannot be copied as each run copies it, or that the runtime's `validate` rejects. */
function checkStorage(cases, validate) {
  for (const c of cases.filter((each) => each.storage !== undefined)) {
    let failure;
    try {
      failure = validate(entriesOf(c.storage), "storage");
    } catch (error) {
      failure = `storage cannot be copied: ${error.message}`;
    }
    if (failure !== null) refuse(`${c.where}: ${failure}`);
  }
}

/** Each case's files and globals, a set's from its unit; a set unreadable, or its unit missing or ambiguous, refuses the file. */
async function resolveCases(cases, root) {
  const unitOf = unitResolver(root);
  for (const c of cases) {
    if (c.set === undefined) {
      c.files = c.files ?? [{ path: "main.tease", source: c.source }];
      c.globals = c.globals ?? ["hostValue"];
      continue;
    }
    let found;
    try {
      found = await unitOf({ set: c.set, name: c.unit, key: c.key });
    } catch (error) {
      refuse(`${c.where}: cannot read the set ${c.set}: ${error.message}`);
    }
    const { unit, keys } = found;
    if (keys !== undefined) refuse(`${c.where}: ${c.unit} names units of keys ${keys.join(", ")}`);
    if (unit === undefined) refuse(`${c.where}: ${c.set} has no unit ${c.unit}`);
    Object.assign(c, { files: unit.files, globals: unit.globals, key: unit.key });
  }
}

async function record() {
  const [root, casesFile] = args;
  const out = option("--out");
  if (root === undefined || casesFile === undefined || out === undefined || root.startsWith("--"))
    refuse("usage: differential.mjs <tree> <cases.jsonl> --out <records.jsonl>");
  const cases = readCases(casesFile);
  const {
    compileProject,
    analyseCore,
    checkedResult,
    coreRecord,
    coreMessage,
    messageSource,
    coreRequest,
    HELD_MODES,
    publishedRoute,
    jsonText,
    runGlobals,
    validateScriptStorageEntries,
    planCheckList,
  } = await loadTree(root);
  // (every fault of the input found before any plan runs and before the output is opened)
  await resolveCases(cases, root);
  checkStorage(cases, validateScriptStorageEntries);

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
      const given = c.storage === undefined ? {} : { storage: c.storage };
      const storage = entriesOf(c.storage);
      try {
        return { globals, ...given, ...runGlobals(plan, globals, storage) };
      } catch (error) {
        return { globals, ...given, threw: thrown(error) };
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
        ...(c.storage === undefined ? {} : { storage: c.storage }),
      },
    };
    try {
      const result = compileProject(files, { globals });
      row.checker = compiled(result.plan, result.diagnostics, c);
    } catch (error) {
      row.checker = { threw: thrown(error) };
    }
    // (a request of its own in each mode, as each analysis is made)
    try {
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
    } catch (error) {
      row.core = { threw: thrown(error) };
    }
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

/** The name of the record on bytes `[start, end)`, or `null` where they are no whole record of this tool's form. */
function nameOf(bytes, start, end) {
  if (
    end - start <= NAME_FIELD.length ||
    bytes[end - 1] !== 0x7d ||
    bytes.compare(NAME_FIELD, 0, NAME_FIELD.length, start, start + NAME_FIELD.length) !== 0
  )
    return null;
  for (let at = start + NAME_FIELD.length; at < end; at += 1)
    if (bytes[at] === 0x5c) at += 1;
    else if (bytes[at] === 0x22)
      try {
        return JSON.parse(bytes.toString("utf8", start + NAME_FIELD.length - 1, at + 1));
      } catch {
        return null;
      }
  return null;
}

function join() {
  const casesFile = option("--cases");
  const out = option("--out");
  const sides = [
    ["base", values("--base")],
    ["head", values("--head")],
  ].filter(([side]) => args.includes(`--${side}`));
  const ignored = new Set(allValues("--ignore"));
  if (casesFile === undefined || out === undefined || values("--base").length === 0)
    refuse(
      "usage: differential.mjs join --cases <cases.jsonl> --base <records>... [--head <records>...] --out <file> [--ignore <field>...]",
    );
  if (ignored.size > 0 && sides.length !== 2) refuse("--ignore compares a base with a head");
  // (an output that is an input, by any path or link, would be emptied before it is read)
  if (existsSync(out)) {
    const { dev, ino } = statSync(out);
    for (const file of [casesFile, ...sides.flatMap(([, files]) => files)])
      if (existsSync(file) && statSync(file).dev === dev && statSync(file).ino === ino)
        refuse(`the output ${out} is the input ${file}`);
  }
  const cases = readCases(casesFile);
  const wanted = new Set(cases.map((c) => c.name));
  const problems = [];
  // (each record by where its line is, so that no record is held as text: one can pass V8's longest string)
  const read = sides.map(([side, files]) => {
    const records = new Map();
    for (const file of files) {
      let bytes;
      try {
        bytes = readFileSync(file);
      } catch (error) {
        refuse(`cannot read ${file}: ${error.message}`);
      }
      for (let start = 0, line = 1; start < bytes.length; line += 1) {
        const newline = bytes.indexOf(0x0a, start);
        const end = newline < 0 ? bytes.length : newline;
        if (end > start) {
          const name = newline < 0 ? null : nameOf(bytes, start, end);
          if (name === null) refuse(`${file}:${line}: no whole record of differential.mjs`);
          if (!wanted.has(name)) problems.push(`${side}: ${JSON.stringify(name)} is no case`);
          else if (records.has(name))
            problems.push(`${side}: ${JSON.stringify(name)} recorded twice`);
          else records.set(name, { file, start, end });
        }
        start = end + 1;
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
  // (written beside the output and renamed onto it once whole, so that a failed copy leaves no output)
  const partial = `${out}.partial-${process.pid}`;
  const inputs = new Map();
  const output = openSync(partial, "w");
  const write = (text) => writeSync(output, text);
  const copy = ({ file, start, end }) => {
    if (!inputs.has(file)) inputs.set(file, openSync(file, "r"));
    const bytes = Buffer.alloc(end - start);
    for (let done = 0; done < bytes.length;) {
      const got = readSync(inputs.get(file), bytes, done, bytes.length - done, start + done);
      if (got === 0) throw new Error(`${file} ended inside the record at ${start}`);
      done += got;
    }
    writeSync(output, bytes);
    return bytes;
  };
  const differing = [];
  const unread = [];
  /** Whether `a` and `b` are equal JSON values once every field in `ignored` is removed, at any depth. */
  const same = (a, b) => {
    if (a === b) return true;
    if (Array.isArray(a))
      return Array.isArray(b) && a.length === b.length && a.every((each, i) => same(each, b[i]));
    if (!isObject(a) || !isObject(b)) return false;
    const kept = (value) => Object.keys(value).filter((key) => !ignored.has(key));
    const keys = kept(a);
    return (
      keys.length === kept(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
    );
  };
  // (equal bytes need no parse, so a record longer than V8's longest string is compared when both sides hold it alike)
  const compare = (name, base, head) => {
    if (base.equals(head)) return;
    let parsed;
    try {
      parsed = [base, head].map((bytes) => JSON.parse(bytes.toString("utf8")));
    } catch {
      unread.push(name);
      return;
    }
    if (!same(...parsed)) differing.push(name);
  };
  try {
    for (const c of cases) {
      if (read.length === 1) copy(read[0].get(c.name));
      else {
        write(`{"name":${JSON.stringify(c.name)},"base":`);
        const base = copy(read[0].get(c.name));
        write(`,"head":`);
        const head = copy(read[1].get(c.name));
        write("}");
        if (ignored.size > 0) compare(c.name, base, head);
      }
      write("\n");
    }
  } catch (error) {
    for (const fd of [output, ...inputs.values()]) closeSync(fd);
    unlinkSync(partial);
    process.stderr.write(`differential.mjs: ${error.message}\n`);
    process.exit(1);
  }
  for (const fd of [output, ...inputs.values()]) closeSync(fd);
  renameSync(partial, out);
  const summary = { cases: cases.length, sides: read.length };
  if (ignored.size > 0)
    Object.assign(summary, { ignore: [...ignored], differ: differing.length, differing, unread });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (differing.length > 0 || unread.length > 0) process.exitCode = 1;
}
