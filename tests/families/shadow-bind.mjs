// node tests/families/shadow-bind.mjs <group-table.json> <group-table.md> <pair-groups.jsonl> <records list> <out dir>
// Writes the shadow gate's group table (`groups.json`, `bindings.jsonl.gz`) from an adjudication: its group table
// (JSON and its rendered Markdown, whose state column names what closes an open group) and its pair bindings, each a
// source key and mode with its group and the sha256 of its raw publication, joined with the gate run's records it
// adjudicated (`<records list>`: one records file a line). Each binding's raw guard is recomputed on its record's row:
// one that differs, or a binding without its row, refuses the join. Each bound pair's line carries the classifier's
// own guard of its reading (`pairGuard`) and class. A re-adjudication writes both files anew, whole.
// It lives beside `shadow-groups/`, which holds data only: a folder of `tests/families/` with a module is a runner area
// (`baselines.mjs`), and importing this module does nothing; it writes only when it is the script run.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { pairGuard, readRecord, classifyRecords } from "./shadow-classify.mjs";

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  bind(...process.argv.slice(2));

function bind(tableJson, tableMd, bindingsFile, recordsList, out) {
  const MODES = [
    "source order, sharing on",
    "source order, sharing off",
    "reversed, sharing on",
    "reversed, sharing off",
  ];
  const canon = (x) =>
    JSON.stringify(x, (_, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v,
    );
  const sha = (text) => createHash("sha256").update(text).digest("hex");

  const table = JSON.parse(readFileSync(tableJson, "utf8"));
  // (what closes an open group: the state column after "open / defect" or "open / pending", as `open / defect / #1749`)
  const closes = new Map();
  for (const line of readFileSync(tableMd, "utf8").split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const id = cells[1]?.split(" ")[0];
    const named = /^open \/ (defect|pending)\s*\/?\s*(.+)$/.exec(cells[3] ?? "");
    if (id && named) closes.set(id, named[2]);
  }
  const groups = table.rows
    .filter((r) => r.leaf)
    .map((r) => ({
      id: r.id,
      parent: r.parent,
      state: r.verdict,
      title: r.title,
      ...(r.verdict === "conforms" ? {} : { closes: closes.get(r.id) ?? null }),
      witness: r.witness
        ? `${r.witness.key.slice(0, 12)} ${r.witness.name ?? ""} (${r.witness.mode})`
        : null,
      evidence: r.evidence ?? null,
    }));
  for (const g of groups)
    if (g.state !== "conforms" && !g.closes)
      throw new Error(`The open group ${g.id} names nothing that closes it.`);

  const wanted = new Map();
  for (const line of readFileSync(bindingsFile, "utf8").split("\n"))
    if (line.trim() !== "") {
      const b = JSON.parse(line);
      const at = `${b.key} ${MODES.indexOf(b.mode)}`;
      // (one adjudication a pair: a second, to whatever group, is refused, never an overwrite)
      if (wanted.has(at)) throw new Error(`The pair ${at} adjudicated twice.`);
      wanted.set(at, b);
    }
  const lines = [];
  /** Each bound pair's line as its first record gave it: every later record of the pair must give the same. */
  const found = new Map();
  for (const file of readFileSync(recordsList, "utf8").split(/\s+/).filter(Boolean))
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const raw = JSON.parse(line);
      const { reading } = readRecord(raw);
      if (reading?.rows === undefined) continue;
      const classes = classifyRecords([{ record: raw, bytes: 0, where: file }]).perPair;
      for (const [index, row] of reading.rows.entries()) {
        const at = `${raw.key} ${index}`;
        const b = wanted.get(at);
        if (b === undefined) continue;
        const rawRow = raw.rows.find(
          (r) => r.mode.reversed === row.mode.reversed && r.mode.unshared === row.mode.unshared,
        );
        const rawGuard = sha(
          canon(
            Object.fromEntries(
              ["legacy", "core"].map((x) => [
                x,
                Object.fromEntries(
                  ["outcome", "diagnostics", "checks", "planHash"].map((f) => [
                    f,
                    rawRow[x][f] ?? null,
                  ]),
                ),
              ]),
            ),
          ),
        );
        if (rawGuard !== b.publicationSHA256)
          throw new Error(`The binding ${at} is not its record's raw publication.`);
        const cls = classes.find((p) => p.mode === MODES[index])?.class;
        if (cls !== b.class)
          throw new Error(`The binding ${at} is ${b.class}, the classifier reads ${cls}.`);
        const bound = `${raw.key.slice(0, 16)} ${index} ${b.group} ${pairGuard(row).slice(0, 16)} ${cls}`;
        // (a record of the pair again, as a repeated source in another set: checked as the first, and the same line)
        if (found.has(at)) {
          if (found.get(at) !== bound)
            throw new Error(`The pair ${at} recorded twice with other readings.`);
          continue;
        }
        found.set(at, bound);
        lines.push(bound);
      }
    }
  const missing = [...wanted.keys()].filter((at) => !found.has(at));
  if (missing.length > 0)
    throw new Error(`${missing.length} bindings without their record, as ${missing[0]}.`);
  lines.sort();
  writeFileSync(
    path.join(out, "groups.json"),
    `${JSON.stringify({ schema: 1, from: table.schema, groups }, null, 1)}\n`,
  );
  writeFileSync(
    path.join(out, "bindings.jsonl.gz"),
    gzipSync(`${lines.join("\n")}\n`, { level: 9 }),
  );
  console.log(JSON.stringify({ groups: groups.length, bindings: lines.length }));
}
