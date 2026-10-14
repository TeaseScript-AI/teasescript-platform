import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, gunzipSync, inflateSync } from "node:zlib";
import Color from "colorjs.io";
import { createPlaygroundServer } from "../dist/playground/server.js";
import { findChromium } from "./find-chromium.mjs";

// An image request's preview on the Stage, once it shows.
const decodedPreview = `(() => { const image = document.querySelector('[data-stage-preview]'); return !!image && image.complete && image.naturalWidth > 0; })()`;
const capturedImages = `[...document.querySelectorAll('img')].filter((image) => image.src.startsWith('blob:') && image.complete && image.naturalWidth > 0).length`;
// A package the smoke serves only as a catalog: paths that model URIs built from the path alone would merge.
const MODEL_PATHS_CATALOG = {
  images: [],
  media: [],
  sources: [
    { path: "main.tease", source: 'goto "rooms/cellar.tease"\n' },
    { path: "rooms/cellar.tease", source: 'say "cellar"\nexit\n' },
    // Not a package path (TSC009), but the editor still opens it.
    { path: "rooms\\cellar.tease", source: 'say "backslash"\nexit\n' },
    { path: "C:/room.tease", source: 'say "upper"\nexit\n' },
    { path: "c:/room.tease", source: 'say "lower"\nexit\n' },
  ],
  problems: [],
};

const CATALOGS = new Map([["/dev-package/model-paths/catalog.json", MODEL_PATHS_CATALOG]]);

const LAN_HOST = "player-lan.test";
// The compiled spill store of Debug's rewind history, which the smoke runs against the browser's real IndexedDB.
const DEBUG_HISTORY_MODULE_URL = "/smoke/debug-history-indexeddb.js";

await main();

async function main() {
  const chromium = await findChromium();
  if (chromium === null) {
    console.log("player-browser-smoke: SKIP Chromium executable not available");
    return;
  }

  // house compiles and starts at its main.tease; broken does not compile.
  const server = createPlaygroundServer({
    packagesRoot: fileURLToPath(new URL("../tests/fixtures/packages/", import.meta.url)),
  });
  // The model-paths package exists only as a catalog, so the smoke needs no file named with `\` or `C:` on disk.
  const [handleRequest] = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    // The spill store's module and the compiled Player modules it imports.
    const smokeModule = /^\/smoke\/([a-z-]+\.js)$/u.exec(request.url ?? "");
    if (smokeModule !== null) {
      void readFile(new URL(`../dist/player/${smokeModule[1]}`, import.meta.url)).then(
        (module) => {
          response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          response.end(module);
        },
        () => {
          response.writeHead(404);
          response.end();
        },
      );
      return;
    }
    const catalog = CATALOGS.get(request.url);
    if (catalog === undefined) return handleRequest(request, response);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(catalog));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("No server address.");
  const origin = `http://127.0.0.1:${address.port}`;
  const debugPort = await reservePort();
  const profile = `/tmp/teasescript-player-chromium-${process.pid}`;
  await mkdir(profile, { recursive: true });
  const browser = spawn(chromium, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    // A synthetic camera that shows the test card for the camera scenarios; permissions are granted or denied per
    // scenario through CDP.
    "--use-fake-device-for-media-stream",
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
        ["debugExport", () => debugExportScenario(cdp, origin, profile)],
        ["debugHistoryStorage", () => debugHistoryStorageScenario(cdp, origin)],
        ["photoColour", () => photoColourScenario(cdp, origin, profile)],
        ["photoVignette", () => photoVignetteScenario(cdp, origin)],
        ["messageUpdates", () => messageUpdatesScenario(cdp, origin)],
        ["entrances", () => entrancesScenario(cdp, origin)],
        ["camera", () => cameraScenario(cdp, origin)],
        ["viewfinder", () => viewfinderScenario(cdp, origin)],
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
          : "player-browser-smoke: PASS technical playground, the repository demo on /player/ and over plain HTTP, packages opened by URL, script storage, a session kept across a reload, saved data exported and imported, the debug export after a script error, the rewind history's IndexedDB store, readable text on photo colours and the vignette, the reading position while messages change and enter, the camera, and the camera view's mirror button on a phone",
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

async function desktopScenario(cdp) {
  await click(cdp, "#run");
  await waitFor(cdp, `document.querySelector('#runtime-status')?.textContent === 'waiting'`);
  const firstGate = await value(
    cdp,
    `JSON.parse(document.querySelector('#runtime-state').textContent).foregroundAction.actionId`,
  );

  await evaluate(
    cdp,
    `document.querySelector('#composer-input').dispatchEvent(new PointerEvent('pointerup', {bubbles:true, button:0, isPrimary:true, pointerType:'mouse'}))`,
  );
  assertEqual(
    await activeActionId(cdp),
    firstGate,
    "interactive composer click must not skip pacing",
  );
  await evaluate(
    cdp,
    `document.querySelector('#player-panel').dispatchEvent(new PointerEvent('pointerup', {bubbles:true, button:1, isPrimary:true}))`,
  );
  assertEqual(await activeActionId(cdp), firstGate, "non-primary pointer must not skip pacing");
  await evaluate(
    cdp,
    `const input=document.querySelector('#composer-input'); input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', {key:' ', bubbles:true, isComposing:true}))`,
  );
  assertEqual(await activeActionId(cdp), firstGate, "IME composition must not skip pacing");
  await evaluate(
    cdp,
    `const input=document.querySelector('#composer-input'); input.value='x'; input.setSelectionRange(0, 1); input.dispatchEvent(new KeyboardEvent('keydown', {key:' ', bubbles:true}))`,
  );
  assertEqual(
    await activeActionId(cdp),
    firstGate,
    "nonempty selected composer text must not skip pacing",
  );
  await evaluate(cdp, `document.querySelector('#composer-input').value=''`);
  await evaluate(cdp, `document.querySelector('#composer-input').focus()`);
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" });
  await waitForNextPacingGate(cdp, firstGate);
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" });
  await waitFor(
    cdp,
    `document.querySelector('#interaction-controls button')?.textContent === 'Continue'`,
  );

  const showButtonId = await activeActionId(cdp);
  await evaluate(
    cdp,
    `const input=document.querySelector('#composer-input'); input.value=''; input.dispatchEvent(new Event('input', {bubbles:true})); input.focus()`,
  );
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" });
  assertEqual(
    await activeActionId(cdp),
    showButtonId,
    "empty-composer Space must not complete showButton",
  );

  const transcriptBeforeButton = await transcriptTexts(cdp);
  await click(cdp, "#interaction-controls button");
  await waitFor(
    cdp,
    `document.querySelector('#composer-input')?.getAttribute('aria-label') === 'Answer' && document.querySelector('#composer-input')?.placeholder === 'Your name'`,
  );
  assertEqual(
    (await transcriptTexts(cdp)).length,
    transcriptBeforeButton.length + 1,
    "button activation must produce exactly one engine transcript message",
  );

  await typeAndSubmit(cdp, "   ");
  await waitFor(
    cdp,
    `document.querySelector('#interaction-feedback')?.textContent.includes('non-whitespace')`,
  );
  assertEqual(
    await value(cdp, `document.querySelector('#composer-input').getAttribute('aria-invalid')`),
    "true",
    "rejection must be associated with the composer",
  );
  await typeAndSubmit(cdp, "Alex");
  await waitFor(
    cdp,
    `document.querySelector('#composer-input')?.getAttribute('aria-label') === 'Number' && document.querySelector('#composer-input')?.placeholder === 'A number'`,
  );
  await typeAndSubmit(cdp, "not a number");
  await waitFor(
    cdp,
    `document.querySelector('#interaction-feedback')?.textContent.includes('decimal')`,
  );
  await typeAndSubmit(cdp, "12.5");
  await waitFor(
    cdp,
    `document.querySelector('.choice-buttons button')?.textContent === 'First option'`,
  );

  assertEqual(await value(cdp, visible(".choice-buttons")), true, "desktop choices show buttons");
  assertEqual(await value(cdp, visible(".choice-select")), false, "desktop dropdown stays hidden");
  await click(cdp, "#save-checkpoint");
  const choiceId = await activeActionId(cdp);
  const transcriptBeforeRestore = await transcriptTexts(cdp);
  await typeAndSubmit(cdp, "Second option");
  await waitFor(cdp, `document.querySelector('#runtime-status')?.textContent === 'halted'`);
  await click(cdp, "#restore-checkpoint");
  assertEqual(
    await activeActionId(cdp),
    choiceId,
    "restore must reconstruct the same active choice",
  );
  assertEqual(
    JSON.stringify(await transcriptTexts(cdp)),
    JSON.stringify(transcriptBeforeRestore),
    "restore must not duplicate transcript",
  );
  await click(cdp, ".choice-buttons button:nth-child(2)");
  await waitFor(cdp, `document.querySelector('#runtime-status')?.textContent === 'halted'`);
  const transcript = await transcriptTexts(cdp);
  for (const expected of ["Continue", "Alex", "12.5", "Second option"]) {
    if (!transcript.includes(expected))
      throw new Error(`Missing canonical transcript text: ${expected}`);
  }
  if (documentTextIncludes(transcript, "Action requested")) {
    throw new Error("Technical action events entered the Player transcript.");
  }
}

async function pointerScenario(cdp) {
  await click(cdp, "#run");
  await waitFor(cdp, `document.querySelector('#runtime-status')?.textContent === 'waiting'`);
  const firstGate = await activeActionId(cdp);
  const drag = await value(
    cdp,
    `(() => {
      const item = document.querySelector('#transcript li');
      const text = [...item.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0);
      const range = document.createRange();
      range.selectNodeContents(text);
      // Drag along the first rendered line; a wrapped message's bounding box also covers the gap between lines.
      const rect = range.getClientRects()[0];
      return {startX: rect.left + 2, endX: rect.right - 2, y: rect.top + rect.height / 2};
    })()`,
  );
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: drag.startX, y: drag.y });
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: drag.startX,
    y: drag.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: drag.endX,
    y: drag.y,
    button: "left",
  });
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: drag.endX,
    y: drag.y,
    button: "left",
    clickCount: 1,
  });
  assertEqual(
    await value(cdp, `document.getSelection().toString().trim().length > 0`),
    true,
    "mouse drag must select transcript text",
  );
  assertEqual(
    await activeActionId(cdp),
    firstGate,
    "selecting transcript text must not skip pacing",
  );
  await evaluate(cdp, `document.getSelection().removeAllRanges()`);
  const pressPlayerSpace = `document.querySelector('#player-panel').dispatchEvent(new PointerEvent('pointerup', {bubbles:true, button:0, isPrimary:true, pointerType:'mouse'}))`;
  await evaluate(cdp, pressPlayerSpace);
  // The second message holds the script for its reading time too, and the playground has no clock.
  await waitForNextPacingGate(cdp, firstGate);
  await evaluate(cdp, pressPlayerSpace);
  await waitFor(
    cdp,
    `document.querySelector('#interaction-controls button')?.textContent === 'Continue'`,
  );
}

