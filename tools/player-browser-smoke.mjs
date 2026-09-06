import { constants } from "node:fs";
import { access, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { createPlaygroundServer } from "../dist/playground/server.js";

await main();

async function main() {
  const chromium = await findChromium();
  if (chromium === null) {
    console.log("player-browser-smoke: SKIP Chromium executable not available");
    return;
  }

  const server = createPlaygroundServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("No server address.");
  const origin = `http://127.0.0.1:${address.port}`;
  const debugPort = await reservePort();
  const profile = `/tmp/teasescript-player-chromium-${process.pid}`;
  const browser = spawn(chromium, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
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
      await manualPlayerForegroundScenario(cdp, origin);
      await vueRuntimeScenario(cdp, origin);
      await vueTranscriptScenario(cdp, origin);
      console.log(
        "player-browser-smoke: PASS runtime-backed Vue Player plus transcript virtualization, anchoring, and follow",
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
  const transcriptBeforeRejectedButtonText = await transcriptTexts(cdp);
  await typeAndSubmit(cdp, "Continue");
  await delay(100);
  assertEqual(
    await activeActionId(cdp),
    showButtonId,
    "exact showButton composer text must not complete the action",
  );
  assertEqual(
    JSON.stringify(await transcriptTexts(cdp)),
    JSON.stringify(transcriptBeforeRejectedButtonText),
    "rejected showButton composer text must not append transcript output",
  );
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

  assertEqual(
    await value(cdp, `getComputedStyle(document.querySelector('.choice-buttons')).display`),
    "flex",
    "desktop choices use buttons",
  );
  assertEqual(
    await value(cdp, `getComputedStyle(document.querySelector('.choice-select')).display`),
    "none",
    "desktop dropdown stays hidden",
  );
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
      const rect = range.getBoundingClientRect();
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
  await replaceSourceAndRun(cdp, `let answer = choose ${options}`);
  await waitFor(cdp, `document.querySelector('.choice-select option:nth-child(13)') !== null`);
  assertEqual(
    await value(cdp, `getComputedStyle(document.querySelector('.choice-buttons')).display`),
    "none",
    "overflowing desktop choices hide buttons",
  );
  assertEqual(
    await value(cdp, `getComputedStyle(document.querySelector('.choice-select')).display`),
    "block",
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
    'say "First", instant\nshowButton "A"\nsay "Second", instant\nshowButton "B"',
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
  assertEqual(
    await value(cdp, `getComputedStyle(document.querySelector('.choice-buttons')).display`),
    "none",
    "narrow choices hide buttons",
  );
  assertEqual(
    await value(cdp, `getComputedStyle(document.querySelector('.choice-select')).display`),
    "block",
    "narrow choices use dropdown",
  );
  await evaluate(
    cdp,
    `const select=document.querySelector('.choice-select'); select.value='1'; select.dispatchEvent(new Event('change', {bubbles:true}))`,
  );
  await waitFor(cdp, `document.querySelector('#runtime-status')?.textContent === 'halted'`);
}

async function manualPlayerForegroundScenario(cdp, origin) {
  await navigate(cdp, `${origin}/player/`);
  await waitFor(cdp, `document.querySelector('[data-demo-select="foreground-fixture"]') !== null`);
  await selectDemoFixture(cdp, "foreground-fixture", "show-button");
  await waitFor(
    cdp,
    `document.querySelector('[data-foreground-button]')?.textContent === 'I am ready'`,
  );

  const initialCount = await manualTranscriptCount(cdp);
  await typeAndSubmitManualPlayer(cdp, "I am ready");
  await waitFor(
    cdp,
    `document.querySelector('#composerFeedback')?.textContent.includes('rendered button')`,
  );
  assertEqual(
    await manualTranscriptCount(cdp),
    initialCount,
    "manual exact showButton composer text must not append or complete",
  );
  await evaluate(
    cdp,
    `const input=document.querySelector('#composerForm textarea'); input.value=''; input.dispatchEvent(new Event('input', {bubbles:true})); input.focus()`,
  );
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" });
  assertEqual(
    await manualTranscriptCount(cdp),
    initialCount,
    "manual empty-composer Space must not complete showButton",
  );
  if (!(await value(cdp, `document.querySelector('[data-foreground-button]') !== null`))) {
    throw new Error("manual empty-composer Space must leave showButton rendered");
  }
  await click(cdp, "[data-foreground-button]");
  await waitFor(cdp, `document.querySelector('[data-foreground-button]') === null`);
  assertEqual(
    await manualTranscriptCount(cdp),
    initialCount + 1,
    "manual rendered showButton activation must append and complete",
  );

  await selectDemoFixture(cdp, "foreground-fixture", "choose");
  await typeAndSubmitManualPlayer(cdp, "Continue steadily");
  await waitFor(cdp, `document.querySelector('[data-foreground-choice]') === null`);
  assertEqual(
    await manualTranscriptCount(cdp),
    initialCount + 2,
    "manual exact visible choose text must still complete",
  );

  await selectDemoFixture(cdp, "pacing-gate", "skippable");
  await waitFor(cdp, `document.querySelectorAll('[data-transcript-entry-id]').length === 1`);
  await evaluate(cdp, `document.querySelector('#composerForm textarea').focus()`);
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" });
  await waitFor(cdp, `document.querySelectorAll('[data-transcript-entry-id]').length === 2`);
}

async function selectDemoFixture(cdp, key, selectedValue) {
  await evaluate(
    cdp,
    `const select=document.querySelector(${JSON.stringify(`[data-demo-select="${key}"]`)}); select.value=${JSON.stringify(selectedValue)}; select.dispatchEvent(new Event('change', {bubbles:true}))`,
  );
}

async function manualTranscriptCount(cdp) {
  return value(cdp, `document.querySelectorAll('[data-transcript-entry-id]').length`);
}

async function vueRuntimeScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  await navigate(cdp, `${origin}/player-vue/?fixture=runtime-skippable-long`);
  await waitFor(
    cdp,
    `document.querySelector('.player') !== null && document.querySelectorAll('[data-transcript-entry-id]').length === 1`,
  );

  const initialTranscript = await vueRuntimeTranscript(cdp);
  await physicalClick(cdp, "#save-player-checkpoint");
  await waitFor(
    cdp,
    `document.querySelector('#player-runtime-status')?.textContent.includes('saved')`,
  );
  assertEqual(
    JSON.stringify(await vueRuntimeTranscript(cdp)),
    JSON.stringify(initialTranscript),
    "checkpoint control pointer activation must not also skip pacing",
  );

  await evaluate(cdp, `document.querySelector('#save-player-checkpoint').focus()`);
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space" });
  assertEqual(
    JSON.stringify(await vueRuntimeTranscript(cdp)),
    JSON.stringify(initialTranscript),
    "checkpoint control Space activation must not also skip pacing",
  );

  await physicalClick(cdp, ".message-body");
  assertEqual(
    await value(cdp, `document.querySelector('[data-foreground-button]') === null`),
    true,
    "transcript message activation must not skip pacing",
  );
  await physicalClick(cdp, ".right-toggle-control .right-control-label");
  await waitFor(cdp, `document.body.textContent.includes('You changed Strict mode to off.')`);
  assertEqual(
    await value(cdp, `document.querySelector('[data-foreground-button]') === null`),
    true,
    "nested right-rail control activation must not skip pacing",
  );
  await physicalDragTranscriptBackground(cdp);
  assertEqual(
    await value(cdp, `document.querySelector('[data-foreground-button]') === null`),
    true,
    "a pointer drag across unused transcript space must not skip pacing",
  );
  await physicalClickTranscriptBackground(cdp);
  await waitFor(
    cdp,
    `document.querySelector('[data-foreground-button]')?.textContent === 'Continue'`,
  );

  await navigate(cdp, `${origin}/player-vue/`);
  await waitFor(
    cdp,
    `document.querySelector('.player') !== null && document.querySelectorAll('[data-transcript-entry-id]').length === 1`,
  );

  await evaluate(cdp, `document.querySelector('.composer textarea').focus()`);
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space" });
  await waitFor(
    cdp,
    `document.querySelector('[data-foreground-button]')?.textContent === 'Continue'`,
  );
  assertEqual(
    (await vueRuntimeTranscript(cdp)).length,
    2,
    "eligible composer Space must advance the active pacing gate once",
  );

  await typeAndSubmitVuePlayer(cdp, "Continue");
  await waitFor(
    cdp,
    `document.querySelector('.composer-feedback')?.textContent.includes('rendered button')`,
  );
  assertEqual(
    (await vueRuntimeTranscript(cdp)).length,
    2,
    "showButton composer text must not append transcript output",
  );
  await typeAndSubmitVuePlayer(cdp, "");
  assertEqual(
    await value(cdp, `document.querySelector('[data-foreground-button]')?.textContent`),
    "Continue",
    "empty showButton composer submission must leave the control active",
  );

  await evaluate(
    cdp,
    `const button=document.querySelector('[data-foreground-button]'); button.focus(); button.click()`,
  );
  await waitFor(
    cdp,
    `document.querySelector('.composer textarea')?.getAttribute('aria-label') === 'Answer'`,
  );
  assertEqual(
    await value(
      cdp,
      `document.activeElement === document.querySelector('.composer textarea') ? 'composer' : document.activeElement?.outerHTML`,
    ),
    "composer",
    "a typed interaction after rendered activation must focus the composer",
  );
  await typeAndSubmitVuePlayer(cdp, "   ");
  await waitFor(
    cdp,
    `document.querySelector('.composer-feedback')?.textContent.includes('non-whitespace')`,
  );
  await physicalClick(cdp, "#save-player-checkpoint");
  await typeAndSubmitVuePlayer(cdp, "Alex");
  await waitFor(
    cdp,
    `document.querySelector('.composer textarea')?.getAttribute('aria-label') === 'Number'`,
  );
  await physicalClick(cdp, "#restore-player-checkpoint");
  await waitFor(
    cdp,
    `document.querySelector('.composer textarea')?.getAttribute('aria-label') === 'Answer'`,
  );
  assertEqual(
    await value(
      cdp,
      `document.activeElement === document.querySelector('.composer textarea') ? 'composer' : document.activeElement?.outerHTML`,
    ),
    "composer",
    "restoring a typed interaction must focus the composer",
  );
  await typeAndSubmitVuePlayer(cdp, "Alex");
  await waitFor(
    cdp,
    `document.querySelector('.composer textarea')?.getAttribute('aria-label') === 'Number'`,
  );
  await typeAndSubmitVuePlayer(cdp, "not a number");
  await waitFor(
    cdp,
    `document.querySelector('.composer-feedback')?.textContent.includes('decimal')`,
  );
  await typeAndSubmitVuePlayer(cdp, "12.5");
  await waitFor(cdp, `document.querySelectorAll('.foreground-choice-buttons button').length === 2`);
  assertEqual(
    JSON.stringify(
      await value(
        cdp,
        `[...document.querySelectorAll('.foreground-choice-buttons button')].map((button) => button.textContent)`,
      ),
    ),
    JSON.stringify(["First option", "Second option"]),
    "Vue choices must preserve authored runtime order",
  );

  await physicalClick(cdp, "#save-player-checkpoint");
  const beforeChoice = await vueRuntimeTranscript(cdp);
  await click(cdp, ".foreground-choice-item:nth-child(2) button");
  await waitFor(cdp, `document.querySelector('[data-foreground-kind]') === null`);
  await waitFor(cdp, `document.body.textContent.includes('Thanks Alex')`);
  await click(cdp, "#restore-player-checkpoint");
  await waitFor(cdp, `document.querySelectorAll('.foreground-choice-buttons button').length === 2`);
  assertEqual(
    JSON.stringify(await vueRuntimeTranscript(cdp)),
    JSON.stringify(beforeChoice),
    "Vue restore must reconstruct transcript exactly without duplicate output",
  );
  await click(cdp, ".foreground-choice-item:nth-child(2) button");
  await waitFor(cdp, `document.body.textContent.includes('Thanks Alex')`);
  assertEqual(
    (await vueRuntimeTranscript(cdp)).filter((entry) => entry.text.includes("Thanks Alex")).length,
    1,
    "continuation after restore must emit final output once",
  );

  await setViewport(cdp, 390, 844);
  await navigate(cdp, `${origin}/player-vue/`);
  await waitFor(cdp, `document.querySelectorAll('[data-transcript-entry-id]').length === 1`);
  await evaluate(cdp, `document.querySelector('.composer textarea').focus()`);
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space" });
  await waitFor(
    cdp,
    `document.querySelector('[data-foreground-button]')?.textContent === 'Continue'`,
  );
  assertEqual(
    await value(
      cdp,
      `document.querySelector('.composer').getBoundingClientRect().bottom <= document.querySelector('.player').getBoundingClientRect().bottom`,
    ),
    true,
    "narrow runtime-backed composer must remain inside the Player",
  );

  await navigate(cdp, `${origin}/player-vue/?fixture=runtime-unskippable`);
  await waitFor(
    cdp,
    `document.querySelector('[data-transcript-entry-id]')?.textContent.includes('Locked')`,
  );
  await physicalClickTranscriptBackground(cdp);
  await waitFor(
    cdp,
    `document.querySelector('.composer-feedback')?.textContent.includes('not skippable')`,
  );
  assertEqual(
    (await vueRuntimeTranscript(cdp)).length,
    1,
    "unskippable pointer attempt must leave runtime transcript unchanged",
  );
  await evaluate(cdp, `document.querySelector('.composer textarea').focus()`);
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space" });
  assertEqual(
    (await vueRuntimeTranscript(cdp)).length,
    1,
    "unskippable Space attempt must leave runtime transcript unchanged",
  );
}

async function typeAndSubmitVuePlayer(cdp, text) {
  await evaluate(
    cdp,
    `const input=document.querySelector('.composer textarea'); input.value=${JSON.stringify(text)}; input.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('.composer form').requestSubmit()`,
  );
}

async function vueRuntimeTranscript(cdp) {
  return value(
    cdp,
    `[...document.querySelectorAll('[data-transcript-entry-id]')].map((entry) => ({id: entry.dataset.transcriptEntryId, text: entry.querySelector('.message-body')?.textContent ?? entry.textContent}))`,
  );
}

async function physicalClick(cdp, selector) {
  const point = await value(
    cdp,
    `(() => { const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:rect.left + rect.width / 2, y:rect.top + rect.height / 2}; })()`,
  );
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

async function physicalClickTranscriptBackground(cdp) {
  const point = await value(
    cdp,
    `(() => {
      const rect = document.querySelector('.transcript').getBoundingClientRect();
      for (let y = rect.top + 4; y < rect.bottom - 4; y += 8) {
        for (let x = rect.left + 4; x < rect.right - 4; x += 8) {
          if (document.elementFromPoint(x, y)?.classList.contains('transcript')) return {x, y};
        }
      }
      throw new Error('No unused transcript background point is visible.');
    })()`,
  );
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

async function physicalDragTranscriptBackground(cdp) {
  const points = await value(
    cdp,
    `(() => {
      const rect = document.querySelector('.transcript').getBoundingClientRect();
      const points = [];
      for (let y = rect.top + 4; y < rect.bottom - 4; y += 8) {
        for (let x = rect.left + 4; x < rect.right - 4; x += 8) {
          if (document.elementFromPoint(x, y)?.classList.contains('transcript')) points.push({x, y});
        }
      }
      const start = points[0];
      const end = points.find((point) => start !== undefined && Math.hypot(point.x - start.x, point.y - start.y) >= 24);
      if (start === undefined || end === undefined) throw new Error('No unused transcript drag path is visible.');
      return {start, end};
    })()`,
  );
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: points.start.x,
    y: points.start.y,
  });
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: points.start.x,
    y: points.start.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: points.end.x,
    y: points.end.y,
    button: "left",
  });
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: points.end.x,
    y: points.end.y,
    button: "left",
    clickCount: 1,
  });
}

