// Records the L5 gate's K/F tapes in Node and judges each (the gate's tape plan §4): for every package, a tape on a fresh
// in-process host (`tests/gate/driver.ts`), the adapter oracle's judgment (`tests/gate/oracle.ts`), and a replay in a
// fresh Node Worker (`tests/gate/tape.ts`). Writes each tape, one report line per package and the mechanism census.
// Run in a built tree (`dist/tests/gate/`):
//   node tools/player-gate/tapes/record.mjs --out DIR [--f DIR] [--k DIR] [--fixtures DIR] [--shard I/N]
// --f: F-interactive's input catalogs (one JSON per package); --k: K's package folders; --fixtures: the gate's own
// sources (`tests/gate/fixtures/*.tease`, family G), one per mechanism group the corpus never meets. Exit 0 when every tape agrees
// with the oracle and replays unchanged, 1 when one does not (an incomplete outcome is reported, not a failure).
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    f: { type: "string" },
    k: { type: "string" },
    fixtures: { type: "string" },
    shard: { type: "string", default: "1/1" },
  },
});
if (!values.out)
  throw new Error("usage: record.mjs --out DIR [--f DIR] [--k DIR] [--fixtures DIR] [--shard I/N]");
const dist = resolve("dist");
const load = (path) => import(pathToFileURL(join(dist, path)).href);
const { createInProcessBackend } = await load("player/engine-bridge/in-process.js");
const { connectBridge } = await load("player/engine-bridge/client.js");
const { nodeWorkerPort } = await load("player/engine-bridge/node-client.js");
const { PlayerBridge } = await load("player/player-bridge.js");
const { PackageFolder } = await load("playground/package-folder.js");
const { driveTape, isComplete } = await load("tests/gate/driver.js");
const { judgeTape } = await load("tests/gate/oracle.js");
const { replayTape } = await load("tests/gate/tape.js");
const { TAPE_START } = await load("tests/gate/start.js");
const { inventoryOf } = await load("tests/gate/inventory.js");
const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const WORKER = pathToFileURL(join(dist, "player/engine-bridge/node-worker.js"));

/** The packages, in a fixed order: F's catalogs, then K's folders, each with how to read its project. */
const packages = [];
if (values.f)
  for (const file of readdirSync(values.f)
    .filter((name) => name.endsWith(".json") && name !== "manifest.json")
    .sort())
    packages.push({
      family: "F",
      name: file.slice(0, -5),
      project: async () => {
        const catalog = JSON.parse(readFileSync(join(values.f, file), "utf8"));
        return { files: catalog.sources, images: catalog.images };
      },
    });
if (values.k)
  for (const name of readdirSync(values.k, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort())
    packages.push({
      family: "K",
      name,
      project: async () => {
        const catalog = await new PackageFolder(join(values.k, name)).scan();
        return {
          files: catalog.sources,
          images: catalog.images,
          unreadableFiles: catalog.unreadable,
        };
      },
    });
if (values.fixtures)
  for (const file of readdirSync(values.fixtures)
    .filter((name) => name.endsWith(".tease"))
    .sort())
    packages.push({
      family: "G",
      name: file.slice(0, -6),
      project: async () => ({
        files: [{ path: "main.tease", source: readFileSync(join(values.fixtures, file), "utf8") }],
      }),
    });
const [shard, shards] = values.shard.split("/").map(Number);
const mine = packages.filter((_, index) => index % shards === shard - 1);

mkdirSync(join(values.out, "tapes"), { recursive: true });
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

let disagreements = 0;
for (const entry of mine) {
  const started = performance.now();
  const project = await entry.project();
  const projectJson = JSON.stringify(project);
  const host = createInProcessBackend(BUILD);
  let run;
  try {
    run = await driveTape(host, { kind: "source", script: project }, TAPE_START);
  } finally {
    host.client.terminate();
  }
  const tapeJson = JSON.stringify({
    format: 1,
    package: entry.name,
    family: entry.family,
    start: TAPE_START,
    entries: run.entries,
  });
  const tapeHash = sha256(tapeJson);
  writeFileSync(
    join(values.out, "tapes", `${entry.family}-${entry.name}.json.gz`),
    gzipSync(tapeJson),
  );
  // Every tape is judged and replayed, a preparation-only one too.
  const oracle = judgeTape(project, TAPE_START, run.entries, { complete: isComplete(run.outcome) });
  const bridge = new PlayerBridge(await connectBridge(nodeWorkerPort(WORKER, BUILD), BUILD));
  let worker;
  try {
    worker = await replayTape(bridge.client, run.entries);
  } finally {
    bridge.client.terminate();
  }
  if (oracle !== null || worker !== null) disagreements += 1;
  const line = {
    family: entry.family,
    package: entry.name,
    projectSha256: sha256(projectJson),
    preparation: run.outcome.kind === "notPrepared" ? run.outcome.reason : "prepared",
    tapeSha256: tapeHash,
    entries: run.entries.length,
    outcome: run.outcome,
    complete: isComplete(run.outcome),
    accepted: run.census.accepted,
    declined: run.census.declined,
    mechanisms: run.census.rows,
    inventory: inventoryOf(run.entries),
    status: run.census.status,
    observedMs: run.census.observedMs,
    oracle: oracle === null ? "agrees" : { index: oracle.index, op: oracle.op, what: oracle.what },
    workerReplay: worker === null ? "agrees" : { index: worker.index, op: worker.op },
    seconds: Math.round(performance.now() - started) / 1000,
  };
  appendFileSync(
    join(values.out, `report-${shard}-of-${shards}.jsonl`),
    `${JSON.stringify(line)}\n`,
  );
  console.log(
    `${entry.family} ${entry.name}: ${run.outcome.kind}, ${run.entries.length} entries, oracle ${oracle === null ? "agrees" : "DIFFERS"}, worker ${worker === null ? "agrees" : "DIFFERS"}`,
  );
}
process.exit(disagreements === 0 ? 0 : 1);
