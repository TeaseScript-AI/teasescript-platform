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
      await vueRuntimeScenario(cdp, origin);
      await vueDevelopmentToolsScenario(cdp, origin);
      await vueTranscriptScenario(cdp, origin);
      await vuePresentationScenario(cdp, origin);
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

async function vuePresentationScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  await navigate(cdp, `${origin}/player/`);
  await waitFor(cdp, `document.querySelector('.composer textarea') !== null`);
  assertEqual(
    await value(
      cdp,
      `document.querySelector('[aria-controls="leftPanel"]').getAttribute('aria-expanded')`,
    ),
    "false",
    "tools start secondary and closed",
  );

  for (const [width, height] of [
    [1440, 900],
    [820, 1180],
    [390, 844],
    [844, 390],
    [1100, 420],
  ]) {
    await setViewport(cdp, width, height);
    await waitFor(
      cdp,
      `Math.abs(document.querySelector('.player').getBoundingClientRect().height - ${height}) < 1`,
    );
    await waitFor(
      cdp,
      `(() => {
      const p = document.querySelector('.player');
      const stage = p.querySelector('.media-area').getBoundingClientRect();
      const transcript = p.querySelector('.transcript').getBoundingClientRect();
      const composer = p.querySelector('.composer').getBoundingClientRect();
      return p.scrollHeight <= p.clientHeight + 1 && p.scrollWidth <= p.clientWidth + 1 && stage.height > 40 && transcript.height > 30 && transcript.top >= stage.bottom && composer.bottom <= p.getBoundingClientRect().bottom + 1;
    })()`,
    );
    await setVueSessionOpen(cdp, true);
    assertEqual(
      await value(
        cdp,
        `(() => {
      const panel=document.querySelector('.session-popover');
      const r=panel.getBoundingClientRect(); const p=document.querySelector('.player').getBoundingClientRect();
      const actions=panel.querySelector('.action-scroll');
      return r.left >= p.left && r.right <= p.right + 1 && r.top >= p.top && r.bottom <= p.bottom + 1 && actions.scrollWidth <= actions.clientWidth + 1;
    })()`,
      ),
      true,
      `session disclosure fits ${width} × ${height}`,
    );
    await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    await waitFor(
      cdp,
      `document.querySelector('.session-popover') === null && document.activeElement === document.querySelector('.session-trigger')`,
    );
  }

  await setViewport(cdp, 390, 844);
  await selectVueTool(cdp, "visuals");
  await waitFor(cdp, `document.querySelector('.left-panel').contains(document.activeElement)`);
  for (let index = 0; index < 8; index += 1) {
    await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab" });
    await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab" });
    assertEqual(
      await value(cdp, `document.querySelector('.left-panel').contains(document.activeElement)`),
      true,
      "drawer contains keyboard focus",
    );
  }
  await physicalClick(cdp, ".left-scrim");
  await waitFor(
    cdp,
    `document.querySelector('.player').dataset.left === 'closed' && document.activeElement === document.querySelector('[aria-controls="leftPanel"]')`,
  );

  await selectVueTool(cdp, "visuals");
  await setVueSessionOpen(cdp, true);
  await waitFor(
    cdp,
    `document.querySelector('.player').dataset.left === 'closed' && document.querySelector('.session-popover').contains(document.activeElement)`,
  );
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await waitFor(
    cdp,
    `document.querySelector('.session-popover') === null && document.activeElement === document.querySelector('.session-trigger')`,
  );
  await setVueSessionOpen(cdp, true);
  await physicalClick(cdp, '[aria-controls="leftPanel"]');
  await waitFor(
    cdp,
    `document.querySelector('.session-popover') === null && document.querySelector('.left-panel').contains(document.activeElement) && document.querySelector('[data-visual-lab-instance]') !== null`,
  );
  await physicalClick(cdp, ".left-scrim");

  await physicalClick(cdp, ".fullscreen-toggle");
  await waitFor(cdp, `document.fullscreenElement === document.querySelector('.player')`);
  await setVueSessionOpen(cdp, true);
  assertEqual(
    await value(
      cdp,
      `document.fullscreenElement.contains(document.querySelector('.session-popover'))`,
    ),
    true,
    "session disclosure remains inside fullscreen",
  );
  await setVueSessionOpen(cdp, false);
  await physicalClick(cdp, ".fullscreen-toggle");
  await waitFor(cdp, `document.fullscreenElement === null`);

  // Synthetic browser-reported geometry, not a production Player test API.
  await evaluate(
    cdp,
    `(() => {
    const input=document.querySelector('.composer textarea');
    input.focus(); input.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,pointerType:'touch',isPrimary:true}));
    Object.defineProperty(window.visualViewport, 'height', {configurable:true,get:()=>360});
    window.visualViewport.dispatchEvent(new Event('resize'));
  })()`,
  );
  await waitFor(cdp, `document.querySelector('.player').dataset.keyboard === 'open'`);
  await evaluate(
    cdp,
    `(() => { const input=document.querySelector('.composer textarea'); input.value=['A longer answer','with several lines','that keeps growing','while the keyboard is open','and still remains contained.'].join(String.fromCharCode(10)); input.dispatchEvent(new Event('input',{bubbles:true})); })()`,
  );
  await waitFor(
    cdp,
    `(() => { const p=document.querySelector('.player'); const c=p.querySelector('.composer').getBoundingClientRect(); return c.bottom <= 361 && p.scrollHeight <= p.clientHeight + 1 && p.querySelector('.transcript').clientHeight > 0 && p.querySelector('.media-area').clientHeight > 0; })()`,
  );
  await evaluate(
    cdp,
    `delete window.visualViewport.height; window.visualViewport.dispatchEvent(new Event('resize'));`,
  );
  await waitFor(cdp, `document.querySelector('.player').dataset.keyboard === 'closed'`);

  await evaluate(
    cdp,
    `(() => {
    const p=document.querySelector('.player');
    for (const [edge,value] of Object.entries({top:24,right:32,bottom:20,left:32})) p.style.setProperty('--safe-'+edge,value+'px');
    window.dispatchEvent(new Event('resize'));
  })()`,
  );
  await waitFor(
    cdp,
    `(() => { const input=document.querySelector('.composer textarea').getBoundingClientRect(); const send=document.querySelector('.send-button').getBoundingClientRect(); return input.left >= 32 && send.right <= 358 && send.bottom <= 824; })()`,
  );
  const keyboardFixture = await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => { const keyboard = new EventTarget(); keyboard.boundingRect = new DOMRect(); keyboard.overlaysContent = false; Object.defineProperty(navigator, 'virtualKeyboard', {configurable:true, value:keyboard}); })()`,
  });
  try {
    await setViewport(cdp, 390, 844);
    await navigate(cdp, `${origin}/player/`);
    await waitFor(cdp, `document.querySelector('.composer textarea') !== null`);
    await physicalClick(cdp, ".fullscreen-toggle");
    await waitFor(
      cdp,
      `document.fullscreenElement !== null && navigator.virtualKeyboard.overlaysContent === true`,
    );
    await evaluate(
      cdp,
      `(() => { const input=document.querySelector('.composer textarea'); input.focus(); input.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'touch',isPrimary:true})); navigator.virtualKeyboard.boundingRect = new DOMRect(0,420,390,424); navigator.virtualKeyboard.dispatchEvent(new Event('geometrychange')); })()`,
    );
    await waitFor(
      cdp,
      `(() => { const p=document.querySelector('.player'); return p.dataset.keyboardGeometry === 'virtual-keyboard' && p.getBoundingClientRect().height === 844 && p.querySelector('.composer').getBoundingClientRect().bottom <= 421 && p.querySelector('.media-area').clientHeight > 0 && p.querySelector('.transcript').clientHeight > 0; })()`,
    );
    await evaluate(
      cdp,
      `navigator.virtualKeyboard.boundingRect = new DOMRect(); navigator.virtualKeyboard.dispatchEvent(new Event('geometrychange'));`,
    );
    await waitFor(cdp, `document.querySelector('.player').dataset.keyboard === 'closed'`);
    await physicalClick(cdp, ".fullscreen-toggle");
    await waitFor(
      cdp,
      `document.fullscreenElement === null && navigator.virtualKeyboard.overlaysContent === false`,
    );
  } finally {
    await cdp.call("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: keyboardFixture.identifier,
    });
  }
  const longButtonSource = `say "A long authored action remains reachable.", 0\nshowButton "${"Continue after reading this important part of the scene. ".repeat(8)}"`;
  const injected = await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => { const originalFetch=window.fetch; window.fetch=(input, options) => String(input).endsWith('/examples/playground/player-controls.tease') ? Promise.resolve(new Response(${JSON.stringify(longButtonSource)})) : originalFetch(input, options); })()`,
  });
  try {
    await setViewport(cdp, 740, 360);
    await navigate(cdp, `${origin}/player/`);
    await waitFor(cdp, `document.querySelector('[data-foreground-button]') !== null`);
    await waitFor(
      cdp,
      `(() => { const p=document.querySelector('.player'); const foreground=p.querySelector('.foreground-controls'); return p.scrollHeight <= p.clientHeight + 1 && p.scrollTop === 0 && p.querySelector('.media-area').clientHeight > 0 && p.querySelector('.transcript').clientHeight > 0 && foreground.scrollHeight > foreground.clientHeight; })()`,
    );
    await evaluate(cdp, `document.querySelector('.foreground-controls').scrollTop = 1000;`);
    await physicalClick(cdp, ".foreground-controls");
    await waitFor(cdp, `document.querySelector('[data-foreground-button]') === null`);
  } finally {
    await cdp.call("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected.identifier });
  }
  await navigate(cdp, `${origin}/player/`);
}

