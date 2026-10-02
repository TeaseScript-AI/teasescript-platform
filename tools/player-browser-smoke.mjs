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
      await demoScenario(cdp, origin);
      console.log(
        "player-browser-smoke: PASS technical playground and the repository demo on /player/",
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

// Plays the repository demo on the maintained /player/ route of the built Player with trusted input, so the Start
// click is the user activation its audio relies on. Checks rely on the demo's authored text and timer labels.
async function demoScenario(cdp, origin) {
  const { identifier } = await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
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
  let staleGestureChecked = false;
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
      !staleGestureChecked &&
      state.texts.some((text) => text.includes("You hold still until that clock runs out.")) &&
      !state.texts.some((text) => text.includes("The other one is mine."))
    ) {
      staleGestureChecked = true;
      await staleSkipGestureCheck(cdp);
    } else if (state.buttons.length === 1) {
      finished = state.buttons[0] === "Finish";
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
  assertEqual(staleGestureChecked, true, "The stale skip gesture check ran");
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
  // Hold until the current message's pacing ends and the next message ("The other one is mine.") arrives.
  await waitFor(cdp, `${count} === ${before + 1}`);
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

async function pressSpace(cdp) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.call("Input.dispatchKeyEvent", {
      type,
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
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
