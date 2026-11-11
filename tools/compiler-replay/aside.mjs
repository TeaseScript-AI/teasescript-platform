// `aside` compiles each route-only area difference and each differing set source, in each mode, through the candidate
// route (`publishedRoute`) on both trees in one queue job as `<prefix>-aside`: a row agrees where the plan's JSON text
// (`jsonText`) is byte-equal and the route's text is equal once every pattern of the declaration file is removed. The
// declaration file is a JSON list of `{ "pattern": <regular expression source>, "reason": <why its text may differ> }`,
// passed as an argument and never read from elsewhere; the report prints each pattern with its reason. Each row also
// counts both plans' checks (`planChecks`).
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CASES, MODES, MODE_OF, USAGE, Usage, inTemporaryFolder, queue } from "./common.mjs";
import { lines } from "./results.mjs";
import { report } from "./collect.mjs";

/** A declaration file's patterns: each `{ pattern, reason }`, compiled; a malformed one is a usage error. */
export function declarations(text) {
  let list;
  try {
    list = JSON.parse(text);
  } catch (error) {
    throw new Usage(`the declaration file is no JSON: ${error.message}`);
  }
  if (!Array.isArray(list) || list.length === 0)
    throw new Usage("the declaration file is a non-empty JSON list");
  return list.map((entry) => {
    if (
      typeof entry?.pattern !== "string" ||
      typeof entry?.reason !== "string" ||
      entry.reason.trim() === ""
    )
      throw new Usage("each declaration has a `pattern` and a `reason`");
    return { ...entry, regex: new RegExp(entry.pattern, "gu") };
  });
}

/** The declaration file at `file`; one it cannot read or parse is a usage error. */
function declarationsOf(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Usage(`the declaration file cannot be read: ${error.message}`);
  }
  return declarations(text);
}

/** `text` with every declared pattern removed. */
export const setAside = (text, declared) =>
  declared.reduce((t, { regex }) => t.replace(regex, ""), text);

export function aside({ positional: [prefix, base, head], options }) {
  if (head === undefined || options.owner === undefined || options.declare === undefined)
    throw new Usage(USAGE);
  const declared = declarationsOf(options.declare);
  const r = report(
    prefix,
    options.results ?? path.join(homedir(), "jobs", "results", options.owner),
    undefined,
    options.replace,
  );
  const rows = [
    ...r.differences
      .filter((d) => d.routeOnly)
      .map(({ generator, source, mode, files, globals }) => ({
        generator,
        source,
        mode,
        files,
        globals,
      })),
    ...[...new Set(r.set.differences.map((d) => d.name))].map((name) => ({ set: name })),
  ];
  // (`sx-job submit` copies `--in rows.jsonl` before it returns)
  return inTemporaryFolder((folder) => {
    writeFileSync(
      path.join(folder, "rows.jsonl"),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    for (const { pattern, reason } of declared)
      process.stdout.write(`set aside: /${pattern}/ (${reason})\n`);
    for (const id of queue([
      "submit",
      "--name",
      `${prefix}-aside`,
      "--owner",
      options.owner,
      "--campaign",
      `${prefix}-aside`,
      "--commit",
      `base=${base}`,
      "--commit",
      `head=${head}`,
      "--data",
      CASES,
      "--mem",
      "8G",
      "--timeout",
      "3h",
      "--in",
      `rows.jsonl=${path.join(folder, "rows.jsonl")}`,
      "--in",
      `declare.json=${options.declare}`,
      "--",
      "bash",
      "-c",
      'export CASES_JSON=$HOME/work/o4-m4-g3/cases.json; node "$SX_TREE_head/tools/compiler-replay.mjs" aside-run ' +
        '"$SX_TREE_base" "$SX_TREE_head" "$SX_IN/rows.jsonl" "$SX_IN/declare.json" "$SX_OUT/aside.jsonl"',
    ]))
      process.stdout.write(`${id}\n`);
    return 0;
  });
}

/** On a queue worker: each row compiled on both built trees (`aside`'s job). */
export async function asideRun({ positional: [base, head, rows, declare, out] }) {
  const declared = declarationsOf(declare);
  const load = async (tree) =>
    import(pathToFileURL(path.join(tree, "dist/tests/helpers/type-core-oracles.js")).href);
  const [b, h] = [await load(base), await load(head)];
  const { planChecks } = await import(
    pathToFileURL(path.join(head, "dist/tests/helpers/plan-checks.js")).href
  );
  const cases =
    process.env.CASES_JSON === undefined
      ? []
      : JSON.parse(readFileSync(process.env.CASES_JSON, "utf8"));
  const units = lines(rows).flatMap((row) =>
    row.set === undefined
      ? [row]
      : MODES.map((mode) => ({
          source: row.set,
          mode,
          files: cases.find((c) => c.name === row.set)?.files,
          globals: ["hostValue", "hostOther", "hostInit"],
        })),
  );
  const written = [];
  for (const u of units) {
    if (u.files === undefined) throw new Usage(`no files for ${u.source}`);
    const route = (o) =>
      o.inMode(MODE_OF[u.mode], () => o.publishedRoute(u.files, u.globals ?? ["hostValue"]));
    const [rb, rh] = [route(b), route(h)];
    const plan = (o, x) => (x.plan === "outside" ? "outside" : o.jsonText(x.plan));
    const [pb, ph] = [plan(b, rb), plan(h, rh)];
    if (pb === undefined || ph === undefined) throw new Usage(`no JSON text of ${u.source}'s plan`);
    const checks = (x) => (x.plan === "outside" || x.plan === null ? null : planChecks(x.plan));
    written.push(
      JSON.stringify({
        generator: u.generator,
        source: u.source,
        mode: u.mode,
        planEqual: pb === ph,
        textEqual: rb.text === rh.text,
        asideEqual: setAside(rb.text, declared) === setAside(rh.text, declared),
        checks: [checks(rb), checks(rh)],
      }),
    );
  }
  writeFileSync(out, written.join("\n") + "\n");
  return 0;
}