async function constrainedChoicesScenario(cdp) {
  const options = Array.from(
    { length: 12 },
    (_, index) =>
      `c${index}: "Option ${index + 1}: select this alternative for the next part of the story"`,
  ).join(", ");
  await replaceSourceAndRun(cdp, `let answer = askChoice ${options}\nexit`);
  await waitFor(cdp, `document.querySelector('.choice-select option:nth-child(13)') !== null`);
  assertEqual(
    await value(cdp, visible(".choice-buttons")),
    false,
    "overflowing desktop choices hide buttons",
  );
  assertEqual(
    await value(cdp, visible(".choice-select")),
    true,
    "overflowing desktop choices use dropdown",
  );
  assertEqual(
    await value(
      cdp,
      `document.querySelector('#composer-help').getBoundingClientRect().bottom <= document.querySelector('#player-panel').getBoundingClientRect().bottom`,
    ),
    true,
    "choice controls and composer must remain inside the Player panel",
  );
}

async function replacedCheckpointScenario(cdp) {
  await replaceSourceAndRun(
    cdp,
    'say "First", instant\nshowButton "A"\nsay "Second", instant\nshowButton "B"\nexit',
  );
  await waitFor(cdp, `document.querySelector('#interaction-controls button')?.textContent === 'A'`);
  await click(cdp, "#save-checkpoint");
  const earlierCheckpoint = await value(
    cdp,
    `(() => { const key = Object.keys(localStorage).find((value) => value.includes('checkpoint')); return {key, serialized: localStorage.getItem(key)}; })()`,
  );
  await click(cdp, "#interaction-controls button");
  await waitFor(cdp, `document.querySelector('#interaction-controls button')?.textContent === 'B'`);
  await click(cdp, "#save-checkpoint");
  await evaluate(
    cdp,
    `localStorage.setItem(${JSON.stringify(earlierCheckpoint.key)}, ${JSON.stringify(earlierCheckpoint.serialized)})`,
  );
  await click(cdp, "#restore-checkpoint");
  assertEqual(
    await value(cdp, `document.querySelector('#interaction-controls button')?.textContent`),
    "A",
    "restore must use the replaced checkpoint snapshot",
  );
  assertEqual(
    JSON.stringify(await transcriptTexts(cdp)),
    "[]",
    "restore must discard transcript cached for a different checkpoint value",
  );
  await click(cdp, "#interaction-controls button");
  await waitFor(cdp, `document.querySelector('#interaction-controls button')?.textContent === 'B'`);
  assertEqual(
    JSON.stringify(await transcriptTexts(cdp)),
    JSON.stringify(["A", "Second"]),
    "continuing a replaced checkpoint must not duplicate stale transcript",
  );
}

async function narrowScenario(cdp) {
  await click(cdp, "#run");
  await waitFor(cdp, `document.querySelector('#runtime-status')?.textContent === 'waiting'`);
  const firstGate = await activeActionId(cdp);
  const touchPlayerSpace = `document.querySelector('#player-panel').dispatchEvent(new PointerEvent('pointerup', {bubbles:true, button:0, isPrimary:true, pointerType:'touch'}))`;
  await evaluate(cdp, touchPlayerSpace);
  await waitForNextPacingGate(cdp, firstGate);
  await evaluate(cdp, touchPlayerSpace);
  await waitFor(
    cdp,
    `document.querySelector('#interaction-controls button')?.textContent === 'Continue'`,
  );
  await click(cdp, "#interaction-controls button");
  await typeAndSubmit(cdp, "Narrow");
  await typeAndSubmit(cdp, "7");
  await waitFor(
    cdp,
    `document.querySelector('.choice-select option:nth-child(2)')?.textContent === 'First option'`,
  );
  assertEqual(await value(cdp, visible(".choice-buttons")), false, "narrow choices hide buttons");
  assertEqual(await value(cdp, visible(".choice-select")), true, "narrow choices use dropdown");
  await evaluate(
    cdp,
    `const select=document.querySelector('.choice-select'); select.value='1'; select.dispatchEvent(new Event('change', {bubbles:true}))`,
  );
  await waitFor(cdp, `document.querySelector('#runtime-status')?.textContent === 'halted'`);
}

async function scriptStorageScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  const start = "[data-session-activation] button";
  const messages = `[...document.querySelectorAll('.transcript-entry')].map((entry) => entry.textContent)`;
  const openSettings = async () => {
    await physicalClick(cdp, "[data-settings-trigger]");
    await waitFor(cdp, `!!document.querySelector('[data-player-settings]')`);
    await waitFor(cdp, `!!document.querySelector('[data-clear-saved-data]')`);
  };
  // A new visit to the demo, which starts a new session.
  const reloadBeforeStart = async () => {
    await navigate(cdp, `${origin}/player/`);
    await waitFor(
      cdp,
      `!!document.querySelector('${start}') && !document.querySelector('[data-player-settings]')`,
    );
  };
  const clearBeforeStart = async () => {
    await openSettings();
    await waitFor(
      cdp,
      `document.querySelector('[data-clear-saved-data]')?.disabled === false`,
      15_000,
      "Saved data can be cleared before Start after the provider has loaded",
    );
    await physicalClick(cdp, "[data-clear-saved-data]");
    await waitFor(cdp, `!!document.querySelector('[data-clear-saved-data-confirm]')`);
    await physicalClick(cdp, "[data-clear-saved-data-confirm]");
    await waitFor(
      cdp,
      `document.querySelector('[data-player-setting="saved-data"]')?.textContent.includes('Saved script data cleared.')`,
    );
  };

  // This is the first demo run in main's fresh Chromium profile.
  await navigate(cdp, `${origin}/player/`);
  await waitFor(cdp, `!!document.querySelector('${start}')`);
  await physicalClick(cdp, start);
  // Reach the introductory Session message, after the returning-visit branch, so its absence is conclusive.
  await waitFor(
    cdp,
    `${messages}.some((text) => text.includes('Some of her messages make you wait.'))`,
    15_000,
  );
  assertEqual(
    await value(cdp, `${messages}.some((text) => text.includes('Back again'))`),
    false,
    "The first visit has no returning-visit message",
  );

  await reloadBeforeStart();
  await physicalClick(cdp, start);
  await waitFor(
    cdp,
    `${messages}.some((text) => text.includes('Back again. Visit 2.'))`,
    15_000,
    "Reloading after the first visible demo message must show Back again. Visit 2.",
  );
  await openSettings();
  assertEqual(
    await value(cdp, `document.querySelector('[data-clear-saved-data]').disabled`),
    true,
    "Saved data cannot be cleared while the session runs",
  );

  await reloadBeforeStart();
  await clearBeforeStart();
  // Clearing publishes an empty generation and removes the values saved before it, in real browser storage.
  assertEqual(
    await value(
      cdp,
      `(() => {
        const names = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
        const head = localStorage.getItem('player-storage-head:"repository-demo"') !== null;
        const values = names.filter((name) => name.includes('"repository-demo"') && !name.startsWith('player-storage-head:') && !name.startsWith('player-storage-name:'));
        return head + ' head, ' + values.length + ' values';
      })()`,
    ),
    "true head, 0 values",
    "Clearing leaves only the scope's empty head",
  );
  await reloadBeforeStart();
  await physicalClick(cdp, start);
  // Reach the introductory Session message so an absent returning-visit line is conclusive.
  await waitFor(
    cdp,
    `${messages}.some((text) => text.includes('Some of her messages make you wait.'))`,
    15_000,
  );
  assertEqual(
    await value(cdp, `${messages}.some((text) => text.includes('Back again'))`),
    false,
    "Clearing saved data resets the demo's visit count",
  );
  // Saves after the clear persist in the published generation and load fresh after a reload.
  await reloadBeforeStart();
  await physicalClick(cdp, start);
  await waitFor(
    cdp,
    `${messages}.some((text) => text.includes('Back again. Visit 2.'))`,
    15_000,
    "A save after clearing must load after a reload",
  );

  // Leave the existing end-to-end demo scenario with its original first-visit state.
  await reloadBeforeStart();
  await clearBeforeStart();
  await reloadBeforeStart();

  // A denied read makes the next run session-local and disables clearing even before Start.
  const deniedStorage = await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `Object.defineProperty(Storage.prototype, 'length', {
      get() { throw new Error('Storage denied for smoke'); }
    });`,
  });
  try {
    await reloadBeforeStart();
    await openSettings();
    assertEqual(
      await value(cdp, `document.querySelector('[data-clear-saved-data]').disabled`),
      true,
      "Saved data cannot be cleared when storage is session-local",
    );
    await physicalClick(cdp, '[data-player-settings] [data-slot="dialog-close"]');
    await waitFor(cdp, `!document.querySelector('[data-player-settings]')`);
    await physicalClick(cdp, start);
    await waitFor(cdp, `${messages}.some((text) => text.includes('Eyes on me.'))`);
  } finally {
    await cdp.call("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: deniedStorage.result.identifier,
    });
  }
  await reloadBeforeStart();
  assertEqual(
    await value(
      cdp,
      `(() => { try { return localStorage.length >= 0; } catch { return false; } })()`,
    ),
    true,
    "Browser storage is usable again before the next scenario",
  );
}

