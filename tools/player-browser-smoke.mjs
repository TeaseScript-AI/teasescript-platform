import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, gunzipSync } from "node:zlib";
import { createPlaygroundServer } from "../dist/playground/server.js";
import { findChromium } from "./find-chromium.mjs";

// The fake camera's frame: a distinct color per quadrant (top left, top right, bottom left, bottom right), so a
// photo that is blank, mirrored, flipped, or not the camera's frame fails the check.
const TEST_CARD = [
  [220, 40, 40],
  [40, 180, 60],
  [40, 70, 220],
  [235, 235, 235],
];

// A decoded captured photo, not merely an image element with a captured URL.
const decodedPhoto = `[...document.querySelectorAll('img')].find((image) => image.src.startsWith('blob:') && image.complete && image.naturalWidth > 0)`;
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

// A file of a few thousand lines with a draw deep inside a long function, for the random draw picker's code; generated,
// as only its length, one long line far from the draw, and the lines above the draw that wrap matter.
const LARGE_FILE_LINES = Array.from({ length: 2_000 }, (_, index) =>
  index >= 1_200 && index % 3 === 0
    ? `// Line ${index + 1}. ${"Words that wrap. ".repeat(10)}`
    : `// Line ${index + 1}.`,
);
LARGE_FILE_LINES[0] = "let hit = false";
LARGE_FILE_LINES[1] = `// ${"A long line. ".repeat(20)}`;
LARGE_FILE_LINES[1_199] = "function flip {";
LARGE_FILE_LINES.splice(
  1_499,
  6,
  "    hit = chance(25)",
  "}",
  "flip()",
  'say "Hit: ${hit}", instant',
  'showButton "Done"',
  "exit",
);
const CATALOGS = new Map([
  ["/dev-package/model-paths/catalog.json", MODEL_PATHS_CATALOG],
  [
    "/dev-package/large-file/catalog.json",
    {
      images: [],
      media: [],
      sources: [{ path: "main.tease", source: LARGE_FILE_LINES.join("\n") }],
      problems: [],
    },
  ],
]);

const LAN_HOST = "player-lan.test";
// The late-image scenario holds the first response for this image until the scenario releases it.
const LATE_IMAGE_URL = "/dev-package/late-image/files/images/late.png";
// The compiled spill store of Debug's rewind history, which the smoke runs against the browser's real IndexedDB.
const DEBUG_HISTORY_MODULE_URL = "/smoke/debug-history-indexeddb.js";
const lateImage = { hold: false, release: null };

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
  // The model-paths and large-file packages exist only as catalogs, so the smoke needs no file named with `\` or `C:`,
  // nor one of thousands of lines, on disk.
  const [handleRequest] = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    if (request.url === LATE_IMAGE_URL && lateImage.hold) {
      lateImage.hold = false;
      lateImage.release = () => handleRequest(request, response);
      return;
    }
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
  const cameraFeed = join(profile, "camera-test-card.y4m");
  await mkdir(profile, { recursive: true });
  await writeFile(cameraFeed, testCardY4m());
  const browser = spawn(chromium, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    // A synthetic camera that shows the test card for the camera scenario; permissions are granted or denied per
    // scenario through CDP.
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${cameraFeed}`,
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
      await scriptStorageScenario(cdp, origin);
      await demoScenario(cdp, origin);
      await insecureOriginScenario(cdp, `http://${LAN_HOST}:${address.port}`);
      await packageScenario(cdp, origin);
      await titleBarScenario(cdp, origin);
      await keptSessionScenario(cdp, origin, profile);
      await debugRoomScenario(cdp, origin);
      await randomPickerScenario(cdp, origin);
      await largeRandomPickerScenario(cdp, origin);
      await askImageScenario(cdp, origin, profile);
      const exported = await savedDataExportScenario(cdp, origin, profile);
      await savedDataImportScenario(debugPort, origin, exported);
      await debugExportScenario(cdp, origin, profile);
      await developmentTimeScenario(cdp, origin);
      await debugCountdownScenario(cdp, origin);
      await debugNowScenario(cdp, origin);
      await debugStorageScenario(cdp, origin, profile);
      await debugStorageEditScenario(cdp, origin);
      await debugHistoryStorageScenario(cdp, origin);
      await debugRewindScenario(cdp, origin);
      await sessionEndScenario(cdp, origin);
      await errorCallPathScenario(cdp, origin);
      await heldPressScenario(cdp, origin);
      await missingMediaScenario(cdp, origin);
      await audioOverlapScenario(cdp, origin);
      await lateImageScenario(cdp, origin);
      await messageUpdatesScenario(cdp, origin);
      await entrancesScenario(cdp, origin);
      await askImageCameraScenario(cdp, origin, profile);
      await cameraScenario(cdp, origin);
      await viewfinderScenario(cdp, origin);
      await permanentButtonsScenario(cdp, origin);
      await formsScenario(cdp, origin);
      await preselectScenario(cdp, origin);
      await formFieldsScenario(cdp, origin);
      console.log(
        "player-browser-smoke: PASS technical playground, the repository demo on /player/, packages opened by URL, the title bar's title and author with its controls' look and the dialog X's target, the start page, no composer focus after Continue on touch, and a session kept across a reload, the debug room with its copy and Reload and Reset session, the random draw picker, also with a file of thousands of lines, askImage by picker, drop, and camera, saved-data export and import from Settings, the error dialog with the failing line and call path and its debug export after a script error, the end dialog with its review placeholder and the start page after it, development time controls, Debug countdowns, Now and Storage with its editor, the rewind history's IndexedDB store, rewinding the chat, a held press, missing, late and overlapping media, messages changed in place, entering messages and controls, and the camera, viewfinder, permanent buttons, askForm toggle, cycle, and typed-field, and preselected-button scenarios",
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
  await evaluate(
    cdp,
    `document.querySelector('#player-panel').dispatchEvent(new PointerEvent('pointerup', {bubbles:true, button:0, isPrimary:true, pointerType:'mouse'}))`,
  );
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
  await replaceSourceAndRun(cdp, `let answer = choose ${options}\nexit`);
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
  await evaluate(
    cdp,
    `document.querySelector('#player-panel').dispatchEvent(new PointerEvent('pointerup', {bubbles:true, button:0, isPrimary:true, pointerType:'touch'}))`,
  );
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
    await physicalClick(cdp, "[data-settings-trigger]");
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
      };`,
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
  let smartFollowChecked = false;
  let staleGestureChecked = false;
  let buttonNameChecked = false;
  const timers = new Map();
  const texts = new Set();
  const avatars = {};
  const audio = [];
  let roomPausedDuringCountdown = false;
  let finished = false;
  const deadline = Date.now() + 120_000;
  while (!finished) {
    if (Date.now() > deadline) throw new Error("The demo did not reach Finish in time");
    const state = await value(
      cdp,
      `(() => {
        const input = document.querySelector('[data-composer-input]');
        const entries = [...document.querySelectorAll('.transcript-entry')];
        const entry = (text) => entries.find((element) => element.textContent.includes(text));
        // An image counts only once it decoded and occupies layout space.
        const rendered = (image) => !!image && image.complete && image.naturalWidth > 0 && image.getBoundingClientRect().width > 0;
        return {
          stage: rendered(document.querySelector('.stage-media')) ? document.querySelector('.stage-media').getAttribute('src') : null,
          timers: [...document.querySelectorAll('.timer-display')].map((timer) => [
            timer.querySelector('.timer-label')?.textContent.trim() ?? '',
            timer.dataset.kind,
          ]),
          // The room ambience is the 4 s loop; the chime lasts 1.6 s.
          roomPaused: window.__played.find((element) => element.duration > 3)?.paused ?? null,
          audio: window.__played.map((element) => ({ time: element.currentTime, audible: !element.muted && element.volume > 0 })),
          texts: entries.map((element) => element.textContent),
          vera: rendered(entry('Eyes on me.')?.querySelector('[data-slot=avatar-image]'))
            ? entry('Eyes on me.').querySelector('[data-slot=avatar-image]').getAttribute('src').slice(0, 18)
            : undefined,
          session: entry('Some of her messages')?.querySelector('[data-speaker-avatar]')?.textContent.trim(),
          buttons: [...document.querySelectorAll('[data-foreground-controls] button')].map((button) => button.textContent.trim()),
          placeholder: input && !input.disabled ? input.placeholder : null,
        };
      })()`,
    );
    if (state.stage !== null && stageSources.at(-1) !== state.stage) stageSources.push(state.stage);
    for (const [label, kind] of state.timers) {
      timers.set(label, new Set([...(timers.get(label) ?? []), kind]));
      if (label === "Stay exactly like that")
        roomPausedDuringCountdown ||= state.roomPaused === true;
    }
    for (const text of state.texts) texts.add(text);
    avatars.vera ??= state.vera;
    avatars.session ??= state.session;
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
    } else if (
      !staleGestureChecked &&
      state.texts.some((text) => text.includes("I've paused your clock.")) &&
      !state.texts.some((text) => text.includes("Twenty seconds less."))
    ) {
      staleGestureChecked = true;
      await staleSkipGestureCheck(cdp);
    } else if (state.buttons.length === 1) {
      finished = state.buttons[0] === "Finish";
      if (!buttonNameChecked) {
        buttonNameChecked = true;
        await buttonNameCheck(cdp, state.buttons[0]);
      }
      await physicalClick(cdp, "[data-foreground-controls] button");
    } else if (state.placeholder === "What you call her") {
      await evaluate(cdp, `document.querySelector('[data-composer-input]').focus()`);
      await cdp.call("Input.insertText", { text: "Mistress" });
      await physicalClick(cdp, ".composer-send");
    } else if (state.placeholder !== null) {
      // A skippable pacing gate: Space in the empty composer hurries the message along.
      await evaluate(cdp, `document.querySelector('[data-composer-input]').focus()`);
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
  assertEqual(inputOwnershipChecked && spaceSkipChecked, true, "The pacing input checks ran");
  assertEqual(smartFollowChecked, true, "The smart follow check ran");
  assertEqual(staleGestureChecked, true, "The stale skip gesture check ran");
  assertEqual(buttonNameChecked, true, "The button name check ran");
  assertEqual(stageSources.length, 2, "Stage images shown before hideImage");
  if (!stageSources.every((source) => source.startsWith("data:image/svg+xml"))) {
    throw new Error(`The Stage did not show the demo's package images: ${stageSources.join(", ")}`);
  }
  assertEqual(
    JSON.stringify([...timers].map(([label, kinds]) => [label, [...kinds].sort()])),
    JSON.stringify([
      ["Hold still", ["visible"]],
      ["Mistress's timer", ["mystery", "visible"]],
      ["Stay exactly like that", ["visible"]],
    ]),
    "Presented runtime timers",
  );
  if (!roomPausedDuringCountdown)
    throw new Error("The room ambience kept playing during the countdown");
  if (audio.length !== 2 || !audio.every((time) => time > 0.2)) {
    throw new Error(`Both demo sounds must actually play audibly: ${JSON.stringify(audio)}`);
  }
  assertEqual(avatars.vera, "data:image/svg+xml", "Mistress Vera's avatar image");
  assertEqual(avatars.session, "S", "Letter glyph for a speaker without an avatar");
  for (const text of [
    "Mistress. Good. Don't forget it.",
    "When you hear that bell, you listen.",
    "Good. That's enough for your first lesson.",
  ]) {
    if (![...texts].some((entry) => entry.includes(text)))
      throw new Error(`Missing message: ${text}`);
  }

  // A narrow phone viewport keeps Start and the first question's input reachable.
  await setViewport(cdp, 390, 844);
  await navigate(cdp, `${origin}/player/`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  const narrowDeadline = Date.now() + 20_000;
  while (
    (await value(cdp, `document.querySelector('[data-composer-input]')?.placeholder`)) !==
    "What you call her"
  ) {
    if (Date.now() > narrowDeadline)
      throw new Error("The narrow demo did not reach its first question");
    if (await value(cdp, `document.querySelector('[data-composer-input]')?.disabled === false`)) {
      await evaluate(cdp, `document.querySelector('[data-composer-input]').focus()`);
      await pressSpace(cdp);
    }
    await delay(150);
  }
  const inputVisible = await value(
    cdp,
    `(() => { const rect = document.querySelector('[data-composer-input]').getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth && rect.height > 0; })()`,
  );
  assertEqual(
    inputVisible,
    true,
    "The narrow layout keeps the question's input inside the viewport",
  );
  await cdp.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
}

// A skippable message's pacing settles from a primary press on unused Player space or from Space in the empty
// composer. A Player control, a press on message text, and Space while the composer holds text keep their own behavior.
// It runs as the demo's session message starts its 7.8 s default pacing, so within it only a skip shows the next one.
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
  // Message text is not unused space: a stationary press on it is reading, not a skip.
  const latestMessage = `[...document.querySelectorAll('[data-slot=bubble], .prose')].at(-1)`;
  const messagePoint = await value(
    cdp,
    `(() => { const message = ${latestMessage}, rect = message.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2; return message.contains(document.elementFromPoint(x, y)) ? { x, y } : null; })()`,
  );
  assertEqual(
    messagePoint !== null,
    true,
    "The latest message must be on screen to receive a press",
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await cdp.call("Input.dispatchMouseEvent", {
      type,
      ...messagePoint,
      button: "left",
      clickCount: 1,
    });
  await unchanged("A press on message text skipped the message's pacing");
  const input = `document.querySelector('[data-composer-input]')`;
  await evaluate(cdp, `${input}.focus()`);
  await cdp.call("Input.insertText", { text: "x" });
  await pressSpace(cdp);
  await unchanged("Space in a composer holding text skipped pacing");
  assertEqual(await value(cdp, `${input}.value`), "x ", "Space in the composer must type a space");
  await evaluate(
    cdp,
    `${input}.value = ''; ${input}.dispatchEvent(new Event('input', {bubbles:true}))`,
  );
  await physicalClick(cdp, ".player-stage");
  await waitFor(
    cdp,
    `${messageCount} > ${gate}`,
    1_000,
    "A press on unused space did not skip pacing",
  );
}

// It runs as a message starts its 3.6 s default pacing: Space in the empty composer shows the next message at once.
async function spaceSkipCheck(cdp) {
  const messageCount = `Number(document.querySelector('.transcript-entry')?.getAttribute('aria-setsize') ?? 0)`;
  const gate = await value(cdp, messageCount);
  await evaluate(cdp, `document.querySelector('[data-composer-input]').focus()`);
  await pressSpace(cdp);
  await waitFor(
    cdp,
    `${messageCount} > ${gate}`,
    1_000,
    "Space in the empty composer did not skip pacing",
  );
}

/** A presented `showButton` is exposed to assistive technology under its visible label. */
async function buttonNameCheck(cdp, label) {
  const document = await cdp.call("DOM.getDocument", { depth: 0 });
  const query = await cdp.call("Accessibility.queryAXTree", {
    nodeId: document.result.root.nodeId,
    accessibleName: label,
    role: "button",
  });
  if (query.error !== undefined)
    throw new Error(`Accessibility query failed: ${query.error.message}`);
  assertEqual(
    query.result.nodes.length,
    1,
    `The ${JSON.stringify(label)} button is named by its label`,
  );
}

// A press on empty Stage space that is held past the current message's pacing deadline must not skip the next
// message's pacing on release (the gesture belongs to the message presented at press time).
async function staleSkipGestureCheck(cdp) {
  const point = async (selector) =>
    value(
      cdp,
      `(() => { const rect = [...document.querySelectorAll(${JSON.stringify(selector)})].at(-1).getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`,
    );
  // The transcript is virtualized, so count messages through its list size rather than rendered entries.
  const count = `Number(document.querySelector('.transcript-entry')?.getAttribute('aria-setsize') ?? 0)`;
  // Read back in the transcript first, so new messages do not scroll it while the button is held.
  const transcript = await point(".transcript-entry");
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...transcript,
    deltaX: 0,
    deltaY: -2000,
  });
  await delay(300);
  const before = await value(cdp, count);
  const stage = await point(".player-stage");
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...stage,
    button: "left",
    clickCount: 1,
  });
  // Hold until the current message's pacing and the script's wait end and the next message arrives.
  await waitFor(cdp, `${count} === ${before + 1}`, 15_000);
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...stage,
    button: "left",
    clickCount: 1,
  });
  await delay(500);
  assertEqual(
    await value(cdp, count),
    before + 1,
    "Releasing a held press skipped the next message's pacing",
  );
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...transcript,
    deltaX: 0,
    deltaY: 20000,
  });
  await delay(300);
}

// Smart follow with the demo's own paced messages: a reader who scrolled up stays in place while the next message
// arrives, and Return to latest resumes following, so the message after that appears above the composer.
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
  await evaluate(cdp, `document.querySelector('.transcript-scroll').focus()`);
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
    `(() => {
      const latest = document.querySelector('.transcript-entry[aria-posinset="' + ${count} + '"]')?.getBoundingClientRect();
      const composer = document.querySelector('[data-composer-shell]').getBoundingClientRect();
      return !!latest && latest.height > 0 && latest.top >= ${viewport}.top - 1 && latest.bottom <= composer.top + 1;
    })()`,
    2_000,
    "After Return to latest, the next message did not appear above the composer",
  );
}

