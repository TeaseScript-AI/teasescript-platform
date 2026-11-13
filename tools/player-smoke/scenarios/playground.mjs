// The Player browser smoke's technical playground scenarios (the page at `/`), each taking the driver's `cdp`.
import { assertEqual, click, evaluate, value, visible, waitFor } from "../driver.mjs";

export async function desktopScenario(cdp) {
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
    `document.querySelector('#interaction-feedback')?.textContent.includes('I asked for some text.')`,
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
    `document.querySelector('#interaction-feedback')?.textContent.includes('I asked for a number.')`,
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

export async function pointerScenario(cdp) {
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

export async function constrainedChoicesScenario(cdp) {
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

export async function replacedCheckpointScenario(cdp) {
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

export async function narrowScenario(cdp) {
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

export async function selectPlayerExample(cdp) {
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

function documentTextIncludes(values, text) {
  return values.some((value) => value.includes(text));
}