// Plays the repository demo on the maintained /player/ route of the built Player with trusted input, so the Start
// click is the user activation its audio relies on. Checks rely on the demo's authored text and timer labels.
// The Player also runs over plain HTTP on a local network, where browsers withhold secure-context APIs such as
// crypto.randomUUID; it must still start and play.
async function insecureOriginScenario(cdp, origin) {
  await navigate(cdp, `${origin}/player/`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  assertEqual(
    await value(cdp, `window.isSecureContext`),
    false,
    "The local-network origin is secure",
  );
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(
    cdp,
    `document.querySelectorAll('.transcript-entry').length > 0`,
    8_000,
    "The Player did not start over plain HTTP",
  );
}

async function demoScenario(cdp, origin) {
  const {
    result: { identifier },
  } = await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__played = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (!window.__played.includes(this)) window.__played.push(this);
        return play.call(this);
      };
      window.__errors = [];
      const error = console.error;
      console.error = (...args) => {
        window.__errors.push(args.map(String).join(' '));
        error.apply(console, args);
      };
      // Chromium reports a ResizeObserver whose callback changed layout again in the same frame as an error event; the
      // remaining notifications arrive in the next frame, so it is no failure.
      addEventListener('error', (event) => {
        if (!String(event.message).startsWith('ResizeObserver loop')) window.__errors.push(String(event.message));
      });
      addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));`,
  });
  await setViewport(cdp, 1440, 900);
  await navigate(cdp, `${origin}/player/`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  assertEqual(
    await value(cdp, `document.querySelectorAll('.transcript-entry').length`),
    0,
    "The demo ran before Start",
  );
  await physicalClick(cdp, "[data-session-activation] button");

  const stageSources = [];
  let inputOwnershipChecked = false;
  let spaceSkipChecked = false;
  let spaceButtonChecked = false;
  let smartFollowChecked = false;
  const texts = new Set();
  const audio = [];
  let finished = false;
  const deadline = Date.now() + 120_000;
  while (!finished) {
    if (Date.now() > deadline) throw new Error("The demo did not reach Finish in time");
    const state = await value(
      cdp,
      `(() => {
        const input = document.querySelector('[data-composer-input]');
        const entries = [...document.querySelectorAll('.transcript-entry')];
        // An image counts only once it decoded and occupies layout space.
        const rendered = (image) => !!image && image.complete && image.naturalWidth > 0 && image.getBoundingClientRect().width > 0;
        return {
          stage: rendered(document.querySelector('.stage-media')) ? document.querySelector('.stage-media').getAttribute('src') : null,
          audio: window.__played.map((element) => ({ time: element.currentTime, audible: !element.muted && element.volume > 0 })),
          texts: entries.map((element) => element.textContent),
          buttons: [...document.querySelectorAll('[data-foreground-controls] button')].map((button) => button.textContent.trim()),
          placeholder: input && !input.disabled ? input.placeholder : null,
        };
      })()`,
    );
    if (state.stage !== null && stageSources.at(-1) !== state.stage) stageSources.push(state.stage);
    for (const text of state.texts) texts.add(text);
    state.audio.forEach(({ time, audible }, index) => {
      if (audible && time > (audio[index] ?? 0)) audio[index] = time;
    });

    if (state.buttons.includes("Stand at attention")) {
      await physicalClick(cdp, "[data-foreground-controls] button:last-of-type");
    } else if (
      !inputOwnershipChecked &&
      state.placeholder !== null &&
      state.texts.some((text) => text.includes("Some of her messages make you wait."))
    ) {
      // The first skippable message: its pacing is still pending while the composer is enabled.
      inputOwnershipChecked = true;
      await pacingInputOwnershipCheck(cdp);
    } else if (
      !spaceSkipChecked &&
      state.placeholder !== null &&
      state.texts.some((text) => text.includes("Twenty seconds less. Don't thank me yet."))
    ) {
      spaceSkipChecked = true;
      await spaceSkipCheck(cdp);
    } else if (
      !smartFollowChecked &&
      state.texts.some((text) => text.includes("You hold still until that clock runs out.")) &&
      !state.texts.some((text) => text.includes("The other one is mine."))
    ) {
      // The next two messages arrive on their own pacing, one after the other.
      smartFollowChecked = true;
      await smartFollowCheck(cdp);
    } else if (!spaceButtonChecked && state.buttons.length === 1 && state.buttons[0] !== "Finish") {
      spaceButtonChecked = true;
      await spaceButtonCheck(cdp);
    } else if (state.buttons.length === 1) {
      finished = state.buttons[0] === "Finish";
      await physicalClick(cdp, "[data-foreground-controls] button");
    } else if (state.placeholder === "What you call her") {
      await focusSeen(cdp, `document.querySelector('[data-composer-input]')`);
      await cdp.call("Input.insertText", { text: "Mistress" });
      await physicalClick(cdp, ".composer-send");
    } else if (state.placeholder !== null) {
      // A skippable pacing gate: Space in the empty composer hurries the message along.
      await focusSeen(cdp, `document.querySelector('[data-composer-input]')`);
      await pressSpace(cdp);
    }
    await delay(150);
  }

  // Finish completes the last interaction and the script exits: no control remains and input is disabled.
  await waitFor(
    cdp,
    `!document.querySelector('[data-foreground-controls] button') && document.querySelector('[data-composer-input]')?.disabled === true`,
  );
  await waitFor(cdp, `!document.querySelector('.stage-media')`);
  assertEqual(
    inputOwnershipChecked && spaceSkipChecked && spaceButtonChecked,
    true,
    "The pacing and Space checks ran",
  );
  assertEqual(smartFollowChecked, true, "The smart follow check ran");
  assertEqual(stageSources.length, 2, "Stage images shown before hideImage");
  if (!stageSources.every((source) => source.startsWith("data:image/svg+xml"))) {
    throw new Error(`The Stage did not show the demo's package images: ${stageSources.join(", ")}`);
  }
  if (audio.length !== 2 || !audio.every((time) => time > 0.2)) {
    throw new Error(`Both demo sounds must actually play audibly: ${JSON.stringify(audio)}`);
  }
  for (const text of [
    "Mistress. Good. Don't forget it.",
    "When you hear that bell, you listen.",
    "Good. That's enough for your first lesson.",
  ]) {
    if (![...texts].some((entry) => entry.includes(text)))
      throw new Error(`Missing message: ${text}`);
  }

  assertEqual(
    JSON.stringify(await value(cdp, `window.__errors`)),
    "[]",
    "The demo reported errors in the console",
  );
  await cdp.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
}

/** The latest message in the conversation. */
function latestMessage() {
  return `[...document.querySelectorAll('[data-slot=bubble], .prose')].at(-1)`;
}

// A skippable message's pacing settles from a primary press on a message or unused Player space, or from Space in the
// empty composer. A Player control and Space while the composer holds text keep their own behavior. It runs as the
// demo's session message starts its 7.8 s default pacing, so within it only a skip shows the next one.
async function pacingInputOwnershipCheck(cdp) {
  const messageCount = `Number(document.querySelector('.transcript-entry')?.getAttribute('aria-setsize') ?? 0)`;
  const gate = await value(cdp, messageCount);
  const unchanged = async (message) => {
    await delay(400);
    assertEqual(await value(cdp, messageCount), gate, message);
  };
  const theme = `document.documentElement.dataset.playerTheme`;
  const initialTheme = await value(cdp, theme);
  await physicalClick(cdp, "[data-theme-mode-control]");
  await waitFor(cdp, `${theme} !== ${JSON.stringify(initialTheme)}`);
  await unchanged("Activating a Player control also skipped the message's pacing");
  await physicalClick(cdp, "[data-theme-mode-control]");
  await waitFor(cdp, `${theme} === ${JSON.stringify(initialTheme)}`);
  const input = `document.querySelector('[data-composer-input]')`;
  await focusSeen(cdp, input);
  await cdp.call("Input.insertText", { text: "x" });
  await pressSpace(cdp);
  await unchanged("Space in a composer holding text skipped pacing");
  assertEqual(await value(cdp, `${input}.value`), "x ", "Space in the composer must type a space");
  await typeInto(cdp, "[data-composer-input]", "");
  await physicalClickOn(cdp, latestMessage(), "the latest message");
  await waitFor(
    cdp,
    `${messageCount} > ${gate}`,
    1_000,
    "A press on a message did not skip pacing",
  );
}

// Space in the empty composer presses the showButton, which is preselected.
async function spaceButtonCheck(cdp) {
  await focusSeen(cdp, `document.querySelector('[data-composer-input]')`);
  await pressSpace(cdp);
  await waitFor(
    cdp,
    `!document.querySelector('[data-foreground-controls] button')`,
    1_000,
    "Space in the empty composer did not press the showButton",
  );
}

// It runs as a message starts its 3.6 s default pacing: Space in the empty composer shows the next message at once.
async function spaceSkipCheck(cdp) {
  const messageCount = `Number(document.querySelector('.transcript-entry')?.getAttribute('aria-setsize') ?? 0)`;
  const gate = await value(cdp, messageCount);
  await focusSeen(cdp, `document.querySelector('[data-composer-input]')`);
  await pressSpace(cdp);
  await waitFor(
    cdp,
    `${messageCount} > ${gate}`,
    1_000,
    "Space in the empty composer did not skip pacing",
  );
}

// Smart follow with the demo's own paced messages: a reader who scrolled up stays in place while the next message
// arrives, and Return to latest resumes following, so the conversation follows the message after that.
async function smartFollowCheck(cdp) {
  const count = `Number(document.querySelector('.transcript-entry')?.getAttribute('aria-setsize') ?? 0)`;
  const viewport = `document.querySelector('.transcript-scroll').getBoundingClientRect()`;
  // The entry at the top edge of the transcript (or a given one) and its distance from that edge.
  const anchor = (index) =>
    value(
      cdp,
      `(() => {
        const top = ${viewport}.top;
        const entries = [...document.querySelectorAll('.transcript-entry')];
        const entry = ${index === undefined ? "entries.find((element) => element.getBoundingClientRect().bottom > top + 1)" : `entries.find((element) => element.dataset.index === ${JSON.stringify(index)})`};
        return entry ? { index: entry.dataset.index, offset: entry.getBoundingClientRect().top - top } : null;
      })()`,
    );
  // A scroll correction lands within a few rendered frames of an append.
  const frames = () =>
    evaluate(
      cdp,
      `return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))`,
    );
  // Let the message that just arrived finish measuring and following, so Page Up is the last scroll input.
  await waitFor(
    cdp,
    `(() => { const element = document.querySelector('.transcript-scroll'); return element.scrollHeight - element.clientHeight - element.scrollTop <= 2; })()`,
  );
  await frames();
  // Page Up in the focused transcript: the reader leaves the latest message.
  await focusSeen(cdp, `document.querySelector('.transcript-scroll')`);
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.call("Input.dispatchKeyEvent", {
      type,
      key: "PageUp",
      code: "PageUp",
      windowsVirtualKeyCode: 33,
    });
  }
  // The control appears once the reader is away from the latest message and scrolling has settled.
  await waitFor(
    cdp,
    `!!document.querySelector('.return-to-latest')`,
    8_000,
    "Scrolling up did not leave the latest message: Return to latest never appeared",
  );
  const before = await value(cdp, count);
  const held = await anchor();
  if (held === null) throw new Error("No transcript entry is visible after scrolling up");
  await waitFor(cdp, `${count} > ${before}`, 15_000, "No demo message arrived while scrolled up");
  await frames();
  const after = await anchor(held.index);
  if (after === null || Math.abs(after.offset - held.offset) > 2) {
    throw new Error(`A new message moved a scrolled-up reader: ${JSON.stringify({ held, after })}`);
  }

  await physicalClick(cdp, ".return-to-latest");
  // The control hides once the latest message is reached.
  await waitFor(
    cdp,
    `!document.querySelector('.return-to-latest')`,
    8_000,
    "Return to latest did not reach the latest message",
  );
  const resumed = await value(cdp, count);
  await waitFor(
    cdp,
    `${count} > ${resumed}`,
    15_000,
    "No demo message arrived after Return to latest",
  );
  await waitFor(
    cdp,
    `(() => { const element = document.querySelector('.transcript-scroll'); return element.scrollHeight - element.clientHeight - element.scrollTop <= 2; })()`,
    2_000,
    "After Return to latest, the conversation did not follow the next message",
  );
}

/**
 * Where a person presses the element `expression` evaluates to: its centre once it is visible, enabled and still (its
 * box unchanged over two frames), within two seconds, scrolled into view first if it is not.
 */
async function pressPoint(cdp, expression, what = expression) {
  const point = await evaluate(
    cdp,
    `return new Promise((resolve) => {
      const deadline = performance.now() + 2_000;
      let [last, still] = [null, 0];
      const check = () => {
        const element = ${expression};
        const ready = !!element?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
          !element.matches(':disabled');
        if (ready) element.scrollIntoViewIfNeeded(true);
        const box = ready ? element.getBoundingClientRect() : null;
        const place = box && [box.left, box.top, box.width, box.height].join();
        still = place && place === last ? still + 1 : 0;
        last = place;
        if (still >= 2) return resolve({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
        if (performance.now() < deadline) return requestAnimationFrame(check);
        resolve(null);
      };
      requestAnimationFrame(check);
    })`,
  );
  if (point === null) throw new Error(`${what} is not visible and enabled`);
  return point;
}

/** A physical click at the centre of the element `expression` evaluates to. */
async function physicalClickOn(cdp, expression, what = expression) {
  const point = await pressPoint(cdp, expression, what);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.call("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
  }
}