// A click at the element's centre once it no longer moves in: a control that live play just showed enters the
// conversation for a moment, as do the messages it glides up with.
async function physicalClick(cdp, selector) {
  const point = await evaluate(
    cdp,
    `return new Promise((resolve) => {
      const target = document.querySelector(${JSON.stringify(selector)});
      const deadline = performance.now() + 2_000;
      const entering = () =>
        document.getAnimations().some((animation) =>
          animation.playState === "running" &&
          animation.effect?.getComputedTiming().endTime !== Infinity &&
          animation.effect?.target?.contains(target));
      const check = () => {
        if (entering() && performance.now() < deadline) return setTimeout(check, 16);
        const rect = target.getBoundingClientRect();
        resolve({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      };
      check();
    })`,
  );
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

// A physical click at the top left corner of the viewport, beside any centred dialog: on its backdrop.
async function backdropClick(cdp) {
  for (const type of ["mousePressed", "mouseReleased"])
    await cdp.call("Input.dispatchMouseEvent", { type, x: 8, y: 8, button: "left", clickCount: 1 });
}

/**
 * A physical click once the element stands still and nothing covers its centre. After a session is replaced, as by
 * Debug's rewind, the transcript remounts, measures its rows, and follows its end, so controls that are already present
 * move for a few frames, partly under the bar above the composer; a click in that window lands elsewhere.
 */
async function settledClick(cdp, selector, timeout = 5_000) {
  await settle(cdp, selector, timeout);
  await physicalClick(cdp, selector);
}

// Waits until the element has held its position for three animation frames with nothing covering its centre.
async function settle(cdp, selector, timeout = 5_000) {
  const settled = await evaluate(
    cdp,
    `return new Promise((resolve) => {
      const deadline = performance.now() + ${timeout};
      let previous = null;
      let stillFrames = 0;
      const check = () => {
        const target = document.querySelector(${JSON.stringify(selector)});
        const rect = target?.getBoundingClientRect();
        const position = rect ? [rect.left, rect.top, rect.width, rect.height].join() : null;
        const centre = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const uncovered = !!centre && target.contains(centre);
        stillFrames = position !== null && position === previous && uncovered ? stillFrames + 1 : 0;
        previous = position;
        if (stillFrames >= 3) resolve(true);
        else if (performance.now() > deadline) resolve(false);
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    })`,
  );
  if (!settled) throw new Error(`${selector} did not come to rest uncovered`);
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
          image.getAttribute('src') === '/dev-package/house/files/images/hall.svg' &&
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
async function keptSessionScenario(cdp, origin, profile) {
  await setViewport(cdp, 1440, 900);
  const start = "[data-session-start]";
  const messages = `[...document.querySelectorAll('.transcript-entry')].map((entry) => entry.textContent)`;
  const choice = (label) =>
    `[...document.querySelectorAll('[data-foreground-controls] button')].find((button) => button.textContent.trim() === '${label}')`;
  // Keeping is asynchronous browser storage; a reload waits until the kept snapshot includes `text`, such as the label
  // of the interaction it should come back to.
  const kept = (text) =>
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
  const reloadOnceKept = async (text) => {
    const deadline = Date.now() + 8_000;
    while (!(await kept(text))) {
      if (Date.now() > deadline) throw new Error("The session was not kept");
      await delay(50);
    }
    await cdp.call("Page.reload");
  };
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
  const point = await value(
    cdp,
    `(() => { const rect = document.querySelector('${start}').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`,
  );
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

// The debug room (DEBUGGER.md "Debug room"): `room=debug` opens it with Debug on, its bug filled inside, and its own
// start page, which offers Reload session and Reset session once there is something to delete; Debug off leaves the bug
// outlined. Debug on during a normal session goes on there with a copy, after a warning when it overwrites a debug
// session, while the normal session stays as it was.
async function debugRoomScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  const start = "[data-session-start]";
  const control = `document.querySelector('${start}')?.textContent.trim()`;
  const runs = `[...document.querySelectorAll('.transcript-entry')].flatMap((entry) => entry.textContent.match(/Run \\d+\\./g) ?? []).join()`;
  const anew = `[...document.querySelectorAll('[data-debug-reload], [data-debug-reset]')].map((button) => button.textContent.trim()).join()`;
  // A visit that keeps this browser's kept sessions and debug rooms.
  const visit = async (query) => {
    await cdp.call("Page.navigate", { url: `${origin}/player/?package=debug-room${query}` });
    await waitFor(
      cdp,
      `document.readyState === 'complete' && !!document.querySelector('${start}')`,
    );
  };
  // Keeping is asynchronous browser storage; a reload waits until the debug room keeps a session at its button.
  const reloadOnceKept = async () => {
    const deadline = Date.now() + 8_000;
    while (
      !(await evaluate(
        cdp,
        `return new Promise((resolve) => {
          const request = indexedDB.open('teasescript-debug-rooms');
          request.onsuccess = () => {
            const sessions = request.result.transaction('sessions').objectStore('sessions').getAll();
            sessions.onsuccess = () => { request.result.close(); resolve(sessions.result.some((session) => session.snapshotJson.includes('"Next"'))); };
            sessions.onerror = () => resolve(false);
          };
          request.onerror = () => resolve(false);
        })`,
      ))
    ) {
      if (Date.now() > deadline) throw new Error("The debug session was not kept");
      await delay(50);
    }
    await cdp.call("Page.reload");
    await waitFor(cdp, `!!document.querySelector('${start}')`);
  };

  const bug = `document.querySelector('[data-debug-room-indicator]')`;
  // The fill layer under the outline, filled with the theme's debug mark exactly in the bug's body and head, and whether
  // the outline's lines keep the text colour.
  const markRed = `(() => { const probe = document.createElement('span'); probe.style.color = 'var(--theme-debug-mark)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; })()`;
  const filled = `[...(${bug}.querySelectorAll('[data-debug-room-fill] path') ?? [])].filter((path) => getComputedStyle(path).fill !== 'none').map((path) => (getComputedStyle(path).fill === ${markRed} ? '' : 'not red: ') + path.getAttribute('d').slice(0, 6)).join(' ')`;
  const outline = `(() => { const style = getComputedStyle(${bug}.querySelector('svg:not([data-debug-room-fill])')); return style.stroke === style.color && style.fill === 'none'; })()`;
  await navigate(cdp, `${origin}/player/?package=debug-room&room=debug`);
  await waitFor(cdp, `${control} === 'Start debug session'`);
  assertEqual(
    await value(cdp, `[${bug}?.getAttribute('aria-label'), ${anew}].join()`),
    "Debug session · Debug on,",
    "A new debug room starts with Debug on and nothing to delete",
  );
  assertEqual(
    await value(cdp, `[${filled}, ${outline}].join()`),
    "M14 7a M9 7.1,true",
    "The bug's inside is filled while Debug is on, and its lines keep the text colour",
  );
  await physicalClick(cdp, "[data-settings-trigger]");
  await physicalClick(cdp, '[data-player-setting="debug-menu"]');
  await physicalClick(cdp, '[data-player-settings] [data-slot="dialog-close"]');
  await waitFor(
    cdp,
    `${bug}?.getAttribute('aria-label') === 'Debug session · Debug off' && !${bug}.querySelector('[data-debug-room-fill]') && ${outline} && !document.querySelector('[data-player-settings]')`,
    8_000,
    "Debug off did not leave the bug outlined",
  );
  await physicalClick(cdp, start);
  await waitFor(cdp, `${runs} === 'Run 1.'`);
  await reloadOnceKept();
  await waitFor(cdp, `${control} === 'Continue debug session'`);
  assertEqual(
    await value(cdp, anew),
    "Reload session,Reset session",
    "A debug room with a session offers Reload session and Reset session",
  );
  await physicalClick(cdp, "[data-debug-reload]");
  await waitFor(cdp, `${runs} === 'Run 2.'`, 8_000, "Reload session did not keep the saved data");
  await reloadOnceKept();
  await waitFor(cdp, `!!document.querySelector('[data-debug-reset]')`);
  await physicalClick(cdp, "[data-debug-reset]");
  await waitFor(cdp, `${runs} === 'Run 1.'`, 8_000, "Reset session did not delete the saved data");

  // Debug on during a normal session overwrites the debug session after a warning, and goes on with a copy.
  await visit("");
  await waitFor(cdp, `${control} === 'Start'`);
  await physicalClick(cdp, start);
  await waitFor(cdp, `${runs} === 'Run 1.'`);
  await physicalClick(cdp, "[data-settings-trigger]");
  await physicalClick(cdp, '[data-player-setting="debug-menu"]');
  await waitFor(cdp, `!!document.querySelector('[data-confirm-dialog="debug-session-overwrite"]')`);
  await physicalClick(cdp, "[data-confirm-action]");
  await physicalClick(cdp, '[data-player-settings] [data-slot="dialog-close"]');
  await waitFor(
    cdp,
    `new URLSearchParams(location.search).get('room') === 'debug' && !!document.querySelector('[data-debug-room-indicator]') && ${runs} === 'Run 1.'`,
    8_000,
    "Debug on did not go on with the copy in the debug room",
  );
  await visit("");
  await waitFor(cdp, `${control} === 'Continue'`);
  await physicalClick(cdp, start);
  await waitFor(
    cdp,
    `${runs} === 'Run 1.' && !document.querySelector('[data-debug-room-indicator]')`,
    8_000,
    "The normal session did not stay as it was",
  );
}

// Debug's random draws (DEBUGGER.md "Random draws"): with Choose outcomes on, the picker asks at each draw, not modal:
// the theme toggle works while Settings waits. It names the draw's script and file, marks the draw in the code, whose
// tools show on hover and whose large view the dialogs' X closes, and resizes the code a line at a time. An outcome, a
// typed value, a new order, and Least tried each go on with the script.
async function randomPickerScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  const picker = (kind) =>
    `!!document.querySelector('[data-random-draw-picker][data-random-draw-kind="${kind}"]')`;
  const said = `[...document.querySelectorAll('.transcript-entry')].map((entry) => entry.textContent).join('|')`;
  const text = (selector, separator = " ") =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].map((node) => node.textContent.trim()).join(${JSON.stringify(separator)})`;
  const tools = `getComputedStyle(document.querySelector('[data-random-draw-source] [data-code-block-tools]')).opacity`;
  const key = async (name, code) => {
    for (const type of ["keyDown", "keyUp"])
      await cdp.call("Input.dispatchKeyEvent", { type, key: name, code });
  };
  await navigate(cdp, `${origin}/player/?package=random-picker&room=debug`);
  await waitFor(cdp, `!!document.querySelector('[data-session-start]')`);
  await physicalClick(cdp, '[data-launcher] button[aria-label="Debug"]');
  await waitFor(cdp, `!!document.querySelector('[data-debug-random-active]')`);
  await physicalClick(cdp, "[data-debug-random-active]");
  await physicalClick(cdp, "[data-session-start]");
  await waitFor(cdp, picker("chance"), 8_000, "The picker did not ask at the first draw");
  assertEqual(
    await value(cdp, text("[data-random-draw-location] li:not([role=presentation])")),
    "random-picker main.tease",
    "The breadcrumb did not start at the package",
  );
  assertEqual(
    await value(cdp, text("[data-random-draw-source] [data-code-mark]", "")),
    "chance(25)",
    "The draw was not marked",
  );
  // Not modal: the display controls work, Settings waits for the outcome.
  const theme = `document.documentElement.dataset.playerTheme`;
  const before = await value(cdp, theme);
  await physicalClick(cdp, "[data-theme-mode-control]");
  await waitFor(
    cdp,
    `${theme} !== ${JSON.stringify(before)}`,
    5_000,
    "The theme toggle did not work beside the picker",
  );
  await physicalClick(cdp, "[data-theme-mode-control]");
  await physicalClick(cdp, "[data-settings-trigger]");
  await delay(300);
  assertEqual(
    await value(cdp, `!!document.querySelector('[data-player-settings]')`),
    false,
    "Settings opened beside the picker",
  );
  // With a mouse, the code's tools show while the pointer is over the code; where the pointer cannot hover, as in a
  // headless browser without a mouse, they always show. Expand opens it large, and the dialogs' X closes that.
  if (await value(cdp, `matchMedia("(hover: hover)").matches`)) {
    assertEqual(
      await value(cdp, tools),
      "0",
      "The code's tools showed without the pointer over it",
    );
    const block = await evaluate(
      cdp,
      `const rect = document.querySelector('[data-random-draw-source] [data-code-block]').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`,
    );
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: block.x, y: block.y });
    await waitFor(cdp, `${tools} === "1"`, 5_000, "The code's tools did not show on hover");
  } else assertEqual(await value(cdp, tools), "1", "The code's tools hid without hover");
  // Without the clipboard API, as over plain HTTP, Copy copies the lines in view the older way and keeps focus; where
  // the browser refuses that too, it selects them instead of claiming a copy.
  const copyButton = `document.querySelector('[data-random-draw-source] [data-code-block-copy]')`;
  await evaluate(
    cdp,
    `window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); document.addEventListener('copy', () => { const area = document.activeElement; window.__copied = area.value.slice(area.selectionStart, area.selectionEnd); }, { once: true });`,
  );
  await physicalClick(cdp, "[data-random-draw-source] [data-code-block-copy]");
  await waitFor(
    cdp,
    `${copyButton}.getAttribute('aria-label') === "Copied"`,
    5_000,
    "Copy without the clipboard API did not copy",
  );
  assertEqual(
    await value(
      cdp,
      `window.__copied?.includes("chance(25)") && document.activeElement === ${copyButton}`,
    ),
    true,
    "Copy without the clipboard API lost the lines in view or the focus",
  );
  await evaluate(cdp, `document.execCommand = () => false;`);
  await physicalClick(cdp, "[data-random-draw-source] [data-code-block-copy]");
  await waitFor(
    cdp,
    `${copyButton}.getAttribute('aria-label').startsWith("Copying is not available here")`,
    5_000,
    "A refused copy claimed to copy",
  );
  // After the mouse click, the tooltip says why nothing was copied.
  await waitFor(
    cdp,
    `document.querySelector('[data-slot="tooltip-content"]')?.textContent.trim().startsWith("Copying is not available here") === true`,
    5_000,
    "A refused copy did not say why in its tooltip",
  );
  assertEqual(
    await value(cdp, `String(document.getSelection()).includes("chance(25)")`),
    true,
    "A refused copy did not select the lines in view",
  );
  // Escape and at once Enter on Copy, which still has focus, refuse again: the label still says why.
  for (const [key, code] of [
    ["Escape", 27],
    ["Enter", 13],
  ])
    for (const type of ["keyDown", "keyUp"])
      await cdp.call("Input.dispatchKeyEvent", {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: code,
      });
  await delay(40);
  assertEqual(
    await value(
      cdp,
      `document.activeElement === ${copyButton} && ${copyButton}.getAttribute('aria-label').startsWith("Copying is not available here")`,
    ),
    true,
    "A refused copy retried at once by key lost its explanation",
  );
  await evaluate(
    cdp,
    `delete document.execCommand; delete navigator.clipboard; document.getSelection().removeAllRanges();`,
  );
  await physicalClick(cdp, "[data-random-draw-source] [data-code-block-expand]");
  await waitFor(
    cdp,
    `!!document.querySelector('[data-code-block-lightbox] [data-code-mark]')`,
    5_000,
    "Expand did not open the code large",
  );
  // Copy works without the clipboard API in the large view too, whose dialog keeps focus inside it.
  await evaluate(
    cdp,
    `Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });`,
  );
  await physicalClick(cdp, "[data-code-block-lightbox] [data-code-block-copy]");
  await waitFor(
    cdp,
    `document.querySelector('[data-code-block-lightbox] [data-code-block-copy]').getAttribute('aria-label') === "Copied"`,
    5_000,
    "Copy without the clipboard API did not copy in the large view",
  );
  await evaluate(cdp, `delete navigator.clipboard;`);
  await physicalClick(cdp, '[data-code-block-lightbox] [data-slot="dialog-close"]');
  await waitFor(
    cdp,
    `!document.querySelector('[data-code-block-lightbox]') && ${picker("chance")}`,
    5_000,
    "The X did not close the large view",
  );
  // The corner grip resizes a whole line at a time.
  await evaluate(
    cdp,
    `document.querySelector('[data-random-draw-source] [data-code-block-resize]').focus()`,
  );
  await key("ArrowDown", "ArrowDown");
  assertEqual(
    await value(
      cdp,
      `document.querySelector('[data-random-draw-source] [data-code-block-resize]').getAttribute('aria-valuenow')`,
    ),
    "8",
    "The grip did not add a line",
  );
  // The tools sidebar's shortcut waits too, also from a control in the picker.
  const sidebar = `document.querySelector('#player-shell').dataset.sidebarVisible`;
  const shown = await value(cdp, sidebar);
  for (const type of ["keyDown", "keyUp"])
    await cdp.call("Input.dispatchKeyEvent", {
      type,
      key: "b",
      code: "KeyB",
      windowsVirtualKeyCode: 66,
      modifiers: 2,
    });
  await delay(200);
  assertEqual(
    await value(cdp, `${sidebar} + ' ' + ${picker("chance")}`),
    `${shown} true`,
    "Ctrl+B changed the sidebar while the picker asked",
  );

  // Tab from the grip onto the first outcome: the outcome list, which clips because it scrolls, keeps room for the
  // outcome's 2px focus outline and its 2px separation.
  for (let presses = 0; presses < 5; presses += 1) {
    if (await value(cdp, `!!document.activeElement.closest('[data-random-draw-outcomes]')`)) break;
    for (const type of ["keyDown", "keyUp"])
      await cdp.call("Input.dispatchKeyEvent", {
        type,
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
      });
  }
  assertEqual(
    await value(
      cdp,
      `(() => {
        const list = document.querySelector('[data-random-draw-outcomes]').getBoundingClientRect();
        const outcome = document.activeElement.closest('[data-random-draw-outcome]')?.getBoundingClientRect();
        return !!outcome && Math.min(outcome.top - list.top, list.bottom - outcome.bottom, outcome.left - list.left, list.right - outcome.right) >= 4;
      })()`,
    ),
    true,
    "The outcome list clipped a focused outcome's outline",
  );

  await physicalClick(cdp, "[data-random-draw-outcome]");
  await waitFor(
    cdp,
    `${picker("randomNormal")} && ${said}.includes('Hit: true')`,
    8_000,
    "The chosen outcome did not reach the script",
  );
  await evaluate(cdp, `document.querySelector('[data-random-draw-value]').focus()`);
  await cdp.call("Input.insertText", { text: "42" });
  await physicalClick(cdp, "[data-random-draw-use]");
  await waitFor(
    cdp,
    `${picker("shuffle")} && ${said}.includes('Value: 42')`,
    8_000,
    "The typed value did not reach the script",
  );
  await physicalClick(cdp, '[data-random-draw-item] button[aria-label="Move down"]');
  await physicalClick(cdp, "[data-random-draw-use]");
  await waitFor(
    cdp,
    `${picker("chance")} && ${said}.includes('First: green')`,
    8_000,
    "The new order did not reach the script",
  );
  await physicalClick(cdp, "[data-random-draw-untried]");
  await waitFor(
    cdp,
    `!document.querySelector('[data-random-draw-picker]') && ${said}.includes('Again: ')`,
    8_000,
    "Least tried did not go on",
  );
}

// In a file of a few thousand lines the picker's unwrapped code renders only the lines in and near view, and shows like
// a short file's: the draw's line in the middle from the first frame and through Wrap, Copy copies the lines in view,
// it scrolls sideways as far as its widest line, its large view opens on the draw, Show whole function starts at the
// function's first line, the file's end scrolls into view, and Show less returns to the draw.
async function largeRandomPickerScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  const block = `document.querySelector('[data-random-draw-source] [data-code-block]')`;
  const rendered = (scope) => `document.querySelectorAll('${scope} [data-code-line]').length`;
  const inView = (number) =>
    `(() => { const line = ${block}.querySelector('[data-code-line="${number}"]'); return !!line && line.offsetTop >= ${block}.scrollTop && line.offsetTop + line.offsetHeight <= ${block}.scrollTop + ${block}.clientHeight; })()`;
  const centred = `(() => { const line = ${block}?.querySelector('[data-code-highlight]'); return line?.dataset.codeLine === '1500' && line.offsetTop - ${block}.scrollTop === 3 * line.offsetHeight; })()`;
  // Where the draw's line is in each of the next frames once the code shows: 0 in its place, null when not rendered.
  // Sampling starts at once, or with the next click.
  const sampleFrames = (count, onClick = false) =>
    `window.__frames = []; const sample = () => { const block = ${block}; if (block) { const line = block.querySelector('[data-code-highlight]'); window.__frames.push(line ? line.offsetTop - block.scrollTop - 3 * line.offsetHeight : null); } if (window.__frames.length < ${count}) requestAnimationFrame(sample); }; ${onClick ? "addEventListener('click', () => requestAnimationFrame(sample), { capture: true, once: true });" : "sample();"}`;
  const stayed = async (message) => {
    await waitFor(cdp, `window.__frames.length >= 8`, 20_000);
    assertEqual(
      await value(cdp, `JSON.stringify(window.__frames)`),
      JSON.stringify(Array(8).fill(0)),
      message,
    );
  };
  await navigate(cdp, `${origin}/player/?package=large-file&room=debug`);
  await waitFor(cdp, `!!document.querySelector('[data-session-start]')`);
  if (!(await value(cdp, `!!document.querySelector('[data-debug-random-active]')`)))
    await physicalClick(cdp, '[data-launcher] button[aria-label="Debug"]');
  await waitFor(cdp, `!!document.querySelector('[data-debug-random-active]')`);
  await physicalClick(cdp, "[data-debug-random-active]");
  await evaluate(cdp, sampleFrames(8));
  await physicalClick(cdp, "[data-session-start]");
  // The draw's line has three lines above it, like a short file's, from the first frame the code shows.
  await stayed("The code did not open with the draw's line in the middle");
  assertEqual(
    await value(
      cdp,
      `[...${block}.querySelectorAll('[data-code-mark]')].map((node) => node.textContent).join('')`,
    ),
    "chance(25)",
    "The draw was not marked",
  );
  // Regression oracle for rendering every line of the file, which took seconds in a file of thousands of lines.
  if ((await value(cdp, rendered("[data-random-draw-source]"))) > 100)
    throw new Error("The picker rendered most of a file of thousands of lines");
  await evaluate(
    cdp,
    `window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.__copied = value; } } });`,
  );
  await physicalClick(cdp, "[data-random-draw-source] [data-code-block-copy]");
  await waitFor(cdp, `window.__copied !== null`, 5_000, "Copy did not copy");
  assertEqual(
    await value(cdp, `window.__copied`),
    LARGE_FILE_LINES.slice(1_496, 1_503).join("\n"),
    "Copy did not copy the lines in view",
  );
  assertEqual(
    await value(cdp, `${block}.scrollWidth > ${block}.clientWidth + 200`),
    true,
    "The code scrolled sideways only as far as the lines near view",
  );
  // Wrapping the lines above the draw's keeps the draw's line in place in every frame from the click, and so does
  // unwrapping them, also after scrolling the wrapped lines.
  for (const state of ["on", "off"]) {
    if (state === "off") await evaluate(cdp, `${block}.scrollTop -= 600`);
    await evaluate(cdp, sampleFrames(8, true));
    await physicalClick(cdp, "[data-random-draw-source] [data-code-block-wrap]");
    await stayed(`Wrap ${state} moved the draw's line`);
  }
  await physicalClick(cdp, "[data-random-draw-source] [data-code-block-expand]");
  await waitFor(
    cdp,
    `[...document.querySelectorAll('[data-code-block-lightbox] [data-code-mark]')].map((node) => node.textContent).join('') === 'chance(25)' && (() => { const block = document.querySelector('[data-code-block-lightbox] [data-code-block]'); const line = block.querySelector('[data-code-highlight]'); return Math.abs(line.offsetTop - block.scrollTop + line.offsetHeight / 2 - block.clientHeight / 2) <= 1; })()`,
    5_000,
    "The large view did not open with the draw's line in the middle",
  );
  if ((await value(cdp, rendered("[data-code-block-lightbox]"))) > 200)
    throw new Error("The large view rendered most of a file of thousands of lines");
  await physicalClick(cdp, '[data-code-block-lightbox] [data-slot="dialog-close"]');
  await waitFor(cdp, `!document.querySelector('[data-code-block-lightbox]')`);
  await physicalClick(cdp, "[data-random-draw-expand]");
  await waitFor(
    cdp,
    `(() => { const line = ${block}.querySelector('[data-code-line="1200"]'); return !!line && Math.abs(line.offsetTop - ${block}.scrollTop) < 1; })()`,
    5_000,
    "Show whole function did not start at the function's first line",
  );
  await evaluate(cdp, `${block}.scrollTop = ${block}.scrollHeight`);
  await waitFor(cdp, inView(2000), 5_000, "The file's last line did not scroll into view");
  await evaluate(
    cdp,
    `document.querySelector('[data-random-draw-expand]').scrollIntoView({ block: 'nearest' })`,
  );
  await physicalClick(cdp, "[data-random-draw-expand]");
  await waitFor(cdp, centred, 5_000, "Show less did not return to the draw's line");

  await physicalClick(cdp, "[data-random-draw-outcome]");
  await waitFor(
    cdp,
    `[...document.querySelectorAll('.transcript-entry')].some((entry) => entry.textContent.includes('Hit: true'))`,
    8_000,
    "The chosen outcome did not reach the script",
  );
}

async function titleBarScenario(cdp, origin) {
  const title = `document.querySelector('.player-top-bar-title').textContent`;
  const open = async (query) => {
    await navigate(cdp, `${origin}/player/?${query}`);
    await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  };
  await setViewport(cdp, 1440, 900);
  await open("package=title-header");
  assertEqual(await value(cdp, title), "Title fixture by Author fixture", "Title and author");
  assertEqual(
    await value(cdp, `!!document.querySelector('[data-player-title-full]')`),
    false,
    "A title that fits offered to open in full",
  );
  await open("dev&package=title-author");
  assertEqual(await value(cdp, title), "by Author fixture", "Author only, in the preview");
  await open("package=house");
  assertEqual(await value(cdp, title), "The house", "Title only");

  // The title takes the display controls' corners. The sidebar toggle is flat like the menu's tools while the sidebar is
  // open, and raised like the display controls in the title bar while it is hidden.
  const look = (selector) =>
    `(() => { const style = getComputedStyle(document.querySelector(${JSON.stringify(selector)})); return [style.borderRadius, style.borderTopWidth, style.borderTopStyle, style.boxShadow, style.backgroundColor].join(" | "); })()`;
  const radius = (selector) =>
    `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).borderRadius`;
  assertEqual(
    await value(cdp, radius(".player-top-bar-title > :is(span, button)")),
    await value(cdp, radius(".player-top-bar-actions")),
    "The title's corners differ from the display controls'",
  );
  assertEqual(
    await value(cdp, look('[data-tools-surface] [data-sidebar="trigger"]')),
    await value(
      cdp,
      look('[data-launcher] [data-sidebar="menu-button"]:not([data-active="true"])'),
    ),
    "The open sidebar's toggle looks different from the menu's tools",
  );
  await physicalClick(cdp, '[data-tools-surface] [data-sidebar="trigger"]');
  await waitFor(cdp, `!!document.querySelector('[data-player-top-bar] [data-sidebar="trigger"]')`);
  assertEqual(
    await value(cdp, look('[data-player-top-bar] [data-sidebar="trigger"]')),
    await value(cdp, look(".player-top-bar-actions")),
    "The title bar's sidebar toggle looks different from the display controls",
  );
  await physicalClick(cdp, '[data-player-top-bar] [data-sidebar="trigger"]');
  await waitFor(cdp, `!document.querySelector('[data-player-top-bar] [data-sidebar="trigger"]')`);
  // A dialog's X takes a click anywhere within 16px of its centre, at least 32px across.
  await physicalClick(cdp, "[data-settings-trigger]");
  await waitFor(
    cdp,
    `!!document.querySelector('[data-player-settings] [data-slot="dialog-close"]')`,
  );
  await delay(300);
  assertEqual(
    await value(
      cdp,
      `(() => { const close = document.querySelector('[data-player-settings] [data-slot="dialog-close"]'); const rect = close.getBoundingClientRect(); const [x, y] = [rect.left + rect.width / 2, rect.top + rect.height / 2]; return [[-16, 0], [16, 0], [0, -16], [0, 16]].every(([dx, dy]) => close.contains(document.elementFromPoint(x + dx, y + dy))); })()`,
    ),
    true,
    "The dialog's X has a small target",
  );
  await physicalClick(cdp, '[data-player-settings] [data-slot="dialog-close"]');
  await waitFor(cdp, `!document.querySelector('[data-player-settings]')`);
  // An open tool is flat too, with only the selected fill; hovering it deepens that fill to the pressed tone rather
  // than lightening it into a closed tool's hover.
  await open("package=house&room=debug");
  const tool = '[data-launcher] button[aria-label="Debug"]';
  await physicalClick(cdp, tool);
  await waitFor(cdp, `document.querySelector(${JSON.stringify(tool)})?.dataset.active === "true"`);
  // A fill as the menu resolves a theme role.
  const tone = (role) =>
    `(() => { const probe = document.createElement("span"); probe.style.backgroundColor = "var(${role})"; document.querySelector("[data-launcher]").append(probe); const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color; })()`;
  const fill = `getComputedStyle(document.querySelector(${JSON.stringify(tool)})).backgroundColor`;
  const selected = await value(cdp, tone("--theme-surface-selected"));
  await waitFor(
    cdp,
    `${fill} === ${JSON.stringify(selected)}`,
    5_000,
    "The open tool lost its selected fill",
  );
  assertEqual(
    await value(cdp, `getComputedStyle(document.querySelector(${JSON.stringify(tool)})).boxShadow`),
    await value(
      cdp,
      `getComputedStyle(document.querySelector("[data-settings-trigger]")).boxShadow`,
    ),
    "The open tool has a marker besides its fill",
  );
  // Its hover tone is the pressed tone, where a closed tool's is the lighter hover tone. The headless browser has no
  // hover, so the tones are read from the variables the shared button hover uses.
  const hoverTone = (selector) =>
    `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).getPropertyValue("--button-hover").trim()`;
  assertEqual(
    await value(cdp, hoverTone(tool)),
    await value(
      cdp,
      `getComputedStyle(document.querySelector("[data-launcher]")).getPropertyValue("--component-pressed").trim()`,
    ),
    "Hovering the open tool does not deepen its fill",
  );
  assertEqual(
    (await value(cdp, hoverTone(tool))) ===
      (await value(cdp, hoverTone("[data-settings-trigger]"))),
    false,
    "The open tool hovers like a closed one",
  );

  const full = "A title too long for the title bar of a narrow screen by Author fixture";
  // The bar's tooltip, read once: its content also holds a copy for assistive technology.
  const tooltip = `document.querySelector('[data-player-title-tooltip] [role="tooltip"]')?.textContent.trim() ?? null`;
  await setViewport(cdp, 390, 760);
  await open("package=title-long");
  await waitFor(
    cdp,
    `!!document.querySelector('[data-player-title-full]')`,
    5_000,
    "No full title",
  );
  await touchTap(cdp, "[data-player-title-full]");
  await waitFor(
    cdp,
    `${tooltip} === ${JSON.stringify(full)}`,
    5_000,
    "A tap did not show the full title",
  );

  // A title without spaces wraps inside the tooltip rather than running off the screen.
  await open("package=title-unbroken");
  await touchTap(cdp, "[data-player-title-full]");
  await waitFor(cdp, `!!document.querySelector('[data-player-title-tooltip]')`);
  assertEqual(
    await value(
      cdp,
      `(() => { const tooltip = document.querySelector('[data-player-title-tooltip]'); const box = tooltip.getBoundingClientRect(); return tooltip.scrollWidth <= tooltip.clientWidth && box.left >= 0 && box.right <= innerWidth; })()`,
    ),
    true,
    "An unbroken title ran out of its tooltip or off the screen",
  );
  // A bar too narrow for the title hides it visually and keeps it plain text, never an invisible control.
  await setViewport(cdp, 180, 760);
  await open("package=title-long");
  assertEqual(
    await value(cdp, `!!document.querySelector('[data-player-title-full]')`),
    false,
    "A visually hidden title became a control",
  );

  // The auto-hide bar on a short screen: the first tap reveals it, the next opens the title.
  await evaluate(cdp, `localStorage.setItem('player-titlebar-variant', 'overlap')`);
  try {
    await setViewport(cdp, 600, 380);
    await open("package=title-long");
    await waitFor(
      cdp,
      `!document.querySelector('[data-player-top-bar]').checkVisibility({ opacityProperty: true }) && !!document.querySelector('[data-player-title-full]')`,
      6_000,
      "The auto-hide bar did not start hidden with a cut-off title",
    );
    await touchTap(cdp, "[data-player-title-full]");
    await waitFor(
      cdp,
      `document.querySelector('[data-player-top-bar]').hasAttribute('data-revealed')`,
    );
    assertEqual(await value(cdp, tooltip), null, "The tap that revealed the bar opened the title");
    await touchTap(cdp, "[data-player-title-full]");
    await waitFor(
      cdp,
      `${tooltip} === ${JSON.stringify(full)}`,
      5_000,
      "A tap did not show the full title",
    );
  } finally {
    await evaluate(cdp, `localStorage.removeItem('player-titlebar-variant')`);
    await setViewport(cdp, 1440, 900);
  }
}

