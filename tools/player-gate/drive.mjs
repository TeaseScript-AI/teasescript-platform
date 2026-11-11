// Runs one scenario of the L5 gate kit in one engine, for one build or an interleaved pair, and appends one JSON line
// per sample (docs/TESTING.md "The L5 activation gate kit").
//   PLAYWRIGHT_PACKAGE=<package.json> node tools/player-gate/drive.mjs --engine chromium|firefox|webkit|pixel
//     --scenario session|sessionInstrumented|aa|taps|bridge|bridgeTaps|keepHandler|keepCompletion|keepDurable|demo|keys
//     --build main=TREE[:PLAYER_APP] [--build worker=TREE[:PLAYER_APP]] --packages DIR [--bridge DIR --inputs DIR]
//     [--script NAME] [--route source|plan] [--samples N] [--commit main=SHA] --out FILE
// A pair's samples run in ABBA order in one browser. On the Pixel (PIXEL_SERIAL set, under the phone lock) each build's
// host is reached through `adb reverse` at http://localhost:<port>, and each sample records the battery. Exit 0 when
// every sample is ok, 1 when one is not, 2 when the kit cannot run; every host, reverse and browser it set up is
// released first, each even when another release fails.
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { classify } from "./cells.mjs";
import { adb, cannotRun, CannotRun, openEngine, phoneBattery } from "./lib/engines.mjs";
import { HOST_POLICY, startGateHost } from "./lib/host.mjs";
import { clearOrigin } from "./lib/cdp.mjs";
import { cdpSession } from "./lib/engines.mjs";
import { coldBytes, session } from "./scenarios/session.mjs";
import { releaser } from "./lib/release.mjs";
import { calibrate, tapsSample } from "./scenarios/taps.mjs";
import { bridge, bridgeUrl } from "./scenarios/bridge.mjs";
import { keep } from "./scenarios/keep.mjs";
import { demo } from "./scenarios/demo.mjs";
import { keys } from "./scenarios/keys.mjs";

const { values } = parseArgs({
  options: {
    engine: { type: "string" },
    scenario: { type: "string" },
    build: { type: "string", multiple: true },
    commit: { type: "string", multiple: true, default: [] },
    packages: { type: "string" },
    bridge: { type: "string" },
    inputs: { type: "string" },
    script: { type: "string" },
    route: { type: "string", default: "source" },
    samples: { type: "string", default: "3" },
    out: { type: "string" },
  },
});
const pairs = (list) =>
  Object.fromEntries(
    (list ?? []).map((entry) => [
      entry.slice(0, entry.indexOf("=")),
      entry.slice(entry.indexOf("=") + 1),
    ]),
  );
const builds = Object.entries(pairs(values.build)).map(([backend, spec]) => {
  const [tree, playerApp = null] = spec.split(":");
  return { backend, tree, playerApp };
});
const commits = pairs(values.commit);
if (!values.engine || !values.scenario || builds.length === 0 || !values.packages || !values.out) {
  console.error(
    "player-gate: cannot run: usage: drive.mjs --engine E --scenario S --build NAME=TREE --packages DIR --out FILE (see its header)",
  );
  process.exit(2);
}
const scenario = values.scenario;
const script =
  values.script ??
  (scenario === "demo" ? "demo" : scenario === "keys" ? "answer-flight" : "CelebWorship");
const samples = Number(values.samples);
const pixel = values.engine === "pixel";
// Every row names a declared cell: an undeclared value fails here, before any sample.
for (const build of builds)
  classify(
    { scenario, script, route: values.route, backend: build.backend, engine: values.engine },
    "r1",
  );

const hosts = [];
const reverses = [];
let opened = null;
let failures = 0;
// What the run owns, released once in order (`lib/release.mjs`); `opened` is read when it runs.
const run = {
  get opened() {
    return opened;
  },
  origins: [],
  reverses,
  hosts,
  removeReverse: (port) =>
    adb(opened?.serial ?? process.env.PIXEL_SERIAL, "reverse", "--remove", `tcp:${port}`),
};
const release = releaser(run);
const cleanup = async () => {
  for (const { step, error } of await release())
    console.error(`player-gate: releasing ${step} failed: ${error}`);
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(130));
  });