async function vueDevelopmentToolsScenario(cdp, origin) {
  await setViewport(cdp, 1200, 760);
  await navigate(cdp, `${origin}/player/`);
  await waitFor(cdp, `document.querySelector('.player') !== null`);
  const resetBaselineTranscript = await vueRuntimeTranscript(cdp);
  await setVueSessionOpen(cdp, true);
  const resetBaselineToggle = await value(
    cdp,
    `document.querySelector('.right-toggle-control input').checked`,
  );
  await selectVueTool(cdp, "visuals");
  await evaluate(
    cdp,
    `([...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Run askText scenario')).click()`,
  );
  await waitFor(
    cdp,
    `document.querySelector('.composer textarea')?.getAttribute('aria-label') === 'Answer'`,
  );
  await evaluate(
    cdp,
    `([...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Simulate script update')).click()`,
  );
  await setVueSessionOpen(cdp, true);
  await waitFor(cdp, `document.querySelector('[data-script-update-feedback]') !== null`);
  await evaluate(
    cdp,
    `([...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Reset visual tests')).click()`,
  );
  await waitFor(cdp, `document.querySelector('[data-script-update-feedback]') === null`);
  assertEqual(
    JSON.stringify(await vueRuntimeTranscript(cdp)),
    JSON.stringify(resetBaselineTranscript),
    "Reset visual tests must restore the baseline runtime and transcript",
  );
  await setVueSessionOpen(cdp, true);
  assertEqual(
    await value(cdp, `document.querySelector('.right-toggle-control input').checked`),
    resetBaselineToggle,
    "Reset visual tests must undo simulated script updates",
  );

  await setViewport(cdp, 1200, 760);
  await navigate(cdp, `${origin}/player/?layout-debug=1`);
  await waitFor(
    cdp,
    `document.querySelector('.debug-card')?.textContent.includes('viewport 1200px')`,
  );
  assertEqual(
    await value(
      cdp,
      `(() => { const text=document.querySelector('.debug-constraints')?.textContent ?? ''; const pixels=(value) => Math.round(value * 10) / 10 + 'px'; return text.includes('conversation') && text.includes('session') && text.includes('tool column ' + pixels(document.querySelector('.tool-column').getBoundingClientRect().width) + ' /') && text.includes('composer input ' + pixels(document.querySelector('.composer textarea').getBoundingClientRect().height) + ' /'); })()`,
    ),
    true,
    "wide Layout Debug must compare the tool column and composer input measurements with their constraints",
  );
  await setViewport(cdp, 390, 700);
  await waitFor(
    cdp,
    `document.querySelector('.debug-card')?.textContent.includes('viewport 390px')`,
  );
  assertEqual(
    await value(cdp, `document.querySelectorAll('[data-debug-kind]').length >= 5`),
    true,
    "narrow Layout Debug must retain current region overlays",
  );

  await setViewport(cdp, 1100, 700);
  await selectVueTool(cdp, "layout-debug");
  await evaluate(cdp, `document.querySelector('[data-tool-column-add]').click()`);
  await waitFor(cdp, `document.querySelectorAll('[data-tool-column-id]').length === 2`);
  await evaluate(
    cdp,
    `(() => { const selects=document.querySelectorAll('[data-tool-column-select]'); selects[1].value='visuals'; selects[1].dispatchEvent(new Event('change',{bubbles:true})); })()`,
  );
  await waitFor(cdp, `document.querySelector('[aria-label="Timer count"]') !== null`);
  await evaluate(cdp, `document.querySelector('[data-tool-column-add]').click()`);
  await waitFor(cdp, `document.querySelectorAll('[data-tool-column-id]').length === 3`);
  await evaluate(
    cdp,
    `(() => { const selects=document.querySelectorAll('[data-tool-column-select]'); selects[2].value='visuals'; selects[2].dispatchEvent(new Event('change',{bubbles:true})); })()`,
  );
  await waitFor(cdp, `document.querySelectorAll('[data-visual-lab-instance]').length >= 2`);
  assertEqual(
    await value(
      cdp,
      `(() => { const ids=[...document.querySelectorAll('[id]')].map((node) => node.id); return ids.length === new Set(ids).size; })()`,
    ),
    true,
    "duplicate Visual Lab columns must retain unique DOM IDs",
  );
  await evaluate(
    cdp,
    `document.querySelectorAll('[data-visual-lab-instance] .lab-option-info-trigger')[0].click()`,
  );
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-visual-lab-instance]')[0].querySelector('[aria-expanded="true"]') !== null`,
  );
  await evaluate(
    cdp,
    `document.querySelectorAll('[data-visual-lab-instance]')[1].querySelector('.lab-option-info-trigger').click()`,
  );
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-visual-lab-instance]')[0].querySelector('[aria-expanded="true"]') === null && document.querySelectorAll('[data-visual-lab-instance]')[1].querySelector('[aria-expanded="true"]') !== null`,
  );
  await evaluate(cdp, `document.querySelector('.composer textarea').focus()`);
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await waitFor(
    cdp,
    `document.querySelector('[data-visual-lab-instance] [aria-expanded="true"]') === null`,
  );
  await evaluate(
    cdp,
    `document.querySelectorAll('[data-visual-lab-instance]')[1].querySelector('.lab-option-info-trigger').click()`,
  );
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-visual-lab-instance]')[1].querySelector('[aria-expanded="true"]') !== null`,
  );
  await physicalClick(cdp, ".media-surface");
  await waitFor(
    cdp,
    `document.querySelector('[data-visual-lab-instance] [aria-expanded="true"]') === null`,
  );
  const timerPaneBefore = await value(
    cdp,
    `document.querySelector('.instrument-timers > .timer-wrap').getBoundingClientRect().height`,
  );
  await evaluate(
    cdp,
    `(() => { const input=document.querySelector('[aria-label="Timer count"]'); input.value='24'; input.dispatchEvent(new Event('change',{bubbles:true})); })()`,
  );
  await waitFor(
    cdp,
    `document.querySelector('.debug-card')?.textContent.match(/timers scroll 0px x \\/ [1-9][0-9.]*px y/) !== null`,
  );
  assertEqual(
    await value(
      cdp,
      `(() => { const list=document.querySelector('.timer-list'); return document.querySelector('.instrument-timers > .timer-wrap').getBoundingClientRect().height <= ${JSON.stringify(timerPaneBefore)} + list.offsetHeight - list.clientHeight; })()`,
    ),
    true,
    "additional timers must retain their bounded instrument allocation",
  );
  assertEqual(
    await value(
      cdp,
      `document.querySelector('.tool-strip-scroll').scrollWidth > document.querySelector('.tool-strip-scroll').clientWidth && [...document.querySelectorAll('.tool-column-body')].some((body) => body.scrollHeight > body.clientHeight) && document.querySelector('.timer-list').scrollHeight > document.querySelector('.timer-list').clientHeight`,
    ),
    true,
    "Layout Debug fixture must create tool-strip, tool-body, and vertical timer overflow",
  );
  assertEqual(
    await value(
      cdp,
      `document.querySelector('.debug-card')?.textContent.includes('tool-body-') && document.querySelector('.debug-card')?.textContent.match(/timers scroll 0px x \\/ [1-9][0-9.]*px y/) !== null`,
    ),
    true,
    "Layout Debug must report the actual overflowing tool body and timer scroll owner",
  );
  await evaluate(
    cdp,
    `(() => { const selects=document.querySelectorAll('[data-tool-column-select]'); for (const index of [1,2]) { selects[index].value='runtime-session'; selects[index].dispatchEvent(new Event('change',{bubbles:true})); } })()`,
  );
  await waitFor(cdp, `document.querySelectorAll('[data-player-runtime-status]').length === 2`);
  assertEqual(
    await value(
      cdp,
      `(() => { const ids=[...document.querySelectorAll('[id]')].map((node) => node.id); return ids.length === new Set(ids).size; })()`,
    ),
    true,
    "duplicate Runtime Session columns must retain unique DOM IDs",
  );

  await setViewport(cdp, 1200, 760);
  await navigate(cdp, `${origin}/player/?fixture=runtime-skippable-long`);
  await waitFor(cdp, `document.querySelector('.player') !== null`);
  await selectVueTool(cdp, "runtime-session");
  await physicalClick(cdp, "[data-save-player-checkpoint]");
  const runtimeBefore = await vueRuntimeTranscript(cdp);
  await physicalClick(cdp, "[data-tool-column-add]");
  await setVueSessionOpen(cdp, true);
  await evaluate(
    cdp,
    `(() => { const selects=document.querySelectorAll('[data-tool-column-select]'); selects[1].value='visuals'; selects[1].dispatchEvent(new Event('change',{bubbles:true})); const toggle=document.querySelector('.right-toggle-control input'); toggle.click(); const composer=document.querySelector('.composer textarea'); composer.value='local draft'; composer.dispatchEvent(new Event('input',{bubbles:true})); })()`,
  );
  const localToggleValue = await value(
    cdp,
    `document.querySelector('.right-toggle-control input').checked`,
  );
  await waitFor(cdp, `document.querySelector('[aria-label="Accent"]') !== null`);
  await evaluate(
    cdp,
    `(() => { const accent=document.querySelector('[aria-label="Accent"]'); accent.value='teal'; accent.dispatchEvent(new Event('change',{bubbles:true})); })()`,
  );
  await setVueSessionOpen(cdp, false);
  await physicalClickTranscriptBackground(cdp);
  await waitFor(cdp, `document.querySelector('[data-foreground-button]') !== null`);
  await selectVueTool(cdp, "runtime-session");
  await physicalClick(cdp, "[data-restore-player-checkpoint]");
  await waitFor(cdp, `document.querySelector('[data-foreground-button]') === null`);
  assertEqual(
    JSON.stringify(
      (await vueRuntimeTranscript(cdp)).filter((entry) => entry.id.startsWith("runtime-")),
    ),
    JSON.stringify(runtimeBefore),
    "Runtime Session restore must rewind runtime presentation",
  );
  await setVueSessionOpen(cdp, true);
  assertEqual(
    await value(
      cdp,
      `document.querySelectorAll('[data-tool-column-id]').length === 2 && document.querySelector('[aria-label="Accent"]').value === 'teal' && document.querySelector('.composer textarea').value === 'local draft' && document.querySelector('.right-toggle-control input').checked === ${JSON.stringify(localToggleValue)}`,
    ),
    true,
    "Runtime Session restore must preserve local Visual Lab, tool, right-rail, and composer state",
  );
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