/** A touch tap at the middle of the first element `selector` matches. */
async function touchTap(cdp, selector) {
  const point = await value(
    cdp,
    `(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`,
  );
  await cdp.call("Emulation.setTouchEmulationEnabled", { enabled: true });
  try {
    await cdp.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await cdp.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.call("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
}

async function missingMediaScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  const button = (label) =>
    `[...document.querySelectorAll('[data-foreground-controls] button')].some((button) => button.textContent.trim() === ${JSON.stringify(label)})`;
  const notices = `[...document.querySelectorAll('[data-player-notice]')].map((notice) => notice.getAttribute('data-notice-level') + ' ' + notice.querySelector('p').textContent.trim())`;
  await navigate(cdp, `${origin}/player/?dev&package=missing-media&time=skip`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  // Its 30 s wait and both failed blocking plays pass at once.
  await waitFor(cdp, button("Next"), 5_000, "Failed media held the session before Next");
  // The browser has tried the invalid image before the script replaces it, and the Stage stays empty.
  await waitFor(
    cdp,
    `(() => {
      const image = document.querySelector('.stage-media');
      return !!image && image.complete && image.naturalWidth === 0 &&
        image.getAttribute('src') === '/dev-package/missing-media/files/images/corrupt.png' &&
        getComputedStyle(image).display === 'none';
    })()`,
    5_000,
    "The invalid image did not leave the Stage empty",
  );
  await physicalClick(cdp, "[data-foreground-controls] button");
  await waitFor(cdp, button("Finish"), 5_000, "Failed media held the session before Finish");
  await waitFor(
    cdp,
    `(() => {
      const image = document.querySelector('.stage-media');
      return !!image && image.complete && image.naturalWidth > 0 &&
        image.getAttribute('src') === '/dev-package/missing-media/files/images/valid.svg' &&
        getComputedStyle(image).display !== 'none';
    })()`,
    5_000,
    "The valid image did not restore the Stage",
  );
  await physicalClick(cdp, "[data-notification-bell]");
  await waitFor(cdp, `!!document.querySelector('[data-player-notification-panel]')`);
  assertEqual(
    JSON.stringify(await value(cdp, `${notices}.sort()`)),
    JSON.stringify([
      "warning Warning: Audio could not be loaded: sounds/corrupt.wav (main.tease, line 15)",
      "warning Warning: Audio not found: sounds/missing.wav (main.tease, line 14)",
      "warning Warning: Image could not be loaded: avatars/corrupt.png",
      "warning Warning: Image could not be loaded: images/corrupt.png",
      "warning Warning: Image not found: avatars/missing.png",
      "warning Warning: Image not found: images/missing.png",
    ]),
    "The notifications did not list one warning per unusable path",
  );
}

/**
 * The `audio-overlap` package plays one sound twice with overlap, then another sound, then the same sound in a loop of
 * 30 overlapping instances. `seeked` notifications arrive late, as under load, after playback already began. Each
 * instance plays to its end once on its own element, without rewinding or stopping another, and releases its element
 * for reuse when it ends.
 */
async function audioOverlapScenario(cdp, origin) {
  const {
    result: { identifier },
  } = await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__instances = [];
      window.__samples = [];
      window.__elements = new Set();
      // Released elements not used again yet, and how often an instance got a new element while one of them was free.
      window.__free = new Set();
      window.__newWhileFree = 0;
      window.__lateSeeked = 0;
      const current = new Map();
      const prototype = HTMLMediaElement.prototype;
      const src = Object.getOwnPropertyDescriptor(prototype, 'src');
      Object.defineProperty(prototype, 'src', {
        ...src,
        set(value) {
          if (!window.__free.delete(this) && window.__free.size > 0) window.__newWhileFree++;
          window.__elements.add(this);
          src.set.call(this, value);
          if (!String(value).includes('/dev-package/audio-overlap/')) return current.delete(this);
          const instance = { file: String(value).split('/').pop(), plays: 0, end: false, time: 0, rewound: false, released: false };
          window.__instances.push(instance);
          current.set(this, instance);
        },
      });
      const removeAttribute = Element.prototype.removeAttribute;
      prototype.removeAttribute = function (name) {
        const instance = current.get(this);
        if (name === 'src' && instance) instance.released = true;
        if (name === 'src') window.__free.add(this);
        return removeAttribute.call(this, name);
      };
      const play = prototype.play;
      prototype.play = function () {
        const instance = current.get(this);
        if (instance && this.getAttribute('src')) instance.plays++;
        return play.call(this);
      };
      // The device pauses an instance at its end and before releasing its element: record whether it reached the end.
      const pause = prototype.pause;
      prototype.pause = function () {
        const instance = current.get(this);
        if (instance && this.getAttribute('src') && this.currentTime >= this.duration) instance.end = true;
        return pause.call(this);
      };
      // Delivers each seeked notification 60 ms late, and not before the element played on from the seek, which under
      // load can take longer; after 2 seconds it is delivered anyway.
      const late = new WeakMap();
      const addEventListener = prototype.addEventListener;
      const removeEventListener = prototype.removeEventListener;
      prototype.addEventListener = function (type, listener, options) {
        if (type !== 'seeked') return addEventListener.call(this, type, listener, options);
        if (!late.has(listener))
          late.set(listener, (event) => {
            const deadline = performance.now() + 2_000;
            const deliver = () => {
              const playedOn = !this.paused && this.currentTime > 0;
              if (!playedOn && performance.now() < deadline) return setTimeout(deliver, 10);
              if (playedOn) window.__lateSeeked++;
              listener.call(this, event);
            };
            setTimeout(deliver, 60);
          });
        return addEventListener.call(this, type, late.get(listener), options);
      };
      prototype.removeEventListener = function (type, listener, options) {
        return removeEventListener.call(this, type, (type === 'seeked' && late.get(listener)) || listener, options);
      };
      setInterval(() => {
        const playing = [];
        for (const [element, instance] of current) {
          if (!element.getAttribute('src')) continue;
          if (element.currentTime < instance.time) instance.rewound = true;
          instance.time = element.currentTime;
          if (!element.paused) playing.push([window.__instances.indexOf(instance), element.currentTime]);
        }
        window.__samples.push(playing);
      }, 25);`,
  });
  try {
    const transcript = (text) =>
      `[...document.querySelectorAll('.transcript-entry')].some((entry) => entry.textContent.includes(${JSON.stringify(text)}))`;
    // Each instance played once, to its end, without moving back.
    const once = (instance) => instance.plays === 1 && instance.end && !instance.rewound;
    await navigate(cdp, `${origin}/player/?package=audio-overlap`);
    await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
    await physicalClick(cdp, "[data-session-activation] button");
    await waitFor(cdp, transcript("Overlap done"), 10_000, "The overlapping sounds did not finish");
    // The script's waits do not wait for what is heard, and under load playback starts late: judge the three instances
    // once the device has released them.
    await waitFor(
      cdp,
      `window.__instances.length >= 3 && window.__instances.slice(0, 3).every((instance) => instance.released)`,
      20_000,
      "The overlapping sounds kept their elements",
    );
    const overlap = await value(
      cdp,
      `(() => {
        const once = ${once};
        const time = (sample, index) => sample.find(([candidate]) => candidate === index)?.[1];
        return JSON.stringify({
          files: window.__instances.slice(0, 3).map((instance) => instance.file),
          once: window.__instances.slice(0, 3).map(once),
          // The first instance plays on, ahead of the second, while the second plays.
          both: window.__samples.some((sample) => time(sample, 1) > 0 && time(sample, 0) > time(sample, 1)),
          all: window.__samples.some((sample) => [0, 1, 2].every((index) => time(sample, index) !== undefined)),
          lateSeeked: window.__lateSeeked > 0,
        });
      })()`,
    );
    assertEqual(
      overlap,
      JSON.stringify({
        files: ["tone.wav", "tone.wav", "chime.wav"],
        once: [true, true, true],
        both: true,
        all: true,
        lateSeeked: true,
      }),
      "Overlapping sounds did not each play out once while the others played",
    );
    const loopStart = await value(cdp, "window.__samples.length");
    await waitFor(cdp, transcript("Loop done"), 15_000, "The sound loop did not finish");
    // Every finished instance released its element; the loop reused elements instead of creating one per instance. Under
    // load the instances play out well after the script's waits.
    await waitFor(
      cdp,
      `window.__instances.length === 33 && [...window.__elements].every((element) => !element.getAttribute('src'))`,
      20_000,
      "Finished sounds kept their elements",
    );
    const loop = await value(
      cdp,
      `JSON.stringify({
        once: window.__instances.every(${once}),
        overlapped: window.__samples.slice(${loopStart}).some((sample) => sample.length > 1),
        // How many elements the loop needs depends on how fast the browser plays: no new element while one was free.
        reused: window.__newWhileFree === 0 && window.__elements.size < window.__instances.length,
      })`,
    );
    assertEqual(
      loop,
      JSON.stringify({ once: true, overlapped: true, reused: true }),
      "The sound loop did not play overlapping instances out once on reused elements",
    );
  } finally {
    await cdp.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
}

/**
 * The `late-image` package shows an invalid image, hides it, then shows a valid one. The invalid image's response arrives
 * only after that: its late failure belongs to an element no longer on the Stage, so the valid image stays and nothing
 * is reported.
 */
async function lateImageScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  const press = async (label) => {
    const done = `[...document.querySelectorAll('[data-foreground-controls] button')].some((button) => button.textContent.trim() === ${JSON.stringify(label)})`;
    await waitFor(cdp, done);
    await physicalClick(cdp, "[data-foreground-controls] button");
  };
  const validShown = `(() => {
    const image = document.querySelector('.stage-media');
    return !!image && image.complete && image.naturalWidth > 0 && getComputedStyle(image).display !== 'none' &&
      image.getAttribute('src') === '/dev-package/late-image/files/images/valid.svg';
  })()`;
  lateImage.hold = true;
  await navigate(cdp, `${origin}/player/?package=late-image`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  // The Stage waits for the held response.
  const deadline = Date.now() + 8_000;
  while (lateImage.release === null) {
    if (Date.now() > deadline) throw new Error("The Stage did not request the late image");
    await delay(50);
  }
  // The image element that waits for the held response, kept so that it lives to fail, reports its failure after the
  // Stage's own handler has seen it.
  await value(
    cdp,
    `(() => {
      window.lateImage = { element: document.querySelector('.stage-media'), failed: false };
      window.lateImage.element.addEventListener('error', () => { window.lateImage.failed = true; });
      return true;
    })()`,
  );
  await press("Hide");
  await press("Show");
  await waitFor(cdp, validShown, 5_000, "The valid image was not shown");
  lateImage.release();
  lateImage.release = null;
  await waitFor(cdp, "window.lateImage.failed", 5_000, "The late image did not report its failure");
  assertEqual(
    await value(cdp, validShown),
    true,
    "A late failure of a removed image hid the valid image",
  );
  await physicalClick(cdp, "[data-notification-bell]");
  await waitFor(cdp, `!!document.querySelector('[data-player-notification-panel]')`);
  assertEqual(
    await value(cdp, `document.querySelectorAll('[data-player-notice]').length`),
    0,
    "A late failure of a removed image was reported",
  );
}

/**
 * Entrances (`entrances` package): what Start shows appears directly; a message live play adds enters while the
 * conversation glides up, and the controls of a new interaction glide with the message above them. An update taller
 * than the view shows directly and stops with its first entry at the top, with Return to latest offered, while later
 * messages do not move the reader; that also holds for an update of two entries, after the reader scrolled back to the
 * end. Under reduced motion nothing enters.
 */
async function entrancesScenario(cdp, origin) {
  await setViewport(cdp, 1280, 800);
  const entries = `Number(document.querySelector('.transcript-entry')?.getAttribute('aria-setsize') ?? 0)`;
  // Records, every frame, which parts of the conversation an animation moves, and how far the controls are from the
  // entry above them while the conversation glides. Each of them also rises in its own entrance, which under load
  // starts at a different frame for each, so the distance leaves those rises out. Under load a glide can also end
  // before a frame samples it, so the distance is also measured as each glide starts.
  const start = async () => {
    await navigate(cdp, `${origin}/player/?package=entrances`);
    await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
    await evaluate(
      cdp,
      `window.smokeEntrances = new Set();
      window.smokeControlGaps = new Set();
      const rise = (element) => Number.parseFloat(getComputedStyle(element).translate.split(' ')[1] ?? 0) || 0;
      const measureGap = () => {
        const controls = document.querySelector('[data-foreground-controls]');
        const above = document.querySelector('.transcript-entry[data-index="2"]');
        if (controls && above && getComputedStyle(document.querySelector('.transcript-history')).translate !== 'none')
          window.smokeControlGaps.add(
            Math.round(controls.getBoundingClientRect().top - rise(controls) - (above.getBoundingClientRect().bottom - rise(above))),
          );
      };
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...parameters) {
        const animation = animate.apply(this, parameters);
        // Once every animation the glide starts together exists.
        if (this.matches('.transcript-history')) queueMicrotask(measureGap);
        return animation;
      };
      const record = () => {
        for (const animation of document.getAnimations()) {
          const target = animation.effect?.target;
          if (target?.matches?.('.transcript-entry')) window.smokeEntrances.add('row ' + target.dataset.index);
          else if (target?.matches?.('.transcript-history')) window.smokeEntrances.add('glide');
          else if (target?.matches?.('[data-foreground-controls]')) window.smokeEntrances.add('controls');
        }
        measureGap();
        requestAnimationFrame(record);
      };
      requestAnimationFrame(record);`,
    );
    await physicalClick(cdp, "[data-session-activation] button");
  };
  const entered = () => evaluate(cdp, `return [...window.smokeEntrances].sort()`);
  const forget = () => evaluate(cdp, `window.smokeEntrances.clear()`);
  // The top of an entry in the view, as long as it is drawn.
  const top = (index) => `(() => {
    const view = document.querySelector('.transcript-scroll').getBoundingClientRect();
    const row = document.querySelector('.transcript-entry[data-index="${index}"]');
    return row ? Math.round(row.getBoundingClientRect().top - view.top) : null;
  })()`;
  const held = (index) =>
    `Math.abs(${top(index)} ?? 99) <= 2 && !!document.querySelector('.return-to-latest')`;
  await start();
  await waitFor(
    cdp,
    `${entries} === 2`,
    8_000,
    "The entrances package did not add its second message",
  );
  await delay(400);
  // Start shows its first message directly; the next one enters alone, and the conversation glides up for it.
  assertEqual(
    JSON.stringify(await entered()),
    JSON.stringify(["glide", "row 1"]),
    "A live message did not enter alone, gliding the conversation up",
  );
  // A message with a choice: the controls enter and glide with the message, at one distance below it.
  await waitFor(cdp, `!!document.querySelector('[data-foreground-controls]')`, 8_000);
  await delay(400);
  const gaps = await evaluate(cdp, `return [...window.smokeControlGaps]`);
  assertEqual(
    gaps.length > 0 && Math.max(...gaps) - Math.min(...gaps) <= 2,
    true,
    `The controls did not glide with the message above them: ${JSON.stringify(gaps)}`,
  );
  assertEqual(
    (await entered()).includes("controls"),
    true,
    "The controls of a new interaction did not enter",
  );
  // An update of many entries, taller than the view, stops at its first entry, the answer.
  await forget();
  await physicalClick(cdp, "[data-foreground-controls] button");
  await waitFor(cdp, `${entries} === 19`, 8_000, "The tall update did not arrive");
  await waitFor(
    cdp,
    held(3),
    4_000,
    "An update taller than the view did not stop at its first entry with Return to latest",
  );
  // The next message and choice arrive below without moving the reader.
  await waitFor(cdp, `${entries} === 20`, 8_000, "No message arrived after the tall update");
  await delay(400);
  assertEqual(
    Math.abs((await value(cdp, top(3))) ?? 99) <= 2,
    true,
    "A message after the tall update moved the reader",
  );
  // Scrolled back to the end, the reader follows again: an update of two entries taller than the view stops at its
  // first entry and shows directly.
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
  await forget();
  await physicalClick(cdp, "[data-foreground-controls] button");
  await waitFor(cdp, `${entries} === 22`, 8_000, "The tall message did not arrive");
  await waitFor(
    cdp,
    held(20),
    4_000,
    "A two-entry update taller than the view did not stop at its first entry after the reader returned to the end",
  );
  await delay(400);
  assertEqual(
    JSON.stringify(await entered()),
    "[]",
    "An update taller than the view entered the conversation",
  );
  // Reduced motion: the same live message shows without entering.
  await cdp.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    await start();
    await waitFor(cdp, `${entries} === 2`, 8_000, "The entrances package did not restart");
    await delay(400);
    assertEqual(
      JSON.stringify(await entered()),
      "[]",
      "Something entered the conversation under reduced motion",
    );
  } finally {
    await cdp.call("Emulation.setEmulatedMedia", { features: [] });
  }
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
  await evaluate(cdp, `${viewport}.focus(); return true;`);
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
  const rect = await value(
    cdp,
    `(() => { const box = ${viewport}.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`,
  );
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
  await evaluate(
    cdp,
    `document.querySelector('.transcript-entry a[href="https://example.com/rules"]').focus({ preventScroll: true }); return true;`,
  );
  await waitFor(
    cdp,
    `document.activeElement?.matches('.transcript-entry[tabindex="-1"]') && document.activeElement.textContent.includes('The rules are gone.')`,
    16_000,
    "Focus did not stay on the message whose link a change removed",
  );
}

/**
 * Player Debug in the default build: the Debug menu starts off and Settings turns it on for this load. While Debug
 * runs, one countdown line under the foreground names a wait, a timed button, or pacing, but never a blocking timer; it
 * follows jumps, also +10 s during pacing, the panel's Debug switch and the Debug menu also while the panel is closed,
 * and never reaches the transcript. `?dev` starts with the menu on.
 */
async function debugCountdownScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  const countdown = `document.querySelector('[data-debug-countdown]')?.textContent.trim() ?? null`;
  const shows = (pattern) =>
    `${pattern}.test(document.querySelector('[data-debug-countdown]')?.textContent.trim() ?? '')`;
  const none = `!document.querySelector('[data-debug-countdown]')`;
  const launcher = '[data-launcher] button[aria-label="Debug"]';
  const toggleDebugMenu = async () => {
    await physicalClick(cdp, "[data-settings-trigger]");
    await waitFor(cdp, `!!document.querySelector('[data-player-setting="debug-menu"]')`);
    await physicalClick(cdp, '[data-player-setting="debug-menu"]');
    // The X is pressed once it stands still with nothing over it. Should Settings stay open, the failure names what
    // the X's centre hits and which dialogs are open, the evidence an earlier, unreproduced timeout here lacked.
    await settledClick(cdp, '[data-player-settings] [data-slot="dialog-close"]');
    try {
      await waitFor(cdp, `!document.querySelector('[data-player-settings]')`);
    } catch {
      const state = await value(
        cdp,
        `(() => {
          const close = document.querySelector('[data-player-settings] [data-slot="dialog-close"]');
          const rect = close?.getBoundingClientRect();
          const hit = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return JSON.stringify({
            dialogs: [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].map((dialog) => dialog.textContent.trim().slice(0, 40)),
            settings: document.querySelector('[data-player-settings]')?.getAttribute('data-state') ?? null,
            hit: hit?.outerHTML.slice(0, 120) ?? null,
          });
        })()`,
      );
      throw new Error(`Settings did not close: ${state}`);
    }
  };
  // Scene time runs on in real time between steps, so a countdown may have passed its first seconds.
  const skip = async (expected, failure) => {
    await physicalClick(cdp, '[data-development-time-action="skip"]');
    await waitFor(cdp, expected, 5_000, failure);
  };

  await navigate(cdp, `${origin}/player/?package=debug-countdowns`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(
    cdp,
    `[...document.querySelectorAll('.transcript-entry')].some((entry) => entry.textContent.includes('Start'))`,
  );
  assertEqual(
    await value(cdp, `!document.querySelector(${JSON.stringify(launcher)}) && ${none}`),
    true,
    "A fresh load started with the Debug menu on",
  );
  // The menu on shows the wait's countdown at once, with the panel still closed.
  await toggleDebugMenu();
  await waitFor(
    cdp,
    shows("/^Debug · Continues in (30|2\\d) s$/"),
    5_000,
    "No countdown for the wait",
  );
  assertEqual(
    await value(cdp, `!document.querySelector('[data-debug-panel]')`),
    true,
    "The panel opened",
  );
  await physicalClick(cdp, launcher);
  await waitFor(cdp, `!!document.querySelector('[data-debug-panel]')`);
  // Skip event ends the wait: the blocking timer is a timer, never a wait.
  await skip(none, "A blocking timer showed a countdown");
  await skip(shows("/^Debug · Pacing: (20|1\\d) s remaining$/"), "No countdown for pacing");
  // +10 s works during pacing: the pause is 10 s shorter, and the next message has not come yet.
  await physicalClick(cdp, '[data-development-time-action="advance-10s"]');
  await waitFor(
    cdp,
    shows("/^Debug · Pacing: (10|\\d) s remaining$/"),
    5_000,
    "+10 s did not advance the pacing",
  );
  // The timed button consumes the pacing of the message before it.
  await skip(shows("/^Debug · Press within (40|3\\d) s$/"), "No countdown for the timed button");
  // The panel's Debug switch and the Debug menu hide and show it, also while the panel is closed.
  await physicalClick(cdp, "[data-debug-active]");
  await waitFor(cdp, none, 2_000, "Debug off left the countdown");
  await physicalClick(cdp, "[data-debug-active]");
  await waitFor(
    cdp,
    shows("/^Debug · Press within (40|3\\d) s$/"),
    2_000,
    "Debug on did not restore the countdown",
  );
  // Closed, the panel keeps its content parked out of view.
  await physicalClick(cdp, launcher);
  await waitFor(cdp, `!document.querySelector('[data-tool="Debug"]')`);
  await toggleDebugMenu();
  await waitFor(
    cdp,
    `${none} && !document.querySelector(${JSON.stringify(launcher)})`,
    2_000,
    "The Debug menu off left Debug",
  );
  await toggleDebugMenu();
  await waitFor(
    cdp,
    shows("/^Debug · Press within \\d+ s$/"),
    2_000,
    "The Debug menu on did not show the countdown",
  );
  // An untimed button has no countdown; Debug added nothing to the transcript.
  await physicalClick(cdp, "[data-foreground-controls] button");
  await waitFor(
    cdp,
    `[...document.querySelectorAll('[data-foreground-controls] button')].some((button) => button.textContent.trim() === 'Done')`,
  );
  assertEqual(await value(cdp, countdown), null, "An untimed button showed a countdown");
  const entries = await value(
    cdp,
    `[...document.querySelectorAll('.transcript-entry')].map((entry) => entry.textContent)`,
  );
  assertEqual(
    entries.some((text) => /Debug|elapsed|⏩/u.test(text)) ||
      !["Start", "A", "B", "Pressed"].every(
        (text, index, texts) =>
          entries.findIndex((entry) => entry.endsWith(text)) >
          (index === 0 ? -1 : entries.findIndex((entry) => entry.endsWith(texts[index - 1]))),
      ),
    false,
    `Debug changed the transcript: ${JSON.stringify(entries)}`,
  );

  await navigate(cdp, `${origin}/player/?dev&package=debug-countdowns`);
  await waitFor(
    cdp,
    `!!document.querySelector(${JSON.stringify(launcher)})`,
    8_000,
    "?dev did not start with the Debug menu on",
  );
}

/**
 * Debug's Now tab on the `debug-now` package, shaped like the Domme3 case: from a nested folder, a called file's
 * function shows an image reference the package lacks, then an image the browser cannot decode, then `hideImage`, then
 * a valid image, while two sounds overlap and a hidden timer runs. The tab names each state with the authored paths,
 * the call chain and the timers, and fits a narrow drawer.
 */
/**
 * Debug's Storage editor on the `debug-storage-edit` package: a malformed value is refused inline and stores nothing;
 * an added value is stored and the running session's next load returns it, while the value loaded before stays; it can
 * be changed to another type and deleted; the editor fits a narrow screen; and after the session ends an edit is
 * stored for the next Start.
 */
async function debugStorageEditScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  const entry = (text) =>
    `[...document.querySelectorAll('.transcript-entry')].some((entry) => entry.textContent.includes(${JSON.stringify(text)}))`;
  const rows = `[...document.querySelectorAll('[data-debug-storage-row]')].map((row) => [row.querySelector('[data-debug-storage-key]').textContent, row.querySelector('[data-storage-preview]').textContent.trim()])`;
  const setField = async (selector, text) => {
    await evaluate(
      cdp,
      `const field = document.querySelector(${JSON.stringify(selector)}); field.value = ''; field.dispatchEvent(new Event('input', { bubbles: true }));`,
    );
    await physicalClick(cdp, selector);
    await cdp.call("Input.insertText", { text });
  };
  const choose = (type) =>
    evaluate(
      cdp,
      `const select = document.querySelector('[data-storage-editor-type]'); select.value = ${JSON.stringify(type)}; select.dispatchEvent(new Event('change', { bubbles: true }));`,
    );
  const save = async (expected, failure) => {
    await physicalClick(cdp, "[data-storage-editor-save]");
    await waitFor(cdp, expected, 5_000, failure);
  };
  // A closed editor leaves the page before the next control is pressed.
  const closed = () => waitFor(cdp, `!document.querySelector('[data-storage-editor]')`);
  await navigate(cdp, `${origin}/player/?dev&package=debug-storage-edit`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(cdp, entry("first 0"));
  await physicalClick(cdp, '[data-launcher] button[aria-label="Debug"]');
  await physicalClick(cdp, '[data-debug-tab="storage"]');
  await waitFor(
    cdp,
    `/Nothing saved yet/.test(document.querySelector('[data-debug-storage]')?.textContent ?? '')`,
  );

  // A malformed number is refused in the editor, and nothing is stored.
  await physicalClick(cdp, "[data-debug-storage-add]");
  await waitFor(cdp, `!!document.querySelector('[data-storage-editor]')`);
  await setField("[data-storage-editor-key]", "k");
  await choose("integer");
  await setField("[data-storage-editor-value]", "5x");
  await save(
    `/Enter a number/.test(document.querySelector('[data-storage-editor-problem]')?.textContent ?? '')`,
    "A malformed number was not refused",
  );
  assertEqual(
    await value(cdp, `document.querySelectorAll('[data-debug-storage-row]').length`),
    0,
    "A refused value was stored",
  );
  // A valid value is stored, and the session's next load returns it; the value loaded before stays.
  await setField("[data-storage-editor-value]", "5");
  await save(
    `!document.querySelector('[data-storage-editor]') && /next load returns it/.test(document.querySelector('[data-debug-storage-saved]')?.textContent ?? '')`,
    "The added value was not saved for the running session",
  );
  await waitFor(cdp, `JSON.stringify(${rows}) === JSON.stringify([['"k"', '5']])`);
  await closed();
  assertEqual(
    await value(cdp, `!!document.querySelector('[data-debug-storage-edited]')`),
    true,
    "The session was not marked edited while debugging",
  );
  await physicalClick(cdp, "[data-foreground-controls] button");
  await waitFor(cdp, entry("second 5"), 5_000, "The next load did not return the edit");
  assertEqual(await value(cdp, entry("first 0")), true, "An earlier load changed");

  // Another type, then deletion.
  await physicalClick(cdp, "[data-debug-storage-edit]");
  await waitFor(cdp, `!!document.querySelector('[data-storage-editor]')`);
  await choose("text");
  await setField("[data-storage-editor-value]", "hi");
  await save(
    `JSON.stringify(${rows}) === JSON.stringify([['"k"', '"hi"']])`,
    "The edit to text was not shown",
  );
  await closed();
  await physicalClick(cdp, "[data-debug-storage-delete]");
  await waitFor(cdp, `!!document.querySelector('[data-storage-editor]')`);
  await save(
    `document.querySelectorAll('[data-debug-storage-row]').length === 0 && /Deleted "k"; the running session's next load gets its default/.test(document.querySelector('[data-debug-storage-saved]')?.textContent ?? '')`,
    "The deleted value was still listed",
  );
  await closed();

  // The editor fits a narrow, short screen: within the viewport, scrolling to reach Save.
  await setViewport(cdp, 390, 480);
  await waitFor(
    cdp,
    `document.querySelector('#player-shell')?.dataset.playerHorizontal === 'constrained'`,
  );
  if (
    await value(cdp, `!!document.querySelector('[data-player-top-bar] [data-sidebar="trigger"]')`)
  )
    await physicalClick(cdp, '[data-player-top-bar] [data-sidebar="trigger"]');
  // The drawer may open on its tools menu; Debug then shows its panel.
  await delay(400);
  if (await value(cdp, visible('.tools-drawer [data-launcher] button[aria-label="Debug"]')))
    await physicalClick(cdp, '.tools-drawer [data-launcher] button[aria-label="Debug"]');
  await waitFor(cdp, `!!document.querySelector('.tools-drawer [data-debug-storage-add]')`);
  await evaluate(
    cdp,
    `document.querySelector('.tools-drawer [data-debug-storage-add]').scrollIntoView()`,
  );
  // The drawer may still slide in.
  await waitFor(cdp, visible(".tools-drawer [data-debug-storage-add]"));
  await delay(400);
  await physicalClick(cdp, ".tools-drawer [data-debug-storage-add]");
  await waitFor(cdp, `!!document.querySelector('[data-storage-editor]')`);
  assertEqual(
    await value(
      cdp,
      `(() => { const box = document.querySelector('[data-storage-editor]').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; })()`,
    ),
    true,
    "The editor overflows a narrow, short screen",
  );
  await choose("advanced");
  await evaluate(
    cdp,
    `document.querySelector('[data-storage-editor-save]').scrollIntoView({ block: "nearest" })`,
  );
  assertEqual(
    await value(
      cdp,
      `(() => { const save = document.querySelector('[data-storage-editor-save]').getBoundingClientRect(); return save.top >= 0 && save.bottom <= innerHeight; })()`,
    ),
    true,
    "Save is out of reach on a short screen",
  );
  await choose("text");
  await setField("[data-storage-editor-key]", "after");
  await setField("[data-storage-editor-value]", "later");
  await save(
    `/Saved "after"; the running session's next load returns it/.test(document.querySelector('[data-debug-storage-saved]')?.textContent ?? '')`,
    "The value added in the narrow layout was not saved",
  );
  await closed();
  // With the session ended, an edit is stored for the next Start.
  await setViewport(cdp, 1440, 900);
  await physicalClick(cdp, "[data-foreground-controls] button");
  await waitFor(cdp, `!document.querySelector('[data-foreground-controls] button')`);
  // The end opens the end dialog, which leaves the Debug panel once closed.
  await waitFor(cdp, `!!document.querySelector('[data-session-end-close]')`);
  await physicalClick(cdp, "[data-session-end-close]");
  await waitFor(cdp, `!document.querySelector('[data-session-end-dialog]')`);
  await physicalClick(cdp, "[data-debug-storage-delete]");
  await waitFor(cdp, `!!document.querySelector('[data-storage-editor]')`);
  await save(
    `/Deleted "after" for the next Start/.test(document.querySelector('[data-debug-storage-saved]')?.textContent ?? '')`,
    "An edit after the session ended was not stored for the next Start",
  );
}

/**
 * Debug's Storage tab on the `debug-storage` package: it lists the script's saved values in key order with typed
 * previews and the saved photo, once per photo with the keys that use it; a member list expands to the shared photo;
 * a later save updates it; Debug off hides it; and it fits the narrow drawer.
 */
async function debugStorageScenario(cdp, origin, profile) {
  await setViewport(cdp, 1440, 900);
  const chosen = join(profile, "debug-storage.png");
  await writeFile(chosen, solidPng(24, 16, [40, 90, 200]));
  const rows = `[...document.querySelectorAll('[data-debug-storage-row]')].map((row) => [row.querySelector('[data-debug-storage-key]').textContent, row.querySelector('[data-storage-preview]').textContent.trim()])`;
  await navigate(cdp, `${origin}/player/?dev&package=debug-storage`);
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
  await waitFor(
    cdp,
    `[...document.querySelectorAll('.transcript-entry')].some((entry) => entry.textContent.includes('Saved.'))`,
    8_000,
    "The script did not save",
  );
  await physicalClick(cdp, '[data-launcher] button[aria-label="Debug"]');
  await physicalClick(cdp, '[data-debug-tab="storage"]');
  await waitFor(
    cdp,
    `document.querySelector('[data-debug-storage-summary]')?.textContent.replace(/\\s+/g, ' ').trim() === 'Saved data · 7 keys'`,
    5_000,
    "The Storage tab did not count the saved values",
  );
  // Text shaped like a photo reference stays visible as text, the chosen photo's reference included.
  const listed = (await value(cdp, rows)).map(([key, preview]) =>
    key === '"player.photo"' && /^"captured-media:[0-9a-f-]+:1"$/.test(preview)
      ? [key, "<photo reference>"]
      : [key, preview],
  );
  assertEqual(
    JSON.stringify(listed),
    JSON.stringify([
      ['"album"', "2 items"],
      ['"missing"', '"captured-media:00000000-0000-4000-8000-000000000000:1"'],
      ['"note"', '"captured-media:note"'],
      ['"player.flags"', "2 properties"],
      ['"player.name"', '"Ada"'],
      ['"player.photo"', "<photo reference>"],
      ['"player.score"', "3"],
    ]),
    "The Storage tab did not list the saved values in key order",
  );
  // The saved photo once, used by two keys; each thumbnail loads from this browser's storage once it is in view.
  const photoRow = `[...document.querySelectorAll('[data-debug-storage-row]')].find((row) => row.querySelector('[data-debug-storage-key]').textContent === '"player.photo"')`;
  await evaluate(cdp, `${photoRow}.scrollIntoView()`);
  await waitFor(
    cdp,
    `!!${photoRow}.querySelector('[data-storage-photo][data-state="ready"] img')`,
    5_000,
    "The saved photo's row showed no thumbnail",
  );
  await evaluate(cdp, `document.querySelector('[data-debug-storage-photos]').scrollIntoView()`);
  await waitFor(
    cdp,
    `/Used by "album", "player.photo"/.test(document.querySelector('[data-debug-storage-photos]').textContent) &&
      !!document.querySelector('[data-debug-storage-photos] [data-storage-photo][data-state="ready"] img')`,
    5_000,
    "The Storage tab did not show the shared saved photo",
  );
  // A well-formed reference the store does not have says so, and ordinary text gets no thumbnail.
  await evaluate(cdp, `document.querySelectorAll('[data-debug-storage-row]')[1].scrollIntoView()`);
  await waitFor(
    cdp,
    `(() => { const [missing, note] = [...document.querySelectorAll('[data-debug-storage-row]')].slice(1, 3);
      return missing.querySelector('[data-storage-photo]')?.dataset.state === 'missing' &&
        /No saved photo/.test(missing.textContent) && !note.querySelector('[data-storage-photo]'); })()`,
    5_000,
    "A reference without a saved photo or ordinary text was misshown",
  );
  await evaluate(cdp, `document.querySelector('[data-debug-storage-row]').scrollIntoView()`);
  await physicalClick(cdp, "[data-debug-storage-row] [data-storage-expand]");
  await waitFor(
    cdp,
    `document.querySelector('[data-debug-storage-row]').querySelectorAll('[data-storage-photo]').length === 2`,
    5_000,
    "The album did not expand to its two photos",
  );
  // A later save shows at once; the photo row's new reference, out of view, is not read until it comes into view.
  await setViewport(cdp, 1440, 480);
  // The Player lays out the new size a moment later; a physical click needs the button on screen.
  await waitFor(
    cdp,
    `(() => { const rect = document.querySelector('[data-foreground-controls] button')?.getBoundingClientRect();
      return !!rect && rect.top >= 0 && rect.bottom <= innerHeight; })()`,
    5_000,
    "The button did not come into view at the short height",
  );
  await evaluate(cdp, `document.querySelector('[data-debug-active]').scrollIntoView()`);
  // The resized Player settles before its button is pressed.
  await waitFor(cdp, visible("[data-foreground-controls] button"));
  await delay(300);
  await physicalClick(cdp, "[data-foreground-controls] button");
  await waitFor(
    cdp,
    `${rows}.some(([key, preview]) => key === '"player.score"' && preview === '4') &&
      /:2"$/.test(${photoRow}.querySelector('[data-storage-preview]').textContent)`,
    5_000,
    "A later save did not update the Storage tab",
  );
  assertEqual(
    await value(
      cdp,
      `(() => { const row = ${photoRow}; const panel = row.closest('[data-tool]').getBoundingClientRect();
        return row.getBoundingClientRect().top > panel.bottom && row.querySelector('[data-storage-photo]').dataset.state; })()`,
    ),
    "loading",
    "An off-screen new photo reference was read before it came into view",
  );
  await evaluate(cdp, `${photoRow}.scrollIntoView()`);
  await waitFor(
    cdp,
    `${photoRow}.querySelector('[data-storage-photo]').dataset.state === 'missing'`,
    5_000,
    "The new photo reference was not read once in view",
  );
  await setViewport(cdp, 1440, 900);
  await evaluate(cdp, `document.querySelector('[data-debug-active]').scrollIntoView()`);
  await physicalClick(cdp, "[data-debug-active]");
  await waitFor(
    cdp,
    `!document.querySelector('[data-debug-storage]') && /Debug is off/.test(document.querySelector('[data-debug-panel]')?.textContent ?? '')`,
    2_000,
    "Debug off left the Storage overview",
  );
  await physicalClick(cdp, "[data-debug-active]");
  await waitFor(cdp, `!!document.querySelector('[data-debug-storage]')`);

  await setViewport(cdp, 390, 760);
  await waitFor(
    cdp,
    `document.querySelector('#player-shell')?.dataset.playerHorizontal === 'constrained'`,
  );
  // Focus in the tools keeps them open as the drawer; otherwise open it.
  if (
    await value(cdp, `!!document.querySelector('[data-player-top-bar] [data-sidebar="trigger"]')`)
  )
    await physicalClick(cdp, '[data-player-top-bar] [data-sidebar="trigger"]');
  await waitFor(
    cdp,
    `!!document.querySelector('.tools-drawer [data-debug-storage]')`,
    5_000,
    "The drawer did not show Storage",
  );
  assertEqual(
    await value(
      cdp,
      `(() => { const storage = document.querySelector('.tools-drawer [data-debug-storage]'); return storage.scrollWidth <= storage.clientWidth && storage.getBoundingClientRect().right <= innerWidth && [...storage.querySelectorAll('[data-debug-storage-row]')].every((row) => row.scrollWidth <= row.clientWidth); })()`,
    ),
    true,
    "The Storage tab overflows the narrow drawer",
  );
}

async function debugNowScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  const text = (selector) =>
    `document.querySelector(${JSON.stringify(selector)})?.textContent.replace(/\\s+/g, " ").trim() ?? null`;
  const imageStatus = (status) =>
    `document.querySelector('[data-debug-now-image] [data-status]')?.getAttribute('data-status') === ${JSON.stringify(status)}`;
  const next = async (status, failure) => {
    await physicalClick(cdp, "[data-foreground-controls] button");
    await waitFor(cdp, imageStatus(status), 5_000, failure);
  };
  await navigate(cdp, `${origin}/player/?dev&package=debug-now`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await physicalClick(cdp, '[data-launcher] button[aria-label="Debug"]');
  await waitFor(cdp, imageStatus("unresolved"), 5_000, "The bad reference was not unresolved");
  assertEqual(
    await value(cdp, text("[data-debug-now-image-path]")),
    "Domme/Domme43.jpg",
    "Now did not name the authored image path",
  );
  // The debug export from the Debug panel reports what Now shows: the state always, the path with session text only.
  const exportPreview = async (categories = []) => {
    await physicalClick(cdp, "[data-debug-export-open]");
    await waitFor(cdp, `!!document.querySelector('[data-debug-export-download]')`);
    const into = (selector) =>
      evaluate(
        cdp,
        `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center', behavior: 'instant' })`,
      );
    for (const category of categories) {
      await into(`[data-debug-export-category="${category}"]`);
      await physicalClick(cdp, `[data-debug-export-category="${category}"] [role=switch]`);
      await waitFor(
        cdp,
        `document.querySelector('[data-debug-export-category="${category}"] [role=switch]')?.getAttribute('aria-checked') === 'true' && !!document.querySelector('[data-debug-export-download]')`,
      );
    }
    await into("[data-debug-export-preview-toggle]");
    await physicalClick(cdp, "[data-debug-export-preview-toggle]");
    await waitFor(cdp, `!!document.querySelector('[data-debug-export-preview]')`);
    const preview = JSON.parse(
      await value(cdp, `document.querySelector('[data-debug-export-preview]').textContent`),
    );
    for (const type of ["keyDown", "keyUp"])
      await cdp.call("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
    await waitFor(
      cdp,
      `!document.querySelector('[data-debug-export]') && document.activeElement?.matches('[data-debug-export-open]')`,
      5_000,
      "Closing the debug export did not return to the Debug panel",
    );
    return preview;
  };
  const structural = await exportPreview();
  assertEqual(
    JSON.stringify(structural.media.stage),
    JSON.stringify({ status: "unresolved" }),
    "The debug export's Stage state",
  );
  assertEqual(
    (await exportPreview(["sessionText"])).media.stage.path,
    "Domme/Domme43.jpg",
    "The debug export's Stage path with session text",
  );
  assertEqual(
    await value(cdp, text("[data-debug-now-waiting]")),
    "Button · Domme3/spanking.tease:3",
    "Now did not name the waiting statement with its nested path",
  );
  await physicalClick(cdp, "[data-debug-now-calls-toggle]");
  await waitFor(cdp, `!!document.querySelector('[data-debug-now-calls]')`);
  assertEqual(
    JSON.stringify(
      await value(
        cdp,
        `[...document.querySelectorAll('[data-debug-now-calls] li')].map((item) => item.textContent.replace(/\\s+/g, " ").trim())`,
      ),
    ),
    JSON.stringify([
      "punish() · Domme3/spanking.tease:8",
      "call Domme3/spanking.tease · Domme3/maintenance.tease:2",
    ]),
    "Now did not list the call chain",
  );
  // Both sounds play at once; the hidden timer is listed.
  await waitFor(
    cdp,
    `[...document.querySelectorAll('[data-debug-now-media] li')].filter((item) => /Playing/.test(item.textContent)).length === 2`,
    5_000,
    "Now did not list both playing sounds",
  );
  await physicalClick(cdp, "[data-debug-now-timers-toggle]");
  await waitFor(
    cdp,
    `/hidden · running/.test(document.querySelector('[data-debug-now-timers]')?.textContent ?? '')`,
    2_000,
    "Now did not list the hidden timer",
  );
  await next("failed", "The undecodable image was not a load failure");
  assertEqual(
    (await exportPreview()).media.stage.status,
    "failed",
    "The debug export did not report the load failure",
  );
  await next("hidden", "hideImage did not hide the Stage image");
  await next("displayed", "The valid image was not displayed");
  assertEqual(
    await value(cdp, text("[data-debug-now-image-path]")),
    "Domme0/Domme44.svg",
    "Now did not name the valid image",
  );

  // The narrow drawer shows the tab without horizontal overflow.
  await setViewport(cdp, 390, 760);
  await waitFor(
    cdp,
    `document.querySelector('#player-shell')?.dataset.playerHorizontal === 'constrained'`,
  );
  await physicalClick(cdp, '[data-player-top-bar] [data-sidebar="trigger"]');
  await waitFor(
    cdp,
    `!!document.querySelector('.tools-drawer [data-debug-now]')`,
    5_000,
    "The drawer did not show Now",
  );
  assertEqual(
    await value(
      cdp,
      `(() => { const now = document.querySelector('.tools-drawer [data-debug-now]'); return now.scrollWidth <= now.clientWidth && now.getBoundingClientRect().right <= innerWidth; })()`,
    ),
    true,
    "The Now tab overflows the narrow drawer",
  );
}

/**
 * The importer's route (#615): a folder package opened by URL with the Debug tool, auto-skip on from the URL. After a
 * physical Start the 15 s wait ends at once; +10 s at the waiting button shows in its elapsed time. Without auto-skip,
 * Skip event ends the wait; the default build has no Debug tool.
 */
async function developmentTimeScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  const done = `[...document.querySelectorAll('[data-foreground-controls] button')].some((button) => button.textContent.trim() === 'Done')`;
  const logged = (pattern) =>
    `${pattern}.test(document.querySelector('[data-debug-log] li')?.textContent ?? '')`;
  const start = async (url) => {
    await navigate(cdp, url);
    await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
    await physicalClick(cdp, "[data-session-activation] button");
  };
  const openPanel = async () => {
    await physicalClick(cdp, '[data-launcher] button[aria-label="Debug"]');
    await waitFor(cdp, `!!document.querySelector('[data-debug-panel]')`);
  };

  await start(`${origin}/player/?dev&package=waiting&time=skip`);
  await openPanel();
  await waitFor(
    cdp,
    `${done} && ${logged("/^⏩ 1[0-5] s skipped$/")}`,
    5_000,
    "Auto-skip did not end the package's 15 s wait at once",
  );
  await physicalClick(cdp, '[data-development-time-action="advance-10s"]');
  await waitFor(cdp, logged("/^⏩ 10 s skipped$/"));
  await physicalClick(cdp, "[data-foreground-controls] button");
  await waitFor(
    cdp,
    `[...document.querySelectorAll('.transcript-entry')].some((entry) => /Waited 1\\d(\\.\\d+)? s/.test(entry.textContent))`,
    5_000,
    "+10 s did not reach the button's elapsed time",
  );

  await start(`${origin}/player/?dev&package=waiting`);
  await openPanel();
  await waitFor(cdp, `!document.querySelector('[data-development-time-action="skip"]').disabled`);
  await physicalClick(cdp, '[data-development-time-action="skip"]');
  await waitFor(
    cdp,
    `${done} && ${logged("/^⏩ 1[0-5] s skipped$/")}`,
    5_000,
    "Skip event did not end the package's 15 s wait",
  );

  await start(`${origin}/player/?package=waiting`);
  await waitFor(
    cdp,
    `[...document.querySelectorAll('.transcript-entry')].some((entry) => entry.textContent.includes('Before the wait'))`,
  );
  assertEqual(
    await value(
      cdp,
      `!!document.querySelector('[data-launcher] button[aria-label="Debug"], [data-debug-panel], [data-development-time-badge]')`,
    ),
    false,
    "The default build offered the Debug tool",
  );
}

/**
 * The session camera opens at Start and `takePhoto()` puts its photo on the Stage; without camera permission the
 * script continues without a photo.
 */
/** The color at the center of each quadrant of an image's or a video's own pixels, in the test card's order. */
function quadrantColors(element) {
  return `(() => {
    const source = ${element};
    const canvas = document.createElement('canvas');
    canvas.width = source.videoWidth ?? source.naturalWidth;
    canvas.height = source.videoHeight ?? source.naturalHeight;
    const drawing = canvas.getContext('2d');
    drawing.drawImage(source, 0, 0);
    return [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([x, y]) =>
      [...drawing.getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data.slice(0, 3)]);
  })()`;
}

async function cameraScenario(cdp, origin) {
  const url = `${origin}/player/?dev&debug=off&scenario=camera`;
  const start = async () => {
    await navigate(cdp, url);
    await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
    await physicalClick(cdp, "[data-session-activation] button");
  };
  const takeNewPhoto = () =>
    evaluate(
      cdp,
      `[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Take another, Mistress').click()`,
    );
  const photoColors = quadrantColors(decodedPhoto);
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
  await waitFor(cdp, `${capturedImages} === 1`);
  assertTestCard(
    await value(cdp, photoColors),
    "The captured photo does not show the camera's frame",
  );
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
  assertTestCard(await value(cdp, photoColors), "The saved photo does not show the captured frame");
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

/** One 320×240 frame of the test card as a Y4M video, which Chromium's fake camera repeats. */
function testCardY4m() {
  const width = 320;
  const height = 240;
  // BT.601 limited-range YUV, the conversion Chromium applies to the file's frames.
  const yuv = ([red, green, blue]) => [
    Math.round(16 + (65.738 * red + 129.057 * green + 25.064 * blue) / 256),
    Math.round(128 + (-37.945 * red - 74.494 * green + 112.439 * blue) / 256),
    Math.round(128 + (112.439 * red - 94.154 * green - 18.285 * blue) / 256),
  ];
  const plane = (planeWidth, planeHeight, channel) => {
    const bytes = Buffer.alloc(planeWidth * planeHeight);
    for (let y = 0; y < planeHeight; y += 1) {
      for (let x = 0; x < planeWidth; x += 1) {
        const quadrant = (y < planeHeight / 2 ? 0 : 2) + (x < planeWidth / 2 ? 0 : 1);
        bytes[y * planeWidth + x] = yuv(TEST_CARD[quadrant])[channel];
      }
    }
    return bytes;
  };
  return Buffer.concat([
    Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\nFRAME\n`),
    plane(width, height, 0),
    plane(width / 2, height / 2, 1),
    plane(width / 2, height / 2, 2),
  ]);
}

function assertTestCard(colors, message) {
  // Video and image encoding shift colors slightly; a different image is far outside this.
  const matches =
    colors?.length === TEST_CARD.length &&
    colors.every((color, quadrant) =>
      color.every((channel, index) => Math.abs(channel - TEST_CARD[quadrant][index]) <= 40),
    );
  if (!matches)
    throw new Error(
      `${message}: expected ${JSON.stringify(TEST_CARD)}, received ${JSON.stringify(colors)}`,
    );
}

async function viewfinderScenario(cdp, origin) {
  const url = `${origin}/player/?dev&debug=off&scenario=viewfinder`;
  const start = async () => {
    await navigate(cdp, url);
    await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
    await physicalClick(cdp, "[data-session-activation] button");
  };
  const takePhoto = () =>
    evaluate(
      cdp,
      `[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === "I'm ready, Mistress").click()`,
    );
  const video = `document.querySelector('[data-viewfinder] video')`;
  const viewfinders = `document.querySelectorAll('[data-viewfinder]').length`;
  const place = `(() => { const box = document.querySelector('[data-floating-viewfinder]').getBoundingClientRect(); return [box.left, box.top, box.width].map(Math.round).join(); })()`;
  const sidebarVisible = `document.querySelector('#player-shell').dataset.sidebarVisible`;
  const stageAspect = `Number(getComputedStyle(document.querySelector('#player-shell')).getPropertyValue('--media-aspect'))`;
  const clickButton = (cdp, label) =>
    evaluate(
      cdp,
      `[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === ${JSON.stringify(label)}).click()`,
    );

  await setViewport(cdp, 1440, 900);
  await cdp.call("Browser.setPermission", {
    origin,
    permission: { name: "camera" },
    setting: "granted",
  });
  // While the script waits on its photo button, the viewfinder window plays the session camera, mirrored for display
  // only.
  await start();
  await waitFor(
    cdp,
    `${video}?.videoWidth > 0 && !${video}.paused`,
    8_000,
    "The viewfinder did not play",
  );
  assertTestCard(
    await value(cdp, quadrantColors(video)),
    "The viewfinder does not show the camera",
  );
  assertEqual(
    await value(cdp, `getComputedStyle(${video}).transform`),
    "matrix(-1, 0, 0, 1, 0, 0)",
    "The viewfinder is not mirrored",
  );
  // The window floats in the whole Player, so showing or hiding the docked sidebar does not move it.
  const shown = await value(cdp, place);
  for (const expected of ["false", "true"]) {
    await evaluate(
      cdp,
      `[...document.querySelectorAll('[data-sidebar=trigger]')].find((trigger) => trigger.offsetParent !== null).click()`,
    );
    await waitFor(cdp, `${sidebarVisible} === ${JSON.stringify(expected)}`);
    assertEqual(await value(cdp, place), shown, "Toggling the sidebar moved the viewfinder");
  }
  // The player's mirroring choice follows the view from the window to the Stage.
  await click(cdp, "[data-floating-viewfinder] [data-viewfinder-mirror]");
  assertEqual(
    await value(cdp, `getComputedStyle(${video}).transform`),
    "none",
    "The flip button did not flip",
  );
  // The script takes the photo from the same open camera; the view stays, and the photo is not mirrored.
  await takePhoto();
  await waitFor(cdp, `document.body.innerText.includes("There you are. I'll keep that one.")`);
  await waitFor(cdp, `${capturedImages} === 1`);
  assertTestCard(
    await value(cdp, quadrantColors(decodedPhoto)),
    "The photo after the viewfinder does not show the camera's frame",
  );
  assertEqual(await value(cdp, viewfinders), 1, "The photo hid the camera view");
  // `view.placement = "stage"` moves the view over the Stage, where the photo stays underneath and the Stage takes the
  // camera's aspect.
  await clickButton(cdp, "Put me on your Stage");
  await waitFor(cdp, `!!document.querySelector('[data-stage-camera] [data-viewfinder] video')`);
  assertEqual(
    await value(cdp, `!!document.querySelector('[data-floating-viewfinder]')`),
    false,
    "The window stayed after the view moved over the Stage",
  );
  assertEqual(
    await value(cdp, `document.querySelector('.stage-media')?.src.startsWith('blob:') ?? false`),
    true,
    "The camera view replaced the Stage image instead of covering it",
  );
  await waitFor(
    cdp,
    `Math.abs(${stageAspect} - ${video}.videoWidth / ${video}.videoHeight) < 0.01`,
    8_000,
    "The Stage did not take the camera's aspect",
  );
  assertEqual(
    await value(cdp, `getComputedStyle(${video}).transform`),
    "none",
    "The Stage view lost the window's mirroring choice",
  );
  // Centred on the Stage like the image underneath, also where a narrow Stage cannot take the camera's aspect.
  await setViewport(cdp, 390, 844);
  await waitFor(
    cdp,
    `(() => { const camera = document.querySelector('[data-stage-camera] [data-viewfinder]').getBoundingClientRect(); const frame = document.querySelector('.stage-media-frame').getBoundingClientRect(); return camera.height < frame.height - 1 && Math.abs(camera.top + camera.height / 2 - (frame.top + frame.height / 2)) < 1; })()`,
    8_000,
    "The camera view over a narrow Stage is not centred",
  );
  await setViewport(cdp, 1440, 900);
  // Back in the window, the view keeps the place it had.
  await clickButton(cdp, "Back to the window");
  await waitFor(cdp, `document.body.innerText.includes("Back in your little window.")`);
  await waitFor(
    cdp,
    `!!document.querySelector('[data-floating-viewfinder] [data-viewfinder] video')`,
  );
  assertEqual(
    await value(cdp, place),
    shown,
    "The window lost its place on the way back from the Stage",
  );
  // hideCamera hides the view; the Stage image was there all along.
  // The script keeps running after hideCamera, so only hiding, not the end of the session, can remove the view.
  await clickButton(cdp, "Yes, Mistress");
  await waitFor(cdp, `document.body.innerText.includes("Good. That's enough looking for now.")`);
  assertEqual(await value(cdp, viewfinders), 0, "hideCamera left a camera view");
  assertEqual(
    await value(cdp, `!!document.querySelector('.stage-media')`),
    true,
    "The Stage image went with the camera view",
  );

  // Without a camera there is no viewfinder, and the script continues without a photo.
  await cdp.call("Browser.setPermission", {
    origin,
    permission: { name: "camera" },
    setting: "denied",
  });
  await start();
  await waitFor(
    cdp,
    `[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === "I'm ready, Mistress")`,
  );
  assertEqual(await value(cdp, viewfinders), 0, "A denied camera showed a viewfinder");
  await takePhoto();
  await waitFor(
    cdp,
    `document.body.innerText.includes('No camera? Then you stay unseen, for now. We go on without a photo.')`,
  );
  await cdp.call("Browser.resetPermissions");
}

/**
 * `askImage` in a package: only while it waits does the composer offer a paperclip, which opens the native file picker,
 * and a drop target. A chosen or dropped file answers once the Player has checked it, and the Stage shows it; a file
 * that is not an image, a second file, or one the request's filters exclude is refused and the request keeps waiting.
 */
async function askImageScenario(cdp, origin, profile) {
  const chosen = join(profile, "chosen.png");
  const notes = join(profile, "notes.png");
  await writeFile(chosen, solidPng(48, 32, [200, 40, 120]));
  await writeFile(notes, "not an image");
  const stageImage = `(() => {
    const image = document.querySelector('.stage-media');
    return !!image && image.complete && image.naturalWidth > 0 && image.getAttribute('src').startsWith('blob:');
  })()`;
  const notice = (text) =>
    `document.querySelector('.composer-notice')?.textContent.includes(${JSON.stringify(text)}) === true`;
  const imageAnswers = `[...document.querySelectorAll('.transcript-entry')].filter((entry) => entry.textContent.trim() === 'Image').length`;
  await setViewport(cdp, 1440, 900);
  await navigate(cdp, `${origin}/player/?package=pictures`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  assertEqual(
    await value(cdp, `!!document.querySelector('[data-composer-attach]')`),
    false,
    "The composer offered a file input before the image request",
  );
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(
    cdp,
    visible("[data-composer-attach]"),
    8_000,
    "The image request offered no paperclip",
  );
  assertEqual(
    await value(cdp, `document.querySelector('[data-composer-attach]').getAttribute('aria-label')`),
    "Attach an image",
    "The paperclip has no accessible name",
  );
  // The paperclip opens the native picker: a click on the hidden file input, which CDP then answers.
  await evaluate(
    cdp,
    `const input = document.querySelector('[data-composer-file]');
    window.__pickerOpened = 0;
    input.addEventListener('click', () => window.__pickerOpened++, { once: true });
    input.addEventListener('click', (event) => event.preventDefault(), { once: true });`,
  );
  await physicalClick(cdp, "[data-composer-attach]");
  assertEqual(
    await value(cdp, "window.__pickerOpened"),
    1,
    "The paperclip did not open the picker",
  );
  await setInputFiles(cdp, "[data-composer-file]", [notes]);
  await waitFor(cdp, notice("That image is not valid."), 8_000, "A text file was not refused");
  assertEqual(
    await value(cdp, visible("[data-composer-attach]")),
    true,
    "The refused file ended the request",
  );
  await openPicker(cdp);
  await setInputFiles(cdp, "[data-composer-file]", [chosen]);
  await waitFor(
    cdp,
    `${stageImage} && ${imageAnswers} === 1`,
    8_000,
    "The chosen image is not on the Stage",
  );

  // The second request accepts PNG files only and is answered by a drop.
  await waitFor(
    cdp,
    `document.body.innerText.includes('Now one more, as a PNG file.') && ${visible("[data-composer-attach]")}`,
    8_000,
    "The second image request did not open",
  );
  const pngBase64 = solidPng(24, 24, [30, 160, 90]).toString("base64");
  const drop = (files) =>
    evaluate(
      cdp,
      `const shell = document.querySelector('[data-composer-shell]');
      const transfer = new DataTransfer();
      for (const [name, base64] of ${JSON.stringify(files)})
        transfer.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], name));
      const fire = (type) =>
        !shell.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
      const entered = fire('dragenter') && fire('dragover');
      // The highlight renders with the next update.
      return new Promise((resolve) =>
        setTimeout(() => {
          const highlighted = shell.hasAttribute('data-drop-active');
          resolve({ entered, highlighted, dropped: fire('drop') });
        }, 0),
      );`,
    );
  const two = await drop([
    ["one.png", pngBase64],
    ["two.png", pngBase64],
  ]);
  assertEqual(
    two.entered && two.highlighted && two.dropped,
    true,
    "The composer was not a drop target",
  );
  await waitFor(cdp, notice("Choose one image."), 8_000, "Two dropped files were not refused");
  await drop([["photo.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64")]]);
  await waitFor(
    cdp,
    notice("Choose an image of these types: .png, image/png."),
    8_000,
    "A JPEG passed the PNG filter",
  );
  assertEqual(await value(cdp, `${imageAnswers}`), 1, "A refused drop answered the request");
  await drop([["dropped.png", pngBase64]]);
  await waitFor(
    cdp,
    `${stageImage} && ${imageAnswers} === 2 && document.body.innerText.includes('Thank you.')`,
    8_000,
    "The dropped image did not answer the request",
  );
  // Outside an image request there is no paperclip and the composer takes no files.
  assertEqual(
    await value(cdp, `!!document.querySelector('[data-composer-attach]')`),
    false,
    "The paperclip stayed",
  );
  const after = await drop([["late.png", pngBase64]]);
  assertEqual(
    after.entered || after.dropped,
    false,
    "The composer took a file outside an image request",
  );

  // A file chosen in a picker opened for one request does not answer the timer's request that replaced it meanwhile.
  const placeholder = (text) =>
    `document.querySelector('[data-composer-input]')?.getAttribute('placeholder') === ${JSON.stringify(text)}`;
  await navigate(cdp, `${origin}/player/?package=picture-race`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(cdp, placeholder("Main image"), 8_000, "The main image request did not open");
  await openPicker(cdp);
  await waitFor(cdp, placeholder("Timer image"), 8_000, "The timer's image request did not open");
  await setInputFiles(cdp, "[data-composer-file]", [chosen]);
  await waitFor(
    cdp,
    notice("This interaction is no longer available."),
    8_000,
    "A file chosen for the main request was not refused",
  );
  assertEqual(
    await value(cdp, `${imageAnswers}`),
    0,
    "A stale choice answered the timer's request",
  );
  await drop([["timer.png", pngBase64]]);
  await waitFor(
    cdp,
    `document.body.innerText.includes('Timer image received.') && ${placeholder("Main image")}`,
    8_000,
    "The timer's request was not answered, or the main request did not resume",
  );
  await drop([["main.png", pngBase64]]);
  await waitFor(
    cdp,
    `document.body.innerText.includes('Main image received.') && ${imageAnswers} === 2`,
    8_000,
    "The resumed main request was not answered",
  );
  // A file chosen for a request that a timer's wait suspended answers it once it resumes.
  await waitFor(cdp, placeholder("Second image"), 8_000, "The second image request did not open");
  await openPicker(cdp);
  await waitFor(
    cdp,
    `!document.querySelector('[data-composer-attach]')`,
    8_000,
    "The timer did not suspend the second request",
  );
  await waitFor(cdp, placeholder("Second image"), 8_000, "The second request did not resume");
  await setInputFiles(cdp, "[data-composer-file]", [chosen]);
  await waitFor(
    cdp,
    `document.body.innerText.includes('Second image received.') && ${imageAnswers} === 3`,
    8_000,
    "A file chosen before the second request was suspended did not answer it",
  );
}

/**
 * The camera route of `askImage`: the camera opens by itself with the request, on the Stage, or in the camera window a
 * script shows. The shutter on the viewfinder takes a photo the player may take again, and "Use this" alone answers the
 * request with the camera's own, unmirrored picture. A camera the request opened turns off after the answer, also one
 * given as a file. A camera that fails offers "Try again" while the paperclip stays.
 */
// Exports a package's saved data from Player Settings in the default build, without Debug: one downloaded file with the
// saved photo's exact bytes, the same data as text with copying and its manual fallback, no unsaved photo, released
// resources once the dialog closes, and a dialog that fits a narrow screen with touch-sized controls.
async function savedDataExportScenario(cdp, origin, profile) {
  const chosen = join(profile, "saved.png");
  const photoBytes = solidPng(24, 16, [30, 160, 90]);
  await writeFile(chosen, photoBytes);
  const downloads = join(profile, "downloads");
  await mkdir(downloads, { recursive: true });
  await cdp.call("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  const text = (value) => `document.body.textContent.includes(${JSON.stringify(value)})`;
  await setViewport(cdp, 1440, 900);
  await navigate(cdp, `${origin}/player/?package=saved-photo`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  assertEqual(
    await value(cdp, `location.search.includes('dev')`),
    false,
    "The export runs without Debug",
  );
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(
    cdp,
    visible("[data-composer-attach]"),
    8_000,
    "The image request offered no paperclip",
  );
  await openPicker(cdp);
  await setInputFiles(cdp, "[data-composer-file]", [chosen]);
  await waitFor(cdp, text("Saved."), 8_000, "The script did not save its photo");
  // The second image request gets another photo, which is never saved; the session then waits for text.
  const unsaved = join(profile, "unsaved.png");
  await writeFile(unsaved, solidPng(24, 16, [200, 30, 30]));
  await waitFor(cdp, visible("[data-composer-attach]"));
  await openPicker(cdp);
  await setInputFiles(cdp, "[data-composer-file]", [unsaved]);
  await waitFor(
    cdp,
    `!!document.querySelector('[placeholder="Anything else?"]')`,
    8_000,
    "The session does not wait after the unsaved photo",
  );

  const openExport = async () => {
    // A narrow Player keeps Settings in its tools drawer, which may be closed or still sliding in after a resize.
    if (!(await value(cdp, visible("[data-settings-trigger]"))))
      await physicalClick(cdp, "[data-player-top-bar] [data-sidebar=trigger]");
    await waitFor(
      cdp,
      `(() => {
        const rect = document.querySelector('[data-settings-trigger]')?.getBoundingClientRect();
        return !!rect && rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth &&
          document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity);
      })()`,
    );
    await physicalClick(cdp, "[data-settings-trigger]");
    await waitFor(cdp, `!!document.querySelector('[data-export-saved-data]')`);
    await physicalClick(cdp, "[data-export-saved-data]");
    await waitFor(
      cdp,
      `document.querySelector('[data-export-script="development-package:saved-photo"]')?.textContent.replace(/\\s+/g, ' ').includes('2 values · 1 photo') === true &&
        !!document.querySelector('[data-export-download]')`,
      8_000,
      "The export did not list the script with its saved values and only its saved photo",
    );
  };
  const closeDialog = async (selector) => {
    await cdp.call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await cdp.call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await waitFor(cdp, `!document.querySelector(${JSON.stringify(selector)})`);
  };
  await openExport();
  // Exporting works while the session waits, when clearing does not.
  assertEqual(
    await value(cdp, `document.querySelector('[data-clear-saved-data]')?.disabled`),
    true,
    "Clearing was offered during the session",
  );
  // Every script this browser keeps is listed and ticked; Select none leaves nothing to download.
  const listedScripts = await value(
    cdp,
    `[...document.querySelectorAll('[data-export-script]')].map((row) => [row.dataset.exportScript, row.querySelector('[role=checkbox]').getAttribute('aria-checked')])`,
  );
  assertEqual(
    listedScripts.length >= 2 && listedScripts.every(([, checked]) => checked === "true"),
    true,
    `Every script with saved data is listed and ticked: ${JSON.stringify(listedScripts)}`,
  );
  await physicalClick(cdp, "[data-export-none]");
  await waitFor(
    cdp,
    `!document.querySelector('[data-export-download]') && document.body.innerText.includes('Tick at least one script')`,
  );
  await physicalClick(cdp, "[data-export-all]");
  await waitFor(cdp, `!!document.querySelector('[data-export-download]')`);
  const download = await value(
    cdp,
    `(() => { const link = document.querySelector('[data-export-download]'); return { href: link.href, name: link.download }; })()`,
  );
  assertEqual(download.name, "teasescript-saved-data.teasestorage.json.gz", "Export file name");
  await physicalClick(cdp, "[data-export-download]");
  let downloaded = null;
  const deadline = Date.now() + 8_000;
  while (downloaded === null && Date.now() < deadline) {
    const names = await readdir(downloads);
    if (names.includes(download.name)) downloaded = await readFile(join(downloads, download.name));
    else await delay(50);
  }
  if (downloaded === null) throw new Error("The export file was not downloaded");
  const document = JSON.parse(gunzipSync(downloaded).toString("utf8"));
  assertEqual(document.format, "teasescript-script-storage", "Downloaded export format");
  assertEqual(
    JSON.stringify(document.scripts.map((script) => script.scope)),
    JSON.stringify(listedScripts.map(([scope]) => scope)),
    "Downloaded export scripts",
  );
  const savedPhotoScript = document.scripts.find(
    (script) => script.scope === "development-package:saved-photo",
  );
  assertEqual(savedPhotoScript.name, "Saved photo", "The script's title names it");
  assertEqual(
    JSON.stringify(savedPhotoScript.entries.map((entry) => entry.key).sort()),
    JSON.stringify(["photo", "score"]),
    "Downloaded export values",
  );
  const savedPhotoImage = document.images.find(
    (image) =>
      image.reference === savedPhotoScript.entries.find((entry) => entry.key === "photo").value,
  );
  assertEqual(
    Buffer.from(savedPhotoImage.data, "base64url").equals(photoBytes) &&
      savedPhotoImage.byteLength === photoBytes.length,
    true,
    "The downloaded photo is not the saved photo's exact bytes",
  );

  await physicalClick(cdp, '[data-export-tab="text"]');
  await waitFor(
    cdp,
    `document.querySelector('[data-export-text]')?.value.startsWith('TSST1.gzip.') === true`,
  );
  const exportedText = await value(cdp, `document.querySelector('[data-export-text]').value`);
  assertEqual(
    gunzipSync(Buffer.from(exportedText.slice("TSST1.gzip.".length), "base64url")).toString("utf8"),
    gunzipSync(downloaded).toString("utf8"),
    "The text holds the same export as the file",
  );
  // Without the clipboard API, as over plain HTTP, the selected text copies the older way, and focus stays on Copy.
  await evaluate(
    cdp,
    `window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); document.addEventListener('copy', () => { const area = document.activeElement; window.__copied = area.value.slice(area.selectionStart, area.selectionEnd); }, { once: true });`,
  );
  await physicalClick(cdp, "[data-export-copy]");
  await waitFor(
    cdp,
    `document.querySelector('[data-export-copy-status]')?.textContent.trim() === 'Copied.'`,
  );
  assertEqual(
    await value(
      cdp,
      `window.__copied === document.querySelector('[data-export-text]').value && document.activeElement === document.querySelector('[data-export-copy]')`,
    ),
    true,
    "Copy without the clipboard API did not copy the text or lost the focus",
  );
  // Refused clipboard access, where the browser also refuses copying the selection, leaves the text selected for
  // copying by hand.
  await evaluate(
    cdp,
    `Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } }); document.execCommand = () => false;`,
  );
  await physicalClick(cdp, "[data-export-copy]");
  await waitFor(
    cdp,
    `document.querySelector('[data-export-copy-status]')?.textContent.includes('copy it with the browser')`,
  );
  assertEqual(
    await value(
      cdp,
      `(() => { const area = document.querySelector('[data-export-text]'); return document.activeElement === area && area.selectionStart === 0 && area.selectionEnd === area.value.length; })()`,
    ),
    true,
    "The refused copy did not select the text",
  );
  await evaluate(
    cdp,
    `delete document.execCommand; window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.__copied = value; } } });`,
  );
  await physicalClick(cdp, "[data-export-copy]");
  await waitFor(
    cdp,
    `document.querySelector('[data-export-copy-status]')?.textContent.trim() === 'Copied.'`,
  );
  assertEqual(
    await value(cdp, `window.__copied === document.querySelector('[data-export-text]').value`),
    true,
    "Copy wrote the text",
  );

  // Closing releases the prepared file.
  await closeDialog("[data-saved-data-export]");
  assertEqual(
    await evaluate(
      cdp,
      `return fetch(${JSON.stringify(download.href)}).then(() => 'readable', () => 'released');`,
    ),
    "released",
    "The export file stayed available after the dialog closed",
  );
  await closeDialog("[data-player-settings]");

  // On a narrow screen the dialog fits, and its controls are large enough to touch.
  await setViewport(cdp, 390, 844);
  await openExport();
  // Let the dialog finish its opening animation.
  await delay(400);
  const fit = await value(
    cdp,
    `(() => {
      const dialog = document.querySelector('[data-saved-data-export]').getBoundingClientRect();
      const controls = [...document.querySelectorAll('[data-saved-data-export] [data-export-download], [data-saved-data-export] [data-export-tab]')];
      const problems = [];
      if (dialog.left < 0 || dialog.right > innerWidth || dialog.top < 0 || dialog.bottom > innerHeight)
        problems.push('dialog ' + JSON.stringify(dialog) + ' in ' + innerWidth + 'x' + innerHeight);
      if (controls.length !== 3) problems.push(controls.length + ' controls');
      for (const control of controls)
        if (control.getBoundingClientRect().height < 44) problems.push(control.textContent.trim() + ' ' + control.getBoundingClientRect().height + 'px');
      return problems.join('; ') || 'fits';
    })()`,
  );
  assertEqual(
    fit,
    "fits",
    "The export dialog does not fit a narrow screen with touch-sized controls",
  );
  await physicalClick(cdp, '[data-export-tab="text"]');
  await waitFor(cdp, `!!document.querySelector('[data-export-copy]')`);
  assertEqual(
    await value(
      cdp,
      `[...document.querySelectorAll('[data-export-copy], [data-export-copy] + button')].map((button) => button.getBoundingClientRect().height >= 44).join()`,
    ),
    "true,true",
    "Copy and Select text are not touch-sized",
  );
  await closeDialog("[data-saved-data-export]");
  await closeDialog("[data-player-settings]");
  await setViewport(cdp, 1440, 900);
  return { file: join(downloads, download.name), text: exportedText };
}

// Imports the export into a fresh browser profile, as on another device: a file chosen and reviewed, whose Cancel keeps
// the running session; then a dropped file whose confirmation ends that session, after which Start shows the saved photo
// again with every other script of the bundle in its own scope; pasted text into a reloaded Player; and, while another
// script runs, only the ticked script of the bundle replaced.
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
    const text = (value) => `document.body.innerText.includes(${JSON.stringify(value)})`;
    const start = "[data-session-activation] button";
    const openImport = async () => {
      await physicalClick(cdp, "[data-settings-trigger]");
      await waitFor(
        cdp,
        `document.querySelector('[data-import-saved-data]')?.disabled === false`,
        8_000,
      );
      await physicalClick(cdp, "[data-import-saved-data]");
      await waitFor(cdp, `!!document.querySelector('[data-saved-data-import]')`);
    };
    const escape = async (selector) => {
      for (const type of ["keyDown", "keyUp"])
        await cdp.call("Input.dispatchKeyEvent", {
          type,
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
      await waitFor(cdp, `!document.querySelector(${JSON.stringify(selector)})`);
    };

    await navigate(cdp, `${origin}/player/?package=saved-photo`);
    await waitFor(cdp, `!!document.querySelector('${start}')`);
    assertEqual(
      await value(
        cdp,
        `Object.keys(localStorage).filter((name) => name.includes('saved-photo') && !name.startsWith('player-storage-name:')).length`,
      ),
      0,
      "The import profile starts without saved data",
    );
    await physicalClick(cdp, start);
    await waitFor(
      cdp,
      visible("[data-composer-attach]"),
      8_000,
      "The fresh profile's session did not ask for an image",
    );
    assertEqual(
      await value(cdp, text("Your saved photo is back.")),
      false,
      "The fresh profile already had the photo",
    );

    // A chosen file is checked and reviewed; Cancel keeps the session.
    await openImport();
    await setInputFiles(cdp, "[data-import-file]", [exported.file]);
    await waitFor(
      cdp,
      `!!document.querySelector('[data-import-confirm]')`,
      8_000,
      "The chosen file was not reviewed",
    );
    // Every script of the bundle is listed, ticked, and new here; the shown one is marked.
    const bundledScopes = JSON.parse(
      gunzipSync(await readFile(exported.file)).toString("utf8"),
    ).scripts.map((script) => script.scope);
    assertEqual(
      await value(
        cdp,
        `JSON.stringify([...document.querySelectorAll('[data-import-script]')].map((row) => [row.dataset.importScript, row.querySelector('[role=checkbox]').getAttribute('aria-checked'), row.querySelector('[data-import-status]').textContent.trim()]))`,
      ),
      JSON.stringify(bundledScopes.map((scope) => [scope, "true", "New"])),
      "Import review lists the bundle's scripts",
    );
    assertEqual(
      await value(
        cdp,
        `document.querySelector('[data-import-script="development-package:saved-photo"]').textContent.includes('This script')`,
      ),
      true,
      "The shown script is marked",
    );
    assertEqual(
      await value(cdp, `document.querySelector('[data-import-confirm]').textContent.trim()`),
      "End session and replace data",
      "Confirming must say it ends the session",
    );
    // Measured once the dialog's opening zoom has finished.
    await waitFor(
      cdp,
      `document.getAnimations().every((animation) => animation.playState !== 'running')`,
    );
    assertEqual(
      await value(
        cdp,
        // A checkbox's touch target is its whole labelled row.
        `[...document.querySelectorAll('[data-saved-data-import] button:not([data-slot="dialog-close"]):not([role=checkbox]), [data-saved-data-import] [data-import-script]')].filter((control) => control.offsetParent && control.getBoundingClientRect().height < 44).map((control) => control.textContent.trim() + ' ' + control.getBoundingClientRect().height).join('; ')`,
      ),
      "",
      "The import review's controls are not touch-sized",
    );
    await physicalClick(cdp, "[data-saved-data-import] [data-import-confirm] + button");
    await waitFor(cdp, `!!document.querySelector('[data-import-drop]')`);
    await escape("[data-saved-data-import]");
    await escape("[data-player-settings]");
    assertEqual(
      await value(cdp, visible("[data-composer-attach]")),
      true,
      "Cancel ended the session",
    );
    assertEqual(
      await value(
        cdp,
        `Object.keys(localStorage).filter((name) => name.includes('saved-photo') && !name.startsWith('player-storage-name:')).length`,
      ),
      0,
      "Cancel changed the saved data",
    );

    // A dropped file; confirming ends the session, and the next Start shows the imported photo.
    await openImport();
    const bytes = (await readFile(exported.file)).toString("base64");
    const drop = (names) =>
      evaluate(
        cdp,
        `const bytes = Uint8Array.from(atob(${JSON.stringify(bytes)}), (character) => character.charCodeAt(0));
        const transfer = new DataTransfer();
        for (const name of ${JSON.stringify(names)}) transfer.items.add(new File([bytes], name));
        document.querySelector('[data-import-drop]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));`,
      );
    // Refusing a drop of two files also discards a file still being read, which never becomes the review.
    await evaluate(
      cdp,
      `const read = File.prototype.arrayBuffer;
      window.__releaseHeld = null;
      File.prototype.arrayBuffer = function () {
        if (this.name !== 'held.teasestorage.json.gz') return read.call(this);
        return new Promise((resolve) => (window.__releaseHeld = () => resolve(read.call(this))));
      };`,
    );
    await drop(["held.teasestorage.json.gz"]);
    await waitFor(cdp, `typeof window.__releaseHeld === 'function'`);
    await drop(["first.teasestorage.json.gz", "second.teasestorage.json.gz"]);
    await waitFor(
      cdp,
      `document.querySelector('[data-import-problem]')?.textContent.includes('Drop one exported file.') === true`,
    );
    await evaluate(cdp, `window.__releaseHeld();`);
    await delay(500);
    assertEqual(
      await value(
        cdp,
        `!document.querySelector('[data-import-confirm]') && document.querySelector('[data-import-problem]')?.textContent.includes('Drop one exported file.') === true`,
      ),
      true,
      "A file read before a refused drop became the import review",
    );
    await drop(["saved.teasestorage.json.gz"]);
    await waitFor(
      cdp,
      `!!document.querySelector('[data-import-confirm]')`,
      8_000,
      "The dropped file was not reviewed",
    );
    await evaluate(
      cdp,
      `document.querySelector('[data-import-confirm]').scrollIntoView({ block: 'center', behavior: 'instant' })`,
    );
    await physicalClick(cdp, "[data-import-confirm]");
    await waitFor(
      cdp,
      text("Saved data imported. Each script uses it from its next Start."),
      8_000,
      "The import did not finish",
    );
    assertEqual(
      await value(cdp, visible("[data-composer-attach]")),
      false,
      "The session did not end",
    );
    await escape("[data-saved-data-import]");
    await escape("[data-player-settings]");
    await waitFor(
      cdp,
      `!!document.querySelector('${start}')`,
      8_000,
      "Start was not offered after the import",
    );
    await physicalClick(cdp, start);
    await waitFor(
      cdp,
      text("Your saved photo is back."),
      8_000,
      "The imported data did not load at Start",
    );
    await waitFor(
      cdp,
      `(() => { const image = document.querySelector('.stage-media'); return !!image && image.complete && image.naturalWidth === 24; })()`,
      8_000,
      "The imported photo is not on the Stage",
    );

    // Pasted text into a reloaded Player, before Start, replaces the data without a session to end.
    await navigate(cdp, `${origin}/player/?package=saved-photo`);
    await waitFor(cdp, `!!document.querySelector('${start}')`);
    await openImport();
    await physicalClick(cdp, '[data-import-tab="text"]');
    await waitFor(cdp, `!!document.querySelector('[data-import-text]')`);
    await evaluate(
      cdp,
      `const area = document.querySelector('[data-import-text]');
      area.value = ${JSON.stringify(exported.text.replace(/(.{76})/g, "$1\n"))};
      area.dispatchEvent(new Event('input', { bubbles: true }));`,
    );
    await physicalClick(cdp, "[data-import-review]");
    await waitFor(
      cdp,
      `!!document.querySelector('[data-import-confirm]')`,
      8_000,
      "The pasted text was not reviewed",
    );
    assertEqual(
      await value(cdp, `document.querySelector('[data-import-confirm]').textContent.trim()`),
      "Replace saved data",
      "Without a session, confirming only replaces the data",
    );
    await physicalClick(cdp, "[data-import-confirm]");
    await waitFor(cdp, text("Saved data imported. Each script uses it from its next Start."));
    await escape("[data-saved-data-import]");
    await escape("[data-player-settings]");
    // Every other script of the bundle went into its own saved data.
    assertEqual(
      await value(
        cdp,
        `${JSON.stringify(bundledScopes)}.every((scope) => localStorage.getItem('player-storage-head:' + JSON.stringify(scope)) !== null)`,
      ),
      true,
      "Every script of the bundle was imported into its own scope",
    );

    // While another script runs, ticking only one script of the bundle replaces just that one and keeps the session.
    const heads = `JSON.stringify(Object.fromEntries(${JSON.stringify(bundledScopes)}.map((scope) => [scope, localStorage.getItem('player-storage-head:' + JSON.stringify(scope))])))`;
    const before = JSON.parse(await value(cdp, heads));
    await navigate(cdp, `${origin}/player/?package=pictures`);
    await waitFor(cdp, `!!document.querySelector('${start}')`);
    await physicalClick(cdp, start);
    await waitFor(cdp, visible("[data-composer-attach]"), 8_000, "The other script did not start");
    await openImport();
    await physicalClick(cdp, '[data-import-tab="text"]');
    await evaluate(
      cdp,
      `const area = document.querySelector('[data-import-text]');
      area.value = ${JSON.stringify(exported.text)};
      area.dispatchEvent(new Event('input', { bubbles: true }));`,
    );
    await physicalClick(cdp, "[data-import-review]");
    await waitFor(
      cdp,
      `!!document.querySelector('[data-import-confirm]')`,
      8_000,
      "The text was not reviewed",
    );
    assertEqual(
      await value(cdp, `document.body.innerText.includes('This script')`),
      false,
      "The running script is not in the bundle",
    );
    for (const scope of bundledScopes)
      if (scope !== "development-package:saved-photo") {
        const box = `[data-import-script="${scope}"] [role=checkbox]`;
        await evaluate(
          cdp,
          `document.querySelector(${JSON.stringify(box)}).scrollIntoView({ block: 'center', behavior: 'instant' })`,
        );
        await physicalClick(cdp, box);
        await waitFor(
          cdp,
          `document.querySelector(${JSON.stringify(box)}).getAttribute('aria-checked') === 'false'`,
        );
      }
    assertEqual(
      await value(cdp, `document.querySelector('[data-import-confirm]').textContent.trim()`),
      "Replace saved data",
      "Importing scripts other than the running one keeps its session",
    );
    await evaluate(
      cdp,
      `document.querySelector('[data-import-confirm]').scrollIntoView({ block: 'center', behavior: 'instant' })`,
    );
    await physicalClick(cdp, "[data-import-confirm]");
    await waitFor(cdp, text("Saved data imported. Each script uses it from its next Start."));
    await escape("[data-saved-data-import]");
    await escape("[data-player-settings]");
    assertEqual(
      await value(cdp, visible("[data-composer-attach]")),
      true,
      "The running script's session ended",
    );
    const after = JSON.parse(await value(cdp, heads));
    for (const scope of bundledScopes)
      assertEqual(
        after[scope] === before[scope],
        scope !== "development-package:saved-photo",
        `Only the ticked script was replaced (${scope})`,
      );
    assertEqual(
      await value(
        cdp,
        `Object.keys(localStorage).some((name) => name.includes('development-package:pictures') && !name.startsWith('player-storage-name:'))`,
      ),
      false,
      "The running script's saved data was changed",
    );
  } finally {
    cdp?.close();
    await browser.call("Target.disposeBrowserContext", {
      browserContextId: context.browserContextId,
    });
    browser.close();
  }
}