let exitCode = 0;
try {
  for (const build of builds) {
    const routes = {};
    if (values.bridge) routes["/gate-bridge/"] = values.bridge;
    if (values.inputs) routes["/gate-inputs/"] = values.inputs;
    const host = await startGateHost({
      tree: build.tree,
      packagesRoot: values.packages,
      playerApp: build.playerApp,
      routes,
    });
    hosts.push(host);
    if (pixel) {
      adb(
        process.env.PIXEL_SERIAL ?? cannotRun("PIXEL_SERIAL is not set"),
        "reverse",
        `tcp:${host.port}`,
        `tcp:${host.port}`,
      );
      reverses.push(host.port);
    }
    build.origin = pixel ? `http://localhost:${host.port}` : host.origin;
    if (pixel) run.origins.push(build.origin);
    build.commit = commits[build.backend] ?? gitHead(build.tree);
  }
  opened = await openEngine(values.engine);
  const reopen = async () => {
    await opened.close().catch(() => {});
    opened = await openEngine(values.engine);
    return opened;
  };
  const rectangles = new Map();
  for (let index = 0; index < samples; index += 1) {
    const order = builds.length === 2 && index % 2 === 1 ? [...builds].reverse() : builds;
    for (const build of order) {
      const cell = {
        scenario,
        script,
        route: values.route,
        backend: build.backend,
        engine: values.engine,
      };
      const battery = pixel ? phoneBattery(opened.serial) : null;
      let result;
      try {
        result = await runSample(build, cell, rectangles, reopen, index);
      } catch (error) {
        if (error instanceof CannotRun) throw error;
        result = { ok: false, error: String(error?.stack ?? error) };
      }
      if (!result.ok) failures += 1;
      const row = {
        ...cell,
        sample: index,
        build: build.playerApp ?? "dist/player-app",
        commit: build.commit,
        version: opened.version,
        battery,
        hostPolicy: HOST_POLICY,
        ok: result.ok === true,
        result,
      };
      appendFileSync(values.out, `${JSON.stringify(row)}\n`);
      console.log(
        `${scenario} ${script} ${build.backend} ${values.engine} #${index}: ${row.ok ? "ok" : `FAILED ${result.error ?? result.reason ?? result.outcome ?? ""}`.slice(0, 300)}`,
      );
    }
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

function gitHead(tree) {
  try {
    return execFileSync("git", ["-C", tree, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function runSample(build, cell, rectangles, reopen, index) {
  const origin = build.origin;
  switch (scenario) {
    case "session": {
      const result = await session({ opened, origin, script, backend: build.backend });
      // The served bytes, on their own cold page (the account pauses each Worker at its start). A request still open
      // after the page's window (a Worker's script whose completion CDP reported on no target, a race of attaching)
      // leaves the account incomplete: the page is loaded once more, cold, and the discarded attempt is kept.
      if (!opened.cdp) return result;
      const open = (bytes) =>
        bytes.requests.filter((request) => !request.finished && request.failed === null);
      let bytes = await coldBytes({ opened, origin, script });
      const discarded = [];
      if (open(bytes).length > 0) {
        discarded.push({
          open: open(bytes).map((request) => request.url),
          requests: bytes.requests,
        });
        bytes = await coldBytes({ opened, origin, script });
      }
      return { ...result, bytes: { ...bytes, discarded } };
    }
    case "sessionInstrumented":
      return session({ opened, origin, script, backend: build.backend, instrumented: true });
    case "aa": {
      // The A/A run: the full probe and the minimal one on the same build, in ABBA order, equal lifetimes.
      const probe = index % 4 === 0 || index % 4 === 3 ? "full" : "minimal";
      return session({ opened, origin, script, backend: build.backend, probe, aa: true });
    }
    case "taps":
    case "bridgeTaps": {
      const url =
        scenario === "taps"
          ? `${origin}/player/?package=${encodeURIComponent(script)}`
          : bridgeUrl(origin, cell, true);
      const key = `${build.backend} ${url}`;
      if (!rectangles.has(key)) rectangles.set(key, await calibrated(url));
      // The window the taps are counted in: the start page's load to Start enabled; `prepare`'s post to its reply.
      const until =
        scenario === "taps"
          ? (page) =>
              page
                .waitForFunction(
                  () => window.__gate?.states.some((state) => state.start?.enabled === true),
                  undefined,
                  { polling: "raf", timeout: 180_000 },
                )
                .then(() =>
                  page.evaluate(() => ({
                    fromMs: 0,
                    toMs: window.__gate.states.find((state) => state.start?.enabled === true).t,
                  })),
                )
          : async (page) => {
              // The bridge page defines `__gateRun` once its module has loaded, which is part of the window.
              await page.waitForFunction(() => typeof window.__gateRun === "function", undefined, {
                timeout: 180_000,
              });
              const result = await page.evaluate(() => window.__gateRun());
              const prepare = result.requests?.find((request) => request.op === "prepare");
              if (!result.ok || prepare?.replyAt == null)
                throw new Error(`the bridge page's prepare did not reply: ${result.error ?? ""}`);
              return { fromMs: prepare.postAt, toMs: prepare.replyAt };
            };
      return tapsSample({
        opened,
        url,
        rectangle: rectangles.get(key),
        until,
        before: async (page, cdp) => {
          if (pixel) await clearOrigin(cdp, new URL(origin).origin);
        },
      });
    }
    case "bridge":
      return bridge({ opened, origin, cell });
    case "keepHandler":
    case "keepCompletion":
    case "keepDurable":
      return keep({ opened, origin, script, trial: scenario, reopen });
    case "demo":
      return demo({ opened, origin });
    case "keys":
      return keys({ opened, origin });
    default:
      return cannotRun(`unknown scenario '${scenario}'`);
  }
}

/** The tap rectangle for `url`: its start page (or the bridge page) loaded once, without taps. */
async function calibrated(url) {
  const { page, close } = await opened.page({ touch: true });
  try {
    if (pixel) await clearOrigin(await cdpSession(opened, page), new URL(url).origin);
    await page.goto(url);
    if (url.includes("/player/"))
      await page.waitForSelector("[data-session-start]:not([disabled])", { timeout: 180_000 });
    return await calibrate(page);
  } finally {
    await close();
  }
}