async function vueRuntimeScenario(cdp, origin) {
  await setViewport(cdp, 1440, 900);
  await navigate(cdp, `${origin}/player/?fixture=runtime-skippable-long`);
  await waitFor(
    cdp,
    `document.querySelector('.player') !== null && document.querySelectorAll('[data-transcript-entry-id]').length === 1`,
  );
  assertEqual(
    await value(cdp, `document.querySelector('[data-layout-debug-overlay]') === null`),
    true,
    "normal Vue route must start with Layout Debug disabled",
  );
  await selectVueTool(cdp, "runtime-session");

  const initialTranscript = await vueRuntimeTranscript(cdp);
  await physicalClick(cdp, "[data-save-player-checkpoint]");
  await waitFor(
    cdp,
    `document.querySelector('[data-player-runtime-status]')?.textContent.includes('saved')`,
  );
  assertEqual(
    JSON.stringify(await vueRuntimeTranscript(cdp)),
    JSON.stringify(initialTranscript),
    "checkpoint control pointer activation must not also skip pacing",
  );

  await evaluate(cdp, `document.querySelector('[data-save-player-checkpoint]').focus()`);
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
  await setVueSessionOpen(cdp, true);
  await physicalClick(cdp, ".right-toggle-control .right-control-label");
  await waitFor(cdp, `document.body.textContent.includes('You changed Strict mode to off.')`);
  assertEqual(
    await value(cdp, `document.querySelector('[data-foreground-button]') === null`),
    true,
    "nested right-rail control activation must not skip pacing",
  );
  await setVueSessionOpen(cdp, false);
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
  assertEqual(
    JSON.stringify((await vueRuntimeTranscript(cdp)).map((entry) => entry.text.trim())),
    JSON.stringify(["Long pacing", "You changed Strict mode to off.", "After"]),
    "runtime and fixture transcript entries must preserve their presentation arrival order",
  );
  await selectVueTool(cdp, "runtime-session");
  await physicalClick(cdp, "[data-save-player-checkpoint]");
  await physicalClick(cdp, "[data-restore-player-checkpoint]");
  await waitFor(
    cdp,
    `document.querySelector('[data-player-runtime-status]')?.textContent.includes('restored')`,
  );
  assertEqual(
    JSON.stringify((await vueRuntimeTranscript(cdp)).map((entry) => entry.text.trim())),
    JSON.stringify(["Long pacing", "You changed Strict mode to off.", "After"]),
    "runtime restore must retain the interleaved presentation arrival order",
  );

  await navigate(cdp, `${origin}/player/`);
  await waitFor(
    cdp,
    `document.querySelector('.player') !== null && document.querySelectorAll('[data-transcript-entry-id]').length === 1`,
  );
  await navigate(cdp, `${origin}/player/?layout-debug=1`);
  await waitFor(
    cdp,
    `document.querySelector('[data-layout-debug-overlay]') !== null && document.querySelector('.player')?.dataset.chrome !== undefined`,
  );
  assertEqual(
    await value(
      cdp,
      `document.querySelector('[data-layout-debug-overlay]')?.getAttribute('aria-hidden')`,
    ),
    "true",
    "direct Layout Debug URL must enable the non-interactive diagnostic overlay",
  );
  await navigate(cdp, `${origin}/player/`);
  await waitFor(cdp, `document.querySelector('.player') !== null`);
  await selectVueTool(cdp, "runtime-session");

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
  await physicalClick(cdp, "[data-save-player-checkpoint]");
  await typeAndSubmitVuePlayer(cdp, "Alex");
  await waitFor(
    cdp,
    `document.querySelector('.composer textarea')?.getAttribute('aria-label') === 'Number'`,
  );
  await physicalClick(cdp, "[data-restore-player-checkpoint]");
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

  await physicalClick(cdp, "[data-save-player-checkpoint]");
  const beforeChoice = await vueRuntimeTranscript(cdp);
  await click(cdp, ".foreground-choice-item:nth-child(2) button");
  await waitFor(cdp, `document.querySelector('[data-foreground-kind]') === null`);
  await waitFor(cdp, `document.body.textContent.includes('Thanks Alex')`);
  await click(cdp, "[data-restore-player-checkpoint]");
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
  await typeAndSubmitVuePlayer(cdp, "Local follow-up");
  await waitFor(
    cdp,
    `document.querySelector('[data-transcript-entry-id^="fixture-activity-"]')?.textContent.includes('Local follow-up')`,
  );
  assertEqual(
    await value(
      cdp,
      `(() => {
        const message=document.querySelector('[data-transcript-entry-id^="fixture-activity-"]');
        const container=message?.parentElement;
        if (!(message instanceof HTMLElement) || !(container instanceof HTMLElement)) return false;
        const messageRect=message.getBoundingClientRect();
        const containerRect=container.getBoundingClientRect();
        return message.classList.contains('user') &&
          getComputedStyle(message).textAlign === 'right' &&
          getComputedStyle(message.querySelector('.message-body')).fontFamily.startsWith('Verdana') &&
          containerRect.right - messageRect.right < messageRect.left - containerRect.left;
      })()`,
    ),
    true,
    "fixture user messages must retain the existing right-aligned Phase 1 user presentation",
  );
  await setViewport(cdp, 1440, 900);
  await physicalClick(cdp, "[data-tool-column-add]");
  await waitFor(cdp, `document.querySelectorAll('[data-tool-column-id]').length === 2`);
  await waitFor(
    cdp,
    `(() => {
      const scroller=document.querySelector('.tool-strip-scroll');
      return scroller instanceof HTMLElement && scroller.scrollWidth <= scroller.clientWidth + 1;
    })()`,
  );
  assertEqual(
    await value(
      cdp,
      `(() => {
        const scroller=document.querySelector('.tool-strip-scroll');
        const columns=[...document.querySelectorAll('[data-tool-column-id]')];
        const last=columns.at(-1);
        if (!(scroller instanceof HTMLElement) || !(last instanceof HTMLElement)) return false;
        return last.getBoundingClientRect().right <= scroller.getBoundingClientRect().right + 1;
      })()`,
    ),
    true,
    "two tool columns must fit their preferred desktop panel width without clipping",
  );
  await setViewport(cdp, 1100, 700);
  await selectVueTool(cdp, "layout-debug");
  await waitFor(
    cdp,
    `(() => {
      const scroller=document.querySelector('.tool-strip-scroll');
      return scroller instanceof HTMLElement && scroller.scrollWidth > scroller.clientWidth + 1;
    })()`,
  );
  assertEqual(
    await value(
      cdp,
      `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`,
    ),
    true,
    "a genuinely constrained tool strip must not create outer-page horizontal overflow",
  );

  await setViewport(cdp, 390, 844);
  await navigate(cdp, `${origin}/player/`);
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

  await navigate(cdp, `${origin}/player/?fixture=runtime-unskippable`);
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

async function setVueSessionOpen(cdp, open) {
  const current = await value(
    cdp,
    `document.querySelector('.session-trigger')?.getAttribute('data-state') === 'open'`,
  );
  if (current !== open) await physicalClick(cdp, ".session-trigger");
  await waitFor(cdp, `document.querySelector('.session-popover') ${open ? "!==" : "==="} null`);
}

async function selectVueTool(cdp, toolId) {
  const open = await value(
    cdp,
    `document.querySelector('[aria-controls="leftPanel"]').getAttribute('aria-expanded') === 'true'`,
  );
  if (!open) await physicalClick(cdp, '[aria-controls="leftPanel"]');
  await evaluate(
    cdp,
    `(() => {
      const select=document.querySelector('[data-tool-column-select]');
      if (!(select instanceof HTMLSelectElement)) throw new Error('Vue tool selector missing');
      select.value=${JSON.stringify(toolId)};
      select.dispatchEvent(new Event('change', {bubbles:true}));
    })()`,
  );
  await waitFor(cdp, `document.querySelector('[data-tool-id=${JSON.stringify(toolId)}]') !== null`);
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
  await navigate(cdp, `${origin}/player/?fixture=transcript-stress`);
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