async function vueTranscriptScenario(cdp, origin) {
  await navigate(cdp, `${origin}/player-vue/?fixture=transcript-stress`);
  await waitFor(
    cdp,
    `document.querySelector('[data-transcript-fixture="stress"]') !== null && document.querySelector('[data-stress-count]')?.textContent === '2000 entries'`,
  );

  const fixtureGeometry = await value(
    cdp,
    `(() => {
      const controls = document.querySelector('.transcript-stress-controls').getBoundingClientRect();
      const transcript = document.querySelector('.transcript').getBoundingClientRect();
      return {controlsBottom: controls.bottom, transcriptTop: transcript.top};
    })()`,
  );
  if (fixtureGeometry.transcriptTop < fixtureGeometry.controlsBottom) {
    throw new Error(
      `Vue stress controls overlap the transcript: ${JSON.stringify(fixtureGeometry)}`,
    );
  }

  let metrics = await vueTranscriptMetrics(cdp);
  assertEqual(metrics.count, 2000, "Vue stress fixture must retain its complete initial history");
  assertAtMost(metrics.rendered, 32, "Vue transcript rendered DOM must stay bounded");
  assertAtMost(metrics.distanceFromEnd, 36, "initial Vue transcript must land at latest");

  await click(cdp, "[data-stress-append]");
  await waitFor(
    cdp,
    `document.querySelector('[data-stress-count]')?.textContent === '2001 entries'`,
  );
  await delay(220);
  metrics = await vueTranscriptMetrics(cdp);
  assertAtMost(metrics.distanceFromEnd, 36, "pinned Vue transcript append must follow latest");
  assertAtMost(metrics.rendered, 32, "pinned Vue append must keep rendered DOM bounded");

  const pointerProbe = await value(
    cdp,
    `(() => {
      const rect = document.querySelector('.transcript').getBoundingClientRect();
      return {x: rect.left + 24, y: rect.top + 24, outsideY: Math.max(2, rect.top - 8)};
    })()`,
  );
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: pointerProbe.x,
    y: pointerProbe.y,
  });
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: pointerProbe.x,
    y: pointerProbe.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: pointerProbe.x,
    y: pointerProbe.outsideY,
    button: "left",
  });
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: pointerProbe.x,
    y: pointerProbe.outsideY,
    button: "left",
    clickCount: 1,
  });
  await delay(180);

  await evaluate(
    cdp,
    `document.querySelector('.transcript').scrollTo({top: 1_000, behavior: 'auto'})`,
  );
  await waitFor(cdp, `document.querySelector('.transcript').scrollTop >= 500`);
  await delay(300);
  metrics = await vueTranscriptMetrics(cdp);
  if (metrics.returnVisible !== true)
    throw new Error(
      `Vue return-to-latest control must appear after scrolling settles: ${JSON.stringify(metrics)}`,
    );
  assertEqual(metrics.fade, "true", "Vue transcript top fade must follow scroll state");

  const anchorBeforePrepend = await value(
    cdp,
    `(() => {
      const transcript = document.querySelector('.transcript');
      const transcriptRect = transcript.getBoundingClientRect();
      const item = [...transcript.querySelectorAll('[data-transcript-entry-id]')].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > transcriptRect.top + 2 && rect.top < transcriptRect.bottom - 2;
      });
      return item === undefined
        ? null
        : {id: item.dataset.transcriptEntryId, offset: item.getBoundingClientRect().top - transcriptRect.top};
    })()`,
  );
  if (anchorBeforePrepend === null)
    throw new Error("Vue prepend test could not find a visible anchor");
  await click(cdp, "[data-stress-prepend]");
  await waitFor(
    cdp,
    `document.querySelector('[data-stress-count]')?.textContent === '2013 entries'`,
  );
  await delay(220);
  const anchorAfterPrepend = await value(
    cdp,
    `(() => {
      const transcript = document.querySelector('.transcript');
      const item = transcript.querySelector(${JSON.stringify(`[data-transcript-entry-id="${anchorBeforePrepend.id}"]`)});
      return item === null
        ? null
        : {offset: item.getBoundingClientRect().top - transcript.getBoundingClientRect().top};
    })()`,
  );
  if (anchorAfterPrepend === null)
    throw new Error(`Vue prepend lost anchor entry ${String(anchorBeforePrepend.id)}`);
  assertAtMost(
    Math.abs(anchorAfterPrepend.offset - anchorBeforePrepend.offset),
    2,
    "Vue prepend must preserve the visible keyed entry offset",
  );
  metrics = await vueTranscriptMetrics(cdp);
  assertAtMost(metrics.rendered, 32, "Vue prepend must keep rendered DOM bounded");

  const awayTop = metrics.scrollTop;
  await click(cdp, "[data-stress-append]");
  await waitFor(
    cdp,
    `document.querySelector('[data-stress-count]')?.textContent === '2014 entries'`,
  );
  await delay(220);
  metrics = await vueTranscriptMetrics(cdp);
  assertAtMost(Math.abs(metrics.scrollTop - awayTop), 2, "away Vue append must not follow latest");
  if (metrics.returnVisible !== true)
    throw new Error("Vue return-to-latest control must remain visible after away append");

  const awayGrowTop = metrics.scrollTop;
  await click(cdp, "[data-stress-grow]");
  await delay(400);
  metrics = await vueTranscriptMetrics(cdp);
  assertAtMost(
    Math.abs(metrics.scrollTop - awayGrowTop),
    2,
    "away Vue measurement growth must not follow latest",
  );

  const awayResizeTop = metrics.scrollTop;
  const previousHeight = metrics.clientHeight;
  await click(cdp, "[data-stress-resize]");
  await waitFor(cdp, `document.querySelector('.transcript').clientHeight < ${previousHeight}`);
  await delay(300);
  metrics = await vueTranscriptMetrics(cdp);
  assertAtMost(
    Math.abs(metrics.scrollTop - awayResizeTop),
    2,
    "away Vue resize must not follow latest",
  );
  if (metrics.returnVisible !== true)
    throw new Error("Vue return-to-latest control must survive an away resize");

  await click(cdp, ".return-to-latest");
  await waitFor(
    cdp,
    `document.querySelector('.transcript').scrollHeight - document.querySelector('.transcript').clientHeight - document.querySelector('.transcript').scrollTop <= 36`,
  );
  await delay(220);
  metrics = await vueTranscriptMetrics(cdp);
  if (metrics.returnVisible !== false)
    throw new Error("Vue return-to-latest control must hide at latest");
  assertAtMost(metrics.distanceFromEnd, 36, "Vue return-to-latest must restore latest follow");

  const pinnedHeight = metrics.clientHeight;
  await click(cdp, "[data-stress-resize]");
  await waitFor(cdp, `document.querySelector('.transcript').clientHeight > ${pinnedHeight}`);
  await delay(300);
  metrics = await vueTranscriptMetrics(cdp);
  assertAtMost(
    metrics.distanceFromEnd,
    36,
    "pinned Vue container resize must preserve latest follow",
  );

  await click(cdp, "[data-stress-grow]");
  await delay(400);
  metrics = await vueTranscriptMetrics(cdp);
  assertAtMost(
    metrics.distanceFromEnd,
    36,
    "pinned Vue measurement growth must keep latest readable",
  );
  await click(cdp, "[data-stress-append]");
  await waitFor(
    cdp,
    `document.querySelector('[data-stress-count]')?.textContent === '2015 entries'`,
  );
  await delay(220);
  metrics = await vueTranscriptMetrics(cdp);
  assertAtMost(
    metrics.distanceFromEnd,
    36,
    "restored Vue follow must keep appended latest readable",
  );

  await evaluate(cdp, `document.querySelector('.transcript').scrollTo({top: 0, behavior: 'auto'})`);
  await waitFor(cdp, `document.querySelector('.transcript').scrollTop === 0`);
  await delay(180);
  metrics = await vueTranscriptMetrics(cdp);
  assertEqual(metrics.fade, "false", "Vue top fade must be off at true top");
}