// A script error in the default build, without Debug: the error line and its notice open one error dialog, which names
// the error, and only on request; its debug export holds no personal content until the player chooses it; with replay
// data chosen, the offline tool reproduces the failure.
async function debugExportScenario(cdp, origin, profile) {
  const downloads = join(profile, "debug-downloads");
  await mkdir(downloads, { recursive: true });
  await cdp.call("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  const picture = join(profile, "debug-picture.png");
  const pictureBytes = solidPng(20, 10, [40, 90, 200]);
  await writeFile(picture, pictureBytes);
  const answer = "Ada-private-answer";
  await setViewport(cdp, 1440, 900);
  await navigate(cdp, `${origin}/player/?package=debug-failure`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(
    cdp,
    `document.querySelector('[data-composer-input]')?.placeholder === 'Your name'`,
  );
  await evaluate(cdp, `document.querySelector('[data-composer-input]').focus()`);
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
  await waitFor(cdp, `!!document.querySelector('[data-runtime-failure]')`, 8_000, "No error line");
  assertEqual(
    await value(
      cdp,
      `document.querySelector('[data-runtime-failure]').textContent.replace(/\\s+/g, ' ').trim()`,
    ),
    "The script stopped because of an error. Details",
    "The error line",
  );
  await delay(300);
  assertEqual(
    await value(cdp, `!!document.querySelector('[data-session-error-dialog]')`),
    false,
    "The error dialog opened by itself",
  );
  const errorDialog = `document.querySelector('[data-session-error-dialog]')`;
  const openErrorDialog = async () => {
    await physicalClick(cdp, "[data-runtime-failure-details]");
    await waitFor(cdp, `!!${errorDialog} && ${errorDialog}.dataset.state === 'open'`);
  };
  await openErrorDialog();
  assertEqual(
    await value(
      cdp,
      `JSON.stringify([${errorDialog}.querySelector('h2').textContent.trim(), ${errorDialog}.querySelector('[data-session-error-summary]').textContent.trim(), !!document.querySelector('[data-session-error-technical]'), !!document.querySelector('[data-session-error-debug]'), [...${errorDialog}.querySelectorAll('button')].map((button) => button.textContent.trim())])`,
    ),
    JSON.stringify([
      "Script error",
      "In main.tease, line 10.",
      false,
      false,
      ["Technical details", "Download debug export", "Close"],
    ]),
    "The error dialog says where the script stopped, with its details closed, one Close, and no Debug without Debug",
  );
  // A click beside the dialog leaves it open; only Close and Escape close it.
  await backdropClick(cdp);
  await delay(300);
  assertEqual(
    await value(cdp, `${errorDialog}?.dataset.state`),
    "open",
    "A click beside the error dialog closed it",
  );
  await physicalClick(cdp, "[data-session-error-technical-toggle]");
  await waitFor(cdp, `!!document.querySelector('[data-session-error-technical]')`);
  assertEqual(
    await value(
      cdp,
      `JSON.stringify([document.querySelector('[data-session-error-code]').textContent.trim(), document.querySelector('[data-session-error-source]').textContent, document.querySelector('[data-session-error-failing]').textContent, !!document.querySelector('[data-session-error-calls]')])`,
    ),
    JSON.stringify([
      "TSR036: Division by zero: '1 / zero' has no result because 'zero' is 0. Check that 'zero' is not 0 first.",
      "let result = 1 / zero",
      "1 / zero",
      false,
    ]),
    "The technical details: the code with the runtime's message, and the failing line with its expression marked",
  );
  // Close returns focus to the error line; the notice's Details opens the same dialog.
  await physicalClick(cdp, "[data-session-error-close]");
  await waitFor(
    cdp,
    `!${errorDialog} && document.activeElement?.matches('[data-runtime-failure-details]')`,
    5_000,
    "Closing the error dialog did not return focus to the error line",
  );
  await physicalClick(cdp, "[data-notification-bell]");
  await waitFor(
    cdp,
    `!!document.querySelector('[data-player-notification-panel] [data-notice-action]')`,
  );
  assertEqual(
    await value(
      cdp,
      `document.querySelector('[data-player-notification-panel] [data-player-notice]').textContent.includes('The script stopped because of an error.')`,
    ),
    true,
    "The error notice",
  );
  await physicalClick(cdp, "[data-player-notification-panel] [data-notice-action]");
  await waitFor(cdp, `!!${errorDialog} && ${errorDialog}.dataset.state === 'open'`);
  await physicalClick(cdp, "[data-session-error-close]");
  await waitFor(cdp, `!${errorDialog}`);
  // The error dialog hands over to the export dialog instead of staying beneath it.
  const openExport = async () => {
    await openErrorDialog();
    await physicalClick(cdp, "[data-session-error-export]");
    await waitFor(cdp, ready, 8_000, "The debug export was not prepared");
    await waitFor(
      cdp,
      `!${errorDialog}`,
      5_000,
      "The error dialog stayed beneath the export dialog",
    );
  };

  const download = async (expectedName) => {
    const before = new Set(await readdir(downloads));
    // The dialog scrolls when its content is taller than the screen.
    await evaluate(
      cdp,
      `document.querySelector('[data-debug-export-download]').scrollIntoView({ block: 'center', behavior: 'instant' })`,
    );
    await physicalClick(cdp, "[data-debug-export-download]");
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const added = (await readdir(downloads)).filter(
        (name) => !before.has(name) && !name.endsWith(".crdownload"),
      );
      if (added.length === 1) {
        assertEqual(added[0], expectedName, "Debug export file name");
        const path = join(downloads, added[0]);
        const bytes = await readFile(path);
        await rm(path);
        return bytes;
      }
      await delay(50);
    }
    throw new Error("The debug export was not downloaded");
  };
  // Named after the title of the package's header.
  const fileName = "Debug-failure-debug.teasedebug.json.gz";
  const ready = `!!document.querySelector('[data-debug-export-download]')`;

  // Nothing personal is chosen at first.
  await openExport();
  assertEqual(
    await value(
      cdp,
      `[...document.querySelectorAll('[data-debug-export] [role=switch]')].every((item) => item.getAttribute('aria-checked') === 'false')`,
    ),
    true,
    "Personal content is off by default",
  );
  const structural = gunzipSync(await download(fileName)).toString("utf8");
  assertEqual(structural.includes(answer), false, "The default export contains the answer");
  assertEqual(
    structural.includes("captured-media:"),
    false,
    "The default export contains a photo reference",
  );
  assertEqual(JSON.parse(structural).incident.code, "TSR036", "The default export names the error");

  // With replay data and its prerequisites, the offline tool reproduces the failure; the chosen photo is included.
  for (const category of ["savedValues", "answers", "sessionText", "replay", "photos"]) {
    await evaluate(
      cdp,
      `document.querySelector('[data-debug-export-category="${category}"]').scrollIntoView({ block: 'center', behavior: 'instant' })`,
    );
    await physicalClick(cdp, `[data-debug-export-category="${category}"] [role=switch]`);
    await waitFor(
      cdp,
      `document.querySelector('[data-debug-export-category="${category}"] [role=switch]')?.getAttribute('aria-checked') === 'true'`,
    );
  }
  // The last choice prepares the file again; Download is offered once that preparation is done.
  await waitFor(
    cdp,
    `document.querySelector('[data-debug-export-photo] [role=checkbox]')?.getAttribute('aria-checked') === 'true' &&
      !!document.querySelector('[data-debug-export-download]') &&
      document.querySelector('[data-debug-export-summary]')?.textContent.includes('replay the error exactly')`,
    8_000,
    "Replay data and the photo were not prepared",
  );
  const replayable = join(downloads, "replayable.teasedebug.json.gz");
  await writeFile(replayable, await download(fileName));
  const replayed = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./debug-export.mjs", import.meta.url)), "replay", replayable],
    { encoding: "utf8" },
  );
  assertEqual(
    replayed.status,
    0,
    `The offline replay failed: ${replayed.stdout}${replayed.stderr}`,
  );
  assertEqual(
    replayed.stdout.startsWith("reproduced engine failure TSR036 at main.tease:10:"),
    true,
    "The offline replay",
  );
  const document = JSON.parse(gunzipSync(await readFile(replayable)).toString("utf8"));
  assertEqual(document.photos.length, 1, "The chosen photo is included");
  assertEqual(
    Buffer.from(document.photos[0].data, "base64url").equals(pictureBytes),
    true,
    "The photo's original bytes",
  );
  // The name was sent with a click on Send; the picture answers through the picker, whose input is not recorded.
  assertEqual(
    JSON.stringify(document.sections.answers.map((answer) => answer.input)),
    JSON.stringify(["send", null]),
    "How each answer was given",
  );

  // The dialog fits a narrow screen with touch-sized rows.
  await cdp.call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await cdp.call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await waitFor(cdp, `!document.querySelector('[data-debug-export]')`);
  await setViewport(cdp, 390, 844);
  // At the transcript's end, its last message is clear of the error line above the composer.
  await waitFor(
    cdp,
    `(() => {
      const scroller = document.querySelector('.transcript-scroll');
      scroller.scrollTop = scroller.scrollHeight;
      const entries = document.querySelectorAll('.transcript-entry');
      const last = entries[entries.length - 1].getBoundingClientRect();
      const card = document.querySelector('[data-runtime-failure]').getBoundingClientRect();
      return last.bottom <= card.top && document.getAnimations().every((animation) => animation.playState !== 'running');
    })()`,
    8_000,
    "The error line covers the transcript's last message",
  );
  // The error dialog fits a narrow screen with touch-sized buttons.
  await openErrorDialog();
  await physicalClick(cdp, "[data-session-error-technical-toggle]");
  await waitFor(
    cdp,
    `!!document.querySelector('[data-session-error-technical]') && document.getAnimations().every((animation) => animation.playState !== 'running')`,
  );
  assertEqual(
    await value(
      cdp,
      `(() => {
        const dialog = ${errorDialog}.getBoundingClientRect();
        const problems = [];
        if (dialog.left < 0 || dialog.right > innerWidth || dialog.top < 0 || dialog.bottom > innerHeight) problems.push('dialog outside the screen');
        for (const button of ${errorDialog}.querySelectorAll('[data-session-error-technical-toggle], [data-session-error-export], [data-session-error-close]'))
          if (button.getBoundingClientRect().height < 44) problems.push(button.textContent.trim());
        return problems.join('; ') || 'fits';
      })()`,
    ),
    "fits",
    "The error dialog on a narrow screen",
  );
  await physicalClick(cdp, "[data-session-error-close]");
  await waitFor(cdp, `!${errorDialog}`);
  await openExport();
  await waitFor(
    cdp,
    `document.getAnimations().every((animation) => animation.playState !== 'running')`,
  );
  const fit = await value(
    cdp,
    `(() => {
      const dialog = document.querySelector('[data-debug-export]').getBoundingClientRect();
      const problems = [];
      if (dialog.left < 0 || dialog.right > innerWidth || dialog.top < 0 || dialog.bottom > innerHeight) problems.push('dialog outside the screen');
      for (const row of document.querySelectorAll('[data-debug-export-category]'))
        if (row.getBoundingClientRect().height < 44) problems.push(row.dataset.debugExportCategory + ' row');
      return problems.join('; ') || 'fits';
    })()`,
  );
  assertEqual(fit, "fits", "The debug export dialog on a narrow screen");
  const escape = async () => {
    for (const type of ["keyDown", "keyUp"])
      await cdp.call("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
  };
  await escape();
  await waitFor(cdp, `!document.querySelector('[data-debug-export]')`);

  // From Settings in the narrow tools drawer, the dialog is above Settings and takes input; closing it returns there.
  await physicalClick(cdp, "[data-player-top-bar] [data-sidebar=trigger]");
  const settled = `document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity)`;
  await waitFor(
    cdp,
    `(() => {
      const rect = document.querySelector('[data-settings-trigger]')?.getBoundingClientRect();
      return !!rect && rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && ${settled};
    })()`,
  );
  await physicalClick(cdp, "[data-settings-trigger]");
  await waitFor(
    cdp,
    `!!document.querySelector('[data-player-setting="debug-export"]') && ${settled}`,
  );
  await evaluate(
    cdp,
    `document.querySelector('[data-player-setting="debug-export"]').scrollIntoView({ block: 'center', behavior: 'instant' })`,
  );
  await physicalClick(cdp, '[data-player-setting="debug-export"]');
  await waitFor(
    cdp,
    `${ready} && ${settled}`,
    8_000,
    "The debug export did not open from Settings",
  );
  const row = '[data-debug-export-category="player"]';
  assertEqual(
    await value(
      cdp,
      `(() => {
        const rect = document.querySelector('${row}').getBoundingClientRect();
        return !!document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('[data-debug-export]');
      })()`,
    ),
    true,
    "The debug export opened from Settings is above Settings",
  );
  await physicalClick(cdp, `${row} [role=switch]`);
  await waitFor(
    cdp,
    `document.querySelector('${row} [role=switch]')?.getAttribute('aria-checked') === 'true'`,
    8_000,
    "A choice in the debug export opened from Settings did not take input",
  );
  await escape();
  await waitFor(
    cdp,
    `!document.querySelector('[data-debug-export]') && document.activeElement?.matches('[data-player-setting="debug-export"]')`,
    8_000,
    "Closing the debug export did not return to Settings",
  );
  await escape();
  await waitFor(cdp, `!document.querySelector('[data-player-settings]')`);
  await setViewport(cdp, 1440, 900);
}

async function askImageCameraScenario(cdp, origin, profile) {
  const file = join(profile, "camera-alternative.png");
  await writeFile(file, solidPng(32, 24, [10, 120, 200]));
  const liveVideo = (frame) =>
    `(() => { const video = document.querySelector('${frame} [data-image-capture]')?.parentElement.querySelector('video'); return !!video && video.readyState >= 2 && video.videoWidth > 0; })()`;
  const photo = `document.querySelector('[data-image-capture-photo]')`;
  const photoReady = `(${photo}?.complete && ${photo}.naturalWidth > 0) === true`;
  const imageAnswers = `[...document.querySelectorAll('.transcript-entry')].filter((entry) => entry.textContent.trim() === 'Image').length`;
  // Every camera track the page opens, so the smoke can see the camera turn off.
  const cameraOff = `window.__cameraTracks.length > 0 && window.__cameraTracks.every((track) => track.readyState === 'ended')`;
  const start = async (pkg) => {
    await navigate(cdp, `${origin}/player/?package=${pkg}`);
    await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
    await physicalClick(cdp, "[data-session-activation] button");
  };
  const tracking = await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `{
      window.__cameraTracks = [];
      // Set before a navigation: that page's first camera request fails as if another application held the camera.
      window.__busyOnce = sessionStorage.getItem('busyOnce') === '1';
      sessionStorage.removeItem('busyOnce');
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (window.__busyOnce) {
          window.__busyOnce = false;
          throw new DOMException('busy', 'NotReadableError');
        }
        const stream = await real(constraints);
        window.__cameraTracks.push(...stream.getVideoTracks());
        return stream;
      };
    }`,
  });
  try {
    await cdp.call("Browser.setPermission", {
      origin,
      permission: { name: "camera" },
      setting: "granted",
    });
    await start("picture-camera");
    await waitFor(
      cdp,
      liveVideo("[data-stage-camera]"),
      8_000,
      "The camera did not open by itself on the Stage",
    );
    assertEqual(
      await value(
        cdp,
        `document.querySelector('[data-image-capture]').textContent.includes('Take a selfie for me')`,
      ),
      true,
      "The viewfinder does not ask the request's question",
    );
    assertEqual(
      await value(cdp, visible("[data-composer-attach]")),
      true,
      "The paperclip is not offered beside the camera",
    );
    await physicalClick(cdp, "[data-image-capture-shutter]");
    // The shutter counts down from five over the live viewfinder before it takes the photo.
    await waitFor(
      cdp,
      `document.querySelector('[data-image-capture-countdown]')?.textContent.trim() === '5' && ${liveVideo("[data-stage-camera]")}`,
      2_000,
      "The shutter did not start the countdown",
    );
    assertEqual(
      await value(cdp, `!!${photo}`),
      false,
      "The photo was taken before the countdown ended",
    );
    await waitFor(cdp, photoReady, 10_000, "The photo taken is not shown for review");
    assertTestCard(
      await value(cdp, quadrantColors(photo)),
      "The photo taken does not show the camera's frame",
    );
    assertEqual(
      await value(cdp, `${imageAnswers}`),
      0,
      "Taking a photo answered the request before Use this",
    );
    await physicalClick(cdp, "[data-image-capture-retake]");
    await waitFor(
      cdp,
      `!${photo} && ${liveVideo("[data-stage-camera]")}`,
      8_000,
      "Retake did not return to the live camera",
    );
    await physicalClick(cdp, "[data-image-capture-shutter]");
    await waitFor(cdp, photoReady, 10_000);
    await physicalClick(cdp, "[data-image-capture-use]");
    await waitFor(
      cdp,
      `!document.querySelector('[data-image-capture]') && ${imageAnswers} === 1 && document.body.innerText.includes('Lovely.')`,
      8_000,
      "Use this did not answer the request",
    );
    await waitFor(
      cdp,
      cameraOff,
      8_000,
      "The camera the request opened stayed on after the answer",
    );
    await waitFor(
      cdp,
      `(() => { const image = document.querySelector('.stage-media'); return !!image && image.complete && image.src.startsWith('blob:'); })()`,
    );
    assertTestCard(
      await value(cdp, quadrantColors(`document.querySelector('.stage-media')`)),
      "The Stage does not show the photo used",
    );

    // With a camera window the script shows, the photo is taken there; a file answer turns the camera off too.
    await start("picture-camera-view");
    await waitFor(
      cdp,
      liveVideo("[data-floating-viewfinder]"),
      8_000,
      "The camera did not open in the script's camera window",
    );
    assertEqual(
      await value(cdp, `!!document.querySelector('[data-stage-camera]')`),
      false,
      "The camera opened on the Stage as well",
    );
    await openPicker(cdp);
    await setInputFiles(cdp, "[data-composer-file]", [file]);
    await waitFor(
      cdp,
      `!document.querySelector('[data-image-capture]') && ${imageAnswers} === 1`,
      8_000,
      "A file did not answer the camera request",
    );
    await waitFor(
      cdp,
      cameraOff,
      8_000,
      "The camera the request opened stayed on after a file answered",
    );

    // The camera is busy the first time: the viewfinder offers Try again, and the paperclip stays.
    await evaluate(cdp, "sessionStorage.setItem('busyOnce', '1')");
    await start("picture-camera");
    await waitFor(
      cdp,
      visible("[data-image-capture-retry]"),
      8_000,
      "A busy camera offered no Try again",
    );
    assertEqual(
      await value(cdp, visible("[data-composer-attach]")),
      true,
      "The paperclip went with the camera",
    );
    await physicalClick(cdp, "[data-image-capture-retry]");
    await waitFor(
      cdp,
      liveVideo("[data-stage-camera]"),
      8_000,
      "Try again did not open the camera",
    );
  } finally {
    await cdp.call("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: tracking.result.identifier,
    });
    await cdp.call("Browser.resetPermissions");
  }
}

