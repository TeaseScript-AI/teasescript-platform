// Replays the K/F tapes' pinned cover set in one browser, through both bridge backends (the gate's tape plan): each
// tape the census pins for the cohort (`census.mjs`, `cohorts.browser` or `cohorts.pixel`, by package and tape hash) is
// served to the bridge page's replay mode (`bridge/replay.mjs`), one fresh page per tape and backend, and every reply is
// compared with the one recorded in Node. Writes one JSON line per tape and backend.
//   PLAYWRIGHT_PACKAGE=<package.json> node tools/player-gate/tapes/browser.mjs --engine chromium|firefox|webkit|pixel
//     --bridge DIR --tapes DIR --census FILE --out FILE
// Run in a built tree (the gate host serves its playground). --bridge: the bridge page's build (`bridge/vite.config.mjs`);
// --tapes: the recorder's `tapes/` folder. On the Pixel (PIXEL_SERIAL set, under the phone lock) the host is reached
// through `adb reverse`. Exit 0 when every replay agrees, 1 when one differs or fails, 2 when it cannot run (a pinned
// tape missing or not its pinned hash among them); the host, reverse and browser are released first.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { adb, cannotRun, CannotRun, openEngine } from "../lib/engines.mjs";
import { startGateHost } from "../lib/host.mjs";
import { releaser } from "../lib/release.mjs";

const REPLAY_MS = 600_000;
const BACKENDS = [
  ["main", "inprocess"],
  ["worker", "worker"],
];

const { values } = parseArgs({
  options: {
    engine: { type: "string" },
    bridge: { type: "string" },
    tapes: { type: "string" },
    census: { type: "string" },
    out: { type: "string" },
  },
});
if (!values.engine || !values.bridge || !values.tapes || !values.census || !values.out) {
  console.error(
    "player-gate: cannot run: usage: browser.mjs --engine E --bridge DIR --tapes DIR --census FILE --out FILE",
  );
  process.exit(2);
}
const pixel = values.engine === "pixel";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const scratch = mkdtempSync(join(tmpdir(), "gate-tapes-"));
const served = join(scratch, "tapes");
const packagesRoot = join(scratch, "packages");
let opened = null;
const run = {
  get opened() {
    return opened;
  },
  origins: [],
  reverses: [],
  hosts: [],
  removeReverse: (port) =>
    adb(opened?.serial ?? process.env.PIXEL_SERIAL, "reverse", "--remove", `tcp:${port}`),
};
const release = releaser(run);
const cleanup = async () => {
  for (const { step, error } of await release())
    console.error(`player-gate: releasing ${step} failed: ${error}`);
  rmSync(scratch, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(130));
  });

let exitCode = 0;
try {
  // The pinned cover set: each tape read, checked against its pinned hash and served as plain JSON.
  const cohort = JSON.parse(readFileSync(values.census, "utf8")).cohorts?.[
    pixel ? "pixel" : "browser"
  ];
  if (!Array.isArray(cohort?.packages) || cohort.packages.length === 0)
    cannotRun(`the census pins no ${pixel ? "pixel" : "browser"} cover set`);
  mkdirSync(served, { recursive: true });
  mkdirSync(packagesRoot, { recursive: true });
  const tapes = cohort.packages.map((pin) => {
    const file = `${pin.family}-${pin.package}.json`;
    let text;
    try {
      text = gunzipSync(readFileSync(join(values.tapes, `${file}.gz`))).toString("utf8");
    } catch (error) {
      cannotRun(`the pinned tape ${file} cannot be read: ${error.message}`);
    }
    if (sha256(text) !== pin.tapeSha256)
      cannotRun(`the tape ${file} is not its pinned hash ${pin.tapeSha256}`);
    writeFileSync(join(served, file), text);
    return { ...pin, file };
  });

  const host = await startGateHost({
    tree: ".",
    packagesRoot,
    routes: { "/gate-bridge/": values.bridge, "/gate-tapes/": served },
  });
  run.hosts.push(host);
  let origin = host.origin;
  if (pixel) {
    adb(
      process.env.PIXEL_SERIAL ?? cannotRun("PIXEL_SERIAL is not set"),
      "reverse",
      `tcp:${host.port}`,
      `tcp:${host.port}`,
    );
    run.reverses.push(host.port);
    origin = `http://localhost:${host.port}`;
    run.origins.push(origin);
  }
  opened = await openEngine(values.engine);

  let failures = 0;
  for (const tape of tapes)
    for (const [backend, query] of BACKENDS) {
      let result;
      const { page, close } = await opened.page();
      try {
        await page.goto(
          `${origin}/gate-bridge/index.html?tape=${encodeURIComponent(tape.file)}&backend=${query}`,
        );
        await page.waitForFunction(() => window.__gateReplay?.done === true, undefined, {
          timeout: REPLAY_MS,
        });
        result = await page.evaluate(() => window.__gateReplay);
      } catch (error) {
        result = { error: String(error?.stack ?? error) };
      } finally {
        await close();
      }
      const agrees = result.error === null && result.difference === null;
      if (!agrees) failures += 1;
      const row = {
        engine: values.engine,
        version: opened.version,
        family: tape.family,
        package: tape.package,
        tapeSha256: tape.tapeSha256,
        backend,
        entries: result.entries ?? null,
        agrees,
        difference: result.difference ?? null,
        error: result.error ?? null,
      };
      appendFileSync(values.out, `${JSON.stringify(row)}\n`);
      console.log(
        `${tape.family} ${tape.package} ${backend} ${values.engine}: ${agrees ? "agrees" : row.error === null ? `DIFFERS at ${row.difference.index} (${row.difference.op})` : `FAILED ${row.error.slice(0, 300)}`}`,
      );
    }
  exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  if (!(error instanceof CannotRun)) throw error;
  console.error(`player-gate: cannot run: ${error.message}`);
  exitCode = 2;
} finally {
  await cleanup();
}
process.exit(exitCode);