// A physical click at the centre of the element `selector` matches.
function physicalClick(cdp, selector) {
  return physicalClickOn(cdp, `document.querySelector(${JSON.stringify(selector)})`, selector);
}

/** A physical click on the button whose text is `label`, among the elements `scope` matches. */
function clickLabelled(cdp, label, scope = "button") {
  return physicalClickOn(
    cdp,
    `[...document.querySelectorAll(${JSON.stringify(scope)})].find((element) => element.textContent.trim() === ${JSON.stringify(label)})`,
    `the "${label}" button`,
  );
}

// Keyboard focus on the element `expression` evaluates to, once it is visible and enabled, without a press, which
// would act (a press on the conversation skips pacing).
async function focusSeen(cdp, expression, options = {}) {
  await pressPoint(cdp, expression);
  await evaluate(cdp, `(${expression}).focus(${JSON.stringify(options)})`);
}

/** A real key press, down and up: a named key such as `Backspace`, with optional editing commands. */
async function key(cdp, name, { modifiers = 0, commands } = {}) {
  const code = /^[A-Za-z]$/u.test(name) ? `Key${name.toUpperCase()}` : name;
  const event = {
    key: name,
    code,
    windowsVirtualKeyCode: /^[A-Za-z]$/u.test(name)
      ? name.toUpperCase().charCodeAt(0)
      : { Backspace: 8 }[name],
    modifiers,
  };
  await cdp.call("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...event,
    ...(commands ? { commands } : {}),
  });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", ...event });
}

// Chooses the option `optionValue` of the `<select>` `selector`, once it is visible and enabled.
async function chooseOption(cdp, selector, optionValue) {
  await pressPoint(cdp, `document.querySelector(${JSON.stringify(selector)})`, selector);
  await evaluate(
    cdp,
    `const select = document.querySelector(${JSON.stringify(selector)});
    select.value = ${JSON.stringify(optionValue)};
    select.dispatchEvent(new Event('change', { bubbles: true }));`,
  );
}

/** Replaces a text field's text: a press on the field, Select All, then the new text typed or deleted. */
async function typeInto(cdp, selector, text) {
  await physicalClick(cdp, selector);
  await key(cdp, "a", { modifiers: 2, commands: ["selectAll"] });
  if (text === "") await key(cdp, "Backspace");
  else await cdp.call("Input.insertText", { text });
}

// A real Escape key, which closes the dialog on top.
async function pressEscape(cdp) {
  for (const type of ["keyDown", "keyUp"])
    await cdp.call("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
}

// A real Space key: unless a handler prevents its default, it types a space into the focused field.
async function pressSpace(cdp) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.call("Input.dispatchKeyEvent", {
      type,
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
      ...(type === "keyDown" ? { text: " " } : {}),
    });
  }
}

async function selectPlayerExample(cdp) {
  await waitFor(
    cdp,
    `document.querySelector('#example-select option[value="player-controls"]') !== null`,
  );
  const previousRevision = await value(
    cdp,
    `document.querySelector('#source-revision')?.textContent`,
  );
  await evaluate(
    cdp,
    `const select=document.querySelector('#example-select'); select.value='player-controls'; select.dispatchEvent(new Event('change', {bubbles:true}))`,
  );
  await waitFor(
    cdp,
    `document.querySelector('#loaded-example-name')?.textContent === 'Player controls' && document.querySelector('#source-revision')?.textContent !== ${JSON.stringify(previousRevision)} && !document.querySelector('#run').disabled`,
  );
}

async function replaceSourceAndRun(cdp, source) {
  await evaluate(
    cdp,
    `const input=document.querySelector('#source-code'); input.value=${JSON.stringify(source)}; input.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#compile').click(); document.querySelector('#run').click()`,
  );
  await waitFor(cdp, `document.querySelector('#runtime-status')?.textContent === 'waiting'`);
}

async function typeAndSubmit(cdp, text) {
  await evaluate(
    cdp,
    `const input=document.querySelector('#composer-input'); input.value=${JSON.stringify(text)}; input.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#composer-form').requestSubmit()`,
  );
}

// Whether the user can see the element: rendered, not `display: none`, `visibility: hidden` or fully transparent.
function visible(selector) {
  return `document.querySelector(${JSON.stringify(selector)})?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) === true`;
}

async function activeActionId(cdp) {
  return value(
    cdp,
    `JSON.parse(document.querySelector('#runtime-state').textContent).foregroundAction?.actionId ?? null`,
  );
}

/** Waits until a skip moved the script from one message's reading time to the next message's. */
async function waitForNextPacingGate(cdp, previousGate) {
  await waitFor(
    cdp,
    `(() => {
      const action = JSON.parse(document.querySelector('#runtime-state').textContent).foregroundAction;
      return action?.kind === 'chatPacingGate' && action.actionId !== ${JSON.stringify(previousGate)};
    })()`,
    8_000,
    "The skip did not move on to the next message's reading time",
  );
}

async function transcriptTexts(cdp) {
  return value(
    cdp,
    `[...document.querySelectorAll('#transcript li')].map((item) => [...item.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim())`,
  );
}

/**
 * `?package=<id>` opens a package of the server's package root as one project: in the Player and the playground a
 * valid package starts at its main.tease, and one that does not compile shows each diagnostic with its file and line.
 */