async function vueTranscriptMetrics(cdp) {
  return value(
    cdp,
    `(() => {
      const transcript = document.querySelector('.transcript');
      return {
        count: Number.parseInt(document.querySelector('[data-stress-count]').textContent, 10),
        rendered: transcript.querySelectorAll('.transcript-virtual-item').length,
        clientHeight: transcript.clientHeight,
        scrollTop: transcript.scrollTop,
        distanceFromEnd: transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop,
        returnVisible: document.querySelector('.return-to-latest') !== null,
        fade: transcript.dataset.scrolledFromTop,
      };
    })()`,
  );
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

async function typeAndSubmitManualPlayer(cdp, text) {
  await evaluate(
    cdp,
    `const input=document.querySelector('#composerForm textarea'); input.value=${JSON.stringify(text)}; input.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#composerForm').requestSubmit()`,
  );
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

async function navigate(cdp, url) {
  const response = await cdp.call("Page.navigate", { url });
  if (response?.result?.errorText) throw new Error(response.result.errorText);
  await waitFor(cdp, `document.readyState === 'complete'`);
}

async function waitFor(cdp, expression) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await value(cdp, expression)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
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

function assertAtMost(actual, maximum, message) {
  if (actual > maximum) throw new Error(`${message}: expected <= ${maximum}, received ${actual}`);
}

async function findChromium() {
  for (const candidate of [
    process.env.CHROMIUM_BIN,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter(Boolean)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
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