/** Opens the file picker with the paperclip; the native dialog itself is suppressed, and `setInputFiles` answers it. */
async function openPicker(cdp) {
  await evaluate(
    cdp,
    `document.querySelector('[data-composer-file]').addEventListener('click', (event) => event.preventDefault(), { once: true });`,
  );
  await physicalClick(cdp, "[data-composer-attach]");
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

/**
 * The buttons scenario (`?scenario=buttons`) shows its permanent buttons in the rail. A click runs a button's block while
 * the button stays in place, inactive and focused; a block may remove its own button, after which focus moves to the
 * button in its place; Pause interrupts the waiting question and returns to it; Stop leaves the file entry, so only the
 * persistent Pause stays, and exit removes it.
 */
async function permanentButtonsScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  await navigate(cdp, `${origin}/player/?dev&scenario=buttons`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  const rail = `[...document.querySelectorAll('.stage-right-rail [data-permanent-button]')].map((button) => button.textContent.trim() + (button.getAttribute('aria-disabled') === 'true' ? ' (inactive)' : '')).join('|')`;
  const button = (id) => `[data-permanent-button="${id}"]`;
  const said = (text) => `document.body.innerText.split(${JSON.stringify(text)}).length - 1`;
  const clickButton = (label) =>
    evaluate(
      cdp,
      `[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === ${JSON.stringify(label)}).click()`,
    );
  await waitFor(cdp, `${rail} === "Count one|Give me a hint|Pause|Stop"`);
  await waitFor(cdp, `document.body.innerText.includes("Done counting")`);

  await physicalClick(cdp, button(1));
  await waitFor(
    cdp,
    `${rail} === "Count one (inactive)|Give me a hint|Pause|Stop"`,
    8_000,
    "The clicked button is not inactive in place while its block runs",
  );
  assertEqual(
    await value(cdp, `document.activeElement === document.querySelector('${button(1)}')`),
    true,
    "The inactive button lost focus",
  );
  // A click on the inactive button runs nothing.
  await physicalClick(cdp, button(1));
  await waitFor(
    cdp,
    `${rail} === "Count one|Give me a hint|Pause|Stop"`,
    8_000,
    "The button did not become active again after its block",
  );
  assertEqual(await value(cdp, said("That makes 1.")), 1, "The block did not run exactly once");
  assertEqual(await value(cdp, said("That makes 2.")), 0, "The inactive button ran its block");

  await physicalClick(cdp, button(2));
  await waitFor(cdp, `${rail} === "Count one|Pause|Stop"`, 8_000, "The hint button stayed");
  assertEqual(
    await value(cdp, `document.activeElement?.dataset.permanentButton`),
    "3",
    "Focus did not move to the button that took the removed one's place",
  );

  // Pause interrupts the waiting button and returns to it.
  await physicalClick(cdp, button(3));
  await waitFor(cdp, `document.body.innerText.includes("Ready, Mistress")`);
  assertEqual(
    await value(cdp, `${rail}`),
    "Count one|Pause (inactive)|Stop",
    "Pause is not inactive",
  );
  assertEqual(
    await value(
      cdp,
      `[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === "Done counting")`,
    ),
    false,
    "The interrupted button stayed presented",
  );
  await clickButton("Ready, Mistress");
  await waitFor(cdp, `${rail} === "Count one|Pause|Stop"`);
  await waitFor(
    cdp,
    `[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === "Done counting")`,
    8_000,
    "The interrupted button did not return",
  );

  await physicalClick(cdp, button(4));
  await waitFor(cdp, `${rail} === "Pause"`, 8_000, "Stop did not remove the entry's buttons");
  await waitFor(cdp, `document.body.innerText.includes("Stopped at 1. Only Pause stays now.")`);
  await clickButton("Yes, Mistress");
  await waitFor(cdp, `${rail} === ""`, 8_000, "exit did not remove the persistent button");
}

/**
 * `askForm` on a phone: 43 toggles wrap and scroll inside the form, so its submit button stays on screen above the
 * composer; a toggle is a pressed button with a polite status count, a cycle steps through authored colours, and
 * submitting adds one summary line.
 */
/**
 * Space in the empty composer activates a preselected button, a `showButton` or the one `prefill:` names, which is
 * marked, but only with a fresh press: not the press that skipped the message before it, and not a held key's repeat.
 * Without a preselected button it activates nothing; Space on a focused form toggle flips it; a held Enter submits
 * nothing.
 */
async function preselectScenario(cdp, origin) {
  await setViewport(cdp, 1280, 800);
  await navigate(cdp, `${origin}/player/?package=preselect`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  const input = `document.querySelector('[data-composer-input]')`;
  const buttons = `[...document.querySelectorAll('[data-foreground-controls] button')]`;
  const marked = `${buttons}.filter((button) => button.hasAttribute('data-preselected')).map((button) => button.textContent.trim())`;
  const answers = `[...document.querySelectorAll('.transcript-entry')].map((entry) => entry.textContent.trim())`;
  const heldKey = (key, code, windowsVirtualKeyCode, text) =>
    cdp.call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode,
      text,
      autoRepeat: true,
    });
  // The Space that skips "First" shows the question and its buttons, but does not answer it.
  await waitFor(
    cdp,
    `${answers}.some((text) => text.includes('First'))`,
    8_000,
    "First was not said",
  );
  await evaluate(cdp, `${input}.focus()`);
  await pressSpace(cdp);
  await waitFor(cdp, `${buttons}.length === 2`, 8_000, "askBoolean did not show its buttons");
  assertEqual(JSON.stringify(await value(cdp, marked)), '["Yes"]', "prefill: true marks Yes");
  await heldKey(" ", "Space", 32, " ");
  await delay(300);
  assertEqual(await value(cdp, `${buttons}.length`), 2, "A held Space answered askBoolean");
  assertEqual(await value(cdp, `${input}.value`), "", "Space typed into the composer");
  // A fresh Space chooses Yes, then continues the showButton, which is always preselected.
  await pressSpace(cdp);
  await waitFor(cdp, `${buttons}.map((button) => button.textContent.trim()).join() === 'Next'`);
  assertEqual(JSON.stringify(await value(cdp, marked)), '["Next"]', "A showButton is marked");
  await pressSpace(cdp);
  await waitFor(cdp, `${buttons}.length === 2 && ${buttons}[0].textContent.trim() === '5'`);
  assertEqual(JSON.stringify(await value(cdp, marked)), '["10"]', "prefill: 10 marks 10");
  await pressSpace(cdp);
  // Without a preselected button Space activates nothing.
  await waitFor(cdp, `${buttons}.length === 2 && ${buttons}[0].textContent.trim() === '1'`);
  assertEqual(
    JSON.stringify(await value(cdp, marked)),
    "[]",
    "A choice without prefill: is marked",
  );
  await pressSpace(cdp);
  await delay(300);
  assertEqual(
    await value(cdp, `${buttons}[0]?.textContent.trim()`),
    "1",
    "Space answered a choice without prefill",
  );
  assertEqual(
    await value(cdp, `${input}.value`),
    "",
    "Space typed into a composer that only buttons wait for",
  );
  await physicalClick(cdp, "[data-foreground-controls] button");
  // A held Enter, in the input or on Send, does not submit the prefill of the field that just opened; a fresh Enter does.
  await waitFor(cdp, `${input}.value === 'Ada'`, 8_000, "askText did not open with its prefill");
  await evaluate(cdp, `${input}.focus()`);
  await heldKey("Enter", "Enter", 13, "\r");
  await delay(300);
  assertEqual(await value(cdp, `${input}.value`), "Ada", "A held Enter submitted the prefill");
  await evaluate(cdp, `document.querySelector('.composer-send').focus()`);
  await heldKey("Enter", "Enter", 13, "\r");
  await delay(300);
  assertEqual(
    await value(cdp, `${input}.value`),
    "Ada",
    "A held Enter on Send submitted the prefill",
  );
  await evaluate(cdp, `${input}.focus()`);
  for (const type of ["keyDown", "keyUp"])
    await cdp.call("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      ...(type === "keyDown" ? { text: "\r" } : {}),
    });
  // Space on a focused form toggle flips it and does not submit the form.
  const toggle = `document.querySelector('[data-form-fields] button')`;
  await waitFor(cdp, `!!${toggle}`, 8_000, "askBooleans did not open");
  await evaluate(cdp, `${toggle}.focus()`);
  await pressSpace(cdp);
  await waitFor(
    cdp,
    `${toggle}.getAttribute('aria-pressed') === 'true'`,
    5_000,
    "Space did not flip the toggle",
  );
  assertEqual(
    await value(cdp, `!!document.querySelector('[data-form-controls]')`),
    true,
    "Space submitted the form",
  );
  await physicalClick(cdp, "[data-form-actions] button");
  await waitFor(
    cdp,
    `${answers}.some((text) => text.endsWith('true 10 1 Ada')) && ${answers}.at(-1).endsWith('[true, false]')`,
    8_000,
    "The answers were not true 10 1 Ada and [true, false]",
  );
}

