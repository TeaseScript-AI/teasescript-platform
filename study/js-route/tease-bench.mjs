// The scripted play of real Teases in Node, today's engine beside the three emitted forms (tease-play.mjs).
//   node study/js-route/tease-bench.mjs PLANS-DIR [--forms engine,replay,kept,resumable] [--ops 2000] [--replay-ops 200] [--rounds 3]
// PLANS-DIR holds NAME.plan.json files. Prints one JSON line per run; `same`: the digest equals today's engine's at the
// same number of answers. Replay is played to fewer answers: each of its drives runs the session again from the start,
// so its whole play grows with the square of its length; its last drive is one resume after a reload.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import * as api from "../../dist/src/index.js";
import * as driver from "./driver.mjs";
import { play, sessions } from "./tease-play.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const dir = args[0];
const forms = option("--forms", "engine,replay,kept,resumable").split(",");
const ops = Number(option("--ops", 2000));
const replayOps = Number(option("--replay-ops", 200));
const rounds = Number(option("--rounds", 3));
const kinds = sessions(api, driver);
const now = () => performance.now();
const round2 = (x) => Math.round(x * 100) / 100;

const teases = fs.readdirSync(dir).filter((f) => f.endsWith(".plan.json")).sort().map((f) => ({ name: f.slice(0, -".plan.json".length), plan: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }));
const expected = new Map();
for (const tease of teases)
  for (const cap of new Set([ops, replayOps])) {
    const kind = kinds.engine;
    const session = kind.create(tease.plan);
    expected.set(`${tease.name}/${cap}`, play(session, () => kind.state(session), cap, now).digest);
  }
for (let round = 0; round < rounds; round += 1)
  for (const tease of teases)
    for (let k = 0; k < forms.length; k += 1) {
      const form = forms[(k + round) % forms.length];
      const cap = form === "replay" ? replayOps : ops;
      const kind = kinds[form];
      const t0 = now();
      const session = kind.create(tease.plan);
      const createMs = now() - t0;
      const r = play(session, () => kind.state(session), cap, now);
      console.log(JSON.stringify({ tease: tease.name, form, round, createMs: round2(createMs), ms: round2(r.ms), maxDriveMs: round2(r.maxDriveMs), lastDriveMs: round2(r.lastDriveMs),
        drives: r.drives, operations: r.operations, status: r.status, waitingOn: r.waitingOn, failure: r.failure, largestSave: session.saveBytes ?? null, same: r.digest === expected.get(`${tease.name}/${cap}`) }));
    }
