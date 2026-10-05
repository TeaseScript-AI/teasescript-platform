import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const LAN_HOST = "player-lan.test";

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
  // The model-paths package exists only as this catalog, so the smoke needs no file named with `\` or `C:` on disk.
  const [handleRequest] = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    if (request.url !== "/dev-package/model-paths/catalog.json")
      return handleRequest(request, response);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(MODEL_PATHS_CATALOG));
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
      await cameraScenario(cdp, origin);
      await viewfinderScenario(cdp, origin);
      await permanentButtonsScenario(cdp, origin);
      console.log(
        "player-browser-smoke: PASS technical playground, the repository demo on /player/, packages opened by URL, and the camera, viewfinder, and permanent buttons scenarios",
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
  const reloadBeforeStart = async () => {
    await cdp.call("Page.reload");
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

async function physicalClick(cdp, selector) {
  const point = await value(
    cdp,
    `(() => { const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:rect.left + rect.width / 2, y:rect.top + rect.height / 2}; })()`,
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
  const url = `${origin}/player/?dev&scenario=camera`;
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
          keys.onsuccess = () => { database.close(); resolve(keys.result.map(([, reference]) => reference)); };
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
  const url = `${origin}/player/?dev&scenario=viewfinder`;
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

async function navigate(cdp, url) {
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