async function formsScenario(cdp, origin) {
  await setViewport(cdp, 390, 700);
  await navigate(cdp, `${origin}/player/?package=forms`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  const fields = `[...document.querySelectorAll('[data-form-fields] button')]`;
  // Each toggle shows and announces its own state; the form has no count of them.
  const pressed = `${fields}.filter((button) => button.getAttribute("aria-pressed") === "true").length`;
  await waitFor(cdp, `${fields}.length === 43`, 15_000, "The 43 toggles did not appear");
  assertEqual(await value(cdp, pressed), 1, "The toggles do not show the start");
  // Every control keeps its touch height; following the latest content shows the submit button above the composer
  // while the fields scroll.
  assertEqual(
    await value(cdp, `${fields}.every((button) => button.getBoundingClientRect().height >= 44)`),
    true,
    "A toggle is shorter than a touch target",
  );
  const submit = `[...document.querySelectorAll('[data-form-actions] button')].find((button) => button.textContent.trim() === "OK")`;
  assertEqual(
    await value(
      cdp,
      `(() => { const rect = ${submit}.getBoundingClientRect(); const composer = document.querySelector('[data-composer-input]').getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= composer.top; })()`,
    ),
    true,
    "The submit button is not visible above the composer",
  );
  assertEqual(
    await value(
      cdp,
      `(() => { const viewport = document.querySelector('[data-form-fields] [data-reka-scroll-area-viewport]'); return viewport.scrollHeight > viewport.clientHeight; })()`,
    ),
    true,
    "The fields do not scroll inside the form",
  );
  // The last toggle scrolls into reach and turns on.
  await evaluate(cdp, `${fields}.at(-1).scrollIntoView({ block: "center" })`);
  await evaluate(cdp, `${fields}.at(-1).setAttribute("data-smoke-last", "")`);
  await physicalClick(cdp, "[data-smoke-last]");
  await waitFor(cdp, `${pressed} === 2`, 8_000, "The toggle did not turn on");
  assertEqual(
    await value(cdp, `document.querySelector('[data-smoke-last]').getAttribute('aria-pressed')`),
    "true",
    "The toggle is not pressed",
  );
  await evaluate(cdp, `${submit}.click()`);
  // Submitting adds one answer listing every toggle with its state, one per line; screen readers read its plain text.
  const summary = `document.querySelector('[data-form-summary]')`;
  await waitFor(cdp, `!!${summary}`, 8_000, "Submitting did not add the form's summary");
  assertEqual(
    await value(
      cdp,
      `[...${summary}.querySelectorAll('[data-form-summary-line="on"]')].map((line) => line.textContent.trim()).join(", ")`,
    ),
    "Rope, key",
    "The summary does not show the toggles that are on",
  );
  assertEqual(
    await value(cdp, `${summary}.querySelectorAll('[data-form-summary-line="off"]').length`),
    41,
    "The summary does not list the toggles that are off",
  );
  const plain = await value(cdp, `${summary}.previousElementSibling.textContent`);
  assertEqual(
    plain.startsWith("Submitted form: ✓ Rope, ✗ ") && plain.endsWith(", ✓ key"),
    true,
    `The summary's plain text is ${plain}`,
  );
  await waitFor(cdp, `${fields}.length === 3`, 15_000, "The second form did not appear");
  assertEqual(
    await value(
      cdp,
      `[...document.querySelectorAll('[data-form-actions] button')].map((button) => button.textContent.trim()).join("|")`,
    ),
    "Continue|Skip",
    "The form written with cancel: shows no cancel button",
  );
  const intensity = `${fields}.find((button) => button.textContent.includes("Intensity"))`;
  const fill = `getComputedStyle(${intensity}).backgroundImage`;
  const low = await value(cdp, fill);
  await evaluate(cdp, `${intensity}.click()`);
  await waitFor(
    cdp,
    `${intensity}.textContent.includes("Medium")`,
    8_000,
    "The cycle did not step",
  );
  assertEqual((await value(cdp, fill)) !== low, true, "The cycle did not take its option's colour");
  await evaluate(
    cdp,
    `[...document.querySelectorAll('[data-form-actions] button')].find((button) => button.textContent.trim() === "Continue").click()`,
  );
  await waitFor(
    cdp,
    `document.body.innerText.includes("Rope: true. Access: false. Intensity: Medium, pace Slow.")`,
    15_000,
    "The answers did not reach the script",
  );
}

/**
 * Typed `askForm` fields in the composer: a field opens with its value selected, so typing replaces it; a refused
 * answer stays with the composer notice; Enter commits and returns focus to the field; a date field uses the date
 * control; and submitting takes the text still being typed.
 */
async function formFieldsScenario(cdp, origin) {
  await setViewport(cdp, 1100, 800);
  await navigate(cdp, `${origin}/player/?package=forms-typed`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  const field = (id) => `document.querySelector('[data-form-field="${id}"]')`;
  const composer = `document.querySelector('[data-composer-input]')`;
  const pressEnter = async () => {
    for (const type of ["keyDown", "keyUp"])
      await cdp.call("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
  };
  await waitFor(cdp, `!!${field("impact")}`, 15_000, "The typed form did not appear");
  await physicalClick(cdp, '[data-form-field="impact"]');
  await waitFor(
    cdp,
    `document.activeElement === ${composer} && ${composer}.value === "5" && ${composer}.selectionEnd === 1`,
    8_000,
    "The field did not open in the composer with its value selected",
  );
  await cdp.call("Input.insertText", { text: "11" });
  await pressEnter();
  await waitFor(
    cdp,
    `document.body.innerText.includes("That is wrong. Impact must be from 1 to 10.")`,
    8_000,
    "An answer outside the bounds was not refused",
  );
  assertEqual(await value(cdp, `${composer}.value`), "11", "The refused text was not kept");
  await evaluate(cdp, `${composer}.select()`);
  await cdp.call("Input.insertText", { text: "7" });
  await pressEnter();
  await waitFor(
    cdp,
    `${field("impact")}.textContent.trim() === "Impact: 7" && document.activeElement === ${field("impact")}`,
    8_000,
    "Enter did not commit the answer and return focus to the field",
  );
  await physicalClick(cdp, '[data-form-field="day"]');
  await waitFor(
    cdp,
    `document.activeElement?.type === "date"`,
    8_000,
    "The date field did not use the date control",
  );
  await evaluate(
    cdp,
    `const input = document.activeElement; input.value = "2026-10-05"; input.dispatchEvent(new Event("input", { bubbles: true }))`,
  );
  await pressEnter();
  await waitFor(
    cdp,
    `!${field("day")}.textContent.includes("Set…")`,
    8_000,
    "The date was not committed",
  );
  await physicalClick(cdp, '[data-form-field="weight"]');
  await waitFor(cdp, `document.activeElement === ${composer}`);
  await cdp.call("Input.insertText", { text: "2.5" });
  const pressButton = (scope, text) =>
    evaluate(
      cdp,
      `[...document.querySelectorAll(${JSON.stringify(scope)})].find((button) => button.textContent.trim() === ${JSON.stringify(text)}).click()`,
    );
  const buttonShown = (scope, text) =>
    `[...document.querySelectorAll(${JSON.stringify(scope)})].some((button) => button.textContent.trim() === ${JSON.stringify(text)})`;
  const pressPermanentButton = async (text) => {
    const id = await value(
      cdp,
      `[...document.querySelectorAll('[data-permanent-button]')].find((button) => button.textContent.trim() === ${JSON.stringify(text)})?.dataset.permanentButton`,
    );
    await physicalClick(cdp, `[data-permanent-button="${id}"]`);
  };
  // Opening another field commits this one; the text typed for that one survives a block that interrupts the form,
  // also one that asks a form of its own.
  await physicalClick(cdp, '[data-form-field="name"]');
  await waitFor(cdp, `${composer}.value === "Ada" && document.activeElement === ${composer}`);
  await cdp.call("Input.insertText", { text: "Bea" });
  // Sooner than the form takes the text from the composer.
  await delay(100);
  await pressPermanentButton("Check");
  // The block's form has a typed field of the same name, submitted while it is edited.
  await waitFor(cdp, `!!${field("ready")} && ${buttonShown("[data-form-actions] button", "OK")}`);
  await physicalClick(cdp, '[data-form-field="name"]');
  await waitFor(cdp, `${composer}.value === "Inner" && document.activeElement === ${composer}`);
  await cdp.call("Input.insertText", { text: "Zed" });
  await pressButton("[data-form-actions] button", "OK");
  await waitFor(
    cdp,
    `!${field("ready")} && !!${field("name")} && ${composer}.value === "Bea" && document.activeElement === ${composer}`,
    8_000,
    "The text being typed was lost, or not focused, after a block asked a form",
  );
  await evaluate(cdp, `${composer}.select()`);
  await cdp.call("Input.insertText", { text: "Cy" });
  await delay(100);
  await pressPermanentButton("Pause");
  await waitFor(cdp, buttonShown("button", "Resume"));
  await pressButton("button", "Resume");
  await waitFor(
    cdp,
    `!!${field("name")} && ${composer}.value === "Cy"`,
    8_000,
    "The text being typed was lost after the interruption",
  );
  await pressButton("[data-form-actions] button", "Continue");
  await waitFor(
    cdp,
    `document.body.innerText.includes("Impact 7, weight 2.5, Cy,")`,
    15_000,
    "Submitting did not take the text being typed",
  );
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

/**
 * Debug's rewind in the chat, on the `debug-rewind` package: Back to here on an answer shows the earlier state with its
 * later messages grey and the inspection bar; Forward restores the later state and Return the session; a different
 * answer adopts the earlier state, with its saved data, and discards the grey messages. A failed state that is
 * inspected shows its failure above the bar, and the bar fits a narrow screen.
 */
async function debugRewindScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  // The text of each message itself, without its speaker header, choice marker, or text for screen readers only.
  const texts = (selector) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].map((element) => { const copy = element.cloneNode(true); copy.querySelectorAll('[data-slot="message-header"], .choice-marker, .sr-only').forEach((part) => part.remove()); return copy.textContent.trim(); })`;
  // A narrator's message is prose, the player's a bubble.
  const message = ":is([data-slot='bubble-content'], .prose)";
  const activeText = texts(`.transcript-entry:not([data-future]) ${message}`);
  const futureText = texts(`.transcript-entry[data-future] ${message}`);
  const options = texts("[data-foreground-controls] button");
  const answer = async (label) => {
    await waitFor(cdp, `${options}.includes(${JSON.stringify(label)})`);
    await evaluate(
      cdp,
      `[...document.querySelectorAll('[data-foreground-controls] button')].find((button) => button.textContent.trim() === ${JSON.stringify(label)}).setAttribute('data-smoke-answer', '')`,
    );
    await settledClick(cdp, "[data-smoke-answer]");
  };
  // Back to here on the player's answer with this text, scrolled into view first.
  const backToHere = async (text) => {
    await waitFor(
      cdp,
      `[...document.querySelectorAll('.transcript-entry:not([data-future])')].some((entry) => entry.querySelector('[data-slot="bubble-content"]')?.textContent.includes(${JSON.stringify(text)}) && entry.querySelector('[data-back-to-here]'))`,
      5_000,
      `No Back to here on ${text}`,
    );
    await evaluate(
      cdp,
      `document.querySelectorAll('[data-smoke-back]').forEach((button) => button.removeAttribute('data-smoke-back')); const button = [...document.querySelectorAll('.transcript-entry:not([data-future])')].find((entry) => entry.querySelector('[data-slot="bubble-content"]')?.textContent.includes(${JSON.stringify(text)}) && entry.querySelector('[data-back-to-here]')).querySelector('[data-back-to-here]'); button.setAttribute('data-smoke-back', ''); button.scrollIntoView({ block: 'center' });`,
    );
    await settledClick(cdp, "[data-smoke-back]");
    await waitFor(cdp, `!!document.querySelector('[data-rewind-inspection]')`);
  };
  const json = (expression) => `JSON.stringify(${expression})`;

  await navigate(cdp, `${origin}/player/?dev&package=debug-rewind`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await answer("One");
  await waitFor(cdp, `${activeText}.includes('first One')`);

  // Back: the earlier choice again, the later messages grey, and what was answered before.
  await backToHere("One");
  await waitFor(
    cdp,
    `${json(futureText)} === ${JSON.stringify(JSON.stringify(["One", "first One"]))} && !${activeText}.includes('first One') && ${json(options)} === ${JSON.stringify(JSON.stringify(["One", "Two"]))}`,
    5_000,
    "Back did not show the earlier choice with a grey future",
  );
  assertEqual(
    await value(
      cdp,
      `JSON.stringify([!!document.querySelector('[data-future-label]'), document.querySelector('[data-rewind-earlier]')?.textContent.trim(), document.querySelectorAll('.transcript-entry[data-future] [data-back-to-here], .transcript-entry[data-future] [data-explain-values]').length])`,
    ),
    JSON.stringify([true, "Answered before: One", 0]),
    "The grey future, its label, or the earlier answer",
  );
  // Forward restores the later state, still inspected; Return reinstates the session.
  await settledClick(cdp, "[data-rewind-forward]");
  await waitFor(
    cdp,
    `${futureText}.length === 0 && ${activeText}.includes('first One') && ${json(options)} === ${JSON.stringify(JSON.stringify(["Red", "Fail"]))} && !!document.querySelector('[data-rewind-inspection]') && document.querySelector('[data-rewind-forward]').disabled`,
    5_000,
    "Forward did not restore the later state",
  );
  await settledClick(cdp, "[data-rewind-return]");
  await waitFor(
    cdp,
    `!document.querySelector('[data-rewind-inspection]') && ${activeText}.includes('first One')`,
    5_000,
    "Return did not reinstate the session",
  );

  // A different answer adopts the earlier state: the grey messages go, and the saved data follow the new branch.
  await backToHere("One");
  await answer("Two");
  await waitFor(
    cdp,
    `!document.querySelector('[data-rewind-inspection]') && ${futureText}.length === 0 && ${activeText}.includes('first Two') && !${activeText}.includes('first One')`,
    5_000,
    "A different answer did not adopt the earlier state",
  );
  await physicalClick(cdp, '[data-launcher] button[aria-label="Debug"]');
  await physicalClick(cdp, '[data-debug-tab="storage"]');
  await waitFor(
    cdp,
    `JSON.stringify([...document.querySelectorAll('[data-debug-storage-row]')].map((row) => [row.querySelector('[data-debug-storage-key]').textContent, row.querySelector('[data-storage-preview]').textContent.trim()])) === ${JSON.stringify(
      JSON.stringify([
        ['"k"', "1"],
        ['"pick"', '"Two"'],
      ]),
    )}`,
    5_000,
    "The adopted branch's saved data",
  );

  // A failed state that is inspected shows its failure, then the bar closest to the composer.
  await answer("Fail");
  await waitFor(cdp, `!!document.querySelector('[data-runtime-failure]')`);
  await backToHere("Fail");
  await settledClick(cdp, "[data-rewind-forward]");
  await waitFor(
    cdp,
    `!!document.querySelector('[data-runtime-failure]') && !!document.querySelector('[data-rewind-inspection]')`,
    5_000,
    "The inspected failed state lost its failure or the bar",
  );
  assertEqual(
    await value(
      cdp,
      `!!(document.querySelector('[data-runtime-failure]').compareDocumentPosition(document.querySelector('[data-rewind-inspection]')) & Node.DOCUMENT_POSITION_FOLLOWING)`,
    ),
    true,
    "The bar does not follow the failure",
  );
  // On a narrow screen, the bar fits and its controls stay touch-sized.
  await setViewport(cdp, 390, 844);
  await waitFor(
    cdp,
    `document.querySelector('[data-rewind-inspection]').getBoundingClientRect().width > 0`,
  );
  assertEqual(
    await value(
      cdp,
      `(() => { const bar = document.querySelector('[data-rewind-inspection]').getBoundingClientRect(); const buttons = [...document.querySelectorAll('[data-rewind-inspection] button')]; return JSON.stringify([bar.left >= 0 && bar.right <= window.innerWidth, buttons.length, buttons.every((button) => button.getBoundingClientRect().height >= 44)]); })()`,
    ),
    JSON.stringify([true, 3, true]),
    "The bar on a narrow screen",
  );
  // The narrow tools drawer may cover the chat, so this press goes to the control itself.
  await evaluate(cdp, `document.querySelector('[data-rewind-return]').click()`);
  await waitFor(
    cdp,
    `!document.querySelector('[data-rewind-inspection]') && !!document.querySelector('[data-runtime-failure]')`,
  );
  await setViewport(cdp, 1440, 900);
  // With Debug on, the error dialog's Open in Debug shows the failure on the Debug panel's Now tab and focuses the tab.
  await physicalClick(cdp, "[data-runtime-failure-details]");
  await waitFor(cdp, `!!document.querySelector('[data-session-error-debug]')`);
  await physicalClick(cdp, "[data-session-error-debug]");
  await waitFor(
    cdp,
    `!document.querySelector('[data-session-error-dialog]') && document.querySelector('[data-debug-now-next]')?.textContent.trim() === 'Error TSR036 at main.tease:13' && document.activeElement?.matches('[data-debug-tab="now"]')`,
    5_000,
    "Open in Debug did not show the failure on the Now tab",
  );
}

/**
 * A script error inside a function of another file: the error dialog's technical details show the failing line with the
 * failing expression marked, and the call path from the function to its call site.
 */
async function errorCallPathScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  await navigate(cdp, `${origin}/player/?package=call-failure`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(
    cdp,
    `document.querySelector('[data-foreground-controls] button')?.textContent.trim() === 'Continue'`,
  );
  await settledClick(cdp, "[data-foreground-controls] button");
  await waitFor(cdp, `!!document.querySelector('[data-runtime-failure-details]')`);
  await physicalClick(cdp, "[data-runtime-failure-details]");
  await waitFor(cdp, `!!document.querySelector('[data-session-error-technical-toggle]')`);
  await physicalClick(cdp, "[data-session-error-technical-toggle]");
  await waitFor(cdp, `!!document.querySelector('[data-session-error-technical]')`);
  assertEqual(
    await value(
      cdp,
      `JSON.stringify([document.querySelector('[data-session-error-source]').textContent, document.querySelector('[data-session-error-failing]').textContent, document.querySelector('[data-session-error-calls]').textContent.trim()])`,
    ),
    JSON.stringify([
      'say "Doing ${count / rounds} rounds."',
      "count / rounds",
      "in punish(), called from main.tease:6",
    ]),
    "The failing line and the call path",
  );
  await physicalClick(cdp, "[data-session-error-close]");
  await waitFor(cdp, `!document.querySelector('[data-session-error-dialog]')`);
}

/**
 * An ordinary end opens the end dialog with its review placeholder, a five-star radio group and an unavailable Send
 * review, and Close, focused, as its one control to close besides Escape; closing it returns to the start page, whose
 * Start begins the script anew.
 */
async function sessionEndScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  const dialog = `document.querySelector('[data-session-end-dialog]')`;
  const entries = `[...document.querySelectorAll('.transcript-entry:not([data-future])')].map((entry) => entry.textContent)`;
  const start = async (url) => {
    await navigate(cdp, url);
    await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
    await physicalClick(cdp, "[data-session-activation] button");
  };
  const finish = async () => {
    await waitFor(
      cdp,
      `document.querySelector('[data-foreground-controls] button')?.textContent.trim() === 'Finish'`,
    );
    await settledClick(cdp, "[data-foreground-controls] button");
    await waitFor(
      cdp,
      `!!${dialog} && ${dialog}.dataset.state === 'open' && document.getAnimations().every((animation) => animation.playState !== 'running')`,
      5_000,
      "The end dialog did not open",
    );
  };
  const startedAnew = `!document.querySelector('[data-runtime-end]') && ${entries}.some((text) => text.includes('Ready to finish?')) && !${entries}.some((text) => text.includes('This is the last message.'))`;

  await start(`${origin}/player/?package=session-end`);
  await finish();
  assertEqual(
    await value(
      cdp,
      `JSON.stringify([${dialog}.querySelector('h2').textContent.trim(), document.querySelector('[data-session-end-rating]').getAttribute('role'), [...document.querySelectorAll('[data-session-end-star]')].map((star) => [star.getAttribute('role'), star.getAttribute('aria-label'), star.getAttribute('aria-checked'), star.getBoundingClientRect().height >= 44]), document.querySelector('[data-session-end-send]').disabled, document.getElementById(${dialog}.getAttribute('aria-describedby'))?.textContent.trim(), [...${dialog}.querySelectorAll('button:not([role=radio])')].map((button) => button.textContent.trim()), document.activeElement?.matches('[data-session-end-close]'), !!document.querySelector('[data-runtime-ended]')])`,
    ),
    JSON.stringify([
      "The end",
      "radiogroup",
      [1, 2, 3, 4, 5].map((star) => [
        "radio",
        star === 1 ? "1 star" : `${star} stars`,
        "false",
        true,
      ]),
      true,
      "Sending reviews will be possible once TeaseScript has its website.",
      ["Send review", "Close"],
      true,
      false,
    ]),
    "The end dialog: a five-star rating, Send review unavailable with its note, and Close focused, with no end line yet",
  );
  // A click beside the dialog leaves it open, with what the player chose or typed.
  await backdropClick(cdp);
  await delay(300);
  assertEqual(
    await value(cdp, `${dialog}?.dataset.state`),
    "open",
    "A click beside the end dialog closed it",
  );
  // A star is chosen by click, and by holding an arrow key, as a radio group does; nothing is sent.
  const checked = `[...document.querySelectorAll('[data-session-end-star]')].map((star) => star.getAttribute('aria-checked') === 'true' ? 'X' : '-').join('')`;
  await physicalClick(cdp, "[data-session-end-star]:nth-child(4)");
  await waitFor(cdp, `${checked} === '---X-'`, 5_000, "A click did not choose the fourth star");
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.call("Input.dispatchKeyEvent", {
      type,
      key: "ArrowRight",
      code: "ArrowRight",
      windowsVirtualKeyCode: 39,
    });
    if (type === "keyDown") await delay(50);
  }
  await waitFor(
    cdp,
    `${checked} === '----X' && document.activeElement?.getAttribute('aria-label') === '5 stars'`,
    5_000,
    "An arrow key did not choose the next star",
  );
  await physicalClick(cdp, "[data-session-end-close]");
  const onStartPage = `!${dialog} && document.querySelector('[data-session-start]')?.textContent.trim() === 'Start' && document.activeElement === document.querySelector('[data-session-start]')`;
  await waitFor(
    cdp,
    onStartPage,
    5_000,
    "Closing the end dialog did not return to the start page with its Start focused",
  );
  // Start begins the script anew; Escape also closes the dialog.
  await physicalClick(cdp, "[data-session-start]");
  await waitFor(cdp, startedAnew, 5_000, "Start after the end did not start anew");
  await finish();
  for (const type of ["keyDown", "keyUp"])
    await cdp.call("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
  await waitFor(cdp, onStartPage, 5_000, "Escape did not close the end dialog for the start page");
}

/**
 * A Player action button held down by the mouse, a choice and a form toggle: its rim keeps its colour and nothing moves
 * or changes size, so a press draws no line; only keyboard focus draws an outline.
 */
async function heldPressScenario(cdp, origin) {
  await setViewport(cdp, 1100, 760);
  const steady = async (label) => {
    const look = `(() => { const button = document.querySelector('[data-smoke-press]'); const rect = button.getBoundingClientRect(); const style = getComputedStyle(button); return JSON.stringify([rect.x, rect.y, rect.width, rect.height, style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor, style.borderTopWidth, style.outlineStyle, style.transform]); })()`;
    await settle(cdp, "[data-smoke-press]");
    const idle = await value(cdp, look);
    const point = await value(
      cdp,
      `(() => { const rect = document.querySelector('[data-smoke-press]').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`,
    );
    await cdp.call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await waitFor(
      cdp,
      `document.querySelector('[data-smoke-press]').matches(':active')`,
      5_000,
      `${label} was not held`,
    );
    const held = await value(cdp, look);
    await cdp.call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    assertEqual(held, idle, `Holding ${label} changed its rim, outline, or box`);
  };
  await navigate(cdp, `${origin}/player/?package=debug-rewind`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(
    cdp,
    `[...document.querySelectorAll('[data-foreground-controls] button')].some((button) => button.textContent.trim() === "One")`,
  );
  await evaluate(
    cdp,
    `[...document.querySelectorAll('[data-foreground-controls] button')].find((button) => button.textContent.trim() === "One").setAttribute('data-smoke-press', '')`,
  );
  await steady("a choice");
  await navigate(cdp, `${origin}/player/?package=forms`);
  await waitFor(cdp, `!!document.querySelector('[data-session-activation] button')`);
  await physicalClick(cdp, "[data-session-activation] button");
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-form-fields] button').length === 43`,
    15_000,
    "The toggles did not appear",
  );
  // The fields scroll; the toggle is brought to the middle of their region, clear of its edges.
  await evaluate(
    cdp,
    `const toggle = document.querySelector('[data-form-fields] button'); toggle.setAttribute('data-smoke-press', ''); toggle.scrollIntoView({ block: "center" });`,
  );
  await steady("a form toggle");
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
