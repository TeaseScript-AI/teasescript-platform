import { mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { findChromium } from "./find-chromium.mjs";
import { prefillsScenario } from "./player-smoke/scenarios/prefills.mjs";
import { startSmokeServer } from "./player-smoke/server.mjs";
import {
  connectCdp,
  navigate,
  reservePort,
  setViewport,
  waitForTarget,
  withTimeout,
} from "./player-smoke/driver.mjs";
import {
  constrainedChoicesScenario,
  desktopScenario,
  narrowScenario,
  pointerScenario,
  replacedCheckpointScenario,
  selectPlayerExample,
} from "./player-smoke/scenarios/playground.mjs";
import {
  demoScenario,
  entrancesScenario,
  insecureOriginScenario,
  messageUpdatesScenario,
  packageScenario,
} from "./player-smoke/scenarios/conversation.mjs";
import {
  debugExportScenario,
  debugHistoryStorageScenario,
  keptSessionScenario,
  rewindScenario,
  savedDataExportScenario,
  savedDataImportScenario,
  scriptStorageScenario,
  sessionTransferScenario,
} from "./player-smoke/scenarios/storage.mjs";
import {
  cameraScenario,
  photoColourScenario,
  photoVignetteScenario,
  viewfinderScenario,
} from "./player-smoke/scenarios/media.mjs";
import {
  lockKeptScenario,
  lockScenario,
  passwordInterruptionScenario,
  passwordScenario,
  publicKeyScenario,
} from "./player-smoke/scenarios/lock.mjs";

const LAN_HOST = "player-lan.test";
await main();

async function main() {
  const chromium = await findChromium();
  if (chromium === null) {
    console.log("player-browser-smoke: SKIP Chromium executable not available");
    return;
  }

  const { server, address, origin } = await startSmokeServer();
  const debugPort = await reservePort();
  const profile = `/tmp/teasescript-player-chromium-${process.pid}`;
  await mkdir(profile, { recursive: true });
  const browser = spawn(chromium, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    // Two synthetic cameras that show the test card for the camera scenarios, like a phone's front and back cameras;
    // permissions are granted or denied per scenario through CDP.
    "--use-fake-device-for-media-stream=device-count=2",
    // A local-network name for the same server: plain HTTP there is not a secure context, unlike 127.0.0.1.
    `--host-resolver-rules=MAP ${LAN_HOST} 127.0.0.1`,
    `--remote-debugging-port=${debugPort}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profile}`,
    "about:blank",
  ]);
  const browserClosed = waitForBrowserClose(browser);

  let scenarioError;
  let scenarioFailed = false;
  let cleanupError;
  try {
    const target = await waitForTarget(debugPort);
    const cdp = await connectCdp(target.webSocketDebuggerUrl);
    try {
      await cdp.call("Page.enable");
      await cdp.call("Runtime.enable");
      // The scenarios in the order they run. `PLAYER_SMOKE_ONLY=photoColour,camera` runs only those named (each
      // scenario's name without "Scenario"; the technical playground's steps are `playground`), in this order, with
      // the ones they need: savedDataImport imports savedDataExport's file. Unset, everything runs.
      let exported;
      const scenarios = [
        [
          "playground",
          async () => {
            await navigate(cdp, `${origin}/`);
            await setViewport(cdp, 1440, 900);
            await selectPlayerExample(cdp);
            await pointerScenario(cdp);
            await selectPlayerExample(cdp);
            await desktopScenario(cdp);
            await constrainedChoicesScenario(cdp);
            await replacedCheckpointScenario(cdp);
            await setViewport(cdp, 390, 844);
            await selectPlayerExample(cdp);
            await narrowScenario(cdp);
          },
        ],
        ["scriptStorage", () => scriptStorageScenario(cdp, origin)],
        ["demo", () => demoScenario(cdp, origin)],
        ["insecureOrigin", () => insecureOriginScenario(cdp, `http://${LAN_HOST}:${address.port}`)],
        ["package", () => packageScenario(cdp, origin)],
        ["keptSession", () => keptSessionScenario(cdp, origin, profile)],
        [
          "savedDataExport",
          async () => {
            exported = await savedDataExportScenario(cdp, origin, profile);
          },
        ],
        ["savedDataImport", () => savedDataImportScenario(debugPort, origin, exported)],
        ["sessionTransfer", () => sessionTransferScenario(debugPort, origin, profile)],
        ["debugExport", () => debugExportScenario(cdp, origin, profile)],
        ["debugHistoryStorage", () => debugHistoryStorageScenario(cdp, origin)],
        ["rewind", () => rewindScenario(cdp, origin)],
        ["photoColour", () => photoColourScenario(cdp, origin, profile)],
        ["photoVignette", () => photoVignetteScenario(cdp, origin)],
        ["messageUpdates", () => messageUpdatesScenario(cdp, origin)],
        ["entrances", () => entrancesScenario(cdp, origin)],
        ["camera", () => cameraScenario(cdp, origin)],
        ["viewfinder", () => viewfinderScenario(cdp, origin)],
        ["lock", () => lockScenario(cdp, origin)],
        ["password", () => passwordScenario(cdp, origin)],
        ["passwordInterruption", () => passwordInterruptionScenario(cdp, origin)],
        ["lockKept", () => lockKeptScenario(cdp, origin)],
        ["publicKey", () => publicKeyScenario(cdp, origin, profile)],
        ["prefills", () => prefillsScenario(cdp, origin)],
      ];
      const named = (process.env.PLAYER_SMOKE_ONLY ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      const unknown = named.filter((name) => !scenarios.some(([known]) => known === name));
      if (unknown.length > 0)
        throw new Error(
          `PLAYER_SMOKE_ONLY names no scenario: ${unknown.join(", ")}. Known: ${scenarios.map(([name]) => name).join(", ")}`,
        );
      const needs = { savedDataImport: ["savedDataExport"] };
      const selected = new Set();
      const select = (name) => {
        for (const need of needs[name] ?? []) select(need);
        selected.add(name);
      };
      named.forEach(select);
      for (const [name, run] of scenarios)
        if (selected.size === 0 || selected.has(name)) await run();
      console.log(
        selected.size > 0
          ? `player-browser-smoke: PASS only ${[...selected].join(", ")}`
          : "player-browser-smoke: PASS technical playground, the repository demo on /player/ and over plain HTTP, packages opened by URL, script storage, a session kept across a reload, saved data exported and imported, a session exported and continued in another profile, the debug export after a script error, the rewind history's IndexedDB store, Back and Return in the Player, readable text on photo colours and the vignette, the reading position while messages change and enter, the camera, the camera view's controls on a phone, the lock dialogs, askPassword and the lock calls' password fields, also across blocks, a lock dialog kept across a reload, a public key's unlock request, and each question's prefill or typed text in the composer",
      );
    } finally {
      cdp.close();
    }
  } catch (error) {
    scenarioFailed = true;
    scenarioError = error;
  } finally {
    try {
      await terminateBrowser(browser, browserClosed);
      await new Promise((resolve) => server.close(resolve));
      // Chromium helper processes can finish profile writes just after the
      // main browser process closes. Node's bounded recursive retry handles
      // that transient ENOTEMPTY window without hiding persistent cleanup failures.
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (error) {
      cleanupError = error;
    }
  }
  if (scenarioFailed) throw scenarioError;
  if (cleanupError !== undefined) throw cleanupError;
}

function waitForBrowserClose(browser) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      browser.off("close", finish);
      browser.off("exit", finish);
      browser.off("error", finish);
      resolve();
    };

    browser.on("close", finish);
    browser.on("exit", finish);
    browser.on("error", finish);
    if (browser.exitCode !== null || browser.signalCode !== null) finish();
  });
}

async function terminateBrowser(browser, browserClosed) {
  if (browser.exitCode === null && browser.signalCode === null) browser.kill("SIGTERM");
  try {
    await withTimeout(browserClosed, 5_000, "Chromium did not exit after SIGTERM");
    return;
  } catch {
    if (browser.exitCode === null && browser.signalCode === null) browser.kill("SIGKILL");
  }
  await withTimeout(browserClosed, 5_000, "Chromium did not exit after SIGKILL");
}