async function packageScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  const {
    result: { identifier },
  } = await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__played = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (!window.__played.includes(this)) window.__played.push(this);
        return play.call(this);
      };`,
  });
  try {
    await navigate(cdp, `${origin}/player/?package=house`);
    await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
    await physicalClick(cdp, "[data-session-activation] button");
    // main.tease shows the package's own image and calls the global function of helpers.tease.
    await waitFor(
      cdp,
      `(() => {
        const image = document.querySelector('.stage-media');
        return !!image && image.complete && image.naturalWidth > 0 &&
          image.dataset.stageSource === '/dev-package/house/files/images/hall.svg' &&
          [...document.querySelectorAll('.transcript-entry')].some((entry) => entry.textContent.includes('Welcome to the house, guest.'));
      })()`,
      8_000,
      "The house package did not start at main.tease with its own Stage image",
    );
    // Then it plays the package's own sound, audibly.
    await waitFor(
      cdp,
      `window.__played.some((element) => element.src.endsWith('/dev-package/house/files/sounds/chime.wav') &&
        (element.currentTime > 0 || element.ended) && !element.muted && element.volume > 0)`,
      10_000,
      "The house package did not play its own sound",
    );
  } finally {
    await cdp.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }

  await navigate(cdp, `${origin}/player/?package=broken`);
  await waitFor(
    cdp,
    `document.querySelector('[data-script-failure]')?.textContent.includes("rooms/cellar.tease, line 3, column 9") === true`,
    8_000,
    "The Player did not show the broken package's diagnostic",
  );
  assertEqual(
    await value(
      cdp,
      `document.querySelector('[data-script-failure]').textContent.includes("Unknown variable 'candle'.") && !document.querySelector('[data-session-activation]')`,
    ),
    true,
    "The Player showed Start or no message for a package that does not compile",
  );

  await navigate(cdp, `${origin}/?package=house`);
  await waitFor(
    cdp,
    `document.querySelector('#loaded-example-name')?.textContent === 'Package house' && document.querySelector('#file-select').value === 'main.tease' && !document.querySelector('#run').disabled`,
    8_000,
    "The playground did not open the house package at main.tease",
  );
  await click(cdp, "#run");
  await waitFor(
    cdp,
    `document.querySelector('#transcript').textContent.includes('Welcome to the house, guest.')`,
  );

  await navigate(cdp, `${origin}/?package=broken`);
  await waitFor(
    cdp,
    `[...document.querySelectorAll('#diagnostics .diagnostic-button')].some((button) => button.textContent.includes('rooms/cellar.tease (3:9)'))`,
    8_000,
    "The playground did not list the broken package's diagnostic with its file",
  );
  // The diagnostic opens its file at the reported line.
  await click(cdp, "#diagnostics .diagnostic-button");
  assertEqual(
    await value(
      cdp,
      `(() => { const source = document.querySelector('#source-code'); return document.querySelector('#file-select').value + ':' + source.value.slice(source.selectionStart, source.selectionEnd); })()`,
    ),
    "rooms/cellar.tease:candle",
    "The playground diagnostic did not select its source",
  );

  await navigate(cdp, `${origin}/editor/?package=broken`);
  await waitFor(
    cdp,
    `document.querySelector('[data-monaco-ready="true"]') !== null && document.querySelector('[data-file-path="rooms/cellar.tease"] .file-problems')?.textContent.trim() === '1 diagnostics'`,
    8_000,
    "The editor did not open the broken package's files with their diagnostics",
  );

  // Package paths that a model URI built from the path alone would merge: on Windows `\` becomes a folder separator,
  // and Monaco lowercases a first folder that looks like a drive. The editor must keep every file apart.
  const userAgent = await value(cdp, "navigator.userAgent");
  await cdp.call("Emulation.setUserAgentOverride", {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36",
    platform: "Win32",
  });
  try {
    await navigate(cdp, `${origin}/editor/?package=model-paths`);
    await waitFor(
      cdp,
      `document.querySelector('[data-monaco-ready="true"]') !== null && document.querySelectorAll('[data-file-path]').length === ${MODEL_PATHS_CATALOG.sources.length} && [...document.querySelectorAll('[data-file-path]')].find((row) => row.getAttribute('data-file-path') === ${JSON.stringify("rooms\\cellar.tease")})?.querySelector('.file-problems')?.textContent.trim() === '1 diagnostics'`,
      8_000,
      "The editor did not keep the package files with `\\` and drive-like folders apart",
    );
  } finally {
    await cdp.call("Emulation.setUserAgentOverride", { userAgent });
  }
}

/**
 * The `missing-media` package refers to an image, a sound, and a speaker avatar the package lacks, and to an image, a
 * sound, and an avatar that are no valid files. With auto-skip on, the failed loads end their waits as settled, so the session reaches its button and its
 * end at once; each path is one warning, also when the script uses it again, and a valid image restores the Stage.
 */
/**
 * The title bar shows the title and author of `main.tease`'s header, for the default build and the development preview;
 * a title cut off by a narrow bar opens in full on a tap, and on short screens with the auto-hide bar the first tap only
 * reveals the bar.
 */
// The start page shows the script's header, and the session it starts is kept: a reload continues it where it was, also
// with a photo only the session holds, and after `exit` the session stays behind the end dialog until it is closed,
// which returns to the start page.
/**
 * Reloads the page once the session the Player keeps includes `text`, such as the label of the interaction it should
 * come back to: keeping is asynchronous browser storage.
 */
async function reloadKept(cdp, text) {
  const kept = () =>
    evaluate(
      cdp,
      `return new Promise((resolve) => {
        const request = indexedDB.open('teasescript-kept-sessions');
        request.onsuccess = () => {
          const sessions = request.result.transaction('sessions').objectStore('sessions').getAll();
          sessions.onsuccess = () => {
            request.result.close();
            resolve(sessions.result.some((session) => session.snapshotJson.includes(${JSON.stringify(JSON.stringify(text))})));
          };
          sessions.onerror = () => resolve(false);
        };
        request.onerror = () => resolve(false);
      })`,
    );
  const deadline = Date.now() + 8_000;
  while (!(await kept())) {
    if (Date.now() > deadline) throw new Error("The session was not kept");
    await delay(50);
  }
  await cdp.call("Page.reload");
}

async function keptSessionScenario(cdp, origin, profile) {
  await setViewport(cdp, 1440, 900);
  const start = "[data-session-start]";
  const messages = `[...document.querySelectorAll('.transcript-entry')].map((entry) => entry.textContent)`;
  const choice = (label) =>
    `[...document.querySelectorAll('[data-foreground-controls] button')].find((button) => button.textContent.trim() === '${label}')`;
  const reloadOnceKept = (text) => reloadKept(cdp, text);
  await navigate(cdp, `${origin}/player/?package=kept-session`);
  await waitFor(cdp, `document.querySelector('${start}')?.textContent.trim() === 'Start'`);
  assertEqual(
    await value(
      cdp,
      `document.querySelector('[data-start-title]')?.textContent + ' / ' + document.querySelector('[data-start-author]')?.textContent`,
    ),
    "Kept session fixture / by Author fixture",
    "The start page shows the header's title and author",
  );
  assertEqual(
    await value(cdp, `document.activeElement === document.querySelector('${start}')`),
    true,
    "Start takes focus on the start page",
  );
  await physicalClick(cdp, start);
  await waitFor(cdp, `!!${choice("One point")}`);

  await reloadOnceKept("One point");
  await waitFor(cdp, `document.querySelector('${start}')?.textContent.trim() === 'Continue'`);
  // The choice appears as soon as Continue leaves the page. On a touch device the composer takes no focus then, so no
  // software keyboard opens. (A desktop with a mouse gives it focus, but this headless browser reports no hover.)
  const point = await pressPoint(cdp, `document.querySelector('${start}')`);
  await cdp.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  try {
    await cdp.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await cdp.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await waitFor(cdp, `!!${choice("One point")}`);
    await delay(300);
    assertEqual(
      await value(cdp, `!!document.activeElement?.matches('[data-composer-input]')`),
      false,
      "The composer took focus after Continue on a device without hover",
    );
  } finally {
    await cdp.call("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
  assertEqual(
    await value(
      cdp,
      `${messages}.flatMap((text) => text.match(/This is visit \\d+\\./g) ?? []).join()`,
    ),
    "This is visit 1.",
    "Continue resumes the kept session without running its start again",
  );

  await physicalClick(cdp, `[data-foreground-controls] button`);
  await waitFor(cdp, `!!document.querySelector('[data-session-end-dialog]')`);
  assertEqual(
    await value(
      cdp,
      `!document.querySelector('${start}') && ${messages}.some((text) => text.includes('You chose 1.'))`,
    ),
    true,
    "After exit the session stays behind the end dialog",
  );
  await physicalClick(cdp, "[data-session-end-close]");
  await waitFor(
    cdp,
    `document.querySelector('${start}')?.textContent.trim() === 'Start' && document.activeElement === document.querySelector('${start}')`,
    5_000,
    "Closing the end dialog returns to the start page, whose Start takes focus",
  );
  await cdp.call("Page.reload");
  await waitFor(cdp, `document.querySelector('${start}')?.textContent.trim() === 'Start'`);
  await physicalClick(cdp, start);
  await waitFor(
    cdp,
    `${messages}.some((text) => text.includes('This is visit 2.'))`,
    8_000,
    "A session that ended is not kept: the next one starts anew",
  );

  // A chosen picture the script shows after its saved reference was deleted comes back with the session, although a
  // later visit reclaims the stored photo no saved value references.
  const chosen = join(profile, "kept-photo.png");
  await writeFile(chosen, solidPng(24, 16, [200, 90, 40]));
  const stageImage = `(() => { const image = document.querySelector('.stage-media'); return !!image && image.complete && image.naturalWidth > 0 && image.getAttribute('src').startsWith('blob:'); })()`;
  await navigate(cdp, `${origin}/player/?package=kept-photo`);
  await waitFor(cdp, `document.querySelector('${start}')?.textContent.trim() === 'Start'`);
  await physicalClick(cdp, start);
  await waitFor(
    cdp,
    visible("[data-composer-attach]"),
    8_000,
    "The image request offered no paperclip",
  );
  await openPicker(cdp);
  await setInputFiles(cdp, "[data-composer-file]", [chosen]);
  await useImage(cdp);
  await waitFor(
    cdp,
    `${stageImage} && !!${choice("Done")}`,
    8_000,
    "The chosen picture is not shown",
  );
  await reloadOnceKept("Done");
  await waitFor(cdp, `document.querySelector('${start}')?.textContent.trim() === 'Continue'`);
  await physicalClick(cdp, start);
  await waitFor(
    cdp,
    `${stageImage} && !!${choice("Done")}`,
    8_000,
    "The picture the kept session shows did not come back after a reload",
  );
}

/**
 * Photo colours (`photo-colour` package): the Stage photo colours the Player's background, the Next options of the photo
 * accent, fade time and blending A/B tests change the Player, and the empty Stage after `hideImage` gives
 * the theme's colours back. Once each change has settled, text on the background and in a message bubble is readable,
 * in both modes and in Standard and High contrast.
 */
async function photoColourScenario(cdp, origin, profile) {
  await setViewport(cdp, 1440, 900);
  const chosen = join(profile, "photo-colour-chosen.png");
  await writeFile(chosen, solidPng(48, 32, [200, 40, 120]));
  // The theme's colour roles on the document root.
  const roles = `Object.fromEntries([...document.documentElement.style].filter((name) => /^--(theme|story-accent)-/.test(name)).map((name) => [name, document.documentElement.style.getPropertyValue(name)]))`;
  // WCAG relative luminance of a colour as the screen shows it.
  const luminance = `const luminance = (colour) => { const context = document.createElement('canvas').getContext('2d'); context.fillStyle = colour; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0); };`;
  const background = `getComputedStyle(document.querySelector('.player-viewport-canvas')).backgroundColor`;
  // The lower WCAG contrast of the text on the background and of a message bubble's text, as the screen shows them now.
  const contrast = `(() => {
    ${luminance}
    const ratio = (first, second) => { const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a); return (high + 0.05) / (low + 0.05); };
    const bubble = getComputedStyle(document.querySelector('.message-speaker'));
    return Math.min(ratio(bubble.color, bubble.backgroundColor), ratio(getComputedStyle(document.body).color, ${background}));
  })()`;
  const photo = `document.documentElement.hasAttribute('data-photo-colour')`;
  const fading = `document.documentElement.hasAttribute('data-photo-fade')`;
  // Judged once the change has settled, never while the colours fade.
  const readable = async (label) => {
    await waitFor(cdp, `!${fading}`, 3_000, `${label}: the colours did not settle`);
    const ratio = await value(cdp, contrast);
    assertEqual(ratio >= 4.5, true, `${label}: text at ${ratio.toFixed(2)} to 1`);
  };
  const switchMode = async (mode) => {
    await physicalClick(cdp, `[aria-label="Switch to ${mode} theme"]`);
    await waitFor(cdp, `document.documentElement.dataset.playerTheme === '${mode}'`);
  };
  const press = async (label) => {
    await waitFor(
      cdp,
      `[...document.querySelectorAll('[data-foreground-controls] button')].some((button) => button.textContent.trim() === ${JSON.stringify(label)})`,
    );
    await clickLabelled(cdp, label, "[data-foreground-controls] button");
  };
  const chooseContrast = async (option) => {
    await physicalClick(cdp, "[data-settings-trigger]");
    const secondary = `document.documentElement.style.getPropertyValue('--theme-text-secondary')`;
    const before = await value(cdp, secondary);
    await chooseOption(cdp, '[data-player-setting="contrast"]', option);
    await waitFor(
      cdp,
      `${secondary} !== ${JSON.stringify(before)}`,
      3_000,
      `Contrast ${option} was not applied`,
    );
    await physicalClick(cdp, '[data-player-settings] [data-slot="dialog-close"]');
    await waitFor(cdp, `!document.querySelector('[data-player-settings]')`);
  };
  await navigate(cdp, `${origin}/player/?package=photo-colour`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  const theme = await value(cdp, roles);
  const themeBackground = await value(cdp, background);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(cdp, photo, 8_000, "The Stage photo did not colour the Player");
  assertEqual(
    JSON.stringify(await value(cdp, roles)) === JSON.stringify(theme),
    false,
    "The photo left the Player's colours as they were",
  );
  await waitFor(cdp, `document.querySelectorAll('.transcript-entry').length >= 3`);
  await readable("The first photo");
  assertEqual(
    (await value(cdp, background)) === themeBackground,
    false,
    "The photo left the painted background unchanged",
  );
  // The A/B tests panel opens from the tools menu, and its photo accent's Next option changes the Player's colours.
  const abTests = '[data-tools-focus="launcher:A/B tests"]';
  const nextAccent = '[aria-label="Next option: Photo accent"]';
  await physicalClick(cdp, abTests);
  await waitFor(cdp, visible(nextAccent));
  const beforeVariant = JSON.stringify(await value(cdp, roles));
  await physicalClick(cdp, nextAccent);
  await waitFor(
    cdp,
    `JSON.stringify(${roles}) !== ${JSON.stringify(beforeVariant)}`,
    3_000,
    "The photo accent's Next option left the Player's colours as they were",
  );
  await physicalClick(cdp, nextAccent);
  await waitFor(cdp, `JSON.stringify(${roles}) === ${JSON.stringify(beforeVariant)}`);
  // The photo colour fade's two tests change the Player too: the fade time its duration, the blending its colours.
  const fadeDuration = `document.documentElement.style.getPropertyValue('--photo-fade-duration')`;
  for (const [test, changed] of [
    ["Photo colour fade time", fadeDuration],
    ["Photo colour blending", `JSON.stringify(${roles})`],
  ]) {
    const next = `[aria-label="Next option: ${test}"]`;
    const before = await value(cdp, changed);
    await physicalClick(cdp, next);
    await waitFor(
      cdp,
      `${changed} !== ${JSON.stringify(before)}`,
      3_000,
      `The ${test} Next option left the Player as it was`,
    );
    await physicalClick(cdp, next);
    await waitFor(cdp, `${changed} === ${JSON.stringify(before)}`);
  }
  await physicalClick(cdp, abTests);
  await waitFor(cdp, `!document.querySelector('[data-tool="A/B tests"]')`);
  await switchMode("dark");
  await readable("Dark mode");
  await chooseContrast("high");
  await readable("Dark mode, High contrast");
  await waitFor(cdp, visible("[data-composer-attach]"));
  await openPicker(cdp);
  await setInputFiles(cdp, "[data-composer-file]", [chosen]);
  await useImage(cdp);
  await press("Next");
  await waitFor(
    cdp,
    `(() => { const image = document.querySelector('img.stage-media'); return !!image && image.complete && image.dataset.stageSource.endsWith('/red.svg'); })()`,
    5_000,
    "The next photo did not show",
  );
  await readable("The next photo");
  await switchMode("light");
  await readable("Light mode, High contrast");
  await chooseContrast("standard");
  await readable("Light mode");
  // The first photo, shown again, comes from the Player's Cache Storage and brings its colour back.
  const nextRoles = JSON.stringify(await value(cdp, roles));
  await press("Back");
  await waitFor(
    cdp,
    `(() => { const image = document.querySelector('img.stage-media'); return !!image && image.complete && image.dataset.stageSource.endsWith('/green.jpg'); })()`,
    5_000,
    "The first photo did not show again",
  );
  await waitFor(
    cdp,
    `JSON.stringify(${roles}) !== ${JSON.stringify(nextRoles)}`,
    3_000,
    "The first photo shown again did not bring its colour",
  );
  assertEqual(
    await evaluate(
      cdp,
      `return caches.open('teasescript-stage-photos').then((cache) => cache.keys()).then((keys) => keys.map((request) => request.url.split('/').at(-1)).sort().join(' '))`,
    ),
    "green.jpg red.svg",
    "The Player's Cache Storage does not keep the script's photos",
  );
  for (const label of ["Again", "Hide"]) await press(label);
  await waitFor(cdp, `!${photo}`, 5_000, "The empty Stage kept the photo's colours");
  await readable("The theme's return");
  const returned = await value(cdp, roles);
  assertEqual(
    Object.keys({ ...theme, ...returned })
      .filter((name) => theme[name] !== returned[name])
      .join(", "),
    "",
    "The empty Stage's colours are not the theme's",
  );
}

/**
 * Photo vignette (`photo-vignette` package): authored text low at the side of the transcript, under the strongest part
 * of the vignette around a wide Stage photo, stays readable on the background as painted there, in both modes and both
 * contrasts: prose, inline code with its fill, inline colours, a link, and a coloured speaker's bubble with code. With
 * the glyphs made transparent, so that every fill, backing and surface stays painted, a screenshot gives the background
 * behind each line of text, and the text's ink must meet the authored-colour treatment's own targets on every pixel
 * sampled there.
 */
async function photoVignetteScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  // Points inside each line of authored text, clear of a code span's border, where the text is shown: not scrolled out
  // of the transcript or under the composer.
  const samples = `[...document.querySelectorAll('.prose :is(span, a), .message-speaker :is(span, a)')].filter((element) => !element.closest('[data-slot="message-header"]') && [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '')).flatMap((element) => [...element.getClientRects()].flatMap((box) => [0, 1, 2].flatMap((row) => [0, 1, 2, 3, 4, 5].map((column) => ({ text: element.textContent.trim().slice(0, 24), ink: getComputedStyle(element).color, x: Math.round(box.left + 3 + ((box.width - 6) * column) / 5), y: Math.round(box.top + 3 + ((box.height - 6) * row) / 2) }))))).filter(({ x, y }, index, all) => { const hit = document.elementFromPoint(x, y); return hit !== null && hit.closest('.prose, .message-speaker') !== null && hit.textContent.includes(all[index].text.slice(0, 4)); })`;
  // Each kind of authored text, among them both inline code examples, is read where it is shown: a kind out of view is
  // scrolled into view, as a reader does, and read there, wherever the Player lays the conversation out.
  const kinds = [
    "Plain grey",
    "Grey code",
    "Inline grey",
    "Link",
    "Light prose",
    "Dark prose",
    "grey code",
  ];
  const readable = async (label, enhanced) => {
    const unread = new Set(kinds);
    const scrolled = new Set();
    while (unread.size > 0) {
      const points = await value(cdp, samples);
      const shown = new Set(points.map(({ text }) => text).filter((text) => unread.has(text)));
      if (shown.size === 0) {
        const [next] = unread;
        if (scrolled.has(next)) throw new Error(`${label}: no visible sample of "${next}"`);
        scrolled.add(next);
        await evaluate(
          cdp,
          `[...document.querySelectorAll('.prose :is(span, a), .message-speaker :is(span, a)')].find((element) => element.textContent.trim().slice(0, 24) === ${JSON.stringify(next)})?.scrollIntoView({ block: 'center' })`,
        );
        await delay(300);
        continue;
      }
      await evaluate(
        cdp,
        `const style = document.createElement('style'); style.id = 'smoke-hidden-glyphs'; style.textContent = '.transcript-entry, .transcript-entry * { -webkit-text-fill-color: transparent !important; text-decoration-color: transparent !important; text-shadow: none !important; }'; document.head.append(style);`,
      );
      await delay(100);
      const shot = await cdp.call("Page.captureScreenshot", { format: "png" });
      await evaluate(cdp, `document.getElementById('smoke-hidden-glyphs').remove();`);
      const image = decodePng(Buffer.from(shot.result.data, "base64"));
      for (const { text, ink, x, y } of points) {
        const offset = (y * image.width + x) * image.channels;
        const background = new Color(
          "srgb",
          [0, 1, 2].map((channel) => image.pixels[offset + channel] / 255),
        );
        const wcag = Color.contrast(background, ink, "WCAG21");
        const apca = Math.abs(Color.contrast(background, ink, "APCA"));
        const passes = enhanced
          ? wcag >= 7 && apca >= 55
          : apca >= 55 || (wcag >= 3.5 && apca >= 40);
        assertEqual(
          passes,
          true,
          `${label}: "${text}" at ${x},${y} on the painted background: WCAG ${wcag.toFixed(2)}, APCA ${apca.toFixed(1)}`,
        );
      }
      for (const text of shown) unread.delete(text);
    }
  };
  const settings = async (option) => {
    await physicalClick(cdp, "[data-settings-trigger]");
    await waitFor(cdp, `!!document.querySelector('[data-player-setting="contrast"]')`);
    const secondary = `document.documentElement.style.getPropertyValue('--theme-text-secondary')`;
    const before = await value(cdp, secondary);
    await chooseOption(cdp, '[data-player-setting="contrast"]', option);
    await waitFor(
      cdp,
      `${secondary} !== ${JSON.stringify(before)}`,
      3_000,
      `Contrast ${option} was not applied`,
    );
    await physicalClick(cdp, '[data-player-settings] [data-slot="dialog-close"]');
    await waitFor(cdp, `!document.querySelector('[data-player-settings]')`);
  };
  // The background fades to a new colour; the text is read once it has settled.
  const settled = `!document.documentElement.hasAttribute('data-photo-fade')`;
  const switchMode = async (mode) => {
    await physicalClick(cdp, `[aria-label="Switch to ${mode} theme"]`);
    await waitFor(cdp, `document.documentElement.dataset.playerTheme === '${mode}'`);
    await waitFor(cdp, settled, 3_000, `The ${mode} colours did not settle`);
  };
  await navigate(cdp, `${origin}/player/?package=photo-vignette`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(
    cdp,
    `document.documentElement.hasAttribute('data-photo-colour') && document.querySelectorAll('.prose').length === 3`,
    8_000,
    "The wide photo did not colour the Player",
  );
  await waitFor(cdp, settled, 3_000, "The photo's colours did not settle");
  await delay(300);
  await readable("Light, Standard", false);
  await switchMode("dark");
  await readable("Dark, Standard", false);
  await settings("high");
  await readable("Dark, High", true);
  await switchMode("light");
  await readable("Light, High", true);
  await settings("standard");
}

/** The pixels of an 8-bit, non-interlaced RGB or RGBA PNG, such as a DevTools screenshot. */
function decodePng(buffer) {
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      channels = { 2: 3, 6: 4 }[chunk[9]] ?? 0;
      if (chunk[8] !== 8 || chunk[12] !== 0 || channels === 0) throw new Error("Unsupported PNG");
    } else if (type === "IDAT") data.push(chunk);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      const estimate = left + up - upLeft;
      const [toLeft, toUp, toUpLeft] = [left, up, upLeft].map((value) =>
        Math.abs(estimate - value),
      );
      const predictor = [
        0,
        left,
        up,
        (left + up) >> 1,
        toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft,
      ][filter];
      pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

/**
 * Entrances (`entrances` package): an update taller than the view stops showing its first entry, with Return to latest
 * offered, while later messages do not move the reader; that also holds for an update of two entries, after the reader
 * scrolled back to the end.
 */
async function entrancesScenario(cdp, origin) {
  await setViewport(cdp, 1280, 800);
  const entries = `Number(document.querySelector('.transcript-entry')?.getAttribute('aria-setsize') ?? 0)`;
  // The top of an entry in the view, as long as it is drawn.
  const top = (index) => `(() => {
    const view = document.querySelector('.transcript-scroll').getBoundingClientRect();
    const row = document.querySelector('.transcript-entry[data-index="${index}"]');
    return row ? Math.round(row.getBoundingClientRect().top - view.top) : null;
  })()`;
  // The reader sees where an entry starts, and is offered Return to latest.
  const held = (index) =>
    `(() => { const start = ${top(index)}; return start !== null && start >= -2 && start < document.querySelector('.transcript-scroll').clientHeight - 2 && !!document.querySelector('.return-to-latest'); })()`;
  await navigate(cdp, `${origin}/player/?package=entrances`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(cdp, `!!document.querySelector('[data-foreground-controls] button')`, 8_000);
  // An update of many entries, taller than the view, stops at its first entry, the answer.
  await physicalClick(cdp, "[data-foreground-controls] button");
  await waitFor(cdp, `${entries} === 19`, 8_000, "The tall update did not arrive");
  await waitFor(
    cdp,
    held(3),
    4_000,
    "An update taller than the view did not stop showing its first entry with Return to latest",
  );
  // The next message and choice arrive below, a second later, without moving the reader.
  await delay(300);
  const [reading, before] = await value(cdp, `[${top(3)}, ${entries}]`);
  if (before !== 19) throw new Error("The next message arrived before the reader's place was read");
  await waitFor(cdp, `${entries} === 20`, 8_000, "No message arrived after the tall update");
  await delay(400);
  assertEqual(
    Math.abs((await value(cdp, top(3))) - reading) <= 2,
    true,
    "A message after the tall update moved the reader",
  );
  // Scrolled back to the end, the reader follows again: an update of two entries taller than the view stops at its
  // first entry.
  await evaluate(
    cdp,
    `const view = document.querySelector('.transcript-scroll'); view.scrollTop = view.scrollHeight;`,
  );
  await waitFor(
    cdp,
    `!document.querySelector('.return-to-latest')`,
    4_000,
    "Scrolling to the end did not reach it",
  );
  await physicalClick(cdp, "[data-foreground-controls] button");
  await waitFor(cdp, `${entries} === 22`, 8_000, "The tall message did not arrive");
  await waitFor(
    cdp,
    held(20),
    4_000,
    "A two-entry update taller than the view did not stop showing its first entry after the reader returned to the end",
  );
}

/**
 * Messages changed in place (`updates` package): a message whose text grows while it is above the view keeps the text
 * being read still as the reader scrolls up past it, the change adds no entry and is spoken by the status region, and
 * a change that removes the focused link leaves focus on its message.
 */
async function messageUpdatesScenario(cdp, origin) {
  await setViewport(cdp, 1280, 800);
  await navigate(cdp, `${origin}/player/?package=updates`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  const entries = `Number(document.querySelector('.transcript-entry')?.getAttribute('aria-setsize') ?? 0)`;
  await waitFor(cdp, `${entries} === 43`, 8_000, "The updates package did not show its messages");
  const viewport = `document.querySelector('.transcript-scroll')`;
  // Measure the counter at its first height, then read further down, with the counter above the view.
  await focusSeen(cdp, viewport);
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Home", code: "Home" });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Home", code: "Home" });
  await delay(300);
  // Far enough down that the counter is no longer rendered, so its change is measured only on the way back up.
  const counterShown = `[...document.querySelectorAll('.transcript-entry')].some((row) => row.textContent.includes('Strokes:'))`;
  for (let step = 0; step < 20 && (await value(cdp, counterShown)); step += 1) {
    await evaluate(cdp, `${viewport}.scrollTop += 200; return true;`);
    await delay(100);
  }
  assertEqual(await value(cdp, counterShown), false, "The counter stayed rendered");
  await waitFor(
    cdp,
    `document.querySelector('[data-message-update-announcement]')?.textContent.includes('Strokes: 1')`,
    10_000,
    "The counter's change was not announced",
  );
  assertEqual(await value(cdp, entries), 43, "A changed message added an entry");
  // Scroll up step by step past the changed counter: the text in view moves exactly as far as each step.
  const rect = await pressPoint(cdp, viewport);
  const tops = `Object.fromEntries([...document.querySelectorAll('.transcript-entry')].map((row) => [row.dataset.messageId, row.getBoundingClientRect().top]))`;
  let passed = false;
  let observed = 0;
  for (let step = 0; step < 40 && !passed; step += 1) {
    passed = await value(cdp, counterShown);
    const before = await value(cdp, tops);
    await cdp.call("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...rect,
      deltaX: 0,
      deltaY: -60,
    });
    await delay(250);
    const after = await value(cdp, tops);
    const moved = new Set(
      Object.keys(before)
        .filter((id) => id in after && before[id] > rect.y - 100 && before[id] < rect.y + 100)
        .map((id) => Math.round(after[id] - before[id])),
    );
    if (moved.size > 0) {
      observed += 1;
      assertEqual(
        [...moved].join(),
        "60",
        "The text in view jumped while scrolling up past a changed message",
      );
    }
  }
  passed ||= await value(cdp, counterShown);
  assertEqual(passed, true, "Scrolling up did not reach the changed counter");
  assertEqual(observed > 0, true, "Scrolling up compared no text in view");
  // Focus on a link that a change removes stays on its message.
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Home", code: "Home" });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Home", code: "Home" });
  await waitFor(
    cdp,
    `!!document.querySelector('.transcript-entry a[href="https://example.com/rules"]')`,
  );
  await focusSeen(
    cdp,
    `document.querySelector('.transcript-entry a[href="https://example.com/rules"]')`,
    { preventScroll: true },
  );
  await waitFor(
    cdp,
    `document.activeElement?.matches('.transcript-entry[tabindex="-1"]') && document.activeElement.textContent.includes('The rules are gone.')`,
    16_000,
    "Focus did not stay on the message whose link a change removed",
  );
}

async function cameraScenario(cdp, origin) {
  const url = `${origin}/player/?dev&debug=off&scenario=camera`;
  const start = async () => {
    await navigate(cdp, url);
    await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
    await physicalClick(cdp, "[data-session-activation] button");
  };
  const takeNewPhoto = () => clickLabelled(cdp, "Take another, Mistress");
  const savedItem = JSON.stringify('player-storage:["development-camera","camera.photo"]');
  const savedPhoto = `JSON.parse(localStorage.getItem(${savedItem}) ?? 'null')?.value ?? null`;
  const storedPhotos = () =>
    evaluate(
      cdp,
      `return new Promise((resolve, reject) => {
        const request = indexedDB.open('teasescript-captured-media');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const store = database.objectStoreNames[0];
          const keys = database.transaction(store).objectStore(store).getAllKeys();
          // Only this scenario's scope: other scenarios may keep saved photos of their own.
          keys.onsuccess = () => { database.close(); resolve(keys.result.filter(([namespace]) => namespace === 'development-camera').map(([, reference]) => reference)); };
        };
      })`,
    );

  await cdp.call("Browser.setPermission", {
    origin,
    permission: { name: "camera" },
    setting: "granted",
  });
  await start();
  await waitFor(cdp, `document.body.innerText.includes('Got you. That one is mine now.')`);
  await waitFor(cdp, `${capturedImages} === 1`, 8_000, "The camera's photo did not show");
  const first = await value(cdp, savedPhoto);
  assertEqual(String(first).startsWith("captured-media:"), true, "The photo reference was saved");
  assertEqual((await storedPhotos()).includes(first), true, "The saved photo was stored durably");

  // A new run loads the saved reference and shows the same stored photo.
  await start();
  await waitFor(cdp, `document.body.innerText.includes('Look what I kept from last time.')`);
  await waitFor(
    cdp,
    `${capturedImages} === 1`,
    8_000,
    "The saved photo did not resolve in a new run",
  );
  await takeNewPhoto();
  await waitFor(cdp, `document.body.innerText.includes('Got you. That one is mine now.')`);
  const second = await value(cdp, savedPhoto);
  assertEqual(
    second !== first && String(second).startsWith("captured-media:"),
    true,
    "The new photo was saved",
  );

  // The next mount reclaims the replaced photo, which no saved value references.
  await navigate(cdp, url);
  const deadline = Date.now() + 8_000;
  while (JSON.stringify(await storedPhotos()) !== JSON.stringify([second])) {
    if (Date.now() > deadline) throw new Error("The replaced photo was not reclaimed");
    await delay(50);
  }

  await cdp.call("Browser.setPermission", {
    origin,
    permission: { name: "camera" },
    setting: "denied",
  });
  await start();
  await waitFor(cdp, `document.body.innerText.includes('Look what I kept from last time.')`);
  await takeNewPhoto();
  await waitFor(
    cdp,
    `document.body.innerText.includes('No camera? Then you stay unseen, for now. We go on without a photo.')`,
  );
  assertEqual(await value(cdp, savedPhoto), second, "A denied camera replaced the saved photo");

  // A forged reference in saved data is ordinary text: it resolves to no photo, and the script continues.
  await evaluate(
    cdp,
    `localStorage.setItem(${savedItem}, JSON.stringify({ v: 1, value: 'captured-media:00000000-0000-4000-8000-000000000000:1' }))`,
  );
  await start();
  await waitFor(cdp, `document.body.innerText.includes('Look what I kept from last time.')`);
  await delay(500);
  assertEqual(await value(cdp, capturedImages), 0, "A forged reference resolved to a photo");
  await takeNewPhoto();
  await waitFor(
    cdp,
    `document.body.innerText.includes('No camera? Then you stay unseen, for now. We go on without a photo.')`,
  );
  await cdp.call("Browser.resetPermissions");
}

// On a phone-sized screen the camera view's mirror button takes real clicks in the window and over the Stage, whose top
// lies under the Player's top controls.
async function viewfinderScenario(cdp, origin) {
  const video = (view) => `document.querySelector('${view} [data-viewfinder] video')`;
  const playing = (view) => `${video(view)}?.readyState >= 2 && !${video(view)}.paused`;
  const mirrored = (view) => `${video(view)}?.classList.contains('viewfinder-mirrored')`;
  const flips = async (view) => {
    const before = await value(cdp, mirrored(view));
    await physicalClick(cdp, `${view} [data-viewfinder-mirror]`);
    await waitFor(
      cdp,
      `${mirrored(view)} === ${!before}`,
      2_000,
      `A click on the mirror button in ${view} did not flip the picture`,
    );
  };
  await cdp.call("Browser.setPermission", {
    origin,
    permission: { name: "camera" },
    setting: "granted",
  });
  await setViewport(cdp, 390, 844);
  await navigate(cdp, `${origin}/player/?dev&debug=off&scenario=viewfinder`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(cdp, playing("[data-floating-viewfinder]"));
  await flips("[data-floating-viewfinder]");
  await clickLabelled(cdp, "I'm ready, Mistress");
  await waitFor(cdp, `document.body.innerText.includes("There you are. I'll keep that one.")`);
  await clickLabelled(cdp, "Put me on your Stage");
  await waitFor(cdp, playing("[data-stage-camera]"));
  await flips("[data-stage-camera]");
  await cdp.call("Browser.resetPermissions");
}

// Exports a package's saved data from Player Settings in the default build, without Debug: the downloaded file holds the
// script's saved values and its saved photo.
async function savedDataExportScenario(cdp, origin, profile) {
  const chosen = join(profile, "saved.png");
  await writeFile(chosen, solidPng(24, 16, [30, 160, 90]));
  const downloads = join(profile, "downloads");
  await mkdir(downloads, { recursive: true });
  await cdp.call("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await setViewport(cdp, 1440, 900);
  await navigate(cdp, `${origin}/player/?package=saved-photo`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(
    cdp,
    visible("[data-composer-attach]"),
    8_000,
    "The image request offered no paperclip",
  );
  await openPicker(cdp);
  await setInputFiles(cdp, "[data-composer-file]", [chosen]);
  await useImage(cdp);
  await waitFor(
    cdp,
    `document.body.textContent.includes("Saved.")`,
    8_000,
    "The script did not save its photo",
  );
  await physicalClick(cdp, "[data-settings-trigger]");
  await physicalClick(cdp, "[data-export-saved-data]");
  await waitFor(
    cdp,
    `!!document.querySelector('[data-export-download]')`,
    8_000,
    "The export offered no download",
  );
  const name = await value(cdp, `document.querySelector('[data-export-download]').download`);
  await physicalClick(cdp, "[data-export-download]");
  const file = join(downloads, name);
  const deadline = Date.now() + 8_000;
  while (!(await readdir(downloads)).includes(name)) {
    if (Date.now() > deadline) throw new Error("The export file was not downloaded");
    await delay(50);
  }
  const exported = JSON.parse(gunzipSync(await readFile(file)).toString("utf8"));
  const script = exported.scripts?.find(
    (candidate) => candidate.scope === "development-package:saved-photo",
  );
  assertEqual(
    JSON.stringify(script?.entries.map((entry) => entry.key).sort()),
    JSON.stringify(["photo", "score"]),
    "The export's saved values",
  );
  const photo = script.entries.find((entry) => entry.key === "photo").value;
  assertEqual(
    exported.images.some((image) => image.reference === photo),
    true,
    "The export does not hold the saved photo",
  );
  for (const dialog of ["[data-saved-data-export]", "[data-player-settings]"]) {
    await pressEscape(cdp);
    await waitFor(cdp, `!document.querySelector(${JSON.stringify(dialog)})`);
  }
  return { file };
}

// Imports the export into a fresh browser profile, as on another device: once confirmed, the next Start shows the saved
// photo again.
async function savedDataImportScenario(debugPort, origin, exported) {
  const browser = await connectCdp(
    (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl,
  );
  const { result: context } = await browser.call("Target.createBrowserContext");
  let cdp;
  try {
    const { result: target } = await browser.call("Target.createTarget", {
      url: "about:blank",
      browserContextId: context.browserContextId,
    });
    cdp = await connectCdp(`ws://127.0.0.1:${debugPort}/devtools/page/${target.targetId}`);
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");
    await setViewport(cdp, 1440, 900);
    const start = "[data-session-activation] button";
    await navigate(cdp, `${origin}/player/?package=saved-photo`);
    await waitFor(cdp, `!!document.querySelector('${start}')`);
    await physicalClick(cdp, "[data-settings-trigger]");
    await waitFor(
      cdp,
      `document.querySelector('[data-import-saved-data]')?.disabled === false`,
      8_000,
    );
    await physicalClick(cdp, "[data-import-saved-data]");
    await waitFor(cdp, `!!document.querySelector('[data-saved-data-import]')`);
    await setInputFiles(cdp, "[data-import-file]", [exported.file]);
    await waitFor(
      cdp,
      `!!document.querySelector('[data-import-confirm]')`,
      8_000,
      "The chosen file was not reviewed",
    );
    await physicalClick(cdp, "[data-import-confirm]");
    await waitFor(
      cdp,
      `document.body.innerText.includes("Saved data imported.")`,
      8_000,
      "The import did not finish",
    );
    for (const dialog of ["[data-saved-data-import]", "[data-player-settings]"]) {
      await pressEscape(cdp);
      await waitFor(cdp, `!document.querySelector(${JSON.stringify(dialog)})`);
    }
    await physicalClick(cdp, start);
    await waitFor(
      cdp,
      `document.body.innerText.includes("Your saved photo is back.")`,
      8_000,
      "The imported data did not load at Start",
    );
    await waitFor(
      cdp,
      `(() => { const image = document.querySelector('.stage-media'); return !!image && image.complete && image.naturalWidth === 24; })()`,
      8_000,
      "The imported photo is not on the Stage",
    );
  } finally {
    cdp?.close();
    await browser.call("Target.disposeBrowserContext", {
      browserContextId: context.browserContextId,
    });
    browser.close();
  }
}

// A script error in the default build, without Debug: the error line opens the error dialog, which says where the
// script stopped, and its debug export downloads a file that names the error and, until the player chooses more, holds
// neither the answer nor the photo.
async function debugExportScenario(cdp, origin, profile) {
  const downloads = join(profile, "debug-downloads");
  await mkdir(downloads, { recursive: true });
  await cdp.call("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  const picture = join(profile, "debug-picture.png");
  await writeFile(picture, solidPng(20, 10, [40, 90, 200]));
  const answer = "Ada-private-answer";
  await setViewport(cdp, 1440, 900);
  await navigate(cdp, `${origin}/player/?package=debug-failure`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(
    cdp,
    `document.querySelector('[data-composer-input]')?.placeholder === 'Your name'`,
  );
  await focusSeen(cdp, `document.querySelector('[data-composer-input]')`);
  await cdp.call("Input.insertText", { text: answer });
  await physicalClick(cdp, ".composer-send");
  await waitFor(
    cdp,
    visible("[data-composer-attach]"),
    8_000,
    "The image request offered no paperclip",
  );
  await openPicker(cdp);
  await setInputFiles(cdp, "[data-composer-file]", [picture]);
  await useImage(cdp);
  await waitFor(cdp, `!!document.querySelector('[data-runtime-failure]')`, 8_000, "No error line");
  await physicalClick(cdp, "[data-runtime-failure-details]");
  await waitFor(
    cdp,
    `document.querySelector('[data-session-error-summary]')?.textContent.includes('In main.tease, line 10.') === true`,
    5_000,
    "The error dialog did not say where the script stopped",
  );
  await physicalClick(cdp, "[data-session-error-export]");
  await waitFor(
    cdp,
    `!!document.querySelector('[data-debug-export-download]')`,
    8_000,
    "The debug export was not prepared",
  );
  const before = new Set(await readdir(downloads));
  await physicalClick(cdp, "[data-debug-export-download]");
  let downloaded = null;
  const deadline = Date.now() + 8_000;
  while (downloaded === null) {
    if (Date.now() > deadline) throw new Error("The debug export was not downloaded");
    const added = (await readdir(downloads)).filter(
      (name) => !before.has(name) && !name.endsWith(".crdownload"),
    );
    if (added.length === 1) downloaded = gunzipSync(await readFile(join(downloads, added[0])));
    else await delay(50);
  }
  const text = downloaded.toString("utf8");
  assertEqual(JSON.parse(text).incident.code, "TSR036", "The debug export names the error");
  assertEqual(text.includes(answer), false, "The default debug export contains the answer");
  assertEqual(
    text.includes("captured-media:"),
    false,
    "The default debug export contains a photo reference",
  );
  await pressEscape(cdp);
  await waitFor(cdp, `!document.querySelector('[data-debug-export]')`);
}

/**
 * Opens the file picker with the paperclip, or another `control` that opens it; the native dialog itself is suppressed,
 * and `setInputFiles` answers it.
 */
async function openPicker(cdp, control = "[data-composer-attach]") {
  await evaluate(
    cdp,
    `document.querySelector('[data-composer-file]').addEventListener('click', (event) => event.preventDefault(), { once: true });`,
  );
  await physicalClick(cdp, control);
}

/** "Use image" answers an image request once the file or photo given for it stands on the Stage as its preview. */
async function useImage(cdp) {
  await waitFor(
    cdp,
    `(${decodedPreview}) && document.querySelector('[data-image-control="use"]')?.getAttribute('aria-disabled') !== 'true'`,
    8_000,
    "The image given shows no preview to use",
  );
  await physicalClick(cdp, '[data-image-control="use"]');
}

/** Sets the files of a file input, as the native picker does, through the DevTools protocol. */
async function setInputFiles(cdp, selector, files) {
  const document = await cdp.call("DOM.getDocument", { depth: 0 });
  const node = await cdp.call("DOM.querySelector", {
    nodeId: document.result.root.nodeId,
    selector,
  });
  await cdp.call("DOM.setFileInputFiles", { files, nodeId: node.result.nodeId });
}

/** A small opaque PNG of one color. */
function solidPng(width, height, [red, green, blue]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const framed = Buffer.alloc(body.length + 8);
    framed.writeUInt32BE(data.length, 0);
    body.copy(framed, 4);
    framed.writeUInt32BE(crc32(body), body.length + 4);
    return framed;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  const row = Buffer.from([0, ...Array.from({ length: width }, () => [red, green, blue]).flat()]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function documentTextIncludes(values, text) {
  return values.some((value) => value.includes(text));
}

async function click(cdp, selector) {
  await evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).click()`);
}

async function setViewport(cdp, width, height) {
  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
}

/**
 * The spill store of Debug's rewind history in the browser's IndexedDB: it keeps and deletes rows, and a sweep removes
 * the history databases of pages that ended without deleting theirs and, once its page closes it, a live one, but never
 * its own page's, a live database's rows meanwhile, or a database it did not name.
 */
async function debugHistoryStorageScenario(cdp, origin) {
  await navigate(cdp, `${origin}/`);
  const result = await evaluate(
    cdp,
    `return (async () => {
      const spill = await import(${JSON.stringify(`${origin}${DEBUG_HISTORY_MODULE_URL}`)});
      const prefix = "teasescript-debug-history-";
      const names = async () =>
        (await indexedDB.databases()).map((info) => info.name).filter((name) => name.startsWith(prefix));
      const open = (name) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open(name, 1);
          request.onupgradeneeded = () => request.result.createObjectStore("snapshots");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const pause = () => new Promise((resolve) => setTimeout(resolve, 300));
      const crashed = prefix + crypto.randomUUID();
      (await open(crashed)).close();
      const live = prefix + crypto.randomUUID();
      const liveConnection = await open(live);
      const unnamed = prefix + "not-a-history";
      (await open(unnamed)).close();
      // Earlier scenarios left Player pages without unmounting them, which leaves their histories as a crash does.
      const before = await names();
      const store = await spill.openDebugHistorySpill();
      await store.put(1, "one");
      await store.put(2, "two");
      await store.delete([1]);
      const rows = [(await store.get(1)) ?? null, await store.get(2)];
      const own = (await names()).filter((name) => !before.includes(name));
      await spill.sweepDebugHistories();
      await pause();
      const afterSweep = await names();
      const liveWrites = await new Promise((resolve) => {
        const transaction = liveConnection.transaction("snapshots", "readwrite");
        transaction.objectStore("snapshots").put("kept", 1);
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = transaction.onabort = () => resolve(false);
      });
      const ownReads = (await store.get(2)) === "two";
      liveConnection.close();
      await pause();
      const afterLiveClosed = await names();
      await store.destroy();
      const afterDestroy = await names();
      indexedDB.deleteDatabase(unnamed);
      return { rows, own, crashed, live, unnamed, afterSweep, liveWrites, ownReads, afterLiveClosed, afterDestroy };
    })()`,
  );
  const { rows, own, crashed, live, unnamed } = result;
  const sorted = (names) => [...names].sort();
  if (
    JSON.stringify(rows) !== JSON.stringify([null, "two"]) ||
    own.length !== 1 ||
    JSON.stringify(sorted(result.afterSweep)) !== JSON.stringify(sorted([own[0], live, unnamed])) ||
    !result.liveWrites ||
    !result.ownReads ||
    JSON.stringify(sorted(result.afterLiveClosed)) !== JSON.stringify(sorted([own[0], unnamed])) ||
    JSON.stringify(result.afterDestroy) !== JSON.stringify([unnamed]) ||
    result.afterSweep.includes(crashed)
  )
    throw new Error(`Debug history IndexedDB store: ${JSON.stringify(result)}`);
}

// Each visit starts without the session the Player keeps for a script (PLAYER-UI "Session start and user activation") and
// without a debug room (DEBUGGER.md "Debug room"), so scenarios stay independent of the order they run in;
// `keptSessionScenario` and `debugRoomScenario` reload to keep them.
async function navigate(cdp, url) {
  for (const databaseName of ["teasescript-kept-sessions", "teasescript-debug-rooms"])
    await cdp.call("IndexedDB.deleteDatabase", {
      securityOrigin: new URL(url).origin,
      databaseName,
    });
  const response = await cdp.call("Page.navigate", { url });
  if (response?.result?.errorText) throw new Error(response.result.errorText);
  await waitFor(cdp, `document.readyState === 'complete'`);
}

async function waitFor(
  cdp,
  expression,
  timeout = 8_000,
  failure = `Timed out waiting for: ${expression}`,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await value(cdp, expression)) return;
    await delay(50);
  }
  throw new Error(failure);
}

async function evaluate(cdp, expression) {
  const response = await cdp.call("Runtime.evaluate", {
    expression: `(() => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response?.result?.exceptionDetails)
    throw new Error(JSON.stringify(response.result.exceptionDetails));
  return response?.result?.result?.value;
}

async function value(cdp, expression) {
  const response = await cdp.call("Runtime.evaluate", { expression, returnByValue: true });
  if (response?.result?.exceptionDetails)
    throw new Error(JSON.stringify(response.result.exceptionDetails));
  return response?.result?.result?.value;
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, received ${actual}`);
}

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (port === 0) throw new Error("Could not reserve a browser debugging port.");
  return port;
}

async function waitForTarget(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page");
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {}
    await delay(50);
  }
  throw new Error("Chromium DevTools endpoint did not become available.");
}

// Keep DevTools waits bounded so a stalled browser still reaches main's cleanup path.
async function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  await withTimeout(
    new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    }),
    30_000,
    "Chromium DevTools socket did not open",
  );
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (waiter !== undefined) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values())
      waiter.reject(new Error("Chromium DevTools socket closed"));
    pending.clear();
  });
  return {
    call(method, params = {}) {
      const id = nextId++;
      return withTimeout(
        new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params }));
        }),
        30_000,
        `Chromium DevTools ${method} did not respond`,
      ).finally(() => pending.delete(id));
    },
    close() {
      socket.close();
    },
  };
}

function withTimeout(promise, milliseconds, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
